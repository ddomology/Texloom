import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluate, createEvaluator, prepareScene, validateBundle, validateFieldProgram,
  type Bundle, type PointNode, type LineNode, type PathNode} from '../src/index.ts';

const targets = () => [{element: 'start', target: 'p0'}, {element: 'mid', target: 'p1'}, {element: 'end', target: 'p2'}];
function fixture(): Bundle {
  return {version: '0.3', title: 'Curve fields', duration: 2, units: 'bp', viewport: {width: 300, height: 200},
    camera: {x: 0, y: 0, zoom: 1}, resources: {}, tracks: [], relations: [],
    nodes: [{id: 'curve', kind: 'path', d: 'M0 0', geometry: {contours: [{id: 'c', start: [0, 0], segments: [{id: 's', kind: 'line', to: [100, 0]}]}]}},
      ...['p0', 'p1', 'p2'].map(id => ({id, kind: 'point' as const, x: 0, y: 0, r: 2}))],
    expressions: {version: 1, parameters: {shift: {type: 'scalar', unit: 'bp', default: 10}}, bindings: []},
    fields: {version: 1, domains: [{id: 'samples', geometry: 'curve', domain: 'curve-sample', samples: [
      {id: 'start', parameter: 0}, {id: 'mid', parameter: 0.5}, {id: 'end', parameter: 1},
    ]}], operations: [
      {id: 'before', domain: 'samples', kind: 'capture', expression: 'position'},
      {id: 'moved', domain: 'samples', kind: 'setPosition', expression: 'position + vec2(shift,20bp*time/1s)'},
      {id: 'after', domain: 'samples', kind: 'evaluate', expression: 'position'},
      {id: 'original', domain: 'samples', kind: 'evaluate', expression: 'position', position: 'original'},
    ], bindings: [{domain: 'samples', field: 'after', property: 'position', targets: targets()}]}};
}
const p = (frame: ReturnType<typeof evaluate>, id = 'p1') => frame.nodes.find(n => n.id === id) as PointNode;
function near(actual: number[], expected: number[]) { actual.forEach((x, i) => assert.ok(Math.abs(x - expected[i]) < 1e-9, `${actual} != ${expected}`)); }

test('fields capture tracked geometry, update datasets and expose immutable before/after/original values', () => {
  const b = fixture(), authored = structuredClone(b);
  b.tracks.push({target: 'curve', property: 'geometry.c.s.to', keys: [[0, [100, 0]], [2, [100, 20]]]});
  const f = evaluate(b, 2);
  assert.deepEqual(f.fields!.attributes.before.values.mid, [50, 10]);
  assert.deepEqual(f.fields!.attributes.after.values.mid, [60, 50]);
  assert.deepEqual(f.fields!.attributes.original.values.mid, [50, 0]);
  near([p(f).x, p(f).y], [60, 50]);
  assert.deepEqual((f.nodes[0] as PathNode).geometry!.contours[0].segments[0].to, [100, 20]);
  assert.deepEqual((b.nodes[0] as PathNode).geometry, (authored.nodes[0] as PathNode).geometry);
  assert.ok(Object.isFrozen(f.fields!.contexts.samples.elements[0].position));
  assert.throws(() => { (f.fields!.attributes.before.values.mid as any)[0] = 999; }, TypeError);
});

test('field positions convert source local coordinates through reflected parents into target local space', () => {
  const b = fixture();
  b.nodes.push({id: 'sourceParent', kind: 'group', transform: {translate: [10, 20], rotate: Math.PI / 2, scale: [-2, 3]}},
    {id: 'targetParent', kind: 'group', transform: {translate: [4, 8], scale: [2, -2]}});
  b.nodes[0].parent = 'sourceParent';
  for (const n of b.nodes.filter(n => n.kind === 'point')) n.parent = 'targetParent';
  b.camera = {x: 900, y: -400, zoom: 5};
  const result = p(evaluate(b, 0));
  // Dataset midpoint (60,0) -> scene (10,-100) -> target local (3,54).
  near([result.x, result.y], [3, 54]);
});

test('fields run after expression deformation and before dependent legacy line relations', () => {
  const b = fixture(); b.nodes.push({id: 'line', kind: 'line', x1: 0, y1: 0, x2: 0, y2: 0});
  b.expressions!.bindings = [{target: 'curve', property: 'geometry.c.s.to', expression: 'vec2(100bp,20bp*time/1s)'}];
  b.relations = [{type: 'lineBetween', target: 'line', a: 'p0', b: 'p2'}];
  const f = evaluate(b, 2), line = f.nodes.find(n => n.id === 'line') as LineNode;
  near([line.x1, line.y1, line.x2, line.y2], [10, 40, 110, 80]);
});

test('one field program keeps two equal-sized geometries distinct and refuses cross-domain references', () => {
  const b = fixture();
  b.nodes.push({id: 'otherCurve', kind: 'path', d: 'M0 0', geometry: {contours: [{id: 'c', start: [1000, 0], segments: [{id: 's', kind: 'line', to: [1200, 0]}]}]}},
    {id: 'otherPoint', kind: 'point', x: 0, y: 0, r: 2});
  b.fields!.domains.push({...structuredClone(b.fields!.domains[0]), id: 'other', geometry: 'otherCurve'});
  b.fields!.operations.push({id: 'otherPosition', domain: 'other', kind: 'evaluate', expression: 'position'});
  b.fields!.bindings.push({domain: 'other', field: 'otherPosition', property: 'position', targets: [{element: 'mid', target: 'otherPoint'}]});
  const f = evaluate(b, 0); near([p(f).x, p(f).y], [60, 0]); near([p(f, 'otherPoint').x, p(f, 'otherPoint').y], [1100, 0]);
  b.fields!.operations[b.fields!.operations.length - 1].expression = 'before';
  assert.ok(validateBundle(b).some(d => d.code === 'FIELD_DOMAIN_MISMATCH'));
  assert.throws(() => prepareScene(b), /FIELD_DOMAIN_MISMATCH/);
});

test('normalized scalar colors clamp explicitly while radius, opacity and visibility use typed values', () => {
  const b = fixture(); b.fields!.operations.push(
    {id: 'color', domain: 'samples', kind: 'evaluate', expression: '2*parameter-0.5'},
    {id: 'radius', domain: 'samples', kind: 'evaluate', expression: '2bp+4bp*parameter'},
    {id: 'alpha', domain: 'samples', kind: 'evaluate', expression: 'parameter'},
    {id: 'shown', domain: 'samples', kind: 'evaluate', expression: 'parameter >= 0.5'},
  );
  b.fields!.bindings.push(
    {domain: 'samples', field: 'color', property: 'style.fill', targets: targets(), ramp: {from: '#000000', to: '#ffffff'}},
    {domain: 'samples', field: 'radius', property: 'r', targets: targets()},
    {domain: 'samples', field: 'alpha', property: 'style.opacity', targets: targets()},
    {domain: 'samples', field: 'shown', property: 'visible', targets: targets()},
  );
  const f = evaluate(b, 0), points = ['p0', 'p1', 'p2'].map(id => p(f, id));
  assert.deepEqual(points.map(n => n.style?.fill), ['#000000', '#808080', '#ffffff']);
  assert.deepEqual(points.map(n => n.r), [2, 4, 6]); assert.deepEqual(points.map(n => n.style?.opacity), [0, 0.5, 1]);
  assert.deepEqual(points.map(n => n.visible), [false, true, true]);
});

test('parameter overrides, reverse time and independent runtimes never change captures or caller state', () => {
  const b = fixture(), original = structuredClone(b), one = createEvaluator(b), two = createEvaluator(b);
  const parameters = {shift: 30}, f = one(1, parameters), expected = structuredClone(f);
  near([p(f).x, p(f).y], [80, 20]); one(2); one(0); two(2, {shift: 0});
  assert.deepEqual(one(1, parameters), expected); assert.deepEqual(two(1, parameters), expected);
  near([p(one(0)).x, p(one(0)).y], [60, 0]); assert.deepEqual(parameters, {shift: 30}); assert.deepEqual(b, original);
  b.fields!.operations[1].expression = 'vec2(0bp,0bp)';
  assert.deepEqual(one(1, parameters), expected); assert.deepEqual(two(1, parameters), expected);
});

test('binding mapping uses sample IDs when samples are reordered and reports unknown IDs', () => {
  const b = fixture(), before = evaluate(b, 0); b.fields!.domains[0].samples!.reverse();
  const after = evaluate(b, 0);
  near([p(after, 'p0').x, p(after, 'p1').x, p(after, 'p2').x], [10, 60, 110]);
  assert.equal(before.fields!.contexts.samples.domain.key, after.fields!.contexts.samples.domain.key);
  b.fields!.bindings[0].targets[0].element = 'missing';
  assert.ok(validateBundle(b).some(d => d.code === 'FIELD_TARGET'));
});

test('field writers cannot overlap tracks, expressions, operation bindings or legacy relations', () => {
  const track = fixture(); track.tracks.push({target: 'p0', property: 'x', keys: [[0, 0]]});
  const expression = fixture(); expression.expressions!.bindings.push({target: 'p0', property: 'position', expression: 'vec2(0bp,0bp)'});
  const graph = fixture(); graph.operationGraph = {version: 1, operations: [{id: 'point', operator: 'pointValue', version: 1,
    spaces: {space: {kind: 'scene'}}, inputs: {value: {kind: 'literal', value: {type: 'vec2', role: 'point', space: {kind: 'scene'}, value: [0, 0]}}}}],
    bindings: [{target: 'p0', property: 'position', value: {operation: 'point', socket: 'value'}}]};
  const relation = fixture(); relation.relations.push({type: 'pointOnPath', target: 'p0', source: 'curve'});
  for (const b of [track, expression, graph, relation]) {
    assert.ok(validateBundle(b).some(d => /WRITER|CONFLICT/.test(d.code)));
    assert.throws(() => prepareScene(b), /WRITER|CONFLICT/);
  }
});

test('forward and cyclic attribute references fail with authored operation source context', () => {
  const b = fixture(); b.fields!.operations[0].expression = 'after';
  b.fields!.operations[0].sourceSpan = {file: 'dataset.tex', start: {line: 9, column: 1}, end: {line: 9, column: 20}};
  const diagnostic = validateBundle(b).find(d => d.code === 'EXPRESSION_IDENTIFIER');
  assert.equal(diagnostic?.sourceSpan?.file, 'dataset.tex'); assert.throws(() => prepareScene(b), /EXPRESSION_IDENTIFIER/);
});

test('malformed bindings return diagnostics instead of raw coercion or property-access errors', () => {
  for (const changes of [{property: 42}, {field: {toString: null}}]) {
    const b = fixture(); b.tracks.push({target: 'p0', property: 'x', keys: [[0, 0]]});
    Object.assign(b.fields!.bindings[0], changes);
    assert.doesNotThrow(() => validateBundle(b)); assert.doesNotThrow(() => validateFieldProgram(b.fields!, b));
    assert.ok(validateBundle(b).some(d => d.severity === 'error'));
    assert.ok(validateFieldProgram(b.fields!, b).some(d => d.severity === 'error'));
  }
  const b = fixture(); b.fields!.operations.push({id: 'color', domain: 'samples', kind: 'evaluate', expression: 'parameter'});
  b.fields!.bindings = [{domain: 'samples', field: 'color', property: 'style.fill', targets: targets(), ramp: {from: ['#00ff00'], to: '#000000'} as any}];
  assert.ok(validateBundle(b).some(d => d.code === 'FIELD_COLOR_RAMP'));
});

test('field bindings retain scalar range checks and reject incompatible dataset positions', () => {
  const b = fixture(); b.fields!.operations.push({id: 'radius', domain: 'samples', kind: 'evaluate', expression: '-1bp'});
  b.fields!.bindings = [{domain: 'samples', field: 'radius', property: 'r', targets: targets()}];
  assert.throws(() => evaluate(b, 0), /RANGE|constraints/);
  b.fields!.operations[1].expression = 'vec2(1,2)';
  assert.ok(validateBundle(b).some(d => d.code === 'FIELD_POSITION_TYPE'));
});
