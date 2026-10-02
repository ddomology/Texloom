import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluate, createEvaluator, prepareScene, validateBundle, validateOperationGraph, validateExpressionProgram, geometryBounds,
  type Bundle, type EvaluatedFrame, type InputRef, type Operation, type SpaceRef, type PointNode, type PathNode,
} from '../src/index.ts';
import {renderSvg} from '../src/render-svg.ts';

const scene = {kind: 'scene'} as const;
const local = (node: string) => ({kind: 'local', node} as const);
const scalar = (value: number, unit: '1'|'bp'|'rad' = '1'): InputRef => ({kind: 'literal', value: {type: 'scalar', value, unit}});
const point = (value: [number, number], space: SpaceRef = scene): InputRef => ({kind: 'literal', value: {type: 'vec2', role: 'point', space, value}});
const output = (operation: string, socket: string): InputRef => ({kind: 'output', ref: {operation, socket}});
const expression = (value: string, unit: '1'|'bp'|'rad' = '1'): InputRef => ({kind: 'expression', expression: value, unit});
const pointExpression = (value: string, space: SpaceRef = scene): InputRef => ({kind: 'pointExpression', expression: value, space});
const read = (node: string, space: SpaceRef = scene): InputRef => ({kind: 'node', node, property: 'position', space});
const points = (items: InputRef[], space: SpaceRef = scene): InputRef => ({kind: 'points', items, space});
function fixture(): Bundle {
  return {version: '0.3', title: 'Parametric shapes', duration: 2, units: 'bp', viewport: {width: 300, height: 250},
    camera: {x: 0, y: 0, zoom: 1}, resources: {}, tracks: [], relations: [],
    nodes: [{id: 'curve', kind: 'path', d: 'M0 0L1 0', geometry: {contours: [{id: 'c', start: [0, 0], segments: [{id: 's', kind: 'line', to: [1, 0]}]}]}},
      {id: 'marker', kind: 'point', x: 0, y: 0, r: 1}, {id: 'tip', kind: 'point', x: 0, y: 0, r: 1},
      {id: 'A', kind: 'point', x: 0, y: 0, r: 1}, {id: 'B', kind: 'point', x: 10, y: 0, r: 1}],
    operationGraph: {version: 1, operations: [], bindings: []}};
}
const p = (b: Bundle, id: string) => b.nodes.find(n => n.id === id) as PointNode;
const at = (f: EvaluatedFrame, id = 'marker') => f.nodes.find(n => n.id === id) as PointNode;
const path = (f: EvaluatedFrame) => f.nodes.find(n => n.id === 'curve') as PathNode;
function near(actual: readonly number[], expected: readonly number[], tolerance = 1e-8) {
  assert.equal(actual.length, expected.length);
  actual.forEach((v, i) => assert.ok(Number.isFinite(v) && Math.abs(v - expected[i]) <= tolerance, `${actual} != ${expected}`));
}
function nearBounds(actual: readonly number[], expected: readonly number[], tolerance = 0.1) {
  // The error budget applies to each extremum; width/height can differ by twice that budget.
  near([actual[0], actual[1], actual[0] + actual[2], actual[1] + actual[3]],
    [expected[0], expected[1], expected[0] + expected[2], expected[1] + expected[3]], tolerance);
}
function op(id: string, operator: string, inputs: Operation['inputs'], space: SpaceRef = scene): Operation {
  return {id, operator, version: 1, inputs, spaces: {space}};
}
function bind(b: Bundle, operation: string, socket: string, target: string, property: string) {
  b.operationGraph!.bindings.push({target, property, value: {operation, socket}});
}
function circle(b: Bundle, radius: InputRef = scalar(20, 'bp'), center: InputRef = point([10, 20]), space: SpaceRef = scene) {
  b.operationGraph!.operations.push(op('shape', 'circle', {center, radius}, space));
}
function lower(b: Bundle, space: SpaceRef = scene, mode = 'shapeToCubic', tolerance = 0.1) {
  b.operationGraph!.operations.push(op('lower', mode, {shape: output('shape', 'shape'), tolerance: scalar(tolerance, 'bp')}, space),
    {id: 'toPath', operator: 'transformPath', version: 1, spaces: {from: space, to: local('curve')}, inputs: {
      path: output('lower', 'path'), transform: {kind: 'spaceTransform', from: space, to: local('curve')},
    }});
  bind(b, 'toPath', 'path', 'curve', 'geometry');
}
function sample(b: Bundle, parameter: InputRef = scalar(0.25), space: SpaceRef = scene) {
  b.operationGraph!.operations.push(op('sample', 'sampleShape', {shape: output('shape', 'shape'), parameter}, space));
  if (space.kind === 'scene') bind(b, 'sample', 'position', 'marker', 'position');
  else {
    b.operationGraph!.operations.push({id: 'toMarker', operator: 'transformPoint', version: 1, spaces: {from: space, to: scene}, inputs: {
      point: output('sample', 'position'), transform: {kind: 'spaceTransform', from: space, to: scene},
    }});
    bind(b, 'toMarker', 'position', 'marker', 'position');
  }
}

test('circle lowering renders a closed editable path while its marker follows the analytic angle parameter', () => {
  const b = fixture(); circle(b); lower(b); sample(b, scalar(0.1));
  const f = evaluate(b, 0), g = path(f).geometry!;
  assert.equal(g.contours.length, 1); assert.equal(g.contours[0].closed, true);
  assert.ok(g.contours[0].segments.every(s => s.kind === 'cubic'));
  assert.deepEqual(f.shapes!.definitions.shape, {space: scene, primitive: {kind: 'circle', center: [10, 20], radius: 20}});
  assert.deepEqual(f.shapes!.approximations.lower.space, scene);
  const report = f.shapes!.approximations.lower.report;
  assert.equal(report.profile, 'cubic'); assert.equal(report.tolerance, 0.1); assert.ok(report.errorBound <= report.tolerance);
  assert.equal(report.segments, g.contours[0].segments.length); assert.equal(report.spans.length, report.segments);
  near([at(f).x, at(f).y], [10 + 20 * Math.cos(Math.PI / 5), 20 + 20 * Math.sin(Math.PI / 5)]);
  nearBounds(geometryBounds(g)!, [-10, 0, 40, 40]); assert.match(path(f).d, /C/); assert.match(renderSvg(f), /data-node-id="curve"/);
  p(b, 'tip').progress = 0.1; b.relations.push({type: 'pointOnPath', target: 'tip', source: 'curve'});
  const sampled = evaluate(b, 0);
  assert.ok(Math.hypot(at(sampled).x - at(sampled, 'tip').x, at(sampled).y - at(sampled, 'tip').y) > 0.001,
    'Analytic angle sampling and cubic path parameter sampling are distinct contracts');
});

test('ellipse and signed arc sample outputs provide analytic positions and unit tangent directions', () => {
  for (const isArc of [false, true]) {
    const b = fixture(); b.operationGraph!.operations.push(op('shape', isArc ? 'arc' : 'ellipse', {
      center: point([4, 7]), rx: scalar(20, 'bp'), ry: scalar(10, 'bp'),
      ...(isArc ? {startAngle: scalar(Math.PI / 2, 'rad'), sweepAngle: scalar(-Math.PI, 'rad')} : {}),
    }));
    lower(b); sample(b, scalar(isArc ? 1 : 0.25));
    b.operationGraph!.operations.push(op('tip', 'offsetPoint', {origin: output('sample', 'position'), direction: output('sample', 'tangent'), distance: scalar(5)}));
    bind(b, 'tip', 'position', 'tip', 'position');
    const f = evaluate(b, 0), y = isArc ? -3 : 17;
    near([at(f).x, at(f).y], [4, y]); near([at(f, 'tip').x, at(f, 'tip').y], [-1, y]);
  }
});

test('rectangle, rounded rectangle and closed polyline produce bounded closed geometry', () => {
  for (const name of ['rectangle', 'roundedRectangle', 'polyline']) {
    const b = fixture(); const inputs: Operation['inputs'] = name === 'polyline'
      ? {points: {kind: 'literal', value: {type: 'points2d', space: scene, value: [[2, 3], [10, 3], [10, 9], [2, 9]]}}, closed: scalar(1)}
      : {origin: point([2, 3]), width: scalar(8, 'bp'), height: scalar(6, 'bp'), ...(name === 'roundedRectangle' ? {cornerRadius: scalar(2, 'bp')} : {})};
    b.operationGraph!.operations.push(op('shape', name, inputs)); lower(b);
    const g = path(evaluate(b, 0)).geometry!; assert.equal(g.contours[0].closed, true); near(geometryBounds(g)!, [2, 3, 8, 6]);
  }
});

test('nested point-list outputs wait for coordinate operations, node tracks and point expressions', () => {
  const b = fixture(); b.tracks.push({target: 'B', property: 'x', keys: [[0, 10], [2, 20]]});
  b.operationGraph!.operations.push(op('shape', 'polyline', {points: points([
    output('zMid', 'position'), read('B'), pointExpression('vec2(20bp,10bp*time/1s)'),
  ])}), op('zMid', 'midpoint', {a: read('A'), b: read('B')}));
  lower(b, scene, 'shapeToPolyline');
  const g = path(evaluate(b, 1)).geometry!; near(g.contours[0].start, [7.5, 0]);
  near(g.contours[0].segments[0].to, [15, 0]); near(g.contours[0].segments.at(-1)!.to, [20, 10]);
  assert.notEqual(g.contours[0].closed, true);
});

test('animated scalar shape inputs and vector center expressions update geometry bounds at every sample', () => {
  const b = fixture(); b.expressions = {version: 1, parameters: {radius: {type: 'scalar', unit: 'bp', default: 10}}, bindings: []};
  circle(b, expression('radius + 5bp*time/1s', 'bp'), pointExpression('vec2(10bp*time/1s,20bp)')); lower(b); sample(b);
  const run = createEvaluator(b), first = run(0), end = run(2, {radius: 20});
  nearBounds(geometryBounds(path(first).geometry!)!, [-10, 10, 20, 20]); nearBounds(geometryBounds(path(end).geometry!)!, [-10, -10, 60, 60]);
  near([at(end).x, at(end).y], [20, 50]); assert.deepEqual(run(0), first);
});

test('shape scalar-property inputs see field radius writes before construction', () => {
  const b = fixture(); b.nodes.push({id: 'guide', kind: 'path', d: 'M0 0L10 0', geometry: {contours: [{id: 'g', start: [0, 0], segments: [{id: 's', kind: 'line', to: [10, 0]}]}]}});
  b.fields = {version: 1, domains: [{id: 'samples', geometry: 'guide', domain: 'curve-sample', samples: [{id: 'middle', parameter: 0.5}]}],
    operations: [{id: 'radius', domain: 'samples', kind: 'evaluate', expression: '4bp + 4bp*parameter'}],
    bindings: [{domain: 'samples', field: 'radius', property: 'r', targets: [{element: 'middle', target: 'A'}]}]};
  circle(b, {kind: 'property', node: 'A', property: 'r', unit: 'bp'}, point([0, 0])); lower(b); sample(b);
  const f = evaluate(b, 0); near([at(f, 'A').r, at(f).x, at(f).y], [6, 0, 6]); nearBounds(geometryBounds(path(f).geometry!)!, [-6, -6, 12, 12]);
});

test('transformPath uses current rotated, reflected nonuniform source and target matrices', () => {
  const b = fixture(); b.nodes.push({id: 'axes', kind: 'group', transform: {translate: [10, 20], rotate: Math.PI / 2, scale: [-2, 3]}},
    {id: 'destination', kind: 'group', transform: {translate: [-5, 7], scale: [2, 4]}});
  b.nodes.find(n => n.id === 'curve')!.parent = 'destination';
  b.tracks.push({target: 'axes', property: 'transform.translate', keys: [[0, [10, 20]], [2, [30, 40]]]});
  b.operationGraph!.operations.push(op('shape', 'polyline', {points: points([point([1, 2], local('axes')), point([3, 4], local('axes'))], local('axes'))}, local('axes')));
  lower(b, local('axes'), 'shapeToPolyline');
  const f = evaluate(b, 2), g = path(f).geometry!;
  assert.deepEqual(f.shapes!.definitions.shape.space, local('axes'));
  assert.deepEqual(f.shapes!.approximations.lower.space, local('axes'));
  assert.equal(f.shapes!.approximations.lower.report.profile, 'polyline');
  // Source local -> scene: (30 - 3y, 40 - 2x), then inverse destination (x+5)/2,(y-7)/4.
  near(g.contours[0].start, [14.5, 7.75]); near(g.contours[0].segments[0].to, [11.5, 6.75]);
  b.camera = {x: 300, y: 200, zoom: 4}; assert.deepEqual(path(evaluate(b, 2)).geometry, g);
});

test('shape path writes conflict with tracks and other geometry writers', () => {
  const b = fixture(); circle(b); lower(b); b.tracks.push({target: 'curve', property: 'geometry.c.s.to', keys: [[0, [2, 3]]]});
  assert.ok(validateBundle(b).some(d => /WRITER|CONFLICT/.test(d.code))); assert.throws(() => createEvaluator(b), /WRITER|CONFLICT/);
});

test('nested point dependencies detect cycles and retain the constructor source location', () => {
  const b = fixture(); b.operationGraph!.operations.push(op('shape', 'polyline', {points: points([output('sample', 'position'), point([2, 3])])}));
  b.operationGraph!.operations[0].sourceSpan = {file: 'shapes.tex', start: {line: 4, column: 1}, end: {line: 4, column: 30}};
  sample(b); assert.throws(() => createEvaluator(b), (error: any) => {
    const d = error.diagnostics?.find((d: any) => /CYCLE/.test(d.code)); assert.ok(d, String(error));
    assert.ok(d.sourceSpan?.file === 'shapes.tex' || d.related?.some((r: any) => r.sourceSpan?.file === 'shapes.tex')); return true;
  });
});

test('reverse seeks, independent runtimes and external mutations do not change shape evaluation', () => {
  const b = fixture(); circle(b, expression('10bp+time*5bp/1s', 'bp')); lower(b); sample(b, expression('time/2s'));
  const authored = structuredClone(b), one = prepareScene(b), two = createEvaluator(b), first = one.sample(0.75), expected = structuredClone(first);
  one.sample(2); one.sample(0); two(1); assert.deepEqual(one.sample(0.75), expected); assert.deepEqual(two(0.75), expected);
  path(first).geometry!.contours[0].start[0] = 999; at(first).x = 999;
  const primitive = first.shapes!.definitions.shape.primitive;
  assert.equal(primitive.kind, 'circle'); if (primitive.kind === 'circle') primitive.radius = 999;
  first.shapes!.approximations.lower.report.spans[0].errorBound = 999;
  assert.deepEqual(one.sample(0.75), expected); assert.deepEqual(b, authored);
  b.operationGraph!.operations[0].inputs.radius = scalar(50, 'bp'); assert.deepEqual(two(0.75), expected);
});

test('shape domains, approximation budgets and sample parameters fail explicitly with source context', () => {
  const cases: {operator: string; inputs: Operation['inputs']; lowerInputs?: Operation['inputs']; sampleParameter?: number}[] = [
    {operator: 'circle', inputs: {center: point([0, 0]), radius: scalar(0, 'bp')}},
    {operator: 'ellipse', inputs: {center: point([0, 0]), rx: scalar(2, 'bp'), ry: scalar(-1, 'bp')}},
    {operator: 'roundedRectangle', inputs: {origin: point([0, 0]), width: scalar(8, 'bp'), height: scalar(4, 'bp'), cornerRadius: scalar(3, 'bp')}},
    {operator: 'arc', inputs: {center: point([0, 0]), rx: scalar(2, 'bp'), ry: scalar(1, 'bp'), startAngle: scalar(0, 'rad'), sweepAngle: scalar(7, 'rad')}},
    {operator: 'polyline', inputs: {points: points([point([0, 0]), point([1, 1])]), closed: scalar(1)}},
    {operator: 'circle', inputs: {center: point([0, 0]), radius: scalar(20, 'bp')}, lowerInputs: {tolerance: scalar(0, 'bp')}},
    {operator: 'circle', inputs: {center: point([0, 0]), radius: scalar(20, 'bp')}, lowerInputs: {tolerance: scalar(1e-12, 'bp'), maxSegments: scalar(1)}},
    {operator: 'circle', inputs: {center: point([0, 0]), radius: scalar(20, 'bp')}, sampleParameter: -0.1},
    {operator: 'circle', inputs: {center: point([0, 0]), radius: scalar(20, 'bp')}, sampleParameter: 1.1},
  ];
  for (const c of cases) {
    const b = fixture(); b.operationGraph!.operations.push(op('shape', c.operator, c.inputs)); lower(b); sample(b, scalar(c.sampleParameter ?? 0.25));
    if (c.lowerInputs) Object.assign(b.operationGraph!.operations.find(o => o.id === 'lower')!.inputs, c.lowerInputs);
    for (const operation of b.operationGraph!.operations) operation.sourceSpan = {file: 'invalid-shape.tex', start: {line: 6, column: 1}, end: {line: 6, column: 60}};
    assert.throws(() => evaluate(b, 0), (error: any) => {
      const d = error.diagnostics?.[0]; assert.ok(d, String(error)); assert.equal(d.sourceSpan?.file, 'invalid-shape.tex');
      assert.match(d.path ?? '', /operations\[/); return true;
    });
  }
});

test('new input kinds enforce scalar units, point dimensions and coordinate-space identity', () => {
  const inputs: InputRef[] = [
    pointExpression('vec2(1,2)'), pointExpression('3bp'),
    {kind: 'points', space: scene, items: [point([1, 2], local('curve')), point([3, 4])]},
    {kind: 'points', space: scene, items: [scalar(1), point([3, 4])]},
    {kind: 'property', node: 'A', property: 'r', unit: 'rad'},
    {kind: 'property', node: 'curve', property: 'geometry', unit: 'bp'},
  ];
  for (const value of inputs) {
    const b = fixture();
    if (value.kind === 'points') b.operationGraph!.operations.push(op('shape', 'polyline', {points: value}));
    else circle(b, value.kind === 'property' ? value : scalar(10, 'bp'), value.kind === 'property' ? point([0, 0]) : value);
    assert.ok(validateBundle(b).some(d => d.severity === 'error')); assert.throws(() => createEvaluator(b));
  }
});

test('candidate expression globals are available inside nested point expressions without mutating the context', () => {
  const b = fixture(); b.expressions = {version: 1, parameters: {}, bindings: []};
  b.operationGraph!.operations.push(op('shape', 'polyline', {points: points([point([0, 0]), pointExpression('vec2(offset,0bp)')])})); lower(b);
  const candidate = {version: 1 as const, parameters: {offset: {type: 'scalar' as const, unit: 'bp' as const, default: 10}}, bindings: []};
  assert.deepEqual(validateExpressionProgram(candidate, b), []); assert.deepEqual(b.expressions.parameters, {});
  b.expressions = candidate; assert.deepEqual(validateOperationGraph(b.operationGraph, b), []);
  near(path(evaluate(b, 0)).geometry!.contours[0].segments[0].to, [10, 0]);
});

test('malformed shape path binding targets produce diagnostics without invoking object coercion', () => {
  const b = fixture(); circle(b); lower(b);
  (b.operationGraph!.bindings[0] as any).target = {toString: null};
  assert.doesNotThrow(() => validateOperationGraph(b.operationGraph, b));
  assert.doesNotThrow(() => validateBundle(b));
  assert.ok(validateOperationGraph(b.operationGraph, b).some(d => d.code === 'OPERATION_BINDING_TARGET'));
  assert.ok(validateBundle(b).some(d => d.code === 'OPERATION_BINDING_TARGET'));
});
