import {createEvaluator} from './evaluate.js';
import type {Bundle, EvaluatedFrame} from './schema.js';
import type {ExpressionValue} from './fields/ast.js';
import {requireCapabilities, sceneFeatures, type CapabilityProfile, type RenderFeature} from './capabilities.js';
import type {TimelineMetadata} from './timeline/ast.js';
import type {DeepReadonly,SourceSpan} from './ir/operations.js';
import {freezeSnapshot} from './operations/values.js';

export interface SceneManifest {
  readonly contract: 'texloom-runtime/1';
  readonly sceneVersion: Bundle['version'];
  readonly title: string;
  readonly duration: number;
  readonly viewport: Readonly<Bundle['viewport']>;
  readonly features: readonly RenderFeature[];
  /** Source-time schedule and cues are immutable data; sampling fires no events. */
  readonly timeline?: DeepReadonly<TimelineMetadata>;
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
  const manifest: SceneManifest = Object.freeze({
    contract: 'texloom-runtime/1', sceneVersion: bundle.version,
    title: bundle.title, duration: bundle.duration,
    viewport: Object.freeze({...bundle.viewport}),
    features: Object.freeze(sceneFeatures(bundle)),
    ...(bundle.timeline ? {timeline:freezeSnapshot(bundle.timeline)} : {}),
  });
  return Object.freeze({manifest, sample,
    require(profile: CapabilityProfile) {requireCapabilities(manifest.features, profile);},
  });
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
export interface ClipSample {
  hostTime: number;
  sourceTime: number;
  phase: 'before' | 'active' | 'after';
  visible: boolean;
  frame: EvaluatedFrame | null;
}
export interface SceneClip {
  readonly timing: Readonly<Required<ClipTiming>>;
  /** Inclusive source endpoints preserve terminal markers, independently of
   * the half-open active frame interval. Hosts decide which cues to dispatch. */
  readonly cues: readonly ClipCue[];
  sample(hostSeconds: number, parameters?:Readonly<Record<string,ExpressionValue>>): ClipSample;
}
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
  return Object.freeze({timing,cues, sample(hostTime: number, parameters?:Readonly<Record<string,ExpressionValue>>): ClipSample {
    if (!Number.isFinite(hostTime)) throw new Error('CLIP_TIME: expected finite absolute host seconds.');
    const phase = hostTime < timing.start ? 'before' : hostTime >= timing.start + duration ? 'after' : 'active';
    const visible = phase === 'active' || (phase === 'before' ? timing.before : timing.after) === 'hold';
    const sourceTime = Math.min(runtime.manifest.duration, sourceStart + Math.max(0, Math.min(duration, hostTime - timing.start)) * rate);
    return {hostTime, sourceTime, phase, visible, frame: visible ? runtime.sample(sourceTime,parameters) : null};
  }});
}
