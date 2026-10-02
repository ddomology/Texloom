import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluate, createEvaluator, prepareScene, validateBundle, validateOperationGraph, validateExpressionProgram,
  geometryLength, type Bundle, type EvaluatedFrame, type InputRef, type Operation, type SpaceRef,
  type PathGeometry, type PathNode, type PointNode,
} from '../src/index.ts';
import {renderSvg} from '../src/render-svg.ts';

const scene = {kind: 'scene'} as const;
const local = (node: string) => ({kind: 'local', node} as const);
const scalar = (value: number, unit: '1'|'bp' = '1'): InputRef => ({kind: 'literal', value: {type: 'scalar', value, unit}});
const output = (operation: string, socket = 'path'): InputRef => ({kind: 'output', ref: {operation, socket}});
const read = (node = 'source', space: SpaceRef = scene): InputRef => ({kind: 'path', node, space});
const expression = (text: string, unit: '1'|'bp' = '1'): InputRef => ({kind: 'expression', expression: text, unit});
const line = (start: [number, number] = [0, 0], end: [number, number] = [10, 0]): PathGeometry => ({contours: [{id: 'c', start, segments: [{id: 's', kind: 'line', to: end}]}]});
const disconnected = (): PathGeometry => ({contours: [line().contours[0], {id: 'd', start: [100, 0], segments: [{id: 't', kind: 'line', to: [130, 0]}]}]});
const square = (): PathGeometry => ({contours: [{id: 'box', start: [0, 0], closed: true, segments: [
  {id: 'east', kind: 'line', to: [10, 0]}, {id: 'south', kind: 'line', to: [10, 10]}, {id: 'west', kind: 'line', to: [0, 10]},
]}]});
function fixture(geometry = line()): Bundle {
  return {version: '0.3', title: 'Reusable curve operations', duration: 2, units: 'bp', viewport: {width: 300, height: 200},
    camera: {x: 0, y: 0, zoom: 1}, resources: {}, tracks: [], relations: [],
    nodes: [{id: 'source', kind: 'path', d: 'M0 0L10 0', geometry}, {id: 'result', kind: 'path', d: 'M0 0L1 0', geometry: line([0, 0], [1, 0])},
      ...['marker', 'tip', 'normal', 'length', 'distance'].map(id => ({id, kind: 'point' as const, x: 0, y: 0, r: 1}))],
    operationGraph: {version: 1, operations: [], bindings: []}};
}
const node = (f: EvaluatedFrame, id = 'marker') => f.nodes.find(n => n.id === id) as PointNode;
const path = (f: EvaluatedFrame, id = 'result') => f.nodes.find(n => n.id === id) as PathNode;
const source = (b: Bundle) => b.nodes.find(n => n.id === 'source') as PathNode;
const near = (actual: readonly number[], expected: readonly number[], tolerance = 1e-7) => {
  assert.equal(actual.length, expected.length);
  actual.forEach((n, i) => assert.ok(Number.isFinite(n) && Math.abs(n - expected[i]) <= tolerance, `${actual} != ${expected}`));
};
function add(b: Bundle, id: string, operator: string, inputs: Operation['inputs'], space: SpaceRef = scene, version = 1): Operation {
  const operation = {id, operator, version, spaces: {space}, inputs}; b.operationGraph!.operations.push(operation); return operation;
}
function bind(b: Bundle, operation: string, socket: string, target: string, property: string) {
  b.operationGraph!.bindings.push({target, property, value: {operation, socket}});
}
function sample(b: Bundle, id = 'sample', curve: InputRef = read(), inputs: Operation['inputs'] = {}, target = 'marker') {
  const operation = add(b, id, 'sampleCurve', {path: curve, parameter: scalar(0.5), ...inputs}, scene, 2);
  bind(b, id, 'position', target, 'position'); return operation;
}
function store(b: Bundle, operation: string, target = 'result') {
  add(b, 'store:' + target, 'transformPath', {path: output(operation), transform: {kind: 'spaceTransform', from: scene, to: local(target)}});
  const transform = b.operationGraph!.operations.at(-1)!; transform.spaces = {from: scene, to: local(target)};
  bind(b, transform.id, 'path', target, 'geometry');
}
const span = {file: 'curves.tex', start: {line: 12, column: 3}, end: {line: 12, column: 70}};

test('live path input waits for control and ancestor transform writers and excludes the camera', () => {
  const b = fixture(); b.nodes.push({id: 'axes', kind: 'group', transform: {translate: [10, 20], rotate: Math.PI / 2, scale: [-2, 3]}});
  source(b).parent = 'axes'; b.expressions = {version: 1, parameters: {}, bindings: [
    {target: 'source', property: 'geometry.c.s.to', expression: 'vec2(10bp+5bp*time/1s,0bp)'},
    {target: 'axes', property: 'transform.translate', expression: 'vec2(10bp,20bp+2bp*time/1s)'},
  ]};
  sample(b); bind(b, 'sample', 'totalLength', 'length', 'r'); bind(b, 'sample', 'distance', 'distance', 'r');
  add(b, 'tip', 'offsetPoint', {origin: output('sample', 'position'), direction: output('sample', 'tangent'), distance: scalar(3)});
  add(b, 'normal', 'offsetPoint', {origin: output('sample', 'position'), direction: output('sample', 'normal2d'), distance: scalar(3)});
  bind(b, 'tip', 'position', 'tip', 'position'); bind(b, 'normal', 'position', 'normal', 'position');
  const frame = evaluate(b, 1); near([node(frame).x, node(frame).y], [10, 7]);
  near([node(frame, 'tip').x, node(frame, 'tip').y], [10, 4]); near([node(frame, 'normal').x, node(frame, 'normal').y], [13, 7]);
  near([node(frame, 'length').r, node(frame, 'distance').r], [30, 15]);
  assert.deepEqual(frame.curves!.samples.sample.space, scene);
  b.camera = {x: 1000, y: -400, zoom: 7}; assert.deepEqual(evaluate(b, 1).curves, frame.curves);
  near([node(evaluate(b, 1)).x, node(evaluate(b, 1)).y], [10, 7]);
});

test('current geometry reads wait for upstream graph writes and feed downstream legacy relations', () => {
  const b = fixture(line([0, 0], [20, 0]));
  sample(b, 'aSample', read('result'), {parameter: scalar(0.25)});
  add(b, 'zReverse', 'reversePath', {path: read()}); store(b, 'zReverse');
  (b.nodes.find(n => n.id === 'tip') as PointNode).progress = 0.75;
  b.relations.push({type: 'pointOnPath', source: 'result', target: 'tip'});
  const frame = evaluate(b, 0); near([node(frame).x, node(frame).y], [15, 0]); near([node(frame, 'tip').x, node(frame, 'tip').y], [5, 0]);
  near(path(frame).geometry!.contours[0].start, [20, 0]); assert.match(renderSvg(frame), /data-node-id="result"/);
});

test('whole path parameter, cumulative length and selected contour sampling have distinct semantics', () => {
  const b = fixture(disconnected());
  sample(b, 'parameter', read(), {parameter: scalar(0.25), mode: scalar(0)});
  sample(b, 'length', read(), {parameter: scalar(0.25)}, 'tip');
  sample(b, 'contour', read(), {parameter: scalar(0.25), contour: scalar(1)}, 'normal');
  bind(b, 'length', 'totalLength', 'length', 'r'); bind(b, 'contour', 'totalLength', 'distance', 'r');
  const f = evaluate(b, 0); near([node(f).x, node(f, 'tip').x, node(f, 'normal').x], [5, 100, 107.5]);
  near([node(f, 'length').r, node(f, 'distance').r], [40, 30]);
  const legacy = fixture(disconnected()); legacy.operationGraph!.operations.push({id: 'v1', operator: 'sampleCurve', version: 1,
    spaces: {curve: scene}, inputs: {curve: read(), parameter: scalar(0.25)}}); bind(legacy, 'v1', 'position', 'marker', 'position');
  near([node(evaluate(legacy, 0)).x, node(evaluate(legacy, 0)).y], [5, 0]);
});

test('trim then reverse composes geometry, direction, length and original source provenance', () => {
  const b = fixture(); add(b, 'trim', 'trimPath', {path: read(), start: scalar(0.2), end: scalar(0.8)});
  add(b, 'snapshot', 'pathValue', {value: output('trim')});
  const mapped = add(b, 'mapped', 'transformPath', {path: output('snapshot', 'value'), transform: {kind: 'spaceTransform', from: scene, to: scene}});
  mapped.spaces = {from: scene, to: scene};
  add(b, 'reverse', 'reversePath', {path: output('mapped')}); sample(b, 'sample', output('reverse'), {parameter: scalar(0.25)}); store(b, 'reverse');
  bind(b, 'sample', 'totalLength', 'length', 'r'); bind(b, 'sample', 'distance', 'distance', 'r');
  const f = evaluate(b, 0); near([node(f).x, node(f).y, node(f, 'length').r, node(f, 'distance').r], [6.5, 0, 6, 1.5]);
  near(path(f).geometry!.contours[0].start, [8, 0]); near(path(f).geometry!.contours[0].segments.at(-1)!.to, [2, 0]);
  const provenance = f.curves!.operations.reverse.provenance.segments[0];
  assert.equal(provenance.mapping, 'exact'); assert.equal(provenance.sources.length, 1);
  assert.equal(provenance.sources[0].geometryId, 'source'); assert.equal(provenance.sources[0].contourId, 'c');
  assert.equal(provenance.sources[0].segmentId, 's'); near(provenance.sources[0].parameterInterval, [0.8, 0.2]);
  const rich = f.curves!.samples.sample.sample; near(rich.position, [6.5, 0]); near(rich.tangent, [-1, 0]);
  assert.equal(rich.mapping, 'exact');
  near([rich.length, rich.totalLength, rich.localParameter], [1.5, 6, 0.25]);
  assert.equal(rich.sourceRefs[0].geometryId, 'source'); near(rich.sourceRefs[0].parameterInterval, [0.65, 0.65]);
});

test('closed wrap trims cross the seam while exact start and end retain one-sided tangent policy', () => {
  const b = fixture(square()); add(b, 'trim', 'trimPath', {path: read(), start: scalar(0.75), end: scalar(0.25), wrap: scalar(1)}); store(b, 'trim');
  sample(b, 'first', read(), {parameter: scalar(0)}); sample(b, 'last', read(), {parameter: scalar(1)}, 'tip');
  const f = evaluate(b, 0), g = path(f).geometry!; near(g.contours[0].start, [0, 10]); near(g.contours[0].segments.at(-1)!.to, [10, 0]);
  assert.notEqual(g.contours[0].closed, true); assert.equal(geometryLength(g), 20);
  near([node(f).x, node(f).y, node(f, 'tip').x, node(f, 'tip').y], [0, 0, 0, 0]);
  near(f.curves!.samples.first.sample.tangent, [1, 0]); near(f.curves!.samples.last.sample.tangent, [0, -1]);
  assert.equal(f.curves!.samples.last.sample.sourceRefs[0].closing, true);
});

test('resampling is per contour and spacing uses ceil without drawing across disconnected gaps', () => {
  for (const [operator, settings, lengths] of [
    ['resamplePathCount', {count: scalar(3)}, [2, 2]],
    ['resamplePathSpacing', {spacing: scalar(4, 'bp')}, [3, 8]],
  ] as [string, Operation['inputs'], number[]][]) {
    const b = fixture(disconnected()); add(b, 'resample', operator, {path: read(), ...settings}); store(b, 'resample');
    sample(b, 'sample', output('resample'), {parameter: scalar(0.1)});
    const f = evaluate(b, 0), g = path(f).geometry!; assert.equal(g.contours.length, 2);
    assert.deepEqual(g.contours.map(c => c.segments.length), lengths); near(g.contours[0].start, [0, 0]); near(g.contours[1].start, [100, 0]);
    near(g.contours[0].segments.at(-1)!.to, [10, 0]); near(g.contours[1].segments.at(-1)!.to, [130, 0]);
    assert.ok(g.contours.every(c => c.segments.every(s => s.kind === 'line'))); assert.equal(geometryLength(g), 40);
    const metadata = f.curves!.operations.resample;
    assert.equal(metadata.report.representation, 'polyline'); assert.equal(metadata.report.sampleCount, lengths[0] + lengths[1] + 2);
    assert.ok(metadata.provenance.segments.every(s => s.mapping === 'approximate'));
    assert.equal(f.curves!.samples.sample.sample.mapping, 'approximate');
    assert.ok(f.curves!.samples.sample.sample.sourceRefs.some(s => s.parameterInterval[0] !== s.parameterInterval[1]),
      'Sampling an approximate chord must retain source coverage instead of inventing an exact original parameter');
  }
  const b = fixture(square()); add(b, 'resample', 'resamplePathSpacing', {path: read(), spacing: scalar(100, 'bp')}); store(b, 'resample');
  const frame = evaluate(b, 0), c = path(frame).geometry!.contours[0]; assert.equal(c.closed, true); assert.equal(c.segments.length, 3);
  assert.equal(frame.curves!.operations.resample.report.sampleCount, 3);
  // The seam is represented by one explicit closing edge, not a repeated sample.
  assert.deepEqual(c.segments.at(-1)!.to, c.start);
  assert.equal(new Set([c.start, ...c.segments.slice(0, -1).map(s => s.to)].map(p => JSON.stringify(p))).size, 3);
});

test('joining contours requires explicit separate, coincident or bridge policy', () => {
  for (const policy of [0, 1, 2]) {
    const b = fixture(); b.nodes.push({id: 'second', kind: 'path', d: 'M0 0L1 0', geometry: line(policy === 1 ? [10, 0] : [100, 0], [130, 0])});
    add(b, 'join', 'joinPaths', {a: read(), b: read('second'), policy: scalar(policy)}); store(b, 'join');
    const g = path(evaluate(b, 0)).geometry!;
    assert.equal(g.contours.length, policy === 0 ? 2 : 1); assert.equal(geometryLength(g), policy === 0 ? 40 : 130);
    if (policy === 2) assert.equal(g.contours[0].segments.length, 3);
  }
  const b = fixture(); add(b, 'join', 'joinPaths', {a: read(), b: read(), policy: scalar(1)});
  assert.throws(() => evaluate(b, 0), /COINCIDENT|JOIN|ENDPOINT/);
  const literals = fixture();
  add(literals, 'join', 'joinPaths', {
    a: {kind:'literal',value:{type:'path2d',space:scene,value:line()}},
    b: {kind:'literal',value:{type:'path2d',space:scene,value:line([20,0],[30,0])}}, policy:scalar(0),
  });
  const refs = evaluate(literals,0).curves!.operations.join.provenance.segments.map(s=>s.sources[0]);
  assert.deepEqual(refs.map(s=>s.segmentId),['s','s']);
  assert.ok(refs.every(s=>s.geometryId)); assert.notEqual(refs[0].geometryId,refs[1].geometryId);
});

test('reverse seeking and independent runtimes retain source and prior geometry and metadata', () => {
  const b = fixture(); add(b, 'trim', 'trimPath', {path: read(), start: expression('time/10s'), end: scalar(1)});
  store(b, 'trim'); sample(b, 'sample', output('trim'));
  const authored = structuredClone(b), one = prepareScene(b), two = createEvaluator(b), frame = one.sample(1), expected = structuredClone(frame);
  one.sample(2); one.sample(0); two(0.5); assert.deepEqual(one.sample(1), expected); assert.deepEqual(two(1), expected);
  path(frame).geometry!.contours[0].start[0] = 999; node(frame).x = 999;
  frame.curves!.samples.sample.sample.position[0] = 999;
  assert.deepEqual(one.sample(1), expected); assert.deepEqual(b, authored);
  source(b).geometry!.contours[0].segments[0].to[0] = 999; assert.deepEqual(two(1), expected);
});

test('path-node reads expose self and multi-node geometry dependency cycles with source context', () => {
  for (const separate of [false, true]) {
    const b = fixture(); const operation = add(b, 'reverse', 'reversePath', {path: read()}); operation.sourceSpan = span;
    if (separate) {store(b, 'reverse'); add(b, 'return', 'reversePath', {path: read('result')}); store(b, 'return', 'source');}
    else store(b, 'reverse', 'source');
    assert.throws(() => createEvaluator(b), (error: any) => {
      const d = error.diagnostics?.find((v: any) => /CYCLE/.test(v.code)); assert.ok(d, String(error));
      assert.ok(d.sourceSpan?.file === span.file || d.related?.some((r: any) => r.sourceSpan?.file === span.file)); return true;
    });
  }
});

test('curve geometry output conflicts with graph, control tracks, expressions and deformation writers', () => {
  for (const kind of ['graph', 'track', 'expression', 'deform']) {
    const b = fixture(); add(b, 'reverse', 'reversePath', {path: read()}); store(b, 'reverse');
    if (kind === 'graph') bind(b, 'store:result', 'path', 'result', 'geometry');
    if (kind === 'track') b.tracks.push({target: 'result', property: 'geometry.c.s.to', keys: [[0, [5, 0]]]});
    if (kind === 'expression') b.expressions = {version: 1, parameters: {}, bindings: [{target: 'result', property: 'geometry.c.s.to', expression: 'vec2(5bp,0bp)'}]};
    if (kind === 'deform') b.deformations = {version: 1, operations: [{id: 'deform', source: 'source', target: 'result', mode: 'controlDeform', expression: 'position'}]};
    assert.ok(validateBundle(b).some(d => /WRITER|CONFLICT/.test(d.code))); assert.throws(() => createEvaluator(b), /WRITER|CONFLICT/);
  }
});

test('invalid sources, units, domains and closed stitching fail with structured located diagnostics', () => {
  const cases: [string, Operation['inputs'], string, PathGeometry?][] = [
    ['reversePath', {path: read('marker')}, 'OPERATION_PATH_REFERENCE'], ['reversePath', {path: read('missing')}, 'OPERATION_PATH_REFERENCE'],
    ['trimPath', {path: read(), start: scalar(0.8), end: scalar(0.2)}, 'CURVE_RANGE'],
    ['trimPath', {path: read(), start: scalar(0.8), end: scalar(0.2), wrap: scalar(1)}, 'CURVE_WRAP'],
    ['sampleCurve', {path: read(), parameter: scalar(1.1)}, 'CURVE_PROGRESS'], ['sampleCurve', {path: read(), contour: scalar(5)}, 'CURVE_CONTOUR'],
    ['sampleCurve', {path: read(), mode: scalar(2)}, 'CURVE_MODE'], ['reversePath', {path: read(), tolerance: scalar(0, 'bp')}, 'CURVE_OPTIONS'],
    ['resamplePathCount', {path: read(), count: scalar(1)}, 'CURVE_COUNT'], ['resamplePathSpacing', {path: read(), spacing: scalar(1)}, 'OPERATION_UNIT_MISMATCH'],
    ['joinPaths', {a: read(), b: read(), policy: scalar(2)}, 'CURVE_JOIN_CLOSED', square()],
  ];
  for (const [operator, inputs, code, geometry] of cases) {
    const b = fixture(geometry); add(b, 'bad', operator, operator === 'sampleCurve' ? {parameter: scalar(0.5), ...inputs} : inputs,
      scene, operator === 'sampleCurve' ? 2 : 1).sourceSpan = span;
    assert.throws(() => evaluate(b, 0), (error: any) => {
      const d = error.diagnostics?.find((v: any) => v.code === code); assert.ok(d, String(error));
      assert.equal(d.sourceSpan?.file, span.file); assert.match(d.path ?? '', /operations\[/); return true;
    });
  }
  const b = fixture(); add(b, 'bad', 'reversePath', {path: read('source', local('source'))});
  assert.ok(validateOperationGraph(b.operationGraph, b).some(d => d.code === 'OPERATION_SPACE_MISMATCH'));
});

test('candidate globals drive curve inputs and validation leaves the authored context unchanged', () => {
  const b = fixture(); b.expressions = {version: 1, parameters: {}, bindings: []};
  add(b, 'trim', 'trimPath', {path: read(), start: scalar(0), end: expression('end')}); store(b, 'trim');
  const candidate = {version: 1 as const, parameters: {end: {type: 'scalar' as const, unit: '1' as const, default: 0.5, min: 0.1, max: 1}}, bindings: []};
  assert.deepEqual(validateExpressionProgram(candidate, b), []); assert.deepEqual(b.expressions.parameters, {});
  b.expressions = candidate; const run = createEvaluator(b); near(path(run(0)).geometry!.contours[0].segments.at(-1)!.to, [5, 0]);
  near(path(run(0, {end: 0.8})).geometry!.contours[0].segments.at(-1)!.to, [8, 0]);
  near(path(run(0)).geometry!.contours[0].segments.at(-1)!.to, [5, 0]);
});

test('singular forward transforms retain closing-edge provenance for path outputs and live node reads', () => {
  const triangle: PathGeometry = {contours: [{id: 'triangle', start: [0, 0], closed: true, segments: [
    {id: 'a', kind: 'line', to: [10, 0]}, {id: 'b', kind: 'line', to: [0, 10]},
  ]}]};
  for (const kind of ['transformPath', 'live node']) {
    const b = fixture(structuredClone(triangle)); let input: InputRef = read();
    if (kind === 'transformPath') {
      const operation = add(b, 'flatten', 'transformPath', {path: read(), transform: {kind: 'literal', value: {
        type: 'transform2d', from: scene, to: scene, value: [1, 0, 0, 0, 0, 0],
      }}});
      operation.spaces = {from: scene, to: scene}; input = output('flatten');
    } else {
      b.nodes.push({id: 'flattened', kind: 'group', transform: {scale: [1, 0]}}); source(b).parent = 'flattened';
    }
    add(b, 'reverse', 'reversePath', {path: input}); store(b, 'reverse');
    sample(b, 'sample', output('reverse'), {parameter: scalar(0.75)});
    const before = structuredClone(b), f = evaluate(b, 0), g = path(f).geometry!;
    near([node(f).x, node(f).y], [5, 0]); near(f.curves!.samples.sample.sample.tangent, [-1, 0]);
    assert.equal(geometryLength(g), 20); assert.equal(g.contours[0].closed, true);
    assert.equal(g.contours[0].segments.length, 3, 'The collapsed closing edge remains an explicit zero-length segment');
    const closing = f.curves!.operations.reverse.provenance.segments.filter(s => s.sources.some(r => r.closing));
    assert.equal(closing.length, 1); assert.equal(closing[0].mapping, 'exact');
    assert.equal(closing[0].sources[0].geometryId, 'source'); assert.equal(closing[0].sources[0].segmentId, 'triangle:close');
    near(closing[0].sources[0].parameterInterval, [1, 0]); assert.deepEqual(b, before);
  }
});
