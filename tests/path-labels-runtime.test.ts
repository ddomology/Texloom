import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluate, prepareScene, createEvaluator, validateBundle, worldMatrix, type Bundle, type InputRef, type Operation, type PathGeometry, type TexNode, type EvaluatedFrame, type PointNode} from '../src/index.ts';

const labelSpace = {kind: 'local', node: 'label'} as const;
const parentSpace = {kind: 'parent', node: 'label'} as const;
const scene = {kind: 'scene'} as const;
const scalar = (value: number, unit: '1'|'bp' = '1'): InputRef => ({kind: 'literal', value: {type: 'scalar', value, unit}});
const line = (start: [number, number], to: [number, number]): PathGeometry => ({contours: [{id: 'c', start, segments: [{id: 's', kind: 'line', to}]}]});
function fixture(geometry = line([0, 0], [100, 0])): Bundle {
  return {version: '0.3', title: 'Metric path labels', duration: 2, units: 'bp', viewport: {width: 300, height: 200}, camera: {x: 0, y: 0, zoom: 1},
    resources: {text: {kind: 'vector', metrics: {width: 20, height: 8, depth: 4}, inkBounds: [-30, -20, 100, 80], items: [], sourceTex: 'phantom'}},
    nodes: [{id: 'path', kind: 'path', geometry, d: 'M0 0L1 0'}, {id: 'label', kind: 'tex', resourceId: 'text', x: 300, y: -200, scale: 1, transform: {translate: [999, -888], rotate: .4}},
      {id: 'observed', kind: 'point', x: 0, y: 0, r: 1}, {id: 'distance', kind: 'point', x: 0, y: 0, r: 1}],
    tracks: [], relations: [], operationGraph: {version: 1, operations: [], bindings: []}};
}
function place(b: Bundle, inputs: Operation['inputs'] = {}) {
  const op: Operation = {id: 'place', operator: 'placePathLabel', version: 1, spaces: {space: parentSpace, label: labelSpace}, inputs: {
    path: {kind: 'path', node: 'path', space: parentSpace}, anchor: {kind: 'textAnchor', node: 'label', anchor: 'center'}, ...inputs,
  }};
  b.operationGraph!.operations.push(op);
  for (const property of ['transform', 'x', 'y']) b.operationGraph!.bindings.push({target: 'label', property, value: {operation: 'place', socket: property}});
  return op;
}
function observe(b: Bundle, name: 'center'|'base') {
  const input: InputRef = {kind: 'anchor', source: {kind: 'node', node: 'label'}, query: {kind: 'named', name}, space: scene};
  b.operationGraph!.operations.unshift({id: 'observe', operator: 'midpoint', version: 1, spaces: {space: scene}, inputs: {a: input, b: structuredClone(input)}});
  b.operationGraph!.bindings.push({target: 'observed', property: 'position', value: {operation: 'observe', socket: 'position'}});
}
const label = (f: EvaluatedFrame) => f.nodes.find(n => n.id === 'label') as TexNode;
const observed = (f: EvaluatedFrame) => f.nodes.find(n => n.id === 'observed') as PointNode;
const near = (actual: readonly number[], expected: readonly number[], tolerance = 1e-8) => actual.forEach((n, i) => assert.ok(Number.isFinite(n) && Math.abs(n-expected[i]) <= tolerance, `${actual} != ${expected}`));
const matrix = (f: EvaluatedFrame) => worldMatrix('label', new Map(f.nodes.map(n => [n.id, n])));

test('text metric center and baseline anchors are placed without reading authored x/y or the old pose', () => {
  for (const name of ['center', 'base'] as const) {
    const b = fixture(); place(b, {anchor: {kind: 'textAnchor', node: 'label', anchor: name}, offset: scalar(5, 'bp')}); observe(b, name);
    const frame = evaluate(b, 0); assert.equal(label(frame).x, 0); assert.equal(label(frame).y, 0);
    near(matrix(frame), [1, 0, 0, 1, 40, name === 'center' ? 7 : 5]); near([observed(frame).x, observed(frame).y], [50, 5]);
    // Metrics use the logical text box, even for empty/phantom artwork with wildly different ink bounds.
    assert.equal(label(frame).scale, 1); assert.deepEqual(b.nodes[1].transform, {translate: [999, -888], rotate: .4});
  }
});

test('live text scale precedes metric anchoring and pose writes do not create a self-dependency', () => {
  const b = fixture(); b.expressions = {version: 1, parameters: {}, bindings: [{target: 'label', property: 'scale', expression: '1+time/1s'}]};
  place(b); observe(b, 'center'); const run = prepareScene(b), f = run.sample(1);
  assert.equal(label(f).scale, 2); near(matrix(f), [1, 0, 0, 1, 30, 4]); near([observed(f).x, observed(f).y], [50, 0]);
  near(run.sample(0).anchors!['$.operationGraph.operations[1].inputs.anchor'].position, [10, -2]);
  near(f.anchors!['$.operationGraph.operations[1].inputs.anchor'].position, [20, -4]);
});

test('tangent and upright rotation treat negative scaleX as the baseline direction and keep parent-space guarantees', () => {
  for (const sx of [1, -2]) for (const rotation of [0, 1, 2]) {
    const b = fixture(line([100, 0], [0, 0])); place(b, {anchor: {kind: 'textAnchor', node: 'label', anchor: 'base'}, rotation: scalar(rotation), scaleX: scalar(sx), scaleY: scalar(3), offset: scalar(4, 'bp')}); observe(b, 'base');
    const f = evaluate(b, 0), m = matrix(f); near([observed(f).x, observed(f).y], [50, -4]);
    const desired = rotation === 0 ? Math.sign(sx) : rotation === 1 ? -1 : 1;
    near([m[0], m[1]], [desired*Math.abs(sx), 0]); near([Math.hypot(m[0], m[1]), Math.hypot(m[2], m[3])], [Math.abs(sx), 3]);
  }
});

test('path-label poses inherit a rotated reflected nonuniform parent while placing the chosen anchor correctly', () => {
  const b = fixture(line([0, 0], [30, 40])); b.nodes.push({id: 'chart', kind: 'group', transform: {translate: [10, 20], rotate: Math.PI/2, scale: [-2, 3]}});
  b.nodes.find(n => n.id === 'path')!.parent = 'chart'; b.nodes.find(n => n.id === 'label')!.parent = 'chart';
  place(b, {anchor: {kind: 'textAnchor', node: 'label', anchor: 'base'}, rotation: scalar(1), offset: scalar(10, 'bp')}); observe(b, 'base');
  const f = evaluate(b, 0); near([observed(f).x, observed(f).y], [-68, 6]);
  near(matrix(f).slice(0, 2), [-2.4, -1.2]);
  b.camera = {x: 600, y: -200, zoom: 8}; near([observed(evaluate(b, 0)).x, observed(evaluate(b, 0)).y], [-68, 6]);
});

test('length and segment-parameter placement differ and an exact elbow uses the following tangent', () => {
  const elbow: PathGeometry = {contours: [{id: 'elbow', start: [0, 0], segments: [{id: 'first', kind: 'line', to: [30, 0]}, {id: 'second', kind: 'line', to: [30, 10]}]}]};
  for (const [mode, parameter, expected] of [[1, .5, [20, 5]], [0, .5, [25, 0]], [1, .75, [25, 0]]] as const) {
    const b = fixture(elbow); place(b, {anchor: {kind: 'textAnchor', node: 'label', anchor: 'base'}, mode: scalar(mode), parameter: scalar(parameter), rotation: scalar(1), offset: scalar(5, 'bp')}); observe(b, 'base');
    const f = evaluate(b, 0); near([observed(f).x, observed(f).y], expected);
    near(matrix(f).slice(0, 2), mode === 1 && parameter === .5 ? [1, 0] : [0, 1]);
  }
});

test('a wide label on a short path keeps authored scale and deterministic parameter overrides across independent seeks', () => {
  const b = fixture(line([0, 0], [2, 0])); b.expressions = {version: 1, parameters: {gap: {type: 'scalar', unit: 'bp', default: 0}}, bindings: []};
  place(b, {parameter: {kind: 'expression', expression: 'time/2s', unit: '1'}, offset: {kind: 'expression', expression: 'gap', unit: 'bp'}}); observe(b, 'center');
  const authored = structuredClone(b), first = prepareScene(b), second = createEvaluator(b), f0 = first.sample(0), saved = structuredClone(f0);
  const f2 = first.sample(2, {gap: 3}); near([observed(f2).x, observed(f2).y], [2, 3]); assert.equal(label(f2).scale, 1);
  near(matrix(f2).slice(0, 4), [1, 0, 0, 1]); assert.deepEqual(first.sample(0), saved); assert.deepEqual(second(0), saved); assert.deepEqual(second(2, {gap: 3}), f2);
  assert.deepEqual(b, authored);
  label(f0).transform!.translate![0] = 999; b.resources.text = {...b.resources.text, metrics: {width: 500, height: 1, depth: 1}} as typeof b.resources.text;
  assert.deepEqual(first.sample(0), saved); assert.deepEqual(second(0), saved); assert.deepEqual(authored.nodes, b.nodes);
});

test('path-label domain, space, and zero-tangent errors retain their authored source span', () => {
  const span = {file: 'labels.tex', start: {line: 9, column: 2}, end: {line: 9, column: 90}};
  const cases: Operation['inputs'][] = [{parameter: scalar(-.1)}, {parameter: scalar(1.1)}, {rotation: scalar(3)}, {mode: scalar(2)}, {scaleX: scalar(0)}, {scaleY: scalar(0)},
    {offset: scalar(2)}, {contour: scalar(.5)}, {tolerance: scalar(0, 'bp')}, {anchor: {kind: 'literal', value: {type: 'vec2', role: 'point', space: scene, value: [0, 0]}}}];
  for (const inputs of cases) {
    const b = fixture(); place(b, inputs).sourceSpan = span;
    assert.throws(() => evaluate(b, 0), (e: any) => {assert.ok(e.diagnostics?.length, String(e)); assert.deepEqual(e.diagnostics[0].sourceSpan, span); return true;});
  }
  const degenerate = fixture(line([2, 3], [2, 3])); place(degenerate).sourceSpan = span;
  assert.throws(() => evaluate(degenerate, 0), (e: any) => {assert.match(e.diagnostics?.[0]?.code ?? '', /TANGENT|DEGENERATE/); assert.deepEqual(e.diagnostics[0].sourceSpan, span); return true;});
});

test('metrics-only anchors allow full-pose binding but additional pose writers and actual geometry cycles are rejected', () => {
  for (const property of ['x', 'transform.rotate']) {
    const b = fixture(); place(b); b.tracks.push({target: 'label', property, keys: [[0, 1]]});
    assert.ok(validateBundle(b).some(d => /WRITER|CONFLICT/.test(d.code))); assert.throws(() => prepareScene(b), /WRITER|CONFLICT/);
  }
  const cyclic = fixture(); place(cyclic);
  cyclic.operationGraph!.operations.push({id: 'loop', operator: 'connectStraight', version: 1, spaces: {space: {kind: 'local', node: 'path'}}, inputs: {
    from: {kind: 'anchor', source: {kind: 'node', node: 'label'}, query: {kind: 'named', name: 'center'}, space: {kind: 'local', node: 'path'}},
    to: {kind: 'literal', value: {type: 'vec2', role: 'point', space: {kind: 'local', node: 'path'}, value: [100, 0]}},
  }});
  cyclic.operationGraph!.bindings.push({target: 'path', property: 'geometry', value: {operation: 'loop', socket: 'path'}});
  assert.throws(() => prepareScene(cyclic), /CYCLE/);
});

test('a different node parent-space alias cannot be used as the label transform destination', () => {
  const b = fixture(), operation = place(b), wrongParent = {kind: 'parent', node: 'distance'} as const;
  // Both nodes currently have the identity scene parent, but their authored chart identities are distinct.
  operation.spaces.space = wrongParent;
  operation.inputs.path = {kind: 'path', node: 'path', space: wrongParent};
  const errors = validateBundle(b);
  assert.ok(errors.some(d => d.code === 'OPERATION_SPACE_MISMATCH' && d.path === '$.operationGraph.bindings[0].value'));
  assert.throws(() => prepareScene(b), /OPERATION_SPACE_MISMATCH/);
});
