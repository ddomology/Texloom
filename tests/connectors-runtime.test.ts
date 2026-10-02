import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluate, prepareScene, createEvaluator, validateBundle, type Bundle, type InputRef, type Operation, type SpaceRef, type EvaluatedFrame, type PathNode, type PointNode} from '../src/index.ts';

const scene = {kind: 'scene'} as const;
const local = (node: string) => ({kind: 'local', node} as const);
const point = (value: [number, number], space: SpaceRef = local('edge')): InputRef => ({kind: 'literal', value: {type: 'vec2', role: 'point', space, value}});
const scalar = (value: number, unit: '1'|'bp' = '1'): InputRef => ({kind: 'literal', value: {type: 'scalar', unit, value}});
const output = (operation: string, socket: string): InputRef => ({kind: 'output', ref: {operation, socket}});
const named = (node: string, name: 'east'|'west'): InputRef => ({kind: 'anchor', source: {kind: 'node', node}, query: {kind: 'named', name}, space: scene});
function fixture(): Bundle {
  return {version: '0.3', title: 'Live connectors', units: 'bp', duration: 2, viewport: {width: 300, height: 200}, camera: {x: 0, y: 0, zoom: 1},
    resources: {text: {kind: 'vector', metrics: {width: 20, height: 8, depth: 4}, inkBounds: [0, 0, 0, 0], items: []}},
    nodes: [{id: 'edge', kind: 'path', d: 'M0 0L1 0', geometry: {contours: [{id: 'seed', start: [0, 0], segments: [{id: 's', kind: 'line', to: [1, 0]}]}]}},
      {id: 'text', kind: 'tex', resourceId: 'text', x: 0, y: 0, scale: 1},
      {id: 'ellipse', kind: 'ellipse', cx: 2, cy: 3, rx: 5, ry: 2}, {id: 'marker', kind: 'point', x: 0, y: 0, r: 1, progress: .5}],
    tracks: [], relations: [], operationGraph: {version: 1, operations: [], bindings: []}};
}
function connect(bundle: Bundle, operator: string, inputs: Operation['inputs'] = {}, space: SpaceRef = local('edge')) {
  const op: Operation = {id: 'connector', operator, version: 1, spaces: {space}, inputs: {from: point([2, 3], space), to: point([12, 9], space), ...inputs}};
  bundle.operationGraph!.operations.push(op); return op;
}
function bind(bundle: Bundle, operation = 'connector', socket = 'path', target = 'edge', property = 'geometry') {
  bundle.operationGraph!.bindings.push({target, property, value: {operation, socket}});
}
const path = (frame: EvaluatedFrame) => frame.nodes.find(n => n.id === 'edge') as PathNode;
const marker = (frame: EvaluatedFrame) => frame.nodes.find(n => n.id === 'marker') as PointNode;
const near = (actual: readonly number[], expected: readonly number[], tolerance = 1e-8) => actual.forEach((n, i) => assert.ok(Math.abs(n-expected[i]) < tolerance, `${actual} != ${expected}`));

test('connector constructors preserve exact endpoints and use absolute cubic handles', () => {
  for (const kind of ['connectStraight', 'connectOrthogonal', 'connectCubic']) {
    const b = fixture(); connect(b, kind, kind === 'connectCubic' ? {handleA: point([20, 30]), handleB: point([-4, 5])} : {}); bind(b);
    const contour = path(evaluate(b, 0)).geometry!.contours[0]; assert.equal(contour.id, 'connector'); assert.deepEqual(contour.start, [2, 3]);
    assert.deepEqual(contour.segments.at(-1)!.to, [12, 9]); assert.equal(contour.segments[0].id, 'segment-0');
    if (kind === 'connectStraight') {assert.equal(contour.segments.length, 1); assert.equal(contour.segments[0].kind, 'line');}
    if (kind === 'connectOrthogonal') {assert.equal(contour.segments.length, 2); assert.deepEqual(contour.segments[0].to, [12, 3]);}
    if (kind === 'connectCubic') {const segment = contour.segments[0]; assert.equal(segment.kind, 'cubic'); if (segment.kind === 'cubic') {assert.deepEqual(segment.c1, [20, 30]); assert.deepEqual(segment.c2, [-4, 5]);}}
  }
});

test('orthogonal route order is explicit and zero-length legs retain stable topology', () => {
  for (const order of [0, 1]) for (const to of [[12, 9], [2, 9], [2, 3]] as [number, number][]) {
    const b = fixture(); connect(b, 'connectOrthogonal', {order: scalar(order), to: point(to)}); bind(b);
    const contour = path(evaluate(b, 0)).geometry!.contours[0]; assert.equal(contour.segments.length, 2);
    assert.deepEqual(contour.segments.map(s => s.id), ['segment-0', 'segment-1']);
    assert.deepEqual(contour.segments[0].to, order === 0 ? [to[0], 3] : [2, to[1]]); assert.deepEqual(contour.segments[1].to, to);
  }
});

test('live text and ellipse anchors across transformed parents feed converted path geometry and legacy sampling', () => {
  const b = fixture(); b.nodes.push({id: 'textParent', kind: 'group', transform: {translate: [10, 20], rotate: Math.PI/2, scale: [-2, 3]}},
    {id: 'ellipseParent', kind: 'group', transform: {translate: [70, -10], scale: [2, -1]}},
    {id: 'edgeParent', kind: 'group', transform: {translate: [4, 6], scale: [2, 4]}});
  b.nodes.find(n => n.id === 'text')!.parent = 'textParent'; b.nodes.find(n => n.id === 'ellipse')!.parent = 'ellipseParent'; b.nodes[0].parent = 'edgeParent';
  b.expressions = {version: 1, parameters: {}, bindings: [{target: 'text', property: 'scale', expression: '1+time/1s'}, {target: 'ellipse', property: 'rx', expression: '5bp+time*1bp/1s'}]};
  b.operationGraph!.operations.push({id: 'toLocal', operator: 'transformPath', version: 1, spaces: {from: scene, to: local('edge')}, inputs: {
    path: output('connector', 'path'), transform: {kind: 'spaceTransform', from: scene, to: local('edge')},
  }});
  connect(b, 'connectStraight', {from: named('text', 'east'), to: named('ellipse', 'west')}, scene); bind(b, 'toLocal');
  b.relations.push({type: 'pointOnPath', source: 'edge', target: 'marker'});
  const frame = evaluate(b, 1), contour = path(frame).geometry!.contours[0];
  near(contour.start, [9, -16.5]); near(contour.segments[0].to, [29, -4.75]); near([marker(frame).x, marker(frame).y], [42, -36.5]);
  b.camera = {x: 500, y: -700, zoom: 9}; const moved = evaluate(b, 1); assert.deepEqual(path(moved).geometry, path(frame).geometry);
  near([marker(moved).x, marker(moved).y], [42, -36.5]);
});

test('connector point references wait for upstream operations and current generated geometry drives downstream graph sampling', () => {
  const b = fixture();
  b.operationGraph!.operations.push({id: 'sample', operator: 'sampleCurve', version: 2, spaces: {space: scene}, inputs: {path: {kind: 'path', node: 'edge', space: scene}, parameter: scalar(.5), mode: scalar(0)}});
  connect(b, 'connectStraight', {from: output('mid', 'position')}); bind(b); bind(b, 'sample', 'position', 'marker', 'position');
  b.operationGraph!.operations.push({id: 'mid', operator: 'midpoint', version: 1, spaces: {space: local('edge')}, inputs: {a: point([0, 1]), b: point([4, 5])}});
  const frame = evaluate(b, 0); near([marker(frame).x, marker(frame).y], [7, 6]);
});

test('connector geometry and stable IDs are independent across seeks, runtimes, and authored input changes', () => {
  const b = fixture(); connect(b, 'connectCubic', {to: {kind: 'pointExpression', expression: 'vec2(12bp+time*2bp/1s,9bp)', space: local('edge')}, handleA: point([4, -3]), handleB: point([8, 20])}); bind(b);
  const authored = structuredClone(b), first = prepareScene(b), second = createEvaluator(b), original = first.sample(0), saved = structuredClone(original);
  const later = first.sample(2); near(path(later).geometry!.contours[0].segments[0].to, [16, 9]);
  assert.deepEqual(first.sample(0), saved); assert.deepEqual(second(0), saved); assert.deepEqual(second(2), later); assert.deepEqual(b, authored);
  assert.deepEqual(path(later).geometry!.contours.map(c => [c.id, ...c.segments.map(s => s.id)]), path(original).geometry!.contours.map(c => [c.id, ...c.segments.map(s => s.id)]));
  path(original).geometry!.contours[0].start[0] = 999; b.operationGraph!.operations[0].inputs.from = point([999, 999]);
  assert.deepEqual(first.sample(0), saved); assert.deepEqual(second(0), saved);
});

test('connector policies, units, point roles, and spaces fail with authored source diagnostics', () => {
  const span = {file: 'connectors.tex', start: {line: 4, column: 1}, end: {line: 4, column: 80}};
  const cases: Operation['inputs'][] = [{order: scalar(2)}, {order: scalar(.5)}, {order: scalar(1, 'bp')}, {from: point([0, 0], scene)},
    {from: {kind: 'literal', value: {type: 'vec2', role: 'vector', space: local('edge'), value: [0, 0]}}}];
  for (const inputs of cases) {
    const b = fixture(); connect(b, 'connectOrthogonal', inputs).sourceSpan = span; bind(b);
    assert.throws(() => evaluate(b, 0), (e: any) => {assert.ok(e.diagnostics?.length, String(e)); assert.deepEqual(e.diagnostics[0].sourceSpan, span); return true;});
  }
  const missing = fixture(); connect(missing, 'connectCubic'); bind(missing);
  assert.ok(validateBundle(missing).some(d => d.code === 'OPERATION_REQUIRED_INPUT'));
});

test('connector geometry dependencies expose self-cycles and whole-path writer conflicts', () => {
  const cyclic = fixture(); connect(cyclic, 'connectStraight', {from: output('sample', 'position')}); bind(cyclic);
  cyclic.operationGraph!.operations.push({id: 'sample', operator: 'sampleCurve', version: 2, spaces: {space: local('edge')}, inputs: {path: {kind: 'path', node: 'edge', space: local('edge')}, parameter: scalar(.5)}});
  assert.throws(() => prepareScene(cyclic), /CYCLE/);
  const conflict = fixture(); connect(conflict, 'connectStraight'); bind(conflict); conflict.tracks.push({target: 'edge', property: 'geometry.seed.s.to', keys: [[0, [2, 4]]]});
  assert.ok(validateBundle(conflict).some(d => /WRITER|CONFLICT/.test(d.code))); assert.throws(() => prepareScene(conflict), /WRITER|CONFLICT/);
});
