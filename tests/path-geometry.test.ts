import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PathGeometryError, derivativeSegment, evaluateSegment, geometryBounds,
  geometryLength, pathGeometryData, revealGeometry, sampleGeometry,
  splitSegment, transformGeometry,
  type PathGeometry, type PathPoint, type PathSegment,
} from '../src/path-geometry.js';

const close = (actual: number, expected: number, tolerance = 1e-9): void => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected} by more than ${tolerance}`);
};
const pointClose = (actual: PathPoint, expected: PathPoint, tolerance = 1e-9): void => {
  close(actual[0], expected[0], tolerance); close(actual[1], expected[1], tolerance);
};
const single = (start: PathPoint, segment: PathSegment, closed = false): PathGeometry => ({
  contours: [{ id: 'curve', start, segments: [segment], closed }],
});
const arch: PathSegment = { kind: 'cubic', id: 'arch', c1: [0, 100], c2: [100, 100], to: [100, 0] };
const archGeometry = single([0, 0], arch);
const hasCode = (code: string) => (error: unknown): boolean => error instanceof PathGeometryError && error.code === code;

test('cubic evaluation and derivative use the true Bernstein curve', () => {
  pointClose(evaluateSegment([0, 0], arch, 0.5), [50, 75]);
  pointClose(derivativeSegment([0, 0], arch, 0.5), [150, 0]);
  pointClose(derivativeSegment([0, 0], arch, 0), [0, 300]);
  pointClose(evaluateSegment([0, 0], arch, -2), [0, 0]);
  pointClose(evaluateSegment([0, 0], arch, 2), [100, 0]);
});

test('cubic subdivision reproduces both original parameter intervals and retains IDs', () => {
  const splitAt = 0.37, [left, right] = splitSegment([0, 0], arch, splitAt);
  assert.equal(left.id, 'arch'); assert.equal(right.id, 'arch');
  for (let i = 0; i <= 20; i++) {
    const t = i / 20;
    pointClose(evaluateSegment([0, 0], left, t), evaluateSegment([0, 0], arch, t * splitAt), 1e-12);
    pointClose(evaluateSegment(left.to, right, t), evaluateSegment([0, 0], arch, splitAt + t * (1 - splitAt)), 1e-12);
  }
  const leftDerivative = derivativeSegment([0, 0], left, 1), rightDerivative = derivativeSegment(left.to, right, 0);
  pointClose([leftDerivative[0] / splitAt, leftDerivative[1] / splitAt], [rightDerivative[0] / (1 - splitAt), rightDerivative[1] / (1 - splitAt)]);
});

test('line and endpoint splits have exact endpoints without mutating inputs', () => {
  const line: PathSegment = { kind: 'line', id: 'line', to: [12, 8] }, before = structuredClone(line);
  const [left, right] = splitSegment([2, 3], line, 0.2);
  pointClose(left.to, [4, 4]); pointClose(right.to, [12, 8]);
  assert.deepEqual(line, before);
  const [empty, complete] = splitSegment([0, 0], arch, 0);
  pointClose(empty.to, [0, 0]); assert.deepEqual(complete, arch);
  const [completeEnd, emptyEnd] = splitSegment([0, 0], arch, 1);
  assert.deepEqual(completeEnd, arch); pointClose(emptyEnd.to, [100, 0]);
});

test('bounds solve cubic extrema instead of bounding control handles', () => {
  assert.deepEqual(geometryBounds(archGeometry), [0, 0, 100, 75]);
  const bounds = geometryBounds(single([0, 0], { kind: 'cubic', id: 'wiggle', c1: [10, 0], c2: [-10, 0], to: [0, 0] }))!;
  close(bounds[0], -5 / Math.sqrt(3)); close(bounds[2], 10 / Math.sqrt(3));
  close(bounds[1], 0); close(bounds[3], 0);
  assert.equal(geometryBounds({ contours: [] }), null);
  assert.deepEqual(geometryBounds({ contours: [{ id: 'move', start: [-4, 7], segments: [] }] }), [-4, 7, 0, 0]);
});

test('bounds include quadratic derivative degeneracy and every contour', () => {
  // Cubic with zero cubic coefficient: x(t)=3t-3t² peaks at 3/4.
  const geometry = single([0, 0], { kind: 'cubic', id: 'quadratic', c1: [1, 1], c2: [1, 2], to: [0, 3] });
  assert.deepEqual(geometryBounds(geometry), [0, 0, 0.75, 3]);
  geometry.contours.push({ id: 'move', start: [-10, 8], segments: [] });
  assert.deepEqual(geometryBounds(geometry), [-10, 0, 10.75, 8]);
});

test('serialization keeps distinct contours and never inserts connecting segments', () => {
  const geometry: PathGeometry = { contours: [
    { id: 'a', start: [0, 0], segments: [{ kind: 'line', id: 'a1', to: [10, 0] }], closed: true },
    { id: 'b', start: [1000, 1000], segments: [{ kind: 'line', id: 'b1', to: [1000, 1010] }] },
  ] };
  assert.equal(pathGeometryData(geometry), 'M 0 0 L 10 0 Z M 1000 1000 L 1000 1010');
  close(geometryLength(geometry), 30);
  pointClose(sampleGeometry(geometry, 2 / 3).point, [1000, 1000]);
  assert.equal(sampleGeometry(geometry, 0.5).segmentId, 'a:close');
});

test('parameter sampling is right-continuous at boundaries and includes implicit closure', () => {
  const geometry: PathGeometry = { contours: [{ id: 'triangle', start: [0, 0], closed: true, segments: [
    { kind: 'line', id: 'right', to: [10, 0] }, { kind: 'line', id: 'up', to: [10, 10] },
  ] }] };
  const boundary = sampleGeometry(geometry, 1 / 3);
  assert.equal(boundary.segmentId, 'up'); close(boundary.localParameter, 0);
  pointClose(boundary.tangent, [0, 1]);
  const closing = sampleGeometry(geometry, 5 / 6);
  assert.equal(closing.segmentId, 'triangle:close'); pointClose(closing.point, [5, 5]);
  pointClose(closing.tangent, [-Math.SQRT1_2, -Math.SQRT1_2]);
  pointClose(sampleGeometry(geometry, 1).point, [0, 0]);
  close(geometryLength(geometry), 20 + Math.sqrt(200));
});

test('coincident closing endpoint adds no phantom parameter interval', () => {
  const geometry: PathGeometry = { contours: [{ id: 'back', start: [0, 0], closed: true, segments: [
    { kind: 'line', id: 'out', to: [10, 0] }, { kind: 'line', id: 'back', to: [0, 0] },
  ] }] };
  assert.equal(sampleGeometry(geometry, 0.75).segmentId, 'back');
  pointClose(sampleGeometry(geometry, 0.75).point, [5, 0]);
});

test('arc length integrates a curved arch with a known exact length', () => {
  // For this symmetric cubic the speed is 300(2t² - 2t + 1), integral 200.
  close(geometryLength(archGeometry, 1e-5), 200, 1e-5);
  const lengthAtQuarter = sampleGeometry(archGeometry, 0.25, 'length', 1e-5);
  const t = lengthAtQuarter.localParameter;
  close(200 * t ** 3 - 300 * t ** 2 + 300 * t, 50, 1e-5);
  pointClose(lengthAtQuarter.point, evaluateSegment([0, 0], arch, t));
  close(Math.hypot(...lengthAtQuarter.tangent), 1);
});

test('length inversion handles collinear cubics with nonuniform speed', () => {
  const geometry = single([0, 0], { kind: 'cubic', id: 'ease', c1: [0, 0], c2: [0, 0], to: [100, 0] });
  close(geometryLength(geometry), 100);
  const sample = sampleGeometry(geometry, 0.5, 'length', 1e-8);
  close(sample.localParameter, Math.cbrt(0.5), 1e-9);
  pointClose(sample.point, [50, 0], 1e-8);
  pointClose(sampleGeometry(geometry, 0.5, 'parameter').point, [12.5, 0]);
});

test('length mode allocates unequal segments by distance without contour travel', () => {
  const geometry: PathGeometry = { contours: [
    { id: 'short', start: [0, 0], segments: [{ kind: 'line', id: 'short-line', to: [10, 0] }] },
    { id: 'long', start: [1000, 0], segments: [{ kind: 'line', id: 'long-line', to: [1090, 0] }] },
  ] };
  pointClose(sampleGeometry(geometry, 0.1, 'length').point, [1000, 0]);
  pointClose(sampleGeometry(geometry, 0.5, 'length').point, [1040, 0]);
  close(geometryLength(geometry), 100);
});

test('reveal starts without ink and splits the actual cubic', () => {
  const before = structuredClone(archGeometry);
  assert.equal(pathGeometryData(revealGeometry(archGeometry, 0)), 'M 0 0');
  const half = revealGeometry(archGeometry, 0.5);
  pointClose(half.contours[0].segments[0].to, [50, 75]);
  assert.equal(half.contours[0].segments[0].id, 'arch');
  const partial = half.contours[0].segments[0];
  for (let i = 0; i <= 10; i++) pointClose(evaluateSegment([0, 0], partial, i / 10), evaluateSegment([0, 0], arch, i / 20));
  assert.deepEqual(revealGeometry(archGeometry, 1), archGeometry);
  assert.deepEqual(archGeometry, before);
  const complete = revealGeometry(archGeometry, 1); complete.contours[0].start[0] = 100;
  assert.equal(archGeometry.contours[0].start[0], 0);
});

test('partial closed contours reveal the closing edge without premature Z', () => {
  const geometry = single([0, 0], { kind: 'line', id: 'out', to: [10, 0] }, true);
  assert.equal(pathGeometryData(revealGeometry(geometry, 0)), 'M 0 0');
  assert.equal(pathGeometryData(revealGeometry(geometry, 0.25)), 'M 0 0 L 5 0');
  assert.equal(pathGeometryData(revealGeometry(geometry, 0.75)), 'M 0 0 L 10 0 L 5 0');
  assert.equal(revealGeometry(geometry, 0.75).contours[0].segments[1].id, 'curve:close');
  assert.equal(pathGeometryData(revealGeometry(geometry, 1)), 'M 0 0 L 10 0 Z');
});

test('reveal across contours preserves completed closure and starts the next with a move', () => {
  const geometry: PathGeometry = { contours: [
    { id: 'a', start: [0, 0], segments: [{ kind: 'line', id: 'a1', to: [10, 0] }], closed: true },
    { id: 'b', start: [100, 0], segments: [{ kind: 'line', id: 'b1', to: [110, 0] }] },
  ] };
  assert.equal(pathGeometryData(revealGeometry(geometry, 2 / 3)), 'M 0 0 L 10 0 Z M 100 0');
  assert.equal(pathGeometryData(revealGeometry(geometry, 5 / 6)), 'M 0 0 L 10 0 Z M 100 0 L 105 0');
});

test('length reveal shares sample location and meets distance tolerance', () => {
  const progress = 0.27, tolerance = 1e-5;
  const revealed = revealGeometry(archGeometry, progress, 'length', tolerance);
  pointClose(revealed.contours[0].segments.at(-1)!.to, sampleGeometry(archGeometry, progress, 'length', tolerance).point);
  close(geometryLength(revealed, tolerance), 200 * progress, tolerance * 2);
});

test('endpoint tangent fallback follows the first noncoincident control secant', () => {
  const geometry = single([0, 0], { kind: 'cubic', id: 'flat-ends', c1: [0, 0], c2: [10, 10], to: [10, 10] });
  pointClose(sampleGeometry(geometry, 0).tangent, [Math.SQRT1_2, Math.SQRT1_2]);
  pointClose(sampleGeometry(geometry, 1).tangent, [Math.SQRT1_2, Math.SQRT1_2]);
  pointClose(derivativeSegment([0, 0], geometry.contours[0].segments[0], 0), [0, 0]);
});

test('interior stationary cusp is an explicit diagnostic rather than a guessed tangent', () => {
  const cusp = single([0, 0], { kind: 'cubic', id: 'cusp', c1: [1, 0], c2: [1, 0], to: [0, 0] });
  pointClose(evaluateSegment([0, 0], cusp.contours[0].segments[0], 0.5), [0.75, 0]);
  assert.throws(() => sampleGeometry(cusp, 0.5), hasCode('UNDEFINED_TANGENT'));
  // Drawing/revealing at the same cusp remains perfectly valid.
  pointClose(revealGeometry(cusp, 0.5).contours[0].segments[0].to, [0.75, 0]);
});

test('empty and degenerate paths draw harmlessly, sampling reports clear diagnostics', () => {
  const empty: PathGeometry = { contours: [] };
  assert.equal(pathGeometryData(empty), ''); assert.deepEqual(revealGeometry(empty, 0), empty);
  assert.equal(geometryLength(empty), 0);
  assert.throws(() => sampleGeometry(empty, 0), hasCode('EMPTY_GEOMETRY'));
  const degenerate = single([2, 3], { kind: 'cubic', id: 'zero', c1: [2, 3], c2: [2, 3], to: [2, 3] }, true);
  assert.equal(geometryLength(degenerate), 0);
  assert.equal(pathGeometryData(revealGeometry(degenerate, 0)), 'M 2 3');
  assert.equal(pathGeometryData(revealGeometry(degenerate, 0.7)), 'M 2 3');
  assert.throws(() => sampleGeometry(degenerate, 0.7), hasCode('DEGENERATE_GEOMETRY'));
  degenerate.contours[0].segments.push({ kind: 'line', id: 'nonzero', to: [12, 3] });
  assert.equal(sampleGeometry(degenerate, 0.25).segmentId, 'nonzero');
  pointClose(sampleGeometry(degenerate, 0.25).point, [7, 3]);
});

test('affine transformation commutes with evaluation and subdivision', () => {
  const matrix: [number, number, number, number, number, number] = [2, 1, -0.5, 3, 20, -7];
  const transformed = transformGeometry(archGeometry, matrix), transformedSegment = transformed.contours[0].segments[0];
  const transform = (p: PathPoint): PathPoint => [2 * p[0] - 0.5 * p[1] + 20, p[0] + 3 * p[1] - 7];
  for (let i = 0; i <= 20; i++) {
    pointClose(evaluateSegment(transformed.contours[0].start, transformedSegment, i / 20), transform(evaluateSegment([0, 0], arch, i / 20)), 1e-12);
  }
  const first = transformGeometry(revealGeometry(archGeometry, 0.37), matrix);
  const second = revealGeometry(transformed, 0.37);
  pointClose(first.contours[0].segments[0].to, second.contours[0].segments[0].to);
  assert.equal(transformed.contours[0].id, 'curve'); assert.equal(transformedSegment.id, 'arch');
  assert.deepEqual(archGeometry.contours[0].start, [0, 0]);
});

test('nonfinite values, bad modes and impossible precision fail explicitly', () => {
  assert.throws(() => sampleGeometry(archGeometry, NaN), hasCode('NONFINITE_GEOMETRY'));
  assert.throws(() => geometryLength(archGeometry, 0), hasCode('INVALID_LENGTH_TOLERANCE'));
  assert.throws(() => geometryLength(archGeometry, Infinity), hasCode('INVALID_LENGTH_TOLERANCE'));
  assert.throws(() => sampleGeometry(archGeometry, 0.5, 'bad' as 'length'), hasCode('INVALID_PROGRESS_MODE'));
  assert.throws(() => transformGeometry(archGeometry, [1, 0, 0, 1, Infinity, 0]), hasCode('NONFINITE_GEOMETRY'));
  const malformed = single([0, 0], { kind: 'line', id: 'line', to: [NaN, 0] });
  assert.throws(() => pathGeometryData(malformed), hasCode('NONFINITE_GEOMETRY'));
  assert.throws(() => geometryLength(archGeometry, 1e-30), hasCode('ARC_LENGTH_TOLERANCE'));
});

test('public geometry boundaries reject ambiguous IDs while generated closing prefixes remain usable', () => {
  const closed = single([0, 0], { kind: 'line', id: 'curve:close', to: [10, 0] }, true);
  assert.throws(() => sampleGeometry(closed, 0.25), hasCode('INVALID_PATH_GEOMETRY'));
  assert.throws(() => pathGeometryData(closed), hasCode('INVALID_PATH_GEOMETRY'));
  closed.contours[0].segments[0].id = 'out';
  const prefix = revealGeometry(closed, 0.75);
  // Its formerly implicit closure is now an explicit open segment: no collision.
  assert.equal(pathGeometryData(prefix), 'M 0 0 L 10 0 L 5 0');
  assert.equal(sampleGeometry(prefix, 1).segmentId, 'curve:close');
  const duplicateContour = structuredClone(archGeometry);
  duplicateContour.contours.push(structuredClone(duplicateContour.contours[0]));
  assert.throws(() => geometryBounds(duplicateContour), hasCode('INVALID_PATH_GEOMETRY'));
  const duplicateSegment = structuredClone(archGeometry);
  duplicateSegment.contours[0].segments.push(structuredClone(arch));
  assert.throws(() => geometryLength(duplicateSegment), hasCode('INVALID_PATH_GEOMETRY'));
  const dotted = structuredClone(archGeometry);
  dotted.contours[0].id = 'curve.part';
  assert.throws(() => revealGeometry(dotted, 0), hasCode('INVALID_PATH_GEOMETRY'));
  dotted.contours[0].id = 'curve'; dotted.contours[0].segments[0].id = 'arch.part';
  assert.throws(() => pathGeometryData(dotted), hasCode('INVALID_PATH_GEOMETRY'));
});
