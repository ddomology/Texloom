import {beginPrepareScene, type PreparedSceneRuntime, type SceneManifest} from '../src/runtime.js';
import {SVG_2D_PROFILE} from '../src/capabilities.js';
import {renderSvg} from '../src/render-svg.js';
import {snapshotScenePackage, sha256Bytes, validateAssetJson} from '../src/resources/package.js';
import {freezeSnapshot} from '../src/operations/values.js';
import type {DeepReadonly, Diagnostic} from '../src/ir/operations.js';
import type {EvaluatedFrame} from '../src/schema.js';

/** Site-owned registration. A TeX note refers only to its catalog ID. */
export interface LemniroFigureReference {
  contract: 'texloom-figure/1'; id: string;
  manifestPath: string; manifestSha256: string; posterPath: string;
  title: string; description: string; width: number; height: number; duration: number;
}
export class LemniroFigureError extends Error {
  readonly diagnostics: DeepReadonly<Diagnostic[]>;
  constructor(public readonly code: string, message: string, diagnostics?: readonly Diagnostic[]) {
    super(`${code}: ${message}`); this.name = 'LemniroFigureError';
    this.diagnostics = freezeSnapshot(diagnostics ?? [{severity:'error', code, message, path:'$'}]);
  }
}
export function isPortableFigurePath(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 2048 && /^[A-Za-z0-9._/-]+$/.test(value) &&
    value.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}
export function validateLemniroFigureReference(input: unknown): Diagnostic[] {
  const errors = validateAssetJson(input);
  const error = (message: string, path: string) => errors.push({severity:'error', code:'FIGURE_REFERENCE', message, path});
  if (errors.length) return errors;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {error('Expected a figure reference.', '$'); return errors;}
  const ref = input as Record<string, unknown>;
  const allowed = ['contract','id','manifestPath','manifestSha256','posterPath','title','description','width','height','duration'];
  for (const key of Object.keys(ref)) if (!allowed.includes(key)) error(`Unsupported field ${key}.`, `$.${key}`);
  if (ref.contract !== 'texloom-figure/1') error('Expected texloom-figure/1.', '$.contract');
  if (typeof ref.id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(ref.id)) error('Expected a lowercase scene ID of at most 64 characters.', '$.id');
  if (!isPortableFigurePath(ref.manifestPath) || !ref.manifestPath.endsWith('.json')) error('Expected a portable relative JSON path.', '$.manifestPath');
  if (!isPortableFigurePath(ref.posterPath) || !/\.(svg|png|webp|jpe?g)$/i.test(ref.posterPath)) error('Expected a portable relative image path.', '$.posterPath');
  if (typeof ref.manifestSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(ref.manifestSha256)) error('Expected lowercase SHA-256.', '$.manifestSha256');
  for (const [key, maximum] of [['title',256],['description',4096]] as const)
    if (typeof ref[key] !== 'string' || !ref[key].trim() || ref[key].length > maximum) error(`Expected nonempty text of at most ${maximum} characters.`, `$.${key}`);
  for (const key of ['width','height']) if (typeof ref[key] !== 'number' || !Number.isFinite(ref[key]) || ref[key] <= 0 || ref[key] > 16384)
    error('Expected positive finite dimensions up to 16384 bp.', `$.${key}`);
  if (typeof ref.duration !== 'number' || !Number.isFinite(ref.duration) || ref.duration < 0) error('Expected finite nonnegative seconds.', '$.duration');
  return errors;
}
export function assertLemniroFigureReference(input: unknown): asserts input is LemniroFigureReference {
  const errors = validateLemniroFigureReference(input);
  if (errors.length) throw new LemniroFigureError('FIGURE_REFERENCE', 'Invalid figure registration.', errors);
}
export interface LemniroFigureOptions {
  /** Absolute HTTP(S) directory, including the deployment base path. */
  baseUrl: string | URL;
  instanceId: string;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
}
export interface LemniroFigureRuntime {
  readonly manifest: SceneManifest;
  readonly state: 'ready' | 'disposed';
  sample(seconds: number): EvaluatedFrame;
  render(seconds: number): string;
  dispose(): void;
}
const MANIFEST_BYTES = 4 * 1024 * 1024;
const RESOURCE_BYTES = 16 * 1024 * 1024;
const abortError = () => new LemniroFigureError('FIGURE_ABORTED', 'Figure preparation was cancelled.');
function checkAbort(signal: AbortSignal): void {if (signal.aborted) throw abortError();}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {signal.removeEventListener('abort', abort); reject(abortError());};
    signal.addEventListener('abort', abort, {once:true});
    promise.then(value => {signal.removeEventListener('abort', abort); signal.aborted ? reject(abortError()) : resolve(value);},
      error => {signal.removeEventListener('abort', abort); reject(error);});
    if (signal.aborted) abort();
  });
}
function cancelBody(response: Response): void {void response.body?.cancel().catch(() => {});}
async function responseBytes(response: Response, limit: number, signal: AbortSignal): Promise<Uint8Array> {
  const declared = response.headers.get('Content-Length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    cancelBody(response); throw new LemniroFigureError('FIGURE_SIZE', 'Response exceeds the permitted byte budget.');
  }
  checkAbort(signal);
  if (!response.body) throw new LemniroFigureError('FIGURE_BYTES', 'Response has no readable body.');
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const next = await abortable(reader.read(), signal);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) throw new LemniroFigureError('FIGURE_SIZE', 'Response exceeded its byte budget while streaming.');
      chunks.push(next.value.slice());
    }
    checkAbort(signal);
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) {bytes.set(chunk, offset); offset += chunk.length;}
    return bytes;
  } catch (error) {void reader.cancel().catch(() => {}); throw error;}
  finally {try {reader.releaseLock();} catch {/* An abort can leave an underlying read pending. */}}
}

/** Site adapter: fixed same-origin portable paths and redirect rejection.
 * Transport never executes note HTML. All scene bytes are verified by PR24. */
export async function prepareLemniroFigure(input: LemniroFigureReference, options: LemniroFigureOptions): Promise<LemniroFigureRuntime> {
  assertLemniroFigureReference(input);
  const ref = freezeSnapshot(input);
  if (!options || typeof options !== 'object' || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(options.instanceId ?? ''))
    throw new LemniroFigureError('FIGURE_INSTANCE', 'An XML-safe instance ID is required.');
  const instanceId = options.instanceId, parentSignal = options.signal;
  if (parentSignal !== undefined && !(parentSignal instanceof AbortSignal)) throw new LemniroFigureError('FIGURE_SIGNAL', 'Expected AbortSignal.');
  let base: URL;
  try {base = new URL(String(options.baseUrl));} catch {throw new LemniroFigureError('FIGURE_BASE_URL', 'Expected an absolute HTTP(S) directory.');}
  if (!['http:','https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || /%|\\/.test(base.pathname))
    throw new LemniroFigureError('FIGURE_BASE_URL', 'Expected a portable HTTP(S) base directory without credentials, query or fragment.');
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  const fetcher = options.fetch ?? globalThis.fetch;
  if (typeof fetcher !== 'function') throw new LemniroFigureError('FIGURE_FETCH', 'This host must supply fetch.');
  const controller = new AbortController(); let runtime: PreparedSceneRuntime | undefined;
  const dispose = () => {controller.abort(); parentSignal?.removeEventListener('abort', dispose); runtime?.dispose(); runtime = undefined;};
  parentSignal?.addEventListener('abort', dispose, {once:true});
  if (parentSignal?.aborted) dispose();
  const signal = controller.signal;
  const localUrl = (path: string, directory: URL): URL => {
    if (!isPortableFigurePath(path)) throw new LemniroFigureError('FIGURE_ASSET_URI', 'Asset references must be portable relative paths.');
    const url = new URL(path, directory);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) throw new LemniroFigureError('FIGURE_ASSET_URI', 'Asset escaped the site base directory.');
    return url;
  };
  const request = async (url: URL, limit: number, range?: {offset:number;length:number}): Promise<Uint8Array> => {
    checkAbort(signal);
    const pending = fetcher(url.href, {signal, credentials:'same-origin', redirect:'error',
      headers:range ? {Range:`bytes=${range.offset}-${range.offset + range.length - 1}`} : {}}).then(response => {
        if (signal.aborted) {cancelBody(response); throw abortError();} return response;
      });
    const response = await abortable(pending, signal);
    try {
      if (!response.ok || response.redirected || response.url && response.url !== url.href)
        throw new LemniroFigureError('FIGURE_FETCH', `Asset request failed or redirected (${response.status}).`);
      if (range) {
        const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(response.headers.get('Content-Range') ?? '');
        if (response.status !== 206 || !match || Number(match[1]) !== range.offset || Number(match[2]) !== range.offset + range.length - 1 ||
            match[3] !== '*' && (!Number.isSafeInteger(Number(match[3])) || Number(match[3]) <= Number(match[2])))
          throw new LemniroFigureError('FIGURE_RANGE', 'Expected the exact 206 Content-Range; whole-body fallback is not enabled.');
      } else if (response.status !== 200) throw new LemniroFigureError('FIGURE_FETCH', 'Expected a complete 200 response.');
    } catch (error) {cancelBody(response); throw error;}
    return responseBytes(response, limit, signal);
  };
  try {
    const manifestUrl = localUrl(ref.manifestPath, base);
    const bytes = await request(manifestUrl, MANIFEST_BYTES);
    if (await sha256Bytes(bytes) !== ref.manifestSha256) throw new LemniroFigureError('FIGURE_HASH', 'Scene manifest SHA-256 does not match the registration.');
    checkAbort(signal);
    let parsed: unknown;
    try {parsed = JSON.parse(new TextDecoder('utf-8', {fatal:true, ignoreBOM:true}).decode(bytes));}
    catch {throw new LemniroFigureError('FIGURE_JSON', 'Manifest is not valid UTF-8 JSON.');}
    const packaged = snapshotScenePackage(parsed);
    if (packaged.scene.viewport.width !== ref.width || packaged.scene.viewport.height !== ref.height || packaged.scene.duration !== ref.duration)
      throw new LemniroFigureError('FIGURE_METADATA', 'Registered viewport or duration differs from the manifest.');
    const directory = new URL('./', manifestUrl);
    // Validate transport and resource bounds for all entries before asset I/O.
    for (const entry of packaged.assets.entries) {
      if (entry.byteLength > RESOURCE_BYTES) throw new LemniroFigureError('FIGURE_SIZE', 'A resource exceeds the site asset budget.');
      if (entry.source.kind === 'external') localUrl(entry.source.uri, directory);
    }
    const preparation = beginPrepareScene(packaged as Parameters<typeof beginPrepareScene>[0], {signal, profile:SVG_2D_PROFILE,
      assetResolver:entry => {
        if (entry.source.kind !== 'external') throw new LemniroFigureError('FIGURE_ASSET_URI', 'Only external entries invoke the resolver.');
        return request(localUrl(entry.source.uri, directory), entry.byteLength, entry.source.byteRange);
      }});
    runtime = await preparation.ready;
    if (signal.aborted) {runtime.dispose(); throw abortError();}
    const manifest = runtime.manifest;
    const live = () => {if (!runtime || runtime.state !== 'ready') throw new LemniroFigureError('FIGURE_DISPOSED', 'This figure has been disposed.'); return runtime;};
    return Object.freeze({manifest, get state() {return runtime?.state ?? 'disposed';},
      sample:(seconds:number) => live().sample(seconds),
      render:(seconds:number) => renderSvg(live().sample(seconds), {idPrefix:instanceId}), dispose});
  } catch (error) {dispose(); throw error;}
}
