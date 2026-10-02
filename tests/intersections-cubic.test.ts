import test from 'node:test';
import assert from 'node:assert/strict';
import {intersectCubicSegments, type CubicControls, type CubicIntersectionOptions} from '../src/geometry/intersections-cubic.ts';

const options: CubicIntersectionOptions = {positionTolerance: 1e-8, parameterTolerance: 1e-9, maxWork: 65536, maxDepth: 40};
const a: CubicControls = [[0, 0], [1/3, 0], [2/3, 0], [1, 1]]; // (t,t^3)
const crossing: CubicControls = [[0, -.08], [1/3, .14], [2/3, -.14], [1, 1.08]];
const tangent: CubicControls = [[0, .25], [1/3, -1/12], [2/3, -1/12], [1, 1.25]];
const loop: CubicControls = [[3/16, 0], [-7/48, 1/16], [-7/48, -5/24], [3/16, 3/16]];
const parabola: CubicControls = [[-1, 1], [-1/3, -1/3], [1/3, -1/3], [1, 1]];
const reverse = (curve: CubicControls): CubicControls => [curve[3], curve[2], curve[1], curve[0]];
const shifted = (curve: CubicControls, y: number): CubicControls => curve.map(([x, v]) => [x, v + y]) as unknown as CubicControls;
const near = (actual: number, expected: number, tolerance = 2e-7) => assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
function pairs(result: ReturnType<typeof intersectCubicSegments>) {
  return [...result.points].sort((x, y) => x.parameterA - y.parameterA);
}
function expectedPairs(result: ReturnType<typeof intersectCubicSegments>, expected: readonly (readonly [number, number])[], tolerance = 2e-7) {
  const values = pairs(result); assert.equal(values.length, expected.length); assert.equal(result.overlaps.length, 0);
  values.forEach((p, i) => {near(p.parameterA, expected[i][0], tolerance); near(p.parameterB, expected[i][1], tolerance);});
}

test('cubic pair finds three analytic crossings without flattening away an interior root', () => {
  // B(t)-A(t)=(0,(t-.2)(t-.5)(t-.8)). Equal x forces equal parameters.
  const result = intersectCubicSegments(a, crossing, options);
  expectedPairs(result, [[.2, .2], [.5, .5], [.8, .8]]);
  assert.ok(result.points.every(p => p.contact === 'crossing'));
  assert.ok(result.work > 0 && result.work <= options.maxWork);
  assert.ok(result.maxDepthReached <= options.maxDepth);
});

test('swapping and reversing inputs preserves all analytic intersection visits', () => {
  expectedPairs(intersectCubicSegments(crossing, a, options), [[.2, .2], [.5, .5], [.8, .8]]);
  expectedPairs(intersectCubicSegments(a, reverse(crossing), options), [[.2, .8], [.5, .5], [.8, .2]]);
  expectedPairs(intersectCubicSegments(reverse(a), reverse(crossing), options), [[.2, .2], [.5, .5], [.8, .8]]);
});

test('a reflected affine change of coordinates exercises general subdivision without inventing a singular solution', () => {
  // det=-7, so the same three parameter pairs survive this invertible change of coordinates.
  // Neither coordinate now has the matching Bernstein controls used by the scalar specialization.
  const map = (curve: CubicControls): CubicControls => curve.map(([x, y]) => [2*x+y+3, x-3*y-2]) as unknown as CubicControls;
  const result = intersectCubicSegments(map(a), map(crossing), options);
  expectedPairs(result, [[.2, .2], [.5, .5], [.8, .8]]); assert.ok(result.work > 1); assert.ok(result.maxDepthReached > 0);
  expectedPairs(intersectCubicSegments(map(a), map(shifted(tangent, 1e-4)), options), []);
  // A general singular root without an existence certificate must fail explicitly, rather than accepting proximity.
  assert.throws(() => intersectCubicSegments(map(a), map(tangent), options), (e: any) => e.code === 'INTERSECTION_AMBIGUOUS');
});

test('isolated quadratic tangency is retained once and a separated near miss is empty', () => {
  // B(t)-A(t)=(0,(t-.5)^2), with no sign change at its only root.
  const result = intersectCubicSegments(a, tangent, options);
  expectedPairs(result, [[.5, .5]]); assert.equal(result.points[0].contact, 'tangent');
  expectedPairs(intersectCubicSegments(a, shifted(tangent, 1e-4), options), []);
});

test('nearby but distinct roots remain distinct in parameter space', () => {
  const r = [.49, .51, .8], c0 = -r[0]*r[1]*r[2], c1 = r[0]*r[1] + r[0]*r[2] + r[1]*r[2], c2 = -r.reduce((x, y) => x + y, 0);
  // The cubic polynomial is t^3 + product(t-r_i); convert polynomial coefficients to Bernstein controls.
  const b: CubicControls = [[0, c0], [1/3, c0+c1/3], [2/3, c0+2*c1/3+c2/3], [1, c0+c1+c2+2]];
  expectedPairs(intersectCubicSegments(a, b, {...options, positionTolerance: 1e-9}), r.map(t => [t, t]), 2e-7);
});

test('a loop visiting the same point twice retains both parameter pairs', () => {
  // A=(q,t*q), q=(t-.25)(t-.75); B=(2u-1,(2u-1)^2).
  // Equality factors q(t)*(t-q(t))=0, so two visits share the origin.
  const extra = 1 - Math.sqrt(13)/4;
  expectedPairs(intersectCubicSegments(loop, parabola, options), [[extra, (1+extra)/2], [.25, .5], [.75, .5]]);
});

test('two transverse cubic graphs recover all nine independently known Chebyshev intersections', () => {
  // A=(x,T3(x)), B=(T3(y),y), where x=2t-1 and y=2u-1.
  // T3(T3(x))=T9(x)=x has the union of cos(k*pi/4) and cos(k*pi/5) roots.
  const chebyshev: CubicControls = [[-1, -1], [-1/3, 5], [1/3, -5], [1, 1]];
  const transposed = chebyshev.map(([x, y]) => [y, x]) as unknown as CubicControls;
  const roots = [-1, -Math.cos(Math.PI/5), -Math.SQRT1_2, -Math.cos(2*Math.PI/5), 0, Math.cos(2*Math.PI/5), Math.SQRT1_2, Math.cos(Math.PI/5), 1];
  const expected = roots.map(x => [(x+1)/2, (4*x**3-3*x+1)/2] as const);
  const result = intersectCubicSegments(chebyshev, transposed, options);
  expectedPairs(result, expected); assert.ok(result.work > 1);
  assert.equal(result.points.filter(p => p.contact === 'endpoint').length, 2);
  assert.equal(result.points.filter(p => p.contact === 'crossing').length, 7);
});

test('a shared endpoint is represented once with endpoint contact', () => {
  const b: CubicControls = [[1, 1], [4/3, 2], [5/3, 2], [2, 3]];
  const result = intersectCubicSegments(a, b, options);
  expectedPairs(result, [[1, 0]]); assert.equal(result.points[0].contact, 'endpoint');
});

test('identical and reversed cubics return overlap intervals instead of sampled point solutions', () => {
  for (const [b, orientation] of [[a, 1], [reverse(a), -1]] as const) {
    const result = intersectCubicSegments(a, b, options);
    assert.deepEqual(result.points, []); assert.equal(result.overlaps.length, 1);
    assert.deepEqual(result.overlaps[0], {parameterA: [0, 1], parameterB: [0, 1], orientation});
  }
});

test('disjoint control hulls are rejected without consuming the full subdivision budget', () => {
  const result = intersectCubicSegments(a, shifted(a, 4), options);
  expectedPairs(result, []); assert.ok(result.work < 16);
});

test('pair results are frozen independent snapshots without freezing authored inputs', () => {
  const aa = structuredClone(a), bb = structuredClone(crossing), saved = structuredClone({aa, bb});
  const result = intersectCubicSegments(aa, bb, options);
  assert.deepEqual({aa, bb}, saved); assert.equal(Object.isFrozen(aa), false);
  assert.equal(Object.isFrozen(result), true); assert.equal(Object.isFrozen(result.points), true);
  assert.equal(Object.isFrozen(result.points[0]), true);
  assert.throws(() => { (result.points[0] as any).parameterA = 99; }, TypeError);
  (aa[0] as [number, number])[0] = -99; expectedPairs(result, [[.2, .2], [.5, .5], [.8, .8]]);
});

test('invalid data and exhausted search limits produce diagnostics without partial results', () => {
  for (const bad of [null, [], [[0, 0]], new Array(4), [new Array(2), [1, 1], [2, 2], [3, 3]], [[0, 0], [1, 1], [2, 2], [3, Infinity]]]) {
    assert.throws(() => intersectCubicSegments(bad as unknown as CubicControls, a, options), (e: any) => e.code === 'INTERSECTION_DATA');
  }
  for (const bad of [{positionTolerance: 0}, {parameterTolerance: 0}, {maxWork: 0}, {maxWork: 1048577}, {maxDepth: 0}, {maxDepth: 53}]) {
    assert.throws(() => intersectCubicSegments(a, crossing, {...options, ...bad}), (e: any) => /^INTERSECTION_(TOLERANCE|BUDGET)$/.test(e.code));
  }
  assert.throws(() => intersectCubicSegments(loop, parabola, {...options, maxWork: 1}), (e: any) => /^INTERSECTION_(BUDGET|AMBIGUOUS)$/.test(e.code));
  assert.throws(() => intersectCubicSegments(loop, parabola, {...options, maxDepth: 1}), (e: any) => /^INTERSECTION_(BUDGET|AMBIGUOUS)$/.test(e.code));
});
