import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluate, createEvaluator, prepareScene, validateBundle, validateOperationGraph, prepareOperationGraph, validateExpressionProgram,
  type Bundle, type EvaluatedFrame, type InputRef, type Operation, type SpaceRef, type PointNode, type LineNode, type ExpressionProgram,
} from '../src/index.ts';

const scene = {kind: 'scene'} as const;
const local = (node: string) => ({kind: 'local', node} as const);
const parent = (node: string) => ({kind: 'parent', node} as const);
const plot = (node: string) => ({kind: 'plot', node} as const);
const read = (node: string, space: SpaceRef = scene): InputRef => ({kind: 'node', node, property: 'position', space});
const scalar = (value: number, unit: '1'|'bp'|'s'|'rad' = '1'): InputRef => ({kind: 'literal', value: {type: 'scalar', value, unit}});
const point = (value: [number, number], space: SpaceRef = scene): InputRef => ({kind: 'literal', value: {type: 'vec2', role: 'point', space, value}});
const output = (operation: string, socket = 'position'): InputRef => ({kind: 'output', ref: {operation, socket}});
const expression = (value: string, unit: '1'|'bp'|'s'|'rad' = '1'): InputRef => ({kind: 'expression', expression: value, unit});
const transform = (from: SpaceRef, to: SpaceRef): InputRef => ({kind: 'spaceTransform', from, to});
function fixture(): Bundle {
  return {version: '0.3', title: 'Coordinate expressions', duration: 2, units: 'bp', viewport: {width: 300, height: 250},
    camera: {x: 0, y: 0, zoom: 1}, resources: {}, tracks: [], relations: [],
    nodes: [
      {id: 'A', kind: 'point', x: 1, y: 2, r: 1}, {id: 'B', kind: 'point', x: 7, y: 10, r: 1},
      {id: 'C', kind: 'point', x: 5, y: 3, r: 1}, {id: 'M', kind: 'point', x: 0, y: 0, r: 1},
      {id: 'G', kind: 'point', x: 0, y: 0, r: 1}, {id: 'edge', kind: 'line', x1: 0, y1: 0, x2: 0, y2: 0},
    ], operationGraph: {version: 1, operations: [], bindings: []}};
}
const p = (b: Bundle, id: string) => b.nodes.find(n => n.id === id) as PointNode;
const at = (f: EvaluatedFrame, id: string) => f.nodes.find(n => n.id === id) as PointNode;
function near(actual: readonly number[], expected: readonly number[], tolerance = 1e-9) {
  assert.equal(actual.length, expected.length);
  actual.forEach((v, i) => assert.ok(Number.isFinite(v) && Math.abs(v - expected[i]) <= tolerance, `${actual} != ${expected}`));
}
function op(id: string, operator: string, inputs: Operation['inputs'], space: SpaceRef = scene): Operation {
  return {id, operator, version: 1, inputs, spaces: {space}};
}
function bind(b: Bundle, operation: string, target: string, property = 'position', socket = 'position') {
  b.operationGraph!.bindings.push({target, property, value: {operation, socket}});
}
function converted(b: Bundle, id: string, input: InputRef, from: SpaceRef, target = 'M') {
  b.operationGraph!.operations.push({id, operator: 'transformPoint', version: 1, spaces: {from, to: scene},
    inputs: {point: input, transform: transform(from, scene)}});
  bind(b, id, target);
}

test('moving triangle coordinates combine tracked and expression positions with shared operation outputs', () => {
  const b = fixture(); Object.assign(p(b, 'A'), {x: 0, y: 0}); Object.assign(p(b, 'C'), {x: 2, y: 8});
  b.tracks = [{target: 'A', property: 'x', keys: [[0, 0], [2, 4]]}];
  b.expressions = {version: 1, parameters: {}, bindings: [{target: 'B', property: 'position', expression: 'vec2(6bp,4bp*time/1s)'}]};
  b.operationGraph!.operations = [op('centroid', 'lerpPoint', {a: output('mid'), b: read('C'), factor: scalar(1 / 3)}),
    op('mid', 'midpoint', {a: read('A'), b: read('B')})];
  bind(b, 'mid', 'M'); bind(b, 'centroid', 'G'); bind(b, 'mid', 'edge', 'start'); bind(b, 'centroid', 'edge', 'end');
  const f = evaluate(b, 1), edge = f.nodes.find(n => n.id === 'edge') as LineNode;
  near([at(f, 'M').x, at(f, 'M').y], [4, 2]); near([at(f, 'G').x, at(f, 'G').y], [10 / 3, 4]);
  near([edge.x1, edge.y1, edge.x2, edge.y2], [4, 2, 10 / 3, 4]);
});

test('coordinate operations and both projection outputs bind to real scene properties', () => {
  const cases: [string, Operation['inputs'], [number, number]][] = [
    ['midpoint', {a: read('A'), b: read('B')}, [4, 6]],
    ['lerpPoint', {a: read('A'), b: read('B')}, [4, 6]],
    ['lerpPoint', {a: read('A'), b: read('B'), factor: scalar(1.5)}, [10, 14]],
    ['pointTowards', {a: read('A'), b: read('B'), distance: scalar(5, 'bp')}, [4, 6]],
    ['rotatePoint', {point: read('A'), center: point([0, 0]), angle: scalar(Math.PI / 2, 'rad')}, [-2, 1]],
    ['projectLine', {point: read('C'), a: read('A'), b: read('B')}, [2.92, 4.56]],
    ['projectSegment', {point: point([13, 18]), a: read('A'), b: read('B')}, [7, 10]],
  ];
  for (const [name, inputs, expected] of cases) {
    const b = fixture(); b.operationGraph!.operations.push(op('calc', name, inputs)); bind(b, 'calc', 'M');
    if (name.startsWith('project')) bind(b, 'calc', 'M', 'style.opacity', 'parameter');
    const f = evaluate(b, 0); near([at(f, 'M').x, at(f, 'M').y], expected);
    if (name.startsWith('project')) near([at(f, 'M').style!.opacity!], [name === 'projectLine' ? 0.32 : 1]);
  }
});

test('node reads and scene sinks compose reflected, rotated, nonuniform ancestor and local transforms', () => {
  const b = fixture();
  b.nodes.push({id: 'sourceParent', kind: 'group', transform: {translate: [10, 20], rotate: Math.PI / 2, scale: [-2, 3]}},
    {id: 'targetParent', kind: 'group', transform: {translate: [-4, 3], rotate: -Math.PI / 2, scale: [2, -1]}});
  Object.assign(p(b, 'A'), {x: 3, y: 4, parent: 'sourceParent', transform: {translate: [2, -1]}});
  Object.assign(p(b, 'B'), {x: 9, y: 18});
  Object.assign(p(b, 'M'), {parent: 'targetParent', transform: {translate: [1, 2]}});
  b.operationGraph!.operations.push(op('mid', 'midpoint', {a: read('A'), b: read('B')})); bind(b, 'mid', 'M');
  b.camera = {x: 500, y: -200, zoom: 7, rotation: 1.4};
  const f = evaluate(b, 0); near([at(f, 'M').x, at(f, 'M').y], [-6.5, -11]);
  b.camera = {x: 0, y: 0, zoom: 1};
  near([at(evaluate(b, 0), 'M').x, at(evaluate(b, 0), 'M').y], [-6.5, -11]);
});

test('parent, local and plot coordinates convert explicitly and keep distinct declared spaces', () => {
  for (const [space, expected] of [[parent('A'), [1, 16]], [local('A'), [4, 12]], [plot('axes'), [1, 16]]] as const) {
    const b = fixture(); b.nodes.push({id: 'axes', kind: 'group', transform: {translate: [10, 20], rotate: Math.PI / 2, scale: [-2, 3]}});
    Object.assign(p(b, 'A'), {parent: 'axes', transform: {translate: [2, -1]}});
    converted(b, 'convert', point([2, 3], space), space);
    const f = evaluate(b, 0); near([at(f, 'M').x, at(f, 'M').y], expected);
  }
  const b = fixture(); b.nodes.push({id: 'axes', kind: 'group', transform: {translate: [10, 20], rotate: Math.PI / 2, scale: [-2, 3]}});
  Object.assign(p(b, 'A'), {x: 3, y: 4, parent: 'axes', transform: {translate: [2, -1]}});
  b.operationGraph!.operations.push(op('mid', 'midpoint', {a: read('A', parent('A')), b: point([0, 0], parent('A'))}, parent('A')));
  converted(b, 'convert', output('mid'), parent('A'));
  const f = evaluate(b, 0); near([at(f, 'M').x, at(f, 'M').y], [5.5, 15]);
});

test('dynamic ancestor matrices from graph, expression and track writers precede node-position reads', () => {
  const b = fixture(); b.nodes.push({id: 'axes', kind: 'group'});
  Object.assign(p(b, 'A'), {x: 2, y: 4, parent: 'axes'}); Object.assign(p(b, 'B'), {x: 0, y: 0});
  b.tracks.push({target: 'axes', property: 'transform.scale', keys: [[0, [1, 1]], [2, [3, 5]]]});
  b.expressions = {version: 1, parameters: {}, bindings: [{target: 'axes', property: 'transform.rotate', expression: 'pi*1rad*time/(2s)'}]};
  b.operationGraph!.operations = [op('aMid', 'midpoint', {a: read('A'), b: read('B')}),
    {id: 'zMove', operator: 'vectorValue', version: 1, spaces: {space: scene}, inputs: {
      value: {kind: 'literal', value: {type: 'vec2', role: 'vector', space: scene, value: [10, 20]}},
    }}];
  bind(b, 'aMid', 'M'); bind(b, 'zMove', 'axes', 'transform.translate', 'value');
  const f = evaluate(b, 1); near([at(f, 'M').x, at(f, 'M').y], [-1, 12]);
});

test('node inputs observe legacy relation and field position writes before coordinate evaluation', () => {
  const b = fixture(); b.nodes.push({id: 'ellipse', kind: 'ellipse', cx: 10, cy: 20, rx: 6, ry: 8},
    {id: 'curve', kind: 'path', d: 'M10 30L30 30', geometry: {contours: [{id: 'c', start: [10, 30], segments: [{id: 's', kind: 'line', to: [30, 30]}]}]}});
  p(b, 'A').phase = Math.PI / 2; b.relations = [{type: 'pointOnEllipse', target: 'A', source: 'ellipse'}];
  b.fields = {version: 1, domains: [{id: 'sampled', geometry: 'curve', domain: 'curve-sample', samples: [{id: 'mid', parameter: 0.5}]}],
    operations: [{id: 'positions', domain: 'sampled', kind: 'capture', expression: 'position'}],
    bindings: [{domain: 'sampled', field: 'positions', property: 'position', targets: [{element: 'mid', target: 'B'}]}]};
  b.operationGraph!.operations.push(op('mid', 'midpoint', {a: read('A'), b: read('B')})); bind(b, 'mid', 'M');
  const f = evaluate(b, 0); near([at(f, 'M').x, at(f, 'M').y], [15, 29]);
});

test('ellipse centers and TeX positions are valid transformed node inputs', () => {
  const b = fixture(); b.resources.label = {kind: 'vector', items: [], metrics: {width: 1, height: 1, depth: 0}, inkBounds: [0, 0, 1, 1]};
  b.nodes.push({id: 'ellipse', kind: 'ellipse', cx: 2, cy: 3, rx: 5, ry: 6, transform: {translate: [10, 20]}},
    {id: 'tex', kind: 'tex', x: 4, y: 5, resourceId: 'label', scale: 2, transform: {translate: [-2, 1]}});
  b.operationGraph!.operations.push(op('mid', 'midpoint', {a: read('ellipse'), b: read('tex')})); bind(b, 'mid', 'M');
  const f = evaluate(b, 0); near([at(f, 'M').x, at(f, 'M').y], [7, 14.5]);
});

test('graph-to-node-to-graph chains run in dependency order even without an output reference edge', () => {
  const b = fixture(); b.operationGraph!.operations = [op('aSecond', 'midpoint', {a: read('M'), b: read('C')}),
    op('zFirst', 'midpoint', {a: read('A'), b: read('B')})];
  bind(b, 'aSecond', 'G'); bind(b, 'zFirst', 'M');
  const f = evaluate(b, 0); near([at(f, 'G').x, at(f, 'G').y], [4.5, 4.5]);
});

test('mixed graph-node dependency cycles fail with authored source context', () => {
  const b = fixture(); b.operationGraph!.operations = [op('one', 'midpoint', {a: read('G'), b: read('B')}),
    op('two', 'midpoint', {a: read('M'), b: read('C')})];
  b.operationGraph!.operations[0].sourceSpan = {file: 'coordinates.tex', start: {line: 8, column: 1}, end: {line: 8, column: 40}};
  bind(b, 'one', 'M'); bind(b, 'two', 'G');
  assert.throws(() => createEvaluator(b), (error: any) => {
    const d = error.diagnostics?.find((d: any) => /CYCLE/.test(d.code)); assert.ok(d, String(error));
    assert.ok(d.sourceSpan?.file === 'coordinates.tex' || d.related?.some((r: any) => r.sourceSpan?.file === 'coordinates.tex')); return true;
  });
});

test('zero direction baselines reject towards and projection operations with located diagnostics', () => {
  for (const name of ['pointTowards', 'projectLine', 'projectSegment']) {
    const b = fixture(); Object.assign(p(b, 'B'), {x: 1, y: 2});
    const inputs: Operation['inputs'] = name === 'pointTowards' ? {a: read('A'), b: read('B'), distance: scalar(5, 'bp')}
      : {a: read('A'), b: read('B'), point: read('C')};
    const operation = op('degenerate', name, inputs); operation.sourceSpan = {file: 'zero.tex', start: {line: 2, column: 1}, end: {line: 2, column: 20}};
    b.operationGraph!.operations.push(operation); bind(b, operation.id, 'M');
    assert.throws(() => evaluate(b, 0), (error: any) => {
      const d = error.diagnostics?.find((d: any) => d.code === 'COORDINATE_DEGENERATE'); assert.ok(d, String(error));
      assert.equal(d.sourceSpan?.file, 'zero.tex'); assert.match(d.path ?? '', /operations\[0\]/); return true;
    });
  }
});

test('singular coordinate destinations fail for authored and animated inverse matrices', () => {
  const make = () => {
    const b = fixture(); b.nodes.push({id: 'axes', kind: 'group'});
    b.operationGraph!.operations.push(op('mid', 'midpoint', {a: read('A', local('axes')), b: read('B', local('axes'))}, local('axes')));
    converted(b, 'convert', output('mid'), local('axes')); return b;
  };
  const fixed = make(); fixed.nodes.find(n => n.id === 'axes')!.transform = {scale: [0, 1]};
  assert.throws(() => evaluate(fixed, 0), /SINGULAR/i);
  const tracked = make(); tracked.tracks.push({target: 'axes', property: 'transform.scale', keys: [[0, [1, 1]], [2, [-1, 1]]]});
  assert.throws(() => evaluate(tracked, 1), /SINGULAR/i);
  const dynamic = make(); dynamic.expressions = {version: 1, parameters: {}, bindings: [{target: 'axes', property: 'transform.scale', expression: 'vec2(1,1-time/1s)'}]};
  const run = createEvaluator(dynamic); assert.doesNotThrow(() => run(0)); assert.throws(() => run(1), /SINGULAR/i);
});

test('expression inputs use shared globals and time with deterministic reverse seeks and immutable capture', () => {
  const b = fixture(); b.expressions = {version: 1, parameters: {amount: {type: 'scalar', unit: '1', default: 0.25}}, bindings: []};
  b.operationGraph!.operations.push(op('lerp', 'lerpPoint', {a: read('A'), b: read('B'), factor: expression('amount + time/(4s)')})); bind(b, 'lerp', 'M');
  const original = structuredClone(b), one = prepareScene(b), two = createEvaluator(b), params = {amount: 0.5};
  const f = one.sample(1, params), expected = structuredClone(f); near([at(f, 'M').x, at(f, 'M').y], [5.5, 8]);
  one.sample(2); one.sample(0); two(0); assert.deepEqual(one.sample(1, params), expected); assert.deepEqual(two(1, params), expected);
  near([at(one.sample(1), 'M').x, at(one.sample(1), 'M').y], [4, 6]);
  at(f, 'A').x = 999; at(f, 'M').y = 999; assert.deepEqual(one.sample(1, params), expected);
  assert.deepEqual(params, {amount: 0.5}); assert.deepEqual(b, original);
  p(b, 'A').x = 1000; (b.operationGraph!.operations[0].inputs.factor as any).expression = '0';
  assert.deepEqual(one.sample(1, params), expected); assert.deepEqual(two(1, params), expected);
});

test('standalone graph validation preserves shared parameter declarations and immutable prepared snapshots', () => {
  const b = fixture(); b.expressions = {version: 1, parameters: {distance: {type: 'scalar', unit: 'bp', default: 5}}, bindings: []};
  const graph = {version: 1 as const, operations: [op('towards', 'pointTowards', {a: read('A'), b: read('B'), distance: expression('distance', 'bp')})],
    bindings: [{target: 'M', property: 'position', value: {operation: 'towards', socket: 'position'}}]};
  assert.deepEqual(validateOperationGraph(graph, b), []);
  const prepared = prepareOperationGraph(graph, b); assert.ok(Object.isFrozen(prepared.graph.operations[0].inputs));
  graph.operations[0].inputs.distance = expression('missing', 'bp');
  assert.equal((prepared.graph.operations[0].inputs.distance as any).expression, 'distance');
  assert.ok(validateOperationGraph(graph, b).some(d => d.severity === 'error'));
});

test('explicit scalar units cannot be mixed across factor, distance, angle or expression declarations', () => {
  const cases = [
    op('bad', 'lerpPoint', {a: read('A'), b: read('B'), factor: scalar(0.5, 'bp')}),
    op('bad', 'pointTowards', {a: read('A'), b: read('B'), distance: scalar(5)}),
    op('bad', 'rotatePoint', {point: read('A'), center: read('B'), angle: scalar(1, 'bp')}),
    op('bad', 'pointTowards', {a: read('A'), b: read('B'), distance: expression('1rad', 'bp')}),
    op('bad', 'lerpPoint', {a: read('A'), b: read('B'), factor: expression('vec2(1,2)')}),
  ];
  for (const operation of cases) {
    const b = fixture(); b.operationGraph!.operations.push(operation); bind(b, operation.id, 'M');
    assert.ok(validateBundle(b).some(d => d.severity === 'error')); assert.throws(() => createEvaluator(b));
  }
});

test('candidate expression-program parameters are used when validating existing graph expression inputs', () => {
  const b = fixture(); b.expressions = {version: 1, parameters: {}, bindings: []};
  b.operationGraph!.operations.push(op('lerp', 'lerpPoint', {a: read('A'), b: read('B'), factor: expression('amount')})); bind(b, 'lerp', 'M');
  const candidate: ExpressionProgram = {version: 1, parameters: {amount: {type: 'scalar', unit: '1', default: 0.25}}, bindings: []};
  assert.deepEqual(validateExpressionProgram(candidate, b), []);
  candidate.parameters = {};
  assert.ok(validateExpressionProgram(candidate, b).some(d => /IDENTIFIER/.test(d.code)));
  assert.deepEqual(b.expressions.parameters, {});
});

test('malformed new input and space declarations return diagnostics instead of raw coercion failures', () => {
  const badInputs: unknown[] = [
    {kind: 'node', node: {toString: null}, property: 'position', space: scene},
    {kind: 'node', node: 'A', property: 'r', space: scene},
    {kind: 'node', node: 'absent', property: 'position', space: scene},
    {kind: 'node', node: 'edge', property: 'position', space: scene},
    {kind: 'node', node: 'A', property: 'position', space: plot('A')},
    {kind: 'expression', expression: {toString: null}, unit: '1'},
    {kind: 'spaceTransform', from: scene, to: {kind: 'parent', node: {toString: null}}},
  ];
  for (const bad of badInputs) {
    const b = fixture(); b.operationGraph!.operations.push(op('bad', 'midpoint', {a: bad as InputRef, b: read('B')}));
    assert.doesNotThrow(() => validateOperationGraph(b.operationGraph, b)); assert.doesNotThrow(() => validateBundle(b));
    assert.ok(validateBundle(b).some(d => d.severity === 'error')); assert.throws(() => createEvaluator(b));
  }
});

test('scalarValue cannot launder a length unit into a dimensionless interpolation factor', () => {
  const b = fixture();
  b.operationGraph!.operations = [
    {id: 'length', operator: 'scalarValue', version: 1, spaces: {}, inputs: {value: scalar(0.5, 'bp')}},
    op('lerp', 'lerpPoint', {a: read('A'), b: read('B'), factor: output('length', 'value')}),
  ];
  bind(b, 'lerp', 'M');
  const diagnostic = validateOperationGraph(b.operationGraph, b).find(d => d.code === 'OPERATION_UNIT_MISMATCH');
  assert.ok(diagnostic); assert.equal(diagnostic.path, '$.operationGraph.operations[0].inputs.value');
  assert.throws(() => createEvaluator(b), /OPERATION_UNIT_MISMATCH/);
  b.operationGraph!.operations[0].inputs.value = {kind: 'literal', value: {type: 'scalar', value: 0.5}};
  const f = evaluate(b, 0); near([at(f, 'M').x, at(f, 'M').y], [4, 6]);
});

test('current transform writers replace authored singular charts before input and sink inverses', () => {
  const make = (space: SpaceRef) => {
    const b = fixture(); b.nodes.push({id: 'axes', kind: 'group', transform: {scale: [0, 1]}}); p(b, 'M').parent = 'axes';
    b.operationGraph!.operations.push(op('mid', 'midpoint', {a: read('A', space), b: read('B', space)}, space));
    converted(b, 'convert', output('mid'), space); return b;
  };
  for (const space of [local('axes'), plot('axes')]) for (const writer of ['expression', 'track', 'graph']) {
    const b = make(space);
    if (writer === 'expression') b.expressions = {version: 1, parameters: {}, bindings: [
      {target: 'axes', property: 'transform.scale', expression: 'vec2(2,1)'},
    ]};
    if (writer === 'track') b.tracks.push({target: 'axes', property: 'transform.scale', keys: [[0, [2, 1]], [2, [2, 1]]]});
    if (writer === 'graph') {
      b.operationGraph!.operations.push({id: 'scale', operator: 'vectorValue', version: 1, spaces: {space: local('axes')}, inputs: {
        value: {kind: 'literal', value: {type: 'vec2', role: 'vector', space: local('axes'), value: [2, 1]}},
      }});
      bind(b, 'scale', 'axes', 'transform.scale', 'value');
      const context = structuredClone(b); context.operationGraph = {version: 1, operations: [], bindings: []};
      assert.deepEqual(validateOperationGraph(b.operationGraph, context), []);
    }
    assert.deepEqual(validateBundle(b), []);
    const f = evaluate(b, 1); near([at(f, 'M').x, at(f, 'M').y], [2, 6]);
  }
  const dynamic = make(local('axes')); dynamic.expressions = {version: 1, parameters: {}, bindings: [
    {target: 'axes', property: 'transform.scale', expression: 'vec2(2-2*time/1s,1)'},
  ]};
  const run = createEvaluator(dynamic); assert.doesNotThrow(() => run(0)); assert.throws(() => run(1), /SINGULAR/i);
});
