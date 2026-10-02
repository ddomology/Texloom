import test from 'node:test';
import assert from 'node:assert/strict';
import {
  intersectPathGeometries, intersectPathGeometriesV2, evaluate, prepareScene, createEvaluator, validateBundle,
  type Bundle, type PathGeometry, type InputRef, type Operation, type EvaluatedFrame, type PointNode,
} from '../src/index.ts';

const scene = {kind: 'scene'} as const;
const scalar = (value: number, unit: '1'|'bp' = '1'): InputRef => ({kind: 'literal', value: {type: 'scalar', unit, value}});
const point = (value: [number, number]): InputRef => ({kind: 'literal', value: {type: 'vec2', role: 'point', space: scene, value}});
const ref = (operation: string, socket: string): InputRef => ({kind: 'output', ref: {operation, socket}});
const a = (): PathGeometry => ({contours: [{id: 'c', start: [0, 0], segments: [{id: 's', kind: 'cubic', c1: [1/3, 0], c2: [2/3, 0], to: [1, 1]}]}]});
const b = (): PathGeometry => ({contours: [{id: 'c', start: [0, -.08], segments: [{id: 's', kind: 'cubic', c1: [1/3, .14], c2: [2/3, -.14], to: [1, 1.08]}]}]});
const near = (actual: number, expected: number, tolerance = 2e-6) => assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const at = (frame: EvaluatedFrame, id = 'marker') => frame.nodes.find(n => n.id === id) as PointNode;
function fixture(): Bundle {
  return {version: '0.3', title: 'Cubic intersections v2', units: 'bp', duration: 2, viewport: {width: 300, height: 200},
    camera: {x: 0, y: 0, zoom: 1}, resources: {}, tracks: [], relations: [],
    nodes: [{id: 'A', kind: 'path', geometry: a(), d: 'M0 0'}, {id: 'B', kind: 'path', geometry: b(), d: 'M0 0'},
      ...['marker', 'other', 'parameter', 'count'].map(id => ({id, kind: 'point' as const, x: 9, y: 8, r: 1}))],
    operationGraph: {version: 1, operations: [], bindings: []}};
}
function add(bundle: Bundle, id: string, operator: string, inputs: Operation['inputs'], version = 1) {
  const operation = {id, operator, version, inputs, spaces: {space: scene}};
  bundle.operationGraph!.operations.push(operation); return operation as Operation;
}
function solve(bundle: Bundle, inputs: Operation['inputs'] = {}) {
  return add(bundle, 'set', 'intersectPaths', {a: {kind: 'path', node: 'A', space: scene}, b: {kind: 'path', node: 'B', space: scene}, ...inputs}, 2);
}
function bind(bundle: Bundle, operation: string, socket: string, target: string, property: string) {
  bundle.operationGraph!.bindings.push({target, property, value: {operation, socket}});
}
function select(bundle: Bundle, inputs: Operation['inputs'] = {}, id = 'selected', target = 'marker') {
  const op = add(bundle, id, 'selectIntersection', {intersections: ref('set', 'intersections'), along: scalar(0), missing: scalar(0), fallback: point([-3, -4]), ...inputs});
  bind(bundle, id, 'position', target, 'position'); return op;
}
const span = {file: 'cubic-intersections.tex', start: {line: 12, column: 2}, end: {line: 12, column: 70}};

test('v2 path results are ordered, frozen, and budgeted while v1 cubic behavior remains unchanged', () => {
  const aa = a(), bb = b(), before = structuredClone({aa, bb});
  const result = intersectPathGeometriesV2(aa, bb);
  assert.equal(result.intersections.points.length, 3);
  result.intersections.points.forEach((p, i) => {const t = [.2, .5, .8][i]; near(p.point[0], t); near(p.point[1], t**3); near(p.incidents[0].parameterA, t);});
  assert.equal(result.report.solver, 'adaptive-cubic-v2'); assert.equal(result.report.cubicPairs, 1);
  assert.equal(result.report.maxWork, 65536); assert.equal(result.report.maxDepth, 40); assert.ok(result.report.work > 0);
  assert.equal(Object.isFrozen(result.intersections.points[0].incidents), true); assert.equal(Object.isFrozen(result.report), true);
  assert.deepEqual({aa, bb}, before); assert.equal(Object.isFrozen(aa), false);
  assert.throws(() => intersectPathGeometries(aa, bb), (e: any) => e.code === 'INTERSECTION_UNSUPPORTED');
});

test('v2 live paths consume reflected parent transforms before selection and downstream coordinates', () => {
  const bundle = fixture(); bundle.nodes.push({id: 'chart', kind: 'group', transform: {rotate: Math.PI/2, scale: [-2, 3]}});
  bundle.nodes.find(n => n.id === 'A')!.parent = 'chart'; bundle.nodes.find(n => n.id === 'B')!.parent = 'chart';
  bundle.expressions = {version: 1, parameters: {shift: {type: 'scalar', unit: 'bp', default: 10}}, bindings: [
    {target: 'chart', property: 'transform.translate', expression: 'vec2(shift,20bp+time*2bp/1s)'},
  ]};
  select(bundle); solve(bundle);
  add(bundle, 'next', 'midpoint', {a: {kind: 'node', node: 'marker', property: 'position', space: scene}, b: point([0, 0])});
  bind(bundle, 'next', 'position', 'other', 'position'); bind(bundle, 'set', 'count', 'count', 'r');
  const frame = evaluate(bundle, 1, {shift: 30});
  near(at(frame).x, 30 - 3*.2**3); near(at(frame).y, 22 - 2*.2);
  near(at(frame, 'other').x, at(frame).x/2); near(at(frame, 'other').y, at(frame).y/2); assert.equal(at(frame, 'count').r, 3);
  assert.equal(frame.intersections!.sets.set.report!.cubicPairs, 1);
  bundle.camera = {x: -500, y: 777, zoom: 9}; assert.deepEqual(evaluate(bundle, 1, {shift: 30}).intersections, frame.intersections);
});

test('v2 selectors keep declared parameter order when one input is reversed', () => {
  const bundle = fixture(), bb = b().contours[0], segment = bb.segments[0]; assert.equal(segment.kind, 'cubic');
  if (segment.kind !== 'cubic') throw new Error('fixture must be cubic');
  (bundle.nodes[1] as any).geometry = {contours: [{id: 'c', start: segment.to, segments: [{id: 's', kind: 'cubic', c1: segment.c2, c2: segment.c1, to: bb.start}]}]};
  solve(bundle); select(bundle); select(bundle, {along: scalar(1)}, 'byB', 'other');
  bind(bundle, 'byB', 'parameterB', 'parameter', 'x');
  const frame = evaluate(bundle, 0); near(at(frame).x, .2); near(at(frame, 'other').x, .8); near(at(frame, 'parameter').x, .2);
});

test('v2 missing hide, reverse seeks, parameter overrides, and frame metadata are independent', () => {
  const bundle = fixture(); bundle.expressions = {version: 1, parameters: {lift: {type: 'scalar', unit: 'bp', default: 0}}, bindings: [
    {target: 'B', property: 'transform.translate', expression: 'vec2(0bp,lift+time*10bp/1s)'},
  ]};
  solve(bundle); select(bundle, {missing: scalar(1), visibleOpacity: scalar(.7)}); bind(bundle, 'selected', 'opacity', 'marker', 'style.opacity');
  const authored = structuredClone(bundle), first = prepareScene(bundle), second = createEvaluator(bundle);
  const hit = first.sample(0), saved = structuredClone(hit), missing = first.sample(1);
  near(at(hit).x, .2); assert.equal(at(hit).style!.opacity, .7);
  assert.deepEqual([at(missing).x, at(missing).y, at(missing).style!.opacity], [-3, -4, 0]);
  assert.equal(missing.intersections!.selections.selected.selected, null);
  assert.deepEqual(first.sample(0), saved); assert.deepEqual(second(0), saved);
  const overridden = second(0, {lift: 10}); assert.equal(overridden.time, 0); assert.deepEqual(overridden.nodes, missing.nodes); assert.deepEqual(overridden.intersections, missing.intersections);
  (hit.intersections!.sets.set.report as any).work = -1; (hit.intersections!.sets.set.result as any).points.length = 0; at(hit).x = 999;
  assert.deepEqual(second(0), saved); assert.deepEqual(first.sample(0), saved); assert.deepEqual(bundle, authored);
  (bundle.nodes[1] as any).geometry.contours[0].start[1] = 999; assert.deepEqual(first.sample(0), saved);
});

test('v2 retains different visits to the same geometric point and selectors expose their parameters', () => {
  const bundle = fixture();
  (bundle.nodes[0] as any).geometry = {contours: [{id: 'loop', start: [3/16, 0], segments: [{id: 's', kind: 'cubic', c1: [-7/48, 1/16], c2: [-7/48, -5/24], to: [3/16, 3/16]}]}]};
  (bundle.nodes[1] as any).geometry = {contours: [{id: 'parabola', start: [-1, 1], segments: [{id: 's', kind: 'cubic', c1: [-1/3, -1/3], c2: [1/3, -1/3], to: [1, 1]}]}]};
  solve(bundle); select(bundle, {index: scalar(1)}); select(bundle, {index: scalar(2)}, 'again', 'other');
  bind(bundle, 'selected', 'parameterA', 'parameter', 'x'); bind(bundle, 'again', 'parameterA', 'parameter', 'y');
  const frame = evaluate(bundle, 0); assert.equal(frame.intersections!.sets.set.result.points.length, 3);
  near(at(frame).x, 0); near(at(frame).y, 0); near(at(frame, 'other').x, 0); near(at(frame, 'other').y, 0);
  near(at(frame, 'parameter').x, .25); near(at(frame, 'parameter').y, .75);
});

test('v2 keeps distinct loop visits with a loose parameter tolerance while merging true adjacent vertices', () => {
  // q=(t-.4)(t-.6); A=(q,t*q) visits the origin at two distinct parameters.
  const loop: PathGeometry = {contours: [{id: 'loop', start: [.24, 0], segments: [{id: 's', kind: 'cubic',
    c1: [.24-1/3, .08], c2: [.24-1/3, .16-1/3], to: [.24, .24]}]}]};
  const parabola: PathGeometry = {contours: [{id: 'parabola', start: [-1, 1], segments: [{id: 's', kind: 'cubic',
    c1: [-1/3, -1/3], c2: [1/3, -1/3], to: [1, 1]}]}]};
  const result = intersectPathGeometriesV2(loop, parabola, {parameterTolerance: .3});
  assert.equal(result.intersections.points.length, 3);
  const visits = result.intersections.points.filter(p => Math.hypot(...p.point) < 1e-6);
  assert.equal(visits.length, 2); near(visits[0].incidents[0].parameterA, .4); near(visits[1].incidents[0].parameterA, .6);
  near(result.intersections.points[0].incidents[0].parameterA, 1-Math.sqrt(.76));

  const adjacent: PathGeometry = {contours: [{id: 'joined', start: [-1, -1], segments: [
    {id: 'left', kind: 'cubic', c1: [-2/3, -1/3], c2: [-1/3, -1/3], to: [0, 0]},
    {id: 'right', kind: 'cubic', c1: [1/3, 1/3], c2: [2/3, 1/3], to: [1, 1]},
  ]}]};
  const horizontal: PathGeometry = {contours: [{id: 'line', start: [-2, 0], segments: [{id: 's', kind: 'line', to: [2, 0]}]}]};
  const shared = intersectPathGeometriesV2(adjacent, horizontal, {parameterTolerance: .3}).intersections;
  assert.equal(shared.points.length, 1); assert.equal(shared.points[0].incidents.length, 2);
  near(shared.points[0].point[0], 0); near(shared.points[0].point[1], 0);
  assert.deepEqual(shared.points[0].incidents.map(i => [i.a.segmentId, i.parameterA]), [['left', 1], ['right', 0]]);
});

test('v2 total work budget spans every cubic pair and never returns a completed prefix', () => {
  const aa = a(); aa.contours.push({...structuredClone(aa.contours[0]), id: 'second'});
  // Each identical pair costs one unit. A per-pair reset would incorrectly return both overlaps with maxWork=1.
  assert.throws(() => intersectPathGeometriesV2(aa, a(), {maxWork: 1}), (e: any) => e.code === 'INTERSECTION_BUDGET');
  const complete = intersectPathGeometriesV2(aa, a(), {maxWork: 2});
  assert.equal(complete.report.work, 2); assert.equal(complete.report.cubicPairs, 2); assert.equal(complete.intersections.overlaps.length, 2);
  assert.throws(() => intersectPathGeometriesV2(aa, a(), {maxResults: 1}), (e: any) => e.code === 'INTERSECTION_BUDGET');
  const bundle = fixture(); (bundle.nodes[0] as any).geometry = aa; (bundle.nodes[1] as any).geometry = a(); solve(bundle, {maxWork: scalar(1)}).sourceSpan = span;
  assert.throws(() => evaluate(bundle, 0), (e: any) => {const d = e.diagnostics?.[0]; assert.equal(d?.code, 'INTERSECTION_BUDGET'); assert.deepEqual(d.sourceSpan, span); return true;});
});

test('v2 overlap selection remains ambiguous, and budget and mode failures retain authored source spans', () => {
  const overlap = fixture(); (overlap.nodes[1] as any).geometry = a(); solve(overlap); select(overlap, {missing: scalar(1)}).sourceSpan = span;
  assert.throws(() => evaluate(overlap, 0), (e: any) => {assert.equal(e.diagnostics?.[0]?.code, 'INTERSECTION_OVERLAP'); assert.deepEqual(e.diagnostics[0].sourceSpan, span); return true;});
  for (const inputs of [{maxWork: scalar(0)}, {maxWork: scalar(1048577)}, {maxDepth: scalar(53)}, {maxWork: scalar(1, 'bp')}, {domainA: scalar(1)}] as Operation['inputs'][]) {
    const bundle = fixture(); solve(bundle, inputs).sourceSpan = span;
    assert.throws(() => evaluate(bundle, 0), (e: any) => {assert.ok(e.diagnostics?.length, String(e)); assert.deepEqual(e.diagnostics[0].sourceSpan, span); return true;});
  }
});

test('v2 geometry-to-selection cycles and explicit position writer conflicts are validated before execution', () => {
  const cyclic = fixture(); solve(cyclic).sourceSpan = span; select(cyclic);
  const conversion: Operation = {id: 'back', operator: 'transformPoint', version: 1, spaces: {from: scene, to: {kind: 'local', node: 'A'}}, inputs: {
    point: ref('selected', 'position'), transform: {kind: 'spaceTransform', from: scene, to: {kind: 'local', node: 'A'}},
  }};
  cyclic.operationGraph!.operations.push(conversion); bind(cyclic, 'back', 'position', 'A', 'geometry.c.s.c1');
  assert.throws(() => prepareScene(cyclic), /CYCLE/);
  const conflict = fixture(); solve(conflict); select(conflict); conflict.tracks.push({target: 'marker', property: 'x', keys: [[0, 1]]});
  assert.ok(validateBundle(conflict).some(d => /WRITER|CONFLICT/.test(d.code)));
});
