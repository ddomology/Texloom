import type {Bundle, EllipseNode, GroupNode, LineNode, Node, PathNode, PointNode, Relation, ResolvedPath, TexNode, VectorResource} from '../../schema.js';
import {geometryError, inverseMatrix, localMatrix, multiplyMatrix, pathData, pathPoint, pathTangent, transformPath, transformPoint, transformVector, worldMatrix, type Point} from '../../geometry.js';
import {PathGeometryError, sampleGeometry} from '../../path-geometry.js';

/** Per-frame mutable state for the internal compatibility operators. */
export interface LegacyFrameContext {
  nodes: Map<string, Node>;
  resources: Bundle['resources'];
  samples: Map<string, {source: string; tangent: Point}>;
}

export interface LegacyOperator {
  name: string;
  version: 1;
  execute: (relation: Relation, context: LegacyFrameContext) => void;
}

/** Preserve the diagnostic boundary used by legacy path evaluation. */
export function withPathContext<T>(id: string, fn: () => T): T {
  try { return fn(); }
  catch (error) {
    if (error instanceof PathGeometryError) geometryError(error.code, `Path ${id}: ${error.message}`);
    throw error;
  }
}

type RelationOf<T extends Relation['type']> = Extract<Relation, {type: T}>;

function pointOnPath(relation: RelationOf<'pointOnPath'>, {nodes, samples}: LegacyFrameContext): void {
  const path=nodes.get(relation.source) as PathNode, point=nodes.get(relation.target) as PointNode;
  const sample=withPathContext(path.id,()=>sampleGeometry(path.geometry!,point.progress??0,
    relation.mode??'parameter',relation.tolerance??path.pathTolerance??.05));
  const world=transformPoint(worldMatrix(path.id,nodes),sample.point);
  const local=transformPoint(inverseMatrix(worldMatrix(point.id,nodes),`point ${point.id}`),world);
  if(!local.every(Number.isFinite))geometryError('NONFINITE_GEOMETRY',`Point ${point.id} position is not finite.`);
  [point.x,point.y]=local;
  samples.set(point.id,{source:path.id,tangent:sample.tangent});
}

function pathDirection(relation: RelationOf<'pathDirection'>, {nodes, samples}: LegacyFrameContext): void {
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
}

function pointOnEllipse(relation: RelationOf<'pointOnEllipse'>, {nodes}: LegacyFrameContext): void {
  const ellipse = nodes.get(relation.source) as EllipseNode, point = nodes.get(relation.target) as PointNode;
  const phase = point.phase ?? 0;
  point.x = ellipse.cx + ellipse.rx * Math.cos(phase); point.y = ellipse.cy + ellipse.ry * Math.sin(phase);
}

function tangent(relation: RelationOf<'tangent'>, {nodes}: LegacyFrameContext): void {
  const ellipse = nodes.get(relation.source) as EllipseNode, point = nodes.get(relation.point) as PointNode, line = nodes.get(relation.target) as LineNode;
  const phase = point.phase ?? 0;
  // Analytic derivative remains perpendicular to the ellipse normal when radii change.
  const dx = -ellipse.rx * Math.sin(phase), dy = ellipse.ry * Math.cos(phase);
  const magnitude = Math.hypot(dx, dy), half = relation.length / (2 * magnitude);
  const x = ellipse.cx + ellipse.rx * Math.cos(phase), y = ellipse.cy + ellipse.ry * Math.sin(phase);
  line.x1 = x - dx * half; line.y1 = y - dy * half; line.x2 = x + dx * half; line.y2 = y + dy * half;
}

function attach(relation: RelationOf<'attach'>, {nodes}: LegacyFrameContext): void {
  const source = nodes.get(relation.source) as PointNode, target = nodes.get(relation.target) as TexNode;
  target.x = source.x + relation.offset[0]; target.y = source.y + relation.offset[1];
}

function lineBetween(relation: RelationOf<'lineBetween'>, {nodes}: LegacyFrameContext): void {
  const a = nodes.get(relation.a) as PointNode, b = nodes.get(relation.b) as PointNode, line = nodes.get(relation.target) as LineNode;
  line.x1 = a.x; line.y1 = a.y; line.x2 = b.x; line.y2 = b.y;
}

function connect(relation: RelationOf<'connect'>, {nodes}: LegacyFrameContext): void {
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
}

function pathLabel(relation: RelationOf<'pathLabel'>, {nodes, resources}: LegacyFrameContext): void {
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

/** Register typed kernels without adding another relation-dispatch branch. */
function operator<T extends Relation['type']>(
  type: T, name: string,
  execute: (relation: RelationOf<T>, context: LegacyFrameContext) => void,
): LegacyOperator {
  return Object.freeze({name, version: 1 as const, execute(relation: Relation, context: LegacyFrameContext): void {
    if (relation.type !== type) throw new TypeError(`Operator ${name} requires relation ${type}, received ${relation.type}.`);
    execute(relation as RelationOf<T>, context);
  }});
}

// These adapters are internal frame-mutating operators, not public plugins.
const registry: Readonly<Record<Relation['type'], LegacyOperator>> = Object.freeze({
  pointOnPath: operator('pointOnPath', 'texloom.pointOnPath', pointOnPath),
  pathDirection: operator('pathDirection', 'texloom.pathDirection', pathDirection),
  connect: operator('connect', 'texloom.connect', connect),
  pointOnEllipse: operator('pointOnEllipse', 'legacy.pointOnEllipse', pointOnEllipse),
  tangent: operator('tangent', 'legacy.tangent', tangent),
  attach: operator('attach', 'legacy.attach', attach),
  lineBetween: operator('lineBetween', 'legacy.lineBetween', lineBetween),
  pathLabel: operator('pathLabel', 'legacy.pathLabel', pathLabel),
});

export function getLegacyOperator(type: Relation['type']): LegacyOperator {
  if (!Object.prototype.hasOwnProperty.call(registry, type)) throw new TypeError(`Unsupported relation type: ${type}`);
  return registry[type];
}

export function executeLegacyOperation(relation: Relation, context: LegacyFrameContext): void {
  getLegacyOperator(relation.type).execute(relation, context);
}
