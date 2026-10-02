import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluate, createEvaluator, prepareScene, validateBundle, validateOperationGraph, validateExpressionProgram,
  type Bundle, type EvaluatedFrame, type InputRef, type Operation, type SpaceRef, type PathGeometry, type PointNode, type IntersectionSet,
} from '../src/index.ts';
import {renderSvg} from '../src/render-svg.ts';

const scene = {kind: 'scene'} as const;
const local = (node: string) => ({kind: 'local', node} as const);
const scalar = (value: number, unit: '1'|'bp' = '1'): InputRef => ({kind: 'literal', value: {type: 'scalar', unit, value}});
const point = (value: [number, number], space: SpaceRef = scene): InputRef => ({kind: 'literal', value: {type: 'vec2', role: 'point', space, value}});
const read = (node: string, space: SpaceRef = scene): InputRef => ({kind: 'path', node, space});
const output = (operation: string, socket = 'position'): InputRef => ({kind: 'output', ref: {operation, socket}});
const line = (start: [number, number], to: [number, number]): PathGeometry => ({contours: [{id: 'c', start, segments: [{id: 's', kind: 'line', to}]}]});
// x=10t and y=100(t-.2)(t-.5)(t-.8), giving three independently known roots.
const cubic = (): PathGeometry => ({contours: [{id: 'c', start: [0, -8], segments: [{id: 's', kind: 'cubic', c1: [10/3, 14], c2: [20/3, -14], to: [10, 8]}]}]});
function fixture(a = line([-10, 0], [10, 0]), b = line([0, -10], [0, 10])): Bundle {
  return {version: '0.3', title: 'Intersection result sets', duration: 2, units: 'bp', viewport: {width: 300, height: 200},
    camera: {x: 0, y: 0, zoom: 1}, resources: {}, tracks: [], relations: [],
    nodes: [{id: 'A', kind: 'path', d: 'M0 0L1 0', geometry: a}, {id: 'B', kind: 'path', d: 'M0 0L1 0', geometry: b},
      ...['marker', 'tip', 'count', 'parameterA', 'parameterB'].map(id => ({id, kind: 'point' as const, x: 90, y: 40, r: 1}))],
    operationGraph: {version: 1, operations: [], bindings: []}};
}
const at = (frame: EvaluatedFrame, id = 'marker') => frame.nodes.find(n => n.id === id) as PointNode;
const near = (actual: readonly number[], expected: readonly number[], tolerance = 1e-6) => {
  assert.equal(actual.length, expected.length);
  actual.forEach((n, i) => assert.ok(Number.isFinite(n) && Math.abs(n - expected[i]) <= tolerance, `${actual} != ${expected}`));
};
function add(b: Bundle, id: string, operator: string, inputs: Operation['inputs'], space: SpaceRef = scene, version = 1): Operation {
  const operation = {id, operator, version, spaces: {space}, inputs}; b.operationGraph!.operations.push(operation); return operation;
}
function bind(b: Bundle, operation: string, socket: string, target: string, property: string) {
  b.operationGraph!.bindings.push({target, property, value: {operation, socket}});
}
function intersect(b: Bundle, inputs: Operation['inputs'] = {}, space: SpaceRef = scene, id = 'set') {
  return add(b, id, 'intersectPaths', {a: read('A', space), b: read('B', space), ...inputs}, space);
}
function select(b: Bundle, inputs: Operation['inputs'] = {}, id = 'selection', target = 'marker', space: SpaceRef = scene) {
  const op = add(b, id, 'selectIntersection', {intersections: output('set', 'intersections'), along: scalar(0), missing: scalar(0), fallback: point([90, 40], space), ...inputs}, space);
  if (space.kind === 'scene') bind(b, id, 'position', target, 'position');
  return op;
}
const span = {file: 'intersections.tex', start: {line: 7, column: 3}, end: {line: 7, column: 80}};

test('intersection inputs consume current control and reflected nonuniform parent transforms without the camera', () => {
  const b = fixture(line([-5, 0], [5, 0]), line([-10, 0], [10, 0]));
  b.nodes.push({id: 'axes', kind: 'group', transform: {translate: [10, 20], rotate: Math.PI/2, scale: [-2, 3]}},
    {id: 'moving', kind: 'group'});
  b.nodes.find(n => n.id === 'A')!.parent = 'axes'; b.nodes.find(n => n.id === 'B')!.parent = 'moving';
  b.expressions = {version: 1, parameters: {}, bindings: [
    {target: 'A', property: 'geometry.c.s.to', expression: 'vec2(5bp+time*1bp/1s,0bp)'},
    {target: 'moving', property: 'transform.translate', expression: 'vec2(10bp,20bp+time*2bp/1s)'},
  ]};
  intersect(b); select(b); bind(b, 'set', 'count', 'count', 'r');
  const frame = evaluate(b, 1); near([at(frame).x, at(frame).y], [10, 22]); assert.equal(at(frame, 'count').r, 1);
  assert.equal(frame.intersections!.selections.selection.selected !== null, true);
  b.camera = {x: 999, y: -333, zoom: 7}; const moved = evaluate(b, 1);
  near([at(moved).x, at(moved).y], [10, 22]); assert.deepEqual(moved.intersections, frame.intersections);
});

test('set-to-selector references and live path reads wait for upstream geometry writes and feed downstream coordinates', () => {
  const b = fixture(); select(b); intersect(b);
  add(b, 'zEndpoint', 'pointValue', {value: point([10, 10], local('A'))}, local('A'));
  bind(b, 'zEndpoint', 'value', 'A', 'geometry.c.s.to');
  add(b, 'aMidpoint', 'midpoint', {a: {kind: 'node', node: 'marker', property: 'position', space: scene}, b: point([10, 5])});
  bind(b, 'aMidpoint', 'position', 'tip', 'position');
  const frame = evaluate(b, 0); near([at(frame).x, at(frame).y], [0, 5]); near([at(frame, 'tip').x, at(frame, 'tip').y], [5, 5]);
  assert.match(renderSvg(frame), /data-node-id="marker"/);
});

test('three cubic roots are selected by parameter order along the explicitly chosen input', () => {
  const b = fixture(line([10, 0], [0, 0]), cubic()); intersect(b);
  select(b, {along: scalar(0)}, 'alongA'); select(b, {along: scalar(1)}, 'alongB', 'tip');
  select(b, {along: scalar(1), index: scalar(2)}, 'third', 'count');
  bind(b, 'set', 'count', 'parameterA', 'r'); bind(b, 'alongA', 'parameterA', 'parameterA', 'x');
  bind(b, 'alongA', 'parameterB', 'parameterB', 'x');
  const f = evaluate(b, 0); near([at(f).x, at(f, 'tip').x, at(f, 'count').x], [8, 2, 8]);
  near([at(f, 'parameterA').x, at(f, 'parameterB').x], [0.2, 0.8]); assert.equal(at(f, 'parameterA').r, 3);
  assert.equal(f.intersections!.sets.set.result.points.length, 3);
  assert.equal(f.intersections!.selections.alongA.along, 'a'); assert.equal(f.intersections!.selections.alongB.along, 'b');
});

test('segment clipping and infinite line extension produce different result sets and unbounded line parameters', () => {
  for (const infinite of [false, true]) {
    const b = fixture(line([4, 0], [6, 0]), cubic()); intersect(b, {domainA: scalar(infinite ? 1 : 0)}); select(b);
    bind(b, 'selection', 'parameterA', 'parameterA', 'x'); bind(b, 'set', 'count', 'count', 'r');
    const f = evaluate(b, 0); near([at(f).x, at(f).y], [infinite ? 2 : 5, 0]);
    near([at(f, 'parameterA').x], [infinite ? -1 : 0.5]); assert.equal(at(f, 'count').r, infinite ? 3 : 1);
  }
});

test('missing hide uses its explicit fallback and opacity without carrying state between seeks or runtimes', () => {
  const b = fixture(line([0, 0], [10, 0]), cubic());
  b.expressions = {version: 1, parameters: {}, bindings: [{target: 'A', property: 'transform.translate', expression: 'vec2(0bp,20bp*time/1s)'}]};
  intersect(b); select(b, {along: scalar(1), missing: scalar(1), fallback: point([-7, 9]), visibleOpacity: scalar(0.6)});
  bind(b, 'selection', 'opacity', 'marker', 'style.opacity'); bind(b, 'selection', 'found', 'tip', 'style.opacity');
  const authored = structuredClone(b), first = prepareScene(b), second = createEvaluator(b), found = first.sample(0), snapshot = structuredClone(found);
  near([at(found).x, at(found).y, at(found).style!.opacity!], [2, 0, 0.6]);
  const missing = first.sample(1); near([at(missing).x, at(missing).y, at(missing).style!.opacity!], [-7, 9, 0]);
  assert.equal(at(missing, 'tip').style!.opacity, 0); assert.equal(missing.intersections!.selections.selection.selected, null);
  assert.deepEqual(first.sample(0), snapshot); assert.deepEqual(second(0), snapshot); assert.deepEqual(second(1), missing);
  at(found).x = 999; (found.intersections!.sets.set.result as any).points.length = 0;
  assert.deepEqual(first.sample(0), snapshot); assert.deepEqual(b, authored);
  b.operationGraph!.operations[1].inputs.fallback = point([500, 500]); assert.deepEqual(second(1), missing);
});

test('selection positions convert from a shared local chart to a transformed target while hide remains explicit', () => {
  const b = fixture(); b.nodes.push({id: 'chart', kind: 'group', transform: {translate: [10, 20], rotate: Math.PI/2, scale: [-2, 3]}},
    {id: 'target', kind: 'group', transform: {translate: [-5, 7], scale: [2, 4]}});
  b.nodes.find(n => n.id === 'A')!.parent = 'chart'; b.nodes.find(n => n.id === 'B')!.parent = 'chart'; b.nodes.find(n => n.id === 'marker')!.parent = 'target';
  intersect(b, {}, local('chart')); select(b, {missing: scalar(1), fallback: point([2, 3], local('chart'))}, 'selection', 'marker', local('chart'));
  const converted = add(b, 'scene', 'transformPoint', {point: output('selection'), transform: {kind: 'spaceTransform', from: local('chart'), to: scene}});
  converted.spaces = {from: local('chart'), to: scene}; bind(b, 'scene', 'position', 'marker', 'position');
  const f = evaluate(b, 0); near([at(f).x, at(f).y], [7.5, 3.25]);
  assert.equal(at(f).style?.opacity, undefined, 'Selection has no implicit visibility writer');
  assert.deepEqual(f.intersections!.sets.set.space, local('chart'));
});

test('overlaps stay set-valued and both selector missing policies reject arbitrary overlap points', () => {
  const b = fixture(line([0, 0], [10, 0]), line([5, 0], [15, 0])); intersect(b); bind(b, 'set', 'overlapCount', 'count', 'r');
  const frame = evaluate(b, 0); assert.equal(at(frame, 'count').r, 1); assert.equal(frame.intersections!.sets.set.result.overlaps.length, 1);
  for (const missing of [0, 1]) {
    const candidate = structuredClone(b); select(candidate, {missing: scalar(missing)}).sourceSpan = span;
    assert.throws(() => evaluate(candidate, 0), (error: any) => {
      const d = error.diagnostics?.find((d: any) => d.code === 'INTERSECTION_OVERLAP'); assert.ok(d, String(error));
      assert.equal(d.sourceSpan?.file, span.file); return true;
    });
  }
});

test('intersection result literals roundtrip through selection and reject malformed nested data and spaces', () => {
  const original = fixture(); intersect(original); const result = evaluate(original, 0).intersections!.sets.set.result;
  const b = fixture(); select(b, {intersections: {kind: 'literal', value: {type: 'intersections2d', space: scene, value: structuredClone(result) as IntersectionSet}}});
  assert.deepEqual(validateOperationGraph(b.operationGraph, b), []); near([at(evaluate(b, 0)).x, at(evaluate(b, 0)).y], [0, 0]);
  for (const change of [
    (literal: any) => {literal.value = null;},
    (literal: any) => {literal.value.points = [null];},
    (literal: any) => {literal.value.overlaps = 'not a list';},
    (literal: any) => {literal.value.extra = true;},
    (literal: any) => {literal.space = local('missing');},
  ]) {
    const invalid = structuredClone(b); change((invalid.operationGraph!.operations[0].inputs.intersections as any).value);
    assert.doesNotThrow(() => validateBundle(invalid)); assert.ok(validateBundle(invalid).some(d => d.severity === 'error'));
  }
  const wrong = fixture(); select(wrong, {intersections: point([0, 0])});
  assert.ok(validateOperationGraph(wrong.operationGraph, wrong).some(d => d.code === 'OPERATION_TYPE_MISMATCH'));
});

test('intersection and selected-point dependencies expose geometry cycles and explicit output writer conflicts', () => {
  const cyclic = fixture(); intersect(cyclic).sourceSpan = span; select(cyclic);
  const converted = add(cyclic, 'toA', 'transformPoint', {point: output('selection'), transform: {kind: 'spaceTransform', from: scene, to: local('A')}});
  converted.spaces = {from: scene, to: local('A')}; bind(cyclic, 'toA', 'position', 'A', 'geometry.c.s.to');
  assert.throws(() => createEvaluator(cyclic), (error: any) => {
    const d = error.diagnostics?.find((d: any) => /CYCLE/.test(d.code)); assert.ok(d, String(error));
    assert.ok(d.sourceSpan?.file === span.file || d.related?.some((r: any) => r.sourceSpan?.file === span.file)); return true;
  });
  for (const property of ['x', 'style.opacity']) {
    const b = fixture(); intersect(b); select(b); bind(b, 'selection', 'opacity', 'marker', 'style.opacity');
    b.tracks.push({target: 'marker', property, keys: [[0, 0.5]]});
    assert.ok(validateBundle(b).some(d => /WRITER|CONFLICT/.test(d.code))); assert.throws(() => createEvaluator(b), /WRITER|CONFLICT/);
  }
});

test('missing errors and unsupported domains produce located diagnostics instead of fabricated points', () => {
  const absent = fixture(line([0, 0], [10, 0]), line([0, 2], [10, 2])); intersect(absent); select(absent).sourceSpan = span;
  assert.throws(() => evaluate(absent, 0), (error: any) => {
    const d = error.diagnostics?.[0]; assert.ok(d, String(error)); assert.match(d.code, /MISSING/); assert.equal(d.sourceSpan?.file, span.file); return true;
  });
  const invalid: [Operation['inputs'], boolean][] = [
    [{positionTolerance: scalar(0, 'bp')}, false], [{parameterTolerance: scalar(-1)}, false], [{domainA: scalar(2)}, false],
    [{domainB: scalar(1)}, true], [{positionTolerance: scalar(1)}, false],
  ];
  for (const [inputs, useCubic] of invalid) {
    const b = fixture(undefined, useCubic ? cubic() : undefined); intersect(b, inputs).sourceSpan = span;
    assert.throws(() => evaluate(b, 0), (error: any) => {
      const d = error.diagnostics?.[0]; assert.ok(d, String(error)); assert.equal(d.sourceSpan?.file, span.file); assert.match(d.path ?? '', /operations\[/); return true;
    });
  }
  for (const inputs of [{along: scalar(2)}, {index: scalar(-1)}, {missing: scalar(2)}, {visibleOpacity: scalar(2)}] as Operation['inputs'][]) {
    const b = fixture(); intersect(b); select(b, inputs).sourceSpan = span;
    assert.throws(() => evaluate(b, 0), (error: any) => {
      const d = error.diagnostics?.[0]; assert.ok(d, String(error)); assert.equal(d.sourceSpan?.file, span.file); return true;
    });
  }
  const b = fixture(); intersect(b); const operation = select(b); delete operation.inputs.fallback;
  assert.ok(validateBundle(b).some(d => d.code === 'OPERATION_REQUIRED_INPUT'));
});

test('candidate global parameters are available to input expressions without changing the existing program', () => {
  const b = fixture(); b.expressions = {version: 1, parameters: {}, bindings: []};
  intersect(b, {positionTolerance: {kind: 'expression', expression: 'eps', unit: 'bp'}}); select(b);
  const candidate = {version: 1 as const, parameters: {eps: {type: 'scalar' as const, unit: 'bp' as const, default: 1e-6, min: 1e-9, max: 0.01}}, bindings: []};
  assert.deepEqual(validateExpressionProgram(candidate, b), []); assert.deepEqual(b.expressions.parameters, {});
  b.expressions = candidate; const run = createEvaluator(b); near([at(run(0, {eps: 1e-5})).x, at(run(0)).y], [0, 0]);
});

test('intersection evaluation shares live paths without altering historical parameter sampling', () => {
  const b = fixture(line([0, 0], [10, 0]), line([5, -10], [5, 10])); intersect(b); select(b);
  const operation = add(b, 'historical', 'sampleCurve', {curve: read('A'), parameter: scalar(0.25)}, scene);
  operation.spaces = {curve: scene}; bind(b, 'historical', 'position', 'tip', 'position');
  const f = evaluate(b, 0); near([at(f).x, at(f).y], [5, 0]); near([at(f, 'tip').x, at(f, 'tip').y], [2.5, 0]);
  assert.equal(f.curves, undefined, 'The historical sampler does not emit new curve-v2 metadata');
});
