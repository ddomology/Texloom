import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluate, createEvaluator, prepareScene, bindSceneClip, validateBundle,
  type Bundle, type EvaluatedFrame, type PointNode, type LineNode, type PathNode,
} from '../src/index.ts';

function fixture(): Bundle {
  return {version: '0.3', title: 'Expression motion', duration: 4, units: 'bp',
    viewport: {width: 300, height: 200}, camera: {x: 0, y: 0, zoom: 1},
    nodes: [{id: 'B', kind: 'point', x: 0, y: 0, r: 2}], resources: {}, tracks: [], relations: [],
    expressions: {version: 1, parameters: {
      a: {type: 'scalar', unit: 'rad', default: 0, min: -Math.PI, max: Math.PI},
      amplitude: {type: 'scalar', unit: 'bp', default: 40, min: 0, max: 100},
      on: {type: 'boolean', default: true}, shift: {type: 'vec2', unit: 'bp', default: [0, 0]},
    }, bindings: [
      {target: 'B', property: 'position', expression: 'vec2(120bp, 100bp - amplitude*sin(a + 1rad*time/1s)) + shift'},
      {target: 'B', property: 'visible', expression: 'on && time >= 0s'},
    ]}};
}
function near(actual: number[], expected: number[]) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, i) => assert.ok(Number.isFinite(value) && Math.abs(value - expected[i]) < 1e-9,
    `${JSON.stringify(actual)} != ${JSON.stringify(expected)}`));
}
const point = (frame: EvaluatedFrame, id = 'B') => frame.nodes.find(n => n.id === id) as PointNode;

test('public runtime entry points evaluate analytic time-driven motion from TeX-sized coordinates', () => {
  const bundle = fixture(); assert.deepEqual(validateBundle(bundle), []);
  for (const sample of [createEvaluator(bundle), prepareScene(bundle).sample, (time: number) => evaluate(bundle, time)]) {
    const start = point(sample(0)), peak = point(sample(Math.PI / 2));
    near([start.x, start.y], [120, 100]); near([peak.x, peak.y], [120, 60]);
  }
});

test('parameter overrides use declared units and reset to defaults on every sample', () => {
  const runtime = prepareScene(fixture());
  const phased = point(runtime.sample(0, {a: Math.PI / 2})); near([phased.x, phased.y], [120, 60]);
  const moved = point(runtime.sample(Math.PI / 2, {amplitude: 20, shift: [5, 6], on: false}));
  near([moved.x, moved.y], [125, 86]); assert.equal(moved.visible, false);
  const reset = point(runtime.sample(0)); near([reset.x, reset.y], [120, 100]); assert.equal(reset.visible, true);
  assert.doesNotThrow(() => runtime.sample(0, {a: -Math.PI, amplitude: 100}));
  const zeroAmplitude = point(runtime.sample(Math.PI / 2, {a: Math.PI, amplitude: 0}));
  near([zeroAmplitude.x, zeroAmplitude.y], [120, 100]);
  const direct = point(evaluate(fixture(), 0, {a: Math.PI / 2})); near([direct.x, direct.y], [120, 60]);
});

test('expression time uses the same clamped absolute scene clock as tracks', () => {
  const bundle = fixture(), runtime = prepareScene(bundle);
  const before = runtime.sample(-10), after = runtime.sample(100);
  assert.equal(before.time, 0); near([point(before).x, point(before).y], [120, 100]);
  assert.equal(after.time, 4); near([point(after).x, point(after).y], [120, 100 - 40 * Math.sin(4)]);
  assert.throws(() => runtime.sample(Infinity), /finite/i);
});

test('clip hosts forward parameter overrides while converting host time to source time', () => {
  const clip = bindSceneClip(prepareScene(fixture()), {start: 10, sourceStart: 1, rate: 2, duration: 1});
  const sampled = clip.sample(10.25, {a: Math.PI / 2});
  assert.equal(sampled.sourceTime, 1.5); assert.ok(sampled.frame);
  const p = point(sampled.frame); near([p.x, p.y], [120, 100 - 40 * Math.sin(Math.PI / 2 + 1.5)]);
});

test('unknown overrides, wrong types, nonfinite components and bounds violations are rejected', () => {
  const runtime = prepareScene(fixture());
  for (const parameters of [
    {missing: 1}, {a: true}, {a: Infinity}, {a: 4}, {amplitude: -1}, {on: 1},
    {shift: [1]}, {shift: [NaN, 1]}, {shift: 'wrong'},
  ]) assert.throws(() => runtime.sample(0, parameters as any), /PARAMETER|EXPRESSION|finite|bound|type/i);
});

test('parameter defaults, types, units and bounds are checked before preparing a scene', () => {
  for (const definition of [
    {type: 'scalar', unit: 'rad', default: true},
    {type: 'scalar', unit: 'rad', default: 10, max: 2},
    {type: 'scalar', unit: 'rad', default: 0, min: 3, max: 2},
    {type: 'boolean', unit: 'bp', default: true},
    {type: 'vec2', unit: 'bp', default: [1]},
  ]) {
    const bundle = fixture(); bundle.expressions!.parameters.a = definition as any;
    assert.ok(validateBundle(bundle).some(d => d.severity === 'error'));
    assert.throws(() => prepareScene(bundle));
  }
});

test('property units and value kinds are enforced including visibility and rotation', () => {
  for (const binding of [
    {target: 'B', property: 'position', expression: 'vec2(1,2)'},
    {target: 'B', property: 'r', expression: '2s'},
    {target: 'B', property: 'transform.rotate', expression: '2bp'},
    {target: 'B', property: 'style.opacity', expression: '1bp'},
    {target: 'B', property: 'visible', expression: '1'},
  ]) {
    const bundle = fixture(); bundle.expressions!.bindings = [binding];
    assert.ok(validateBundle(bundle).some(d => d.severity === 'error'));
    assert.throws(() => createEvaluator(bundle));
  }
});

test('expression scene-position sinks account for simultaneously expressed parent transforms', () => {
  const bundle = fixture();
  bundle.nodes.push({id: 'parent', kind: 'group'}); bundle.nodes[0].parent = 'parent';
  bundle.expressions!.bindings.push({target: 'parent', property: 'transform.translate', expression: 'vec2(10bp, 20bp*time/1s)'});
  const p = point(evaluate(bundle, 2)); near([p.x, p.y], [110, 60 - 40 * Math.sin(2)]);
});

test('expression phase bindings run before legacy pointOnEllipse and tangent relations', () => {
  const bundle = fixture(); bundle.nodes = [
    {id: 'E', kind: 'ellipse', cx: 5, cy: 7, rx: 10, ry: 20},
    {id: 'B', kind: 'point', x: 0, y: 0, r: 2},
    {id: 'L', kind: 'line', x1: 0, y1: 0, x2: 0, y2: 0},
  ];
  bundle.expressions!.bindings = [{target: 'B', property: 'phase', expression: '1rad * time / 1s'}];
  bundle.relations = [{type: 'tangent', target: 'L', source: 'E', point: 'B', length: 4},
    {type: 'pointOnEllipse', target: 'B', source: 'E'}];
  const frame = evaluate(bundle, Math.PI / 2), p = point(frame), l = frame.nodes.find(n => n.id === 'L') as LineNode;
  near([p.x, p.y], [5, 27]); near([l.x1, l.y1, l.x2, l.y2], [7, 27, 3, 27]);
});

test('expression controls deform a path before dependent legacy sampling and SVG lowering', () => {
  const bundle = fixture();
  bundle.nodes.push({id: 'curve', kind: 'path', d: 'M0 0', geometry: {contours: [{id: 'c', start: [0, 0], segments: [
    {id: 's', kind: 'cubic', c1: [0, 100], c2: [100, 100], to: [100, 0]},
  ]}]}});
  (bundle.nodes[0] as PointNode).progress = 0.5;
  bundle.expressions!.bindings = [{target: 'curve', property: 'geometry.c.s.c1', expression: 'vec2(10bp, 20bp*time/1s)'}];
  bundle.relations = [{type: 'pointOnPath', target: 'B', source: 'curve'}];
  const frame = evaluate(bundle, 2), p = point(frame), curve = frame.nodes.find(n => n.id === 'curve') as PathNode;
  near([p.x, p.y], [53.75, 52.5]); assert.match(curve.d, /10 40/);
});

test('writer conflicts span expression aliases, tracks, operation bindings and legacy relations', () => {
  const track = fixture(); track.tracks = [{target: 'B', property: 'x', keys: [[0, 0]]}];
  const duplicate = fixture(); duplicate.expressions!.bindings.push({...duplicate.expressions!.bindings[0]});
  const relation = fixture(); relation.nodes.push({id: 'E', kind: 'ellipse', cx: 0, cy: 0, rx: 10, ry: 5});
  relation.relations = [{type: 'pointOnEllipse', target: 'B', source: 'E'}];
  const operation = fixture(); operation.expressions!.bindings = [{target: 'B', property: 'r', expression: '3bp'}];
  operation.operationGraph = {version: 1, operations: [{id: 'radius', operator: 'scalarValue', version: 1, spaces: {},
    inputs: {value: {kind: 'literal', value: {type: 'scalar', value: 2}}}}],
    bindings: [{target: 'B', property: 'r', value: {operation: 'radius', socket: 'value'}}]};
  for (const bundle of [track, duplicate, relation, operation]) {
    assert.ok(validateBundle(bundle).some(d => /WRITER|CONFLICT/.test(d.code)));
    assert.throws(() => prepareScene(bundle), /WRITER|CONFLICT/);
  }
});

test('lazy expression masks avoid singular samples while selected invalid branches report their source', () => {
  const bundle = fixture(); bundle.expressions!.bindings = [{target: 'B', property: 'r',
    expression: 'mask(time > 0s, 10bp*1s/time, 0bp)',
    sourceSpan: {file: 'motion.tex', start: {line: 12, column: 5}, end: {line: 12, column: 40}}}];
  assert.equal(point(evaluate(bundle, 0)).r, 0); assert.equal(point(evaluate(bundle, 2)).r, 5);
  bundle.expressions!.bindings[0].expression = '10bp*1s/time';
  assert.throws(() => evaluate(bundle, 0), (error: any) => {
    const diagnostic = error.diagnostics?.[0]; assert.ok(diagnostic, String(error));
    assert.equal(diagnostic.sourceSpan?.file, 'motion.tex');
    assert.match(diagnostic.path ?? '', /expressions.*bindings\[0\]/); return true;
  });
});

test('runtime expression values cannot bypass property range checks', () => {
  const bundle = fixture(); bundle.expressions!.bindings = [{target: 'B', property: 'r', expression: '-time/1s * 1bp'}];
  assert.throws(() => evaluate(bundle, 1), /RANGE|range|constraints/);
  bundle.expressions!.bindings = [{target: '$camera', property: 'zoom', expression: 'time/1s'}];
  assert.throws(() => evaluate(bundle, 0), /RANGE|range|constraints/);
});

test('reverse seek, repeated overrides and independent runtimes preserve caller and frame state', () => {
  const bundle = fixture(), original = structuredClone(bundle), one = createEvaluator(bundle), two = createEvaluator(bundle);
  const parameters = {a: 0.5, shift: [3, 4] as [number, number]}, before = structuredClone(parameters);
  const reference = one(1, parameters), expected = structuredClone(reference);
  one(3); one(0, {on: false}); two(2, {amplitude: 10});
  assert.deepEqual(one(1, parameters), expected); assert.deepEqual(two(1, parameters), expected);
  reference.nodes[0].visible = false; reference.camera.zoom = 100; reference.viewport.width = 10;
  assert.deepEqual(one(1, parameters), expected); assert.deepEqual(parameters, before); assert.deepEqual(bundle, original);
  bundle.expressions!.parameters.a.default = Math.PI;
  bundle.expressions!.bindings[0].expression = 'vec2(0bp,0bp)';
  assert.deepEqual(one(1, parameters), expected); assert.deepEqual(two(1, parameters), expected);
});

test('program versions and bundle versions are exact boundaries and unknown expression names fail eagerly', () => {
  const old = fixture(); old.version = '0.2'; assert.ok(validateBundle(old).some(d => d.severity === 'error'));
  const future = fixture(); (future.expressions as any).version = 2; assert.throws(() => prepareScene(future));
  const unknown = fixture(); unknown.expressions!.bindings[0].expression = 'true ? vec2(0bp,0bp) : missing';
  assert.throws(() => prepareScene(unknown), /EXPRESSION_IDENTIFIER/);
});
