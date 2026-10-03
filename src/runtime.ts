import {createEvaluator, createEvaluatorWithSharedResources} from './evaluate.js';
import {assertBundle, BundleValidationError, type Bundle, type EvaluatedFrame, type Resource} from './schema.js';
import type {ExpressionValue} from './fields/ast.js';
import {requireCapabilities, sceneFeatures, SVG_2D_PROFILE, NUMERIC_3D_PROFILE, type CapabilityProfile, type RenderFeature} from './capabilities.js';
import type {TimelineMetadata} from './timeline/ast.js';
import type {DeepReadonly,SourceSpan} from './ir/operations.js';
import {freezeSnapshot, validateJsonData} from './operations/values.js';
import {snapshotScenePackage, validateAssetJson, type ScenePackage, type AssetEntry} from './resources/package.js';
import {createAssetStore, type AssetStore, type AssetResolver, type AssetLease} from './resources/store.js';
import type {MeshUnit} from './ir/mesh.js';

export interface SceneManifest {
  readonly contract: 'texloom-runtime/1';
  readonly sceneVersion: Bundle['version'];
  readonly title: string;
  readonly duration: number;
  readonly viewport: Readonly<Bundle['viewport']>;
  readonly features: readonly RenderFeature[];
  /** Source-time schedule and cues are immutable data; sampling fires no events. */
  readonly timeline?: DeepReadonly<TimelineMetadata>;
  /** Metadata only: no transport URI, inline payload, object URL or GPU handle. */
  readonly assets?: readonly DeepReadonly<Omit<AssetEntry, 'source'>>[];
  /** Evaluated frame resources, with no asset transport or fixed bounds. */
  readonly generatedResources?:readonly Readonly<{id:string;kind:'mesh'|'curve3d';producer:'surface'|'curve3d';operationId:string;units:MeshUnit}>[];
}
export interface SceneRuntime {
  readonly manifest: SceneManifest;
  /** Sample absolute source seconds. Every call is independent of prior calls. */
  sample(seconds: number, parameters?:Readonly<Record<string,ExpressionValue>>): EvaluatedFrame;
  require(profile: CapabilityProfile): void;
}

/** Compile once, host either web or lecture clock, distribute the same frame. */
export function prepareScene(bundle: Bundle): SceneRuntime {
  const sample = createEvaluator(bundle);
  const manifest = sceneManifest(bundle);
  return Object.freeze({manifest, sample,
    require(profile: CapabilityProfile) {requireCapabilities(manifest.features, profile);},
  });
}

function sceneManifest(bundle: Bundle, assets?: readonly AssetEntry[]): SceneManifest {
  return Object.freeze({
    contract: 'texloom-runtime/1', sceneVersion: bundle.version,
    title: bundle.title, duration: bundle.duration,
    viewport: Object.freeze({...bundle.viewport}),
    features: Object.freeze(sceneFeatures(bundle)),
    ...(bundle.timeline ? {timeline:freezeSnapshot(bundle.timeline)} : {}),
    ...(assets ? {assets:freezeSnapshot(assets.map(({source: _source, ...metadata}) => metadata))} : {}),
    ...(bundle.surfaces||bundle.curves3d ? {generatedResources:freezeSnapshot([
      ...(bundle.surfaces?.operations??[]).map(o=>({id:o.resourceId,kind:'mesh' as const,producer:'surface' as const,operationId:o.id,units:o.units})),
      ...(bundle.curves3d?.operations??[]).map(o=>({id:o.resourceId,kind:'curve3d' as const,producer:'curve3d' as const,operationId:o.id,units:o.units})),
    ])} : {}),
  });
}

export type PreparationState = 'preparing' | 'ready' | 'failed' | 'disposed';
export interface PreparedSceneRuntime extends SceneRuntime {
  readonly state: 'ready' | 'disposed';
  /** Idempotent. Releases this scene's leases; existing frames remain usable. */
  dispose(): void;
}
export interface ScenePreparation {
  readonly state: PreparationState;
  readonly error: Error | undefined;
  /** Resolves atomically after every resource and the complete plan validate. */
  readonly ready: Promise<PreparedSceneRuntime>;
  /** Cancels pending work immediately, or disposes the ready runtime. */
  dispose(): void;
}
export interface PrepareSceneOptions {
  /** URI policies, transport, and exact range selection belong to the host. */
  assetResolver?: AssetResolver;
  /** Host-owned store enables sharing between concurrent scenes. Mutually
   * exclusive with assetResolver. The scene never disposes a supplied store. */
  assetStore?: AssetStore;
  /** Abort also disposes an already ready scene (e.g. component unmount). */
  signal?: AbortSignal;
  /** Defaults to the complete current 2D profile. */
  profile?: CapabilityProfile;
}

export class ScenePreparationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(`${code}: ${message}`); this.name = 'ScenePreparationError';
  }
}

function snapshotProfile(input: CapabilityProfile): CapabilityProfile {
  const errors = validateJsonData(input);
  if (errors.length) throw new BundleValidationError(errors);
  if (!input || input.contract !== 'texloom-render/1' || typeof input.id !== 'string' || !input.id ||
      !Array.isArray(input.features) || input.features.some(feature => typeof feature !== 'string' || !feature))
    throw new ScenePreparationError('RENDER_PROFILE', 'Expected a renderer ID, texloom-render/1 contract and feature strings.');
  return freezeSnapshot(input);
}

/** Start an atomic preparation transaction. This function always returns a
 * handle, including for malformed data. All caller data is snapshotted before
 * the first await, and errors are delivered through ready and error. */
export function beginPrepareScene(input: Bundle | ScenePackage, options: PrepareSceneOptions = {}): ScenePreparation {
  let state: PreparationState = 'preparing', failure: Error | undefined;
  let sample: ReturnType<typeof createEvaluator> | undefined;
  let snapshot: Bundle | ScenePackage | undefined, profile: CapabilityProfile;
  let store: AssetStore | undefined, ownedStore = false;
  let externalSignal: AbortSignal | undefined;
  const controller = new AbortController(), leases = new Set<AssetLease>();
  let resolveReady!: (runtime: PreparedSceneRuntime) => void, rejectReady!: (error: Error) => void;
  const ready = new Promise<PreparedSceneRuntime>((resolve, reject) => {resolveReady = resolve; rejectReady = reject;});
  // Disposal may precede the host attaching an await/catch. Preserve the public
  // rejection while avoiding an unhandled rejection during component teardown.
  void ready.catch(() => {});

  const release = () => {
    sample = undefined;
    snapshot = undefined;
    externalSignal?.removeEventListener('abort', dispose);
    for (const lease of leases) lease.release();
    leases.clear();
    if (ownedStore) store?.dispose();
    store = undefined;
  };
  function dispose(): void {
    if (state === 'disposed') return;
    const wasPreparing = state === 'preparing';
    state = 'disposed';
    controller.abort();
    release();
    if (wasPreparing) {
      failure = new ScenePreparationError('SCENE_ABORTED', 'Scene preparation was cancelled.');
      rejectReady(failure);
    }
  }
  const fail = (error: unknown) => {
    if (state !== 'preparing') return;
    failure = error instanceof Error ? error : new ScenePreparationError('SCENE_PREPARATION', String(error));
    state = 'failed';
    controller.abort();
    release();
    rejectReady(failure);
  };
  const handle: ScenePreparation = Object.freeze({get state() {return state;}, get error() {return failure;}, ready, dispose});

  try {
    if (!options || typeof options !== 'object' || Array.isArray(options))
      throw new ScenePreparationError('SCENE_OPTIONS', 'Expected preparation options.');
    if (options.assetStore && options.assetResolver)
      throw new ScenePreparationError('SCENE_OPTIONS', 'Use either assetStore or assetResolver.');
    if (options.assetResolver !== undefined && typeof options.assetResolver !== 'function')
      throw new ScenePreparationError('SCENE_OPTIONS', 'assetResolver must be a function.');
    if (options.assetStore && (typeof options.assetStore.acquire !== 'function' || typeof options.assetStore.dispose !== 'function'))
      throw new ScenePreparationError('SCENE_OPTIONS', 'assetStore must implement acquire and dispose.');
    if (options.signal !== undefined && !(options.signal instanceof AbortSignal))
      throw new ScenePreparationError('SCENE_OPTIONS', 'signal must be an AbortSignal.');
    profile = snapshotProfile(options.profile ?? SVG_2D_PROFILE);
    const jsonErrors = validateAssetJson(input);
    if (jsonErrors.length) throw new BundleValidationError(jsonErrors);
    if (input && typeof input === 'object' && 'contract' in input) {
      snapshot = snapshotScenePackage(input) as ScenePackage;
      // A permissive custom renderer cannot make an unknown core feature work.
      requireCapabilities(snapshot.assets.requiredFeatures, NUMERIC_3D_PROFILE);
      requireCapabilities(snapshot.assets.requiredFeatures, profile);
      store = options.assetStore ?? createAssetStore({resolver: options.assetResolver});
      ownedStore = !options.assetStore;
    } else {
      assertBundle(input);
      snapshot = structuredClone(input);
      requireCapabilities(sceneFeatures(snapshot), profile);
    }
    externalSignal = options.signal;
    externalSignal?.addEventListener('abort', dispose, {once: true});
    if (externalSignal?.aborted) {dispose(); return handle;}
  } catch (error) {fail(error); return handle;}

  async function prepare(): Promise<void> {
    try {
      const data = snapshot!;
      let bundle: Bundle, entries: readonly AssetEntry[] | undefined;
      if ('contract' in data) {
        entries = data.assets.entries;
        const activeStore = store!;
        const resources = await Promise.all(entries.map(async entry => {
          const lease = await activeStore.acquire(entry, controller.signal);
          if (state !== 'preparing') {lease.release(); throw new ScenePreparationError('SCENE_ABORTED', 'Preparation ended.');}
          leases.add(lease);
          return [entry.id, lease.resource as Resource] as const;
        }));
        if (state !== 'preparing') return;
        bundle = {...data.scene, resources: Object.freeze(Object.fromEntries(resources))};
        assertBundle(bundle);
        const actual = sceneFeatures(bundle);
        const undeclared = actual.filter(feature => !data.assets.requiredFeatures.includes(feature));
        if (undeclared.length) throw new ScenePreparationError('ASSET_FEATURES', `Manifest omits required features: ${undeclared.join(', ')}.`);
        requireCapabilities(actual, profile);
        sample = createEvaluatorWithSharedResources(bundle);
      } else {
        bundle = data;
        sample = createEvaluator(bundle);
      }
      if (state !== 'preparing') return;
      const manifest = sceneManifest(bundle, entries);
      const assertReady = () => {
        if (state !== 'ready' || !sample) throw new ScenePreparationError('SCENE_DISPOSED', 'This scene has been disposed.');
      };
      const runtime: PreparedSceneRuntime = Object.freeze({
        manifest,
        get state(): 'ready' | 'disposed' {return state === 'ready' ? 'ready' : 'disposed';},
        sample(seconds: number, parameters?: Readonly<Record<string, ExpressionValue>>) {
          assertReady(); return sample!(seconds, parameters);
        },
        require(requiredProfile: CapabilityProfile) {assertReady(); requireCapabilities(manifest.features, requiredProfile);},
        dispose,
      });
      snapshot = undefined;
      state = 'ready';
      resolveReady(runtime);
    } catch (error) {fail(error);}
  }
  // Keep state observably preparing until a microtask, including inline scenes.
  void Promise.resolve().then(() => {if (state === 'preparing') return prepare();});
  return handle;
}

/** Convenience when a host already owns an AbortSignal. Use beginPrepareScene
 * when the caller also needs a cancellation handle before ready resolves. */
export function prepareSceneAsync(input: Bundle | ScenePackage, options?: PrepareSceneOptions): Promise<PreparedSceneRuntime> {
  return beginPrepareScene(input, options).ready;
}

export interface ClipTiming {
  /** Absolute host/lesson start, seconds. */
  start: number;
  /** Optional source time offset, seconds. */
  sourceStart?: number;
  /** Source seconds per host second; strictly positive. */
  rate?: number;
  /** Host seconds. Defaults to the remaining source duration divided by rate. */
  duration?: number;
  before?: 'hidden' | 'hold';
  after?: 'hidden' | 'hold';
}
export interface ClipDescription {
  hostTime: number;
  sourceTime: number;
  phase: 'before' | 'active' | 'after';
  visible: boolean;
}
export interface ClipSample extends ClipDescription {
  frame: EvaluatedFrame | null;
}
export interface SceneClip {
  readonly timing: Readonly<Required<ClipTiming>>;
  /** Inclusive source endpoints preserve terminal markers, independently of
   * the half-open active frame interval. Hosts decide which cues to dispatch. */
  readonly cues: readonly ClipCue[];
  /** Intersection with the active clip, expressed on both clocks. Held frames
   * never extend a contact/sound interval. Empty intersections return null. */
  mapInterval(sourceStart:number,sourceEnd:number):ClipInterval|null;
  /** Pure clock mapping: no geometry evaluation or event dispatch. */
  describe(hostSeconds: number): ClipDescription;
  sample(hostSeconds: number, parameters?:Readonly<Record<string,ExpressionValue>>): ClipSample;
}
export interface ClipInterval {hostStart:number;hostEnd:number;sourceStart:number;sourceEnd:number}
export interface ClipCue {
  readonly name:string;
  readonly sourceTime:number;
  readonly hostTime:number;
  readonly sourceSpan?:DeepReadonly<SourceSpan>;
}

/** Half-open active interval [start,start+duration); no independent wall clock. */
export function bindSceneClip(runtime: SceneRuntime, input: ClipTiming): SceneClip {
  const sourceStart = input.sourceStart ?? 0, rate = input.rate ?? 1;
  const duration = input.duration ?? (runtime.manifest.duration - sourceStart) / rate;
  const timing: Required<ClipTiming> = {start: input.start, sourceStart, rate, duration,
    before: input.before ?? 'hidden', after: input.after ?? 'hold'};
  if (![timing.start, sourceStart, rate, duration].every(Number.isFinite) || timing.start < 0 || sourceStart < 0 ||
      sourceStart > runtime.manifest.duration || rate <= 0 || duration < 0 ||
      !Number.isFinite(sourceStart + duration * rate) || sourceStart + duration * rate > runtime.manifest.duration + 1e-9 ||
      duration > 0 && sourceStart + duration * rate <= sourceStart ||
      !Number.isFinite(timing.start + duration) || duration > 0 && timing.start + duration <= timing.start ||
      !['hidden', 'hold'].includes(timing.before) || !['hidden', 'hold'].includes(timing.after)) {
    throw new Error('CLIP_TIMING: finite nonnegative timing must stay inside the source duration; rate must be positive.');
  }
  Object.freeze(timing);
  const sourceEnd=Math.min(runtime.manifest.duration,sourceStart+duration*rate);
  const cues:readonly ClipCue[]=freezeSnapshot((runtime.manifest.timeline?.cues??[])
    .filter(cue=>cue.time>=sourceStart&&cue.time<=sourceEnd)
    .map(cue=>({name:cue.name,sourceTime:cue.time,hostTime:timing.start+(cue.time-sourceStart)/rate,
      ...(cue.sourceSpan?{sourceSpan:cue.sourceSpan}:{})})));
  const describe=(hostTime:number):ClipDescription=>{
    if (!Number.isFinite(hostTime)) throw new Error('CLIP_TIME: expected finite absolute host seconds.');
    const phase = hostTime < timing.start ? 'before' : hostTime >= timing.start + duration ? 'after' : 'active';
    const visible = phase === 'active' || (phase === 'before' ? timing.before : timing.after) === 'hold';
    const sourceTime = Math.min(runtime.manifest.duration, sourceStart + Math.max(0, Math.min(duration, hostTime - timing.start)) * rate);
    return {hostTime,sourceTime,phase,visible};
  };
  const mapInterval=(begin:number,end:number):ClipInterval|null=>{
    if(![begin,end].every(Number.isFinite)||begin<0||end<begin||end>runtime.manifest.duration)
      throw new Error('CLIP_INTERVAL: ordered finite source interval must stay inside the scene.');
    const a=Math.max(begin,sourceStart),b=Math.min(end,sourceEnd);
    if(b<=a)return null;
    const hostStart=Math.max(timing.start,timing.start+(a-sourceStart)/rate);
    const hostEnd=Math.min(timing.start+duration,timing.start+(b-sourceStart)/rate);
    if(![hostStart,hostEnd].every(Number.isFinite)||hostEnd<=hostStart)
      throw new Error('CLIP_INTERVAL: source interval cannot be represented at this host clock precision.');
    return {sourceStart:a,sourceEnd:b,hostStart,hostEnd};
  };
  return Object.freeze({timing,cues,describe,mapInterval, sample(hostTime: number, parameters?:Readonly<Record<string,ExpressionValue>>): ClipSample {
    const description=describe(hostTime);
    return {...description,frame:description.visible?runtime.sample(description.sourceTime,parameters):null};
  }});
}
