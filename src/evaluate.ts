import type {Bundle, Camera, EvaluatedFrame, FieldNode, Node, PathNode, ScalarFieldResource, Track, TrackValue} from './schema.js';
import {geometryPointSlot} from './path-contract.js';
import {pathGeometryData, revealGeometry, type PathPoint} from './path-geometry.js';
import {prepareExecutionPlan, type ExecutionPlan} from './operations/plan.js';
import {withPathContext} from './operations/builtins/legacy.js';

/** Upper bound makes exact key times right-continuous, including step tracks. */
function interval(times: readonly number[], time: number): [number, number, number] {
  if (time <= times[0]) return [0, 0, 0];
  const last = times.length - 1;
  if (time >= times[last]) return [last, last, 0];
  let lo = 0, hi = times.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (times[mid] <= time) lo = mid + 1; else hi = mid; }
  const a = lo - 1, b = lo;
  return [a, b, (time - times[a]) / (times[b] - times[a])];
}
function mix(a: TrackValue, b: TrackValue, t: number): TrackValue {
  return typeof a === 'number' ? a + ((b as number) - a) * t : a.map((v, i) => v + ((b as number[])[i] - v) * t);
}
function trackValue(track: Track, time: number): TrackValue {
  const [a, b, raw] = interval(track.keys.map(key => key[0]), time);
  const t = track.interpolation === 'step' ? 0 : track.interpolation === 'smooth' ? raw * raw * (3 - 2 * raw) : raw;
  return mix(track.keys[a][1], track.keys[b][1], t);
}
function setValue(target: Node | Camera, property: string, value: TrackValue): void {
  if(property.startsWith('geometry.')) {
    geometryPointSlot((target as PathNode).geometry,property)!.set(value as PathPoint);
    return;
  }
  const [head, tail] = property.split('.');
  const record = target as unknown as Record<string, any>;
  if (tail) { record[head] ??= {}; record[head][tail] = value; }
  else record[head] = value;
}
function sampleField(resource: ScalarFieldResource, time: number): number[] {
  const [a, b, t] = interval(resource.times, time);
  return mix(resource.samples[a], resource.samples[b], resource.interpolation === 'step' ? 0 : t) as number[];
}
function evaluatePrepared(bundle: Bundle, time: number, plan: ExecutionPlan): EvaluatedFrame {
  if (!Number.isFinite(time)) throw new RangeError('Evaluation time must be finite.');
  const clamped = Math.max(0, Math.min(bundle.duration, time));
  const nodes = structuredClone(bundle.nodes), camera = structuredClone(bundle.camera);
  const byId = new Map(nodes.map(n => [n.id, n]));
  for (const track of bundle.tracks) setValue(track.target === '$camera' ? camera : byId.get(track.target)!, track.property, trackValue(track, clamped));
  plan.execute(byId, bundle.resources, camera);
  for(const node of nodes) if(node.kind==='path'&&node.geometry) {
    // Full editable geometry survives reveal: dependent points keep sampling the
    // mathematical curve, while both renderers receive the same visible prefix.
    node.d=withPathContext(node.id,()=>pathGeometryData(node.reveal===undefined?node.geometry!:
      revealGeometry(node.geometry!,node.reveal,node.revealMode??'parameter',node.pathTolerance??.05)));
  }
  for (const node of nodes) if (node.kind === 'field') (node as FieldNode).values = sampleField(bundle.resources[node.resourceId] as ScalarFieldResource, clamped);
  // Resources are immutable shared data; frame-local geometry and camera are independent.
  return { time: clamped, viewport: { ...bundle.viewport }, camera, nodes, resources: bundle.resources };
}

/** Convenience evaluation at an absolute time. Treat returned resources as immutable. */
export function evaluate(bundle: Bundle, time: number): EvaluatedFrame {
  return createEvaluator(bundle)(time);
}
function freezeDeep(value: any): void {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value); for (const child of Object.values(value)) freezeDeep(child);
  }
}
/** Validate and snapshot once for playback/export; seeking has no playback-history state. */
export function createEvaluator(bundle: Bundle): (time: number) => EvaluatedFrame {
  const plan = prepareExecutionPlan(bundle);
  const snapshot = structuredClone(bundle);
  freezeDeep(snapshot);
  return time => evaluatePrepared(snapshot, time, plan);
}
