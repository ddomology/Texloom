import { BundleValidationError, type Matrix, type Node, type ResolvedPath, type Transform } from './schema.js';

export type Point = [number, number];
export const identityMatrix = (): Matrix => [1, 0, 0, 1, 0, 0];

/** SVG affine convention: result applies b first, then a. */
export function multiplyMatrix(a: Matrix, b: Matrix): Matrix {
  return [a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1],
    a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3],
    a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5]];
}
/** Matches renderer order translate · rotate · scale. Angles are radians. */
export function localMatrix(transform?: Transform): Matrix {
  const [x, y] = transform?.translate ?? [0, 0];
  const [sx, sy] = transform?.scale ?? [1, 1];
  const angle = transform?.rotate ?? 0, c = Math.cos(angle), s = Math.sin(angle);
  return [c*sx, s*sx, -s*sy, c*sy, x, y];
}
export function transformPoint(m: Matrix, p: Point): Point {
  return [m[0]*p[0]+m[2]*p[1]+m[4], m[1]*p[0]+m[3]*p[1]+m[5]];
}
export function transformVector(m: Matrix, p: Point): Point {
  return [m[0]*p[0]+m[2]*p[1], m[1]*p[0]+m[3]*p[1]];
}
export function geometryError(code: string, message: string): never {
  throw new BundleValidationError([{ severity: 'error', code, message }]);
}
export function inverseMatrix(m: Matrix, context = 'coordinate transform'): Matrix {
  const det = m[0]*m[3]-m[1]*m[2];
  if (!Number.isFinite(det) || det === 0) geometryError('SINGULAR_TRANSFORM', `Cannot invert ${context}.`);
  const result: Matrix = [m[3]/det, -m[1]/det, -m[2]/det, m[0]/det,
    (m[2]*m[5]-m[3]*m[4])/det, (m[1]*m[4]-m[0]*m[5])/det];
  if (!result.every(Number.isFinite)) geometryError('SINGULAR_TRANSFORM', `Inverse of ${context} is not finite.`);
  return result;
}
/** World geometry is independent of the viewing camera. */
export function worldMatrix(id: string | undefined, nodes: ReadonlyMap<string, Node>): Matrix {
  if (id === undefined) return identityMatrix();
  const chain: Node[] = [], seen = new Set<string>();
  let next: string | undefined = id;
  while (next !== undefined) {
    if (seen.has(next)) geometryError('PARENT_CYCLE', `Transform hierarchy cycles at ${next}.`);
    seen.add(next);
    const node = nodes.get(next);
    if (!node) geometryError('NODE_REFERENCE', `Missing transform node ${next}.`);
    chain.push(node); next = node.parent;
  }
  let result = identityMatrix();
  for (let i = chain.length-1; i >= 0; --i) result = multiplyMatrix(result, localMatrix(chain[i].transform));
  if (!result.every(Number.isFinite)) geometryError('NONFINITE_GEOMETRY', `Transform of ${id} is not finite.`);
  return result;
}
export function transformPath(m: Matrix, path: ResolvedPath): ResolvedPath {
  return { start: transformPoint(m, path.start), c1: transformPoint(m, path.c1),
    c2: transformPoint(m, path.c2), end: transformPoint(m, path.end) };
}
export function pathPoint(path: ResolvedPath, t: number): Point {
  const v = 1-t;
  return [0, 1].map(i => v*v*v*path.start[i]+3*v*v*t*path.c1[i]+3*v*t*t*path.c2[i]+t*t*t*path.end[i]) as Point;
}
export function pathTangent(path: ResolvedPath, t: number): Point {
  const v = 1-t;
  const derivative = [0, 1].map(i => 3*v*v*(path.c1[i]-path.start[i])+6*v*t*(path.c2[i]-path.c1[i])+3*t*t*(path.end[i]-path.c2[i])) as Point;
  return Math.hypot(...derivative) > 1e-12 ? derivative : [path.end[0]-path.start[0], path.end[1]-path.start[1]];
}
export function pathData(path: ResolvedPath): string {
  const values = [...path.start, ...path.c1, ...path.c2, ...path.end];
  if (!values.every(Number.isFinite)) geometryError('NONFINITE_GEOMETRY', 'Connection coordinates must be finite.');
  return `M ${path.start.join(' ')} C ${path.c1.join(' ')} ${path.c2.join(' ')} ${path.end.join(' ')}`;
}
