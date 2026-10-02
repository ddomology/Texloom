/**
 * Editable, renderer-independent 2D paths. Coordinates are in local scene bp.
 * No SVG parser, DOM state, or source-package implementation is required here.
 */
export type PathPoint = [number, number];
export type PathMatrix = [number, number, number, number, number, number];
export type PathSegment =
  | { kind: 'line'; id: string; to: PathPoint }
  | { kind: 'cubic'; id: string; c1: PathPoint; c2: PathPoint; to: PathPoint };
export interface PathContour {
  id: string;
  start: PathPoint;
  segments: PathSegment[];
  closed?: boolean;
}
export interface PathGeometry { contours: PathContour[] }
export type PathProgressMode = 'parameter' | 'length';
/** [minimum x, minimum y, width, height], including move-only contour starts. */
export type PathBounds = [number, number, number, number];
export interface PathSample {
  point: PathPoint;
  /** Unit tangent, in the direction of increasing path parameter. */
  tangent: PathPoint;
  contourId: string;
  segmentId: string;
  localParameter: number;
}

export class PathGeometryError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'PathGeometryError';
  }
}

const MAX_DEPTH = 20;
const MAX_SUBDIVISIONS = 131072;
const EPSILON = Number.EPSILON * 32;
const copy = (p: PathPoint): PathPoint => [p[0], p[1]];
const same = (a: PathPoint, b: PathPoint): boolean => a[0] === b[0] && a[1] === b[1];
const distance = (a: PathPoint, b: PathPoint): number => Math.hypot(b[0] - a[0], b[1] - a[1]);

function fail(code: string, message: string): never { throw new PathGeometryError(code, message); }
function finite(value: number, description: string): void {
  if (!Number.isFinite(value)) fail('NONFINITE_GEOMETRY', `${description} must be finite.`);
}
function checkPoint(point: PathPoint, description: string): void {
  if (!Array.isArray(point) || point.length !== 2) fail('INVALID_PATH_GEOMETRY', `${description} must be a pair.`);
  point.forEach(value => finite(value, description));
}
function checkSegment(start: PathPoint, segment: PathSegment): void {
  checkPoint(start, 'Segment start');
  if (!segment || typeof segment.id !== 'string' || segment.id.length === 0) {
    fail('INVALID_PATH_GEOMETRY', 'A segment must have a nonempty ID.');
  }
  if (segment.kind !== 'line' && segment.kind !== 'cubic') {
    fail('INVALID_PATH_GEOMETRY', `Unsupported segment kind ${(segment as PathSegment).kind}.`);
  }
  checkPoint(segment.to, `Segment ${segment.id} endpoint`);
  if (segment.kind === 'cubic') {
    checkPoint(segment.c1, `Segment ${segment.id} first control point`);
    checkPoint(segment.c2, `Segment ${segment.id} second control point`);
  }
}
function checkGeometry(geometry: PathGeometry): void {
  if (!geometry || !Array.isArray(geometry.contours)) fail('INVALID_PATH_GEOMETRY', 'Geometry requires contours.');
  const contourIds = new Set<string>();
  for (const contour of geometry.contours) {
    if (!contour || typeof contour.id !== 'string' || contour.id.length === 0 || !Array.isArray(contour.segments)) {
      fail('INVALID_PATH_GEOMETRY', 'Each contour requires a nonempty ID and a segment array.');
    }
    if (contour.id.includes('.') || contourIds.has(contour.id)) {
      fail('INVALID_PATH_GEOMETRY', 'Contour IDs must be unique and contain no dots.');
    }
    contourIds.add(contour.id);
    if (contour.closed !== undefined && typeof contour.closed !== 'boolean') {
      fail('INVALID_PATH_GEOMETRY', `Contour ${contour.id} closed must be boolean.`);
    }
    let start = contour.start;
    checkPoint(start, `Contour ${contour.id} start`);
    const segmentIds = new Set<string>();
    for (const segment of contour.segments) {
      checkSegment(start, segment);
      if (segment.id.includes('.') || segmentIds.has(segment.id)) {
        fail('INVALID_PATH_GEOMETRY', `Segment IDs in contour ${contour.id} must be unique and contain no dots.`);
      }
      if (contour.closed && segment.id === `${contour.id}:close`) {
        fail('INVALID_PATH_GEOMETRY', `Segment ID ${segment.id} is reserved for the implicit closing edge.`);
      }
      segmentIds.add(segment.id); start = segment.to;
    }
  }
}
function parameter(value: number): number {
  finite(value, 'Path parameter');
  return Math.max(0, Math.min(1, value));
}
function options(mode: PathProgressMode, tolerance: number): void {
  if (mode !== 'parameter' && mode !== 'length') fail('INVALID_PROGRESS_MODE', `Unknown progress mode ${mode}.`);
  if (!Number.isFinite(tolerance) || tolerance <= 0) fail('INVALID_LENGTH_TOLERANCE', 'Arc-length tolerance must be positive and finite.');
}
function lerp(a: PathPoint, b: PathPoint, t: number): PathPoint {
  return [(1 - t) * a[0] + t * b[0], (1 - t) * a[1] + t * b[1]];
}
function cloneSegment(segment: PathSegment): PathSegment {
  return segment.kind === 'line' ? { ...segment, to: copy(segment.to) }
    : { ...segment, c1: copy(segment.c1), c2: copy(segment.c2), to: copy(segment.to) };
}
function cloneGeometry(geometry: PathGeometry): PathGeometry {
  return { contours: geometry.contours.map(contour => ({ ...contour, start: copy(contour.start), segments: contour.segments.map(cloneSegment) })) };
}

function evaluateUnchecked(start: PathPoint, segment: PathSegment, t: number): PathPoint {
  if (segment.kind === 'line') return lerp(start, segment.to, t);
  const a = lerp(start, segment.c1, t), b = lerp(segment.c1, segment.c2, t), c = lerp(segment.c2, segment.to, t);
  return lerp(lerp(a, b, t), lerp(b, c, t), t);
}
/** De Casteljau evaluation. Finite parameters outside [0,1] are clamped. */
export function evaluateSegment(start: PathPoint, segment: PathSegment, t: number): PathPoint {
  checkSegment(start, segment);
  return evaluateUnchecked(start, segment, parameter(t));
}
function derivativeUnchecked(start: PathPoint, segment: PathSegment, t: number): PathPoint {
  if (segment.kind === 'line') return [segment.to[0] - start[0], segment.to[1] - start[1]];
  const s = 1 - t;
  return [0, 1].map(axis => 3 * (
    s * s * (segment.c1[axis] - start[axis]) +
    2 * s * t * (segment.c2[axis] - segment.c1[axis]) +
    t * t * (segment.to[axis] - segment.c2[axis]))) as PathPoint;
}
/** Actual derivative, including [0,0] at stationary points; never normalized. */
export function derivativeSegment(start: PathPoint, segment: PathSegment, t: number): PathPoint {
  checkSegment(start, segment);
  const result = derivativeUnchecked(start, segment, parameter(t));
  checkPoint(result, 'Segment derivative');
  return result;
}
function splitUnchecked(start: PathPoint, segment: PathSegment, t: number): [PathSegment, PathSegment] {
  if (segment.kind === 'line') {
    return [{ ...segment, to: lerp(start, segment.to, t) }, cloneSegment(segment)];
  }
  const a = lerp(start, segment.c1, t), b = lerp(segment.c1, segment.c2, t), c = lerp(segment.c2, segment.to, t);
  const d = lerp(a, b, t), e = lerp(b, c, t), p = lerp(d, e, t);
  return [{ ...segment, c1: a, c2: d, to: p }, { ...segment, c1: e, c2: c, to: copy(segment.to) }];
}
/**
 * Exact De Casteljau split. Right start is left.to. Both independent results
 * retain the original semantic ID; rename them if inserting both as siblings.
 */
export function splitSegment(start: PathPoint, segment: PathSegment, t: number): [PathSegment, PathSegment] {
  checkSegment(start, segment);
  return splitUnchecked(start, segment, parameter(t));
}

/** SVG transport serialization; contour boundaries are always explicit moves. */
export function pathGeometryData(geometry: PathGeometry): string {
  checkGeometry(geometry);
  const point = (p: PathPoint): string => `${p[0] === 0 ? 0 : p[0]} ${p[1] === 0 ? 0 : p[1]}`;
  return geometry.contours.map(contour => [
    `M ${point(contour.start)}`,
    ...contour.segments.map(segment => segment.kind === 'line' ? `L ${point(segment.to)}`
      : `C ${point(segment.c1)} ${point(segment.c2)} ${point(segment.to)}`),
    ...(contour.closed ? ['Z'] : []),
  ].join(' ')).join(' ');
}

/** Roots of a cubic coordinate derivative in the open parameter interval. */
function extrema(p0: number, p1: number, p2: number, p3: number): number[] {
  // Dividing by 3 removes the common derivative coefficient.
  const a = -p0 + 3 * p1 - 3 * p2 + p3, b = 2 * (p0 - 2 * p1 + p2), c = p1 - p0;
  [a, b, c].forEach(value => finite(value, 'Cubic derivative coefficient'));
  const scale = Math.max(Math.abs(a), Math.abs(b), Math.abs(c));
  if (scale === 0) return [];
  const an = a / scale, bn = b / scale, cn = c / scale;
  let roots: number[];
  if (Math.abs(an) <= EPSILON) roots = Math.abs(bn) <= EPSILON ? [] : [-cn / bn];
  else {
    let discriminant = bn * bn - 4 * an * cn;
    if (discriminant < 0 && discriminant > -EPSILON * (bn * bn + Math.abs(4 * an * cn))) discriminant = 0;
    if (discriminant < 0) return [];
    const q = -0.5 * (bn + (bn >= 0 ? 1 : -1) * Math.sqrt(discriminant));
    roots = q === 0 ? [-bn / (2 * an)] : [q / an, cn / q];
  }
  return roots.filter(t => Number.isFinite(t) && t > 0 && t < 1);
}
/** Tight analytic cubic bounds, not control-polygon bounds. Empty input -> null. */
export function geometryBounds(geometry: PathGeometry): PathBounds | null {
  checkGeometry(geometry);
  if (geometry.contours.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const add = (p: PathPoint): void => {
    minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
    minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
  };
  for (const contour of geometry.contours) {
    let start = contour.start; add(start);
    for (const segment of contour.segments) {
      add(segment.to);
      if (segment.kind === 'cubic') {
        for (const axis of [0, 1]) for (const t of extrema(start[axis], segment.c1[axis], segment.c2[axis], segment.to[axis])) {
          add(evaluateUnchecked(start, segment, t));
        }
      }
      start = segment.to;
    }
  }
  const result: PathBounds = [minX, minY, maxX - minX, maxY - minY];
  result.forEach(value => finite(value, 'Path bound'));
  return result;
}

/** Apply an affine transform to actual geometry; contour and segment IDs survive. */
export function transformGeometry(geometry: PathGeometry, matrix: PathMatrix): PathGeometry {
  checkGeometry(geometry);
  if (!Array.isArray(matrix) || matrix.length !== 6) fail('INVALID_PATH_TRANSFORM', 'Path transform requires six affine coefficients.');
  matrix.forEach(value => finite(value, 'Affine coefficient'));
  const transform = (p: PathPoint): PathPoint => {
    const result: PathPoint = [matrix[0] * p[0] + matrix[2] * p[1] + matrix[4], matrix[1] * p[0] + matrix[3] * p[1] + matrix[5]];
    checkPoint(result, 'Transformed point'); return result;
  };
  return { contours: geometry.contours.map(contour => ({ ...contour, start: transform(contour.start), segments: contour.segments.map(segment =>
    segment.kind === 'line' ? { ...segment, to: transform(segment.to) }
      : { ...segment, c1: transform(segment.c1), c2: transform(segment.c2), to: transform(segment.to) }) })) };
}

interface DrawableSegment {
  contourIndex: number;
  segmentIndex: number;
  contourId: string;
  start: PathPoint;
  segment: PathSegment;
  closing: boolean;
}
function isDrawable(start: PathPoint, segment: PathSegment): boolean {
  return !same(start, segment.to) || (segment.kind === 'cubic' && (!same(start, segment.c1) || !same(start, segment.c2)));
}
function drawableSegments(geometry: PathGeometry): DrawableSegment[] {
  const result: DrawableSegment[] = [];
  geometry.contours.forEach((contour, contourIndex) => {
    let start = contour.start;
    contour.segments.forEach((segment, segmentIndex) => {
      if (isDrawable(start, segment)) result.push({ contourIndex, segmentIndex, contourId: contour.id, start, segment, closing: false });
      start = segment.to;
    });
    if (contour.closed && !same(start, contour.start)) {
      result.push({ contourIndex, segmentIndex: contour.segments.length, contourId: contour.id, start,
        segment: { kind: 'line', id: `${contour.id}:close`, to: contour.start }, closing: true });
    }
  });
  return result;
}

/**
 * The true curve length lies between the chord and control polygon lengths.
 * Subdivision divides the absolute-error budget, so summed leaf estimates
 * stay within tolerance. Depth/work limits fail explicitly rather than silently
 * declaring convergence. Straight but non-uniformly parameterized cubics still
 * require length inversion; a single polyline interpolation would be incorrect.
 */
function segmentLength(start: PathPoint, segment: PathSegment, tolerance: number): number {
  if (segment.kind === 'line') {
    const result = distance(start, segment.to); finite(result, 'Line length'); return result;
  }
  let subdivisions = 0;
  const visit = (p: PathPoint, s: PathSegment & { kind: 'cubic' }, budget: number, depth: number): number => {
    const chord = distance(p, s.to), polygon = distance(p, s.c1) + distance(s.c1, s.c2) + distance(s.c2, s.to);
    finite(polygon, 'Cubic control-polygon length');
    if (polygon - chord <= 2 * budget) return (chord + polygon) / 2;
    if (depth === MAX_DEPTH || ++subdivisions > MAX_SUBDIVISIONS) {
      fail('ARC_LENGTH_TOLERANCE', `Segment ${segment.id} cannot meet arc-length tolerance ${tolerance} within the subdivision limit.`);
    }
    const [left, right] = splitUnchecked(p, s, 0.5) as [PathSegment & { kind: 'cubic' }, PathSegment & { kind: 'cubic' }];
    return visit(p, left, budget / 2, depth + 1) + visit(left.to, right, budget / 2, depth + 1);
  };
  return visit(start, segment, tolerance, 0);
}
/** Total arc length; separate contours contribute no connecting distance. */
export function geometryLength(geometry: PathGeometry, tolerance = 0.05): number {
  checkGeometry(geometry); options('length', tolerance);
  const segments = drawableSegments(geometry);
  if (segments.length === 0) return 0;
  const result = segments.reduce((sum, entry) => sum + segmentLength(entry.start, entry.segment, tolerance / segments.length), 0);
  finite(result, 'Path length'); return result;
}

interface Location { index: number; t: number }
function locate(segments: DrawableSegment[], progress: number, mode: PathProgressMode, tolerance: number): Location {
  if (progress === 0) return { index: 0, t: 0 };
  if (progress === 1) return { index: segments.length - 1, t: 1 };
  if (mode === 'parameter') {
    const scaled = progress * segments.length, index = Math.min(segments.length - 1, Math.floor(scaled));
    return { index, t: scaled - index };
  }
  // Reserve most of the requested tolerance for length -> parameter inversion.
  const budget = tolerance / (8 * segments.length);
  const lengths = segments.map(entry => segmentLength(entry.start, entry.segment, budget));
  const total = lengths.reduce((sum, length) => sum + length, 0);
  finite(total, 'Path length');
  if (total <= 0) fail('DEGENERATE_GEOMETRY', 'This path has zero arc length.');
  let index = 0, remaining = progress * total;
  while (index < segments.length - 1 && remaining >= lengths[index]) { remaining -= lengths[index]; index++; }
  if (remaining === 0) return { index, t: 0 };
  const { start, segment } = segments[index];
  if (segment.kind === 'line') return { index, t: remaining / lengths[index] };
  // Partial-curve length is monotone even for collinear nonuniform cubics.
  let lo = 0, hi = 1;
  for (let iteration = 0; iteration < 64; iteration++) {
    const mid = (lo + hi) / 2;
    const [left] = splitUnchecked(start, segment, mid);
    const measured = segmentLength(start, left, budget);
    if (Math.abs(measured - remaining) <= tolerance / 4) return { index, t: mid };
    if (measured < remaining) lo = mid; else hi = mid;
    if (mid === (lo + hi) / 2) break;
  }
  fail('ARC_LENGTH_TOLERANCE', `Segment ${segment.id} cannot invert arc length within tolerance ${tolerance}.`);
}

function unitTangent(start: PathPoint, segment: PathSegment, t: number): PathPoint {
  let derivative = derivativeUnchecked(start, segment, t);
  checkPoint(derivative, `Tangent of ${segment.id}`);
  const points = segment.kind === 'line' ? [segment.to] : [segment.c1, segment.c2, segment.to];
  const scale = Math.max(...points.map(point => distance(start, point)));
  let norm = Math.hypot(...derivative);
  if (norm <= scale * EPSILON) {
    // One-sided endpoint limit: first nonzero endpoint control secant. This
    // correctly handles common cubic easing handles coincident with endpoints.
    const candidates: PathPoint[] = t === 0 ? points.map(p => [p[0] - start[0], p[1] - start[1]])
      : t === 1 ? (segment.kind === 'line' ? [start] : [segment.c2, segment.c1, start]).map(p => [segment.to[0] - p[0], segment.to[1] - p[1]])
        : [];
    const fallback = candidates.find(vector => Math.hypot(...vector) > scale * EPSILON);
    if (!fallback) fail('UNDEFINED_TANGENT', `Segment ${segment.id} has no defined tangent at parameter ${t}; stationary interior points require an explicit direction.`);
    derivative = fallback; norm = Math.hypot(...derivative);
  }
  if (!Number.isFinite(norm) || norm === 0) fail('UNDEFINED_TANGENT', `Segment ${segment.id} has no finite tangent.`);
  return [derivative[0] / norm, derivative[1] / norm];
}

/**
 * Progress is clamped to [0,1]. Parameter mode allocates equal time to each
 * nondegenerate segment, including a nonzero implicit closing edge. Length mode
 * uses absolute local-bp tolerance. Boundaries choose the following segment;
 * progress=1 chooses the last endpoint. There is never travel between contours.
 * An implicit closing edge has semantic ID `${contour.id}:close`.
 * Interior stationary points throw UNDEFINED_TANGENT (no arbitrary cusp side).
 */
export function sampleGeometry(geometry: PathGeometry, progress: number, mode: PathProgressMode = 'parameter', tolerance = 0.05): PathSample {
  checkGeometry(geometry); options(mode, tolerance);
  const normalized = parameter(progress), segments = drawableSegments(geometry);
  if (segments.length === 0) fail(geometry.contours.length === 0 ? 'EMPTY_GEOMETRY' : 'DEGENERATE_GEOMETRY', 'Path sampling requires at least one nondegenerate segment.');
  const location = locate(segments, normalized, mode, tolerance), entry = segments[location.index];
  return { point: evaluateUnchecked(entry.start, entry.segment, location.t), tangent: unitTangent(entry.start, entry.segment, location.t),
    contourId: entry.contourId, segmentId: entry.segment.id, localParameter: location.t };
}

/**
 * Return a genuine prefix path, not a stroke-dash approximation. Exact cubic
 * splitting preserves shape. No connector is inserted between contours, and a
 * partial closed contour is explicitly open until its closing edge is finished.
 * Zero progress has move-only output, including for all-degenerate geometry.
 */
export function revealGeometry(geometry: PathGeometry, progress: number, mode: PathProgressMode = 'parameter', tolerance = 0.05): PathGeometry {
  checkGeometry(geometry); options(mode, tolerance);
  const normalized = parameter(progress);
  if (normalized === 1) return cloneGeometry(geometry);
  if (geometry.contours.length === 0) return { contours: [] };
  const segments = drawableSegments(geometry);
  if (normalized === 0 || segments.length === 0) return { contours: [{ id: geometry.contours[0].id, start: copy(geometry.contours[0].start), segments: [], closed: false }] };
  const location = locate(segments, normalized, mode, tolerance), entry = segments[location.index];
  const contours = geometry.contours.slice(0, entry.contourIndex).map(contour => ({ ...contour, start: copy(contour.start), segments: contour.segments.map(cloneSegment) }));
  const source = geometry.contours[entry.contourIndex];
  const partial: PathContour = { id: source.id, start: copy(source.start), segments: source.segments.slice(0, entry.segmentIndex).map(cloneSegment), closed: false };
  if (location.t > 0) partial.segments.push(splitUnchecked(entry.start, entry.segment, location.t)[0]);
  contours.push(partial);
  return { contours };
}
