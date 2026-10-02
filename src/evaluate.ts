import { assertBundle, relationSources, type Bundle, type Camera, type EllipseNode, type EvaluatedFrame, type FieldNode, type GroupNode, type LineNode, type Node, type PathNode, type PointNode, type Relation, type ResolvedPath, type ScalarFieldResource, type TexNode, type Track, type TrackValue, type VectorResource } from './schema.js';
import { geometryError, inverseMatrix, localMatrix, multiplyMatrix, pathData, pathPoint, pathTangent, transformPath, transformPoint, transformVector, worldMatrix, type Point } from './geometry.js';
import {geometryPointSlot} from './path-contract.js';
import {PathGeometryError, pathGeometryData, revealGeometry, sampleGeometry, type PathPoint} from './path-geometry.js';

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
function relationOrder(relations: Relation[], nodes: Node[]): Relation[] {
  const byTarget = new Map(relations.map(r => [r.target, r]));
  const byId = new Map(nodes.map(n => [n.id, n]));
  const result: Relation[] = [], done = new Set<string>();
  const visit = (id: string) => {
    if (done.has(id)) return;
    const parent = byId.get(id)?.parent;
    if (parent !== undefined) visit(parent);
    const r = byTarget.get(id);
    if (r) for (const source of relationSources(r)) visit(source);
    done.add(id); if (r) result.push(r);
  };
  for (const relation of relations) visit(relation.target);
  return result;
}
interface SampledPath { source: string; tangent: Point }
function withPathContext<T>(id:string, fn:()=>T):T {
  try { return fn(); }
  catch(error) {
    if(error instanceof PathGeometryError) geometryError(error.code,`Path ${id}: ${error.message}`);
    throw error;
  }
}
function applyRelation(relation: Relation, nodes: Map<string, Node>, resources: Bundle['resources'], samples:Map<string,SampledPath>): void {
  if(relation.type==='pointOnPath') {
    const path=nodes.get(relation.source) as PathNode, point=nodes.get(relation.target) as PointNode;
    const sample=withPathContext(path.id,()=>sampleGeometry(path.geometry!,point.progress??0,
      relation.mode??'parameter',relation.tolerance??path.pathTolerance??.05));
    const world=transformPoint(worldMatrix(path.id,nodes),sample.point);
    const local=transformPoint(inverseMatrix(worldMatrix(point.id,nodes),`point ${point.id}`),world);
    if(!local.every(Number.isFinite))geometryError('NONFINITE_GEOMETRY',`Point ${point.id} position is not finite.`);
    [point.x,point.y]=local;
    samples.set(point.id,{source:path.id,tangent:sample.tangent});
  } else if(relation.type==='pathDirection') {
    const path=nodes.get(relation.source) as PathNode, point=nodes.get(relation.point) as PointNode,
      line=nodes.get(relation.target) as LineNode;
    const sample=samples.get(point.id)!;
    const tangent=transformVector(worldMatrix(path.id,nodes),sample.tangent), size=Math.hypot(...tangent);
    if(!Number.isFinite(size)||size===0)geometryError('DEGENERATE_TANGENT',`Path ${path.id} has no finite world tangent at ${point.id}.`);
    const unit:Point=relation.normal?[-tangent[1]/size,tangent[0]/size]:[tangent[0]/size,tangent[1]/size];
    const center=transformPoint(worldMatrix(point.id,nodes),[point.x,point.y]);
    const inverse=inverseMatrix(worldMatrix(line.id,nodes),`direction ${line.id}`), half=relation.length/2;
    const a=transformPoint(inverse,[center[0]-half*unit[0],center[1]-half*unit[1]]);
    const b=transformPoint(inverse,[center[0]+half*unit[0],center[1]+half*unit[1]]);
    if(![...a,...b].every(Number.isFinite))geometryError('NONFINITE_GEOMETRY',`Direction ${line.id} endpoints are not finite.`);
    [line.x1,line.y1]=a; [line.x2,line.y2]=b;
  } else if (relation.type === 'pointOnEllipse') {
    const ellipse = nodes.get(relation.source) as EllipseNode, point = nodes.get(relation.target) as PointNode;
    const phase = point.phase ?? 0;
    point.x = ellipse.cx + ellipse.rx * Math.cos(phase); point.y = ellipse.cy + ellipse.ry * Math.sin(phase);
  } else if (relation.type === 'tangent') {
    const ellipse = nodes.get(relation.source) as EllipseNode, point = nodes.get(relation.point) as PointNode, line = nodes.get(relation.target) as LineNode;
    const phase = point.phase ?? 0;
    // Analytic derivative remains perpendicular to the ellipse normal when radii change.
    const dx = -ellipse.rx * Math.sin(phase), dy = ellipse.ry * Math.cos(phase);
    const magnitude = Math.hypot(dx, dy), half = relation.length / (2 * magnitude);
    const x = ellipse.cx + ellipse.rx * Math.cos(phase), y = ellipse.cy + ellipse.ry * Math.sin(phase);
    line.x1 = x - dx * half; line.y1 = y - dy * half; line.x2 = x + dx * half; line.y2 = y + dy * half;
  } else if (relation.type === 'attach') {
    const source = nodes.get(relation.source) as PointNode, target = nodes.get(relation.target) as TexNode;
    target.x = source.x + relation.offset[0]; target.y = source.y + relation.offset[1];
  } else if (relation.type === 'lineBetween') {
    const a = nodes.get(relation.a) as PointNode, b = nodes.get(relation.b) as PointNode, line = nodes.get(relation.target) as LineNode;
    line.x1 = a.x; line.y1 = a.y; line.x2 = b.x; line.y2 = b.y;
  } else if (relation.type === 'connect') {
    const target = nodes.get(relation.target) as PathNode;
    // The authoring contract measures bend in target-parent coordinates. World
    // anchors are first converted there, then the finished path is lowered into
    // target-local geometry so an arbitrary target transform is applied once.
    const parentInverse = inverseMatrix(worldMatrix(target.parent, nodes), `parent space of ${target.id}`);
    const anchor = (ref: { node: string; anchor: string }): Point => {
      const owner = nodes.get(ref.node) as GroupNode;
      const position = owner.anchors![ref.anchor];
      return transformPoint(multiplyMatrix(parentInverse, worldMatrix(owner.id, nodes)), position);
    };
    const start = anchor(relation.from), end = anchor(relation.to);
    const dx = end[0]-start[0], dy = end[1]-start[1], distance = Math.hypot(dx, dy);
    if (distance === 0 && (target.arrowStart || target.arrowEnd || relation.bend)) geometryError('CONNECT_DEGENERATE', `Connection ${target.id} has coincident endpoints and no defined direction.`);
    const bend = relation.bend ?? 0;
    const normal: Point = distance ? [-dy/distance, dx/distance] : [0, 0];
    const parentPath: ResolvedPath = {
      start, end,
      c1: [start[0]+dx/3+normal[0]*bend, start[1]+dy/3+normal[1]*bend],
      c2: [start[0]+2*dx/3+normal[0]*bend, start[1]+2*dy/3+normal[1]*bend],
    };
    target.resolvedPath = transformPath(inverseMatrix(localMatrix(target.transform), `local transform of ${target.id}`), parentPath);
    target.d = pathData(target.resolvedPath);
  } else if (relation.type === 'pathLabel') {
    const target = nodes.get(relation.target) as TexNode, path = nodes.get(relation.path) as PathNode;
    if (!path.resolvedPath) geometryError('PATH_LABEL_GEOMETRY', `Label ${target.id} requires evaluated path geometry on ${path.id}.`);
    const pathToParent = multiplyMatrix(inverseMatrix(worldMatrix(target.parent, nodes), `parent space of ${target.id}`), worldMatrix(path.id, nodes));
    const parentPath = transformPath(pathToParent, path.resolvedPath);
    const position = pathPoint(parentPath, relation.position), tangent = pathTangent(parentPath, relation.position);
    const length = Math.hypot(...tangent);
    if (!length) geometryError('PATH_LABEL_TANGENT', `Label ${target.id} has no defined path tangent.`);
    const center: Point = [position[0]-tangent[1]/length*relation.offset, position[1]+tangent[0]/length*relation.offset];
    if (relation.rotate) {
      target.transform ??= {};
      // Match the tangent even for a reflected local x axis. A label's baseline
      // follows the path in its parent's coordinate space, not camera space.
      const reflected = (target.transform.scale?.[0] ?? 1) < 0 ? Math.PI : 0;
      target.transform.rotate = Math.atan2(tangent[1], tangent[0])-reflected;
    }
    const localCenter = transformPoint(inverseMatrix(localMatrix(target.transform), `local transform of ${target.id}`), center);
    const metrics = (resources[target.resourceId] as VectorResource).metrics, scale = target.scale ?? 1;
    // Vector resources have baseline origin (0,0); their logical center is
    // (width/2, (depth-height)/2). Ink bounds deliberately do not set placement.
    target.x = localCenter[0]-metrics.width*scale/2;
    target.y = localCenter[1]-(metrics.depth-metrics.height)*scale/2;
    if (![target.x, target.y].every(Number.isFinite)) geometryError('NONFINITE_GEOMETRY', `Label ${target.id} position is not finite.`);
  }
}
function sampleField(resource: ScalarFieldResource, time: number): number[] {
  const [a, b, t] = interval(resource.times, time);
  return mix(resource.samples[a], resource.samples[b], resource.interpolation === 'step' ? 0 : t) as number[];
}
function evaluateValidated(bundle: Bundle, time: number, ordered: Relation[]): EvaluatedFrame {
  if (!Number.isFinite(time)) throw new RangeError('Evaluation time must be finite.');
  const clamped = Math.max(0, Math.min(bundle.duration, time));
  const nodes = structuredClone(bundle.nodes), camera = structuredClone(bundle.camera);
  const byId = new Map(nodes.map(n => [n.id, n]));
  for (const track of bundle.tracks) setValue(track.target === '$camera' ? camera : byId.get(track.target)!, track.property, trackValue(track, clamped));
  const samples=new Map<string,SampledPath>();
  for (const relation of ordered) applyRelation(relation, byId, bundle.resources,samples);
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
  assertBundle(bundle);
  return evaluateValidated(bundle, time, relationOrder(bundle.relations, bundle.nodes));
}
function freezeDeep(value: any): void {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value); for (const child of Object.values(value)) freezeDeep(child);
  }
}
/** Validate and snapshot once for playback/export; seeking has no playback-history state. */
export function createEvaluator(bundle: Bundle): (time: number) => EvaluatedFrame {
  assertBundle(bundle);
  const snapshot = structuredClone(bundle);
  freezeDeep(snapshot);
  const ordered = relationOrder(snapshot.relations, snapshot.nodes);
  return time => evaluateValidated(snapshot, time, ordered);
}
