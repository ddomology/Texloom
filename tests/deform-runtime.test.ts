import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluate, createEvaluator, prepareScene, validateBundle, validateDeformationProgram,
  validateExpressionProgram, validateFieldProgram, validateOperationGraph,
  type Bundle, type PathGeometry, type PathNode, type PointNode, type LineNode} from '../src/index.ts';

const geometry = (): PathGeometry => ({contours: [{id: 'c', start: [0, 0], segments: [
  {id: 's', kind: 'cubic', c1: [0, 100], c2: [100, 100], to: [100, 0]},
]}]});
function fixture(): Bundle {
  return {version: '0.3', title: 'Deformed curves', duration: 2, units: 'bp', viewport: {width: 300, height: 250},
    camera: {x: 0, y: 0, zoom: 1}, resources: {}, tracks: [], relations: [],
    nodes: [{id: 'src', kind: 'path', d: 'M0 0', geometry: geometry()}, {id: 'dst', kind: 'path', d: 'M0 0', geometry: geometry()},
      {id: 'p', kind: 'point', x: 0, y: 0, r: 2, progress: 0.5},
      {id: 't', kind: 'line', x1: 0, y1: 0, x2: 0, y2: 0}, {id: 'n', kind: 'line', x1: 0, y1: 0, x2: 0, y2: 0}],
    deformations: {version: 1, operations: [{id: 'warp', source: 'src', target: 'dst', mode: 'controlDeform', expression: 'position'}]}};
}
function dependents(b: Bundle) {
  b.relations = [{type: 'pathDirection', target: 't', source: 'dst', point: 'p', length: 20},
    {type: 'pathDirection', target: 'n', source: 'dst', point: 'p', length: 20, normal: true},
    {type: 'pointOnPath', target: 'p', source: 'dst'}];
}
const path = (f: ReturnType<typeof evaluate>, id = 'dst') => f.nodes.find(n => n.id === id) as PathNode;
const point = (f: ReturnType<typeof evaluate>) => f.nodes.find(n => n.id === 'p') as PointNode;
function near(actual: readonly number[], expected: readonly number[], tolerance = 1e-8) {
  assert.equal(actual.length, expected.length);
  actual.forEach((x, i) => assert.ok(Number.isFinite(x) && Math.abs(x - expected[i]) <= tolerance, `${actual} != ${expected}`));
}
function linear(b: Bundle) {
  for (const n of b.nodes) if (n.kind === 'path') n.geometry = {contours: [{id: 'c', start: [0, 0], segments: [{id: 's', kind: 'line', to: [100, 0]}]}]};
}

test('affine deformation has exact analytic controls and feeds points, tangents and normals', () => {
  for (const mode of ['controlDeform', 'pointwiseDeform'] as const) {
    const b = fixture(); dependents(b); b.deformations!.operations[0].mode = mode;
    b.deformations!.operations[0].expression = 'position*2 + vec2(10bp,-5bp)';
    const f = evaluate(b, 0), p = point(f), t = f.nodes.find(n => n.id === 't') as LineNode,
      n = f.nodes.find(n => n.id === 'n') as LineNode, segment = path(f).geometry!.contours[0].segments[0];
    assert.equal(segment.kind, 'cubic');
    if (segment.kind !== 'cubic') throw new Error('Expected preserved cubic');
    near(path(f).geometry!.contours[0].start, [10, -5]); near(segment.c1, [10, 195]);
    near(segment.c2, [210, 195]); near(segment.to, [210, -5]); near([p.x, p.y], [110, 145]);
    near([t.x1, t.y1, t.x2, t.y2], [100, 145, 120, 145]); near([n.x1, n.y1, n.x2, n.y2], [110, 135, 110, 155]);
    assert.equal(f.deformations!.warp.method, mode === 'controlDeform' ? 'control' : 'affine-exact');
    assert.deepEqual(path(f, 'src').geometry, geometry());
  }
});

test('nonlinear pointwise output reports its error budget and downstream directions follow the generated curve', () => {
  const b = fixture(); linear(b); dependents(b);
  Object.assign(b.deformations!.operations[0], {mode: 'pointwiseDeform', expression: 'position + vec2(0bp,20bp*sin(parameter*pi))', tolerance: 0.25});
  const f = evaluate(b, 0), g = path(f).geometry!, report = f.deformations!.warp;
  assert.equal(report.method, 'adaptive-polyline'); assert.ok(report.outputSegments > 1);
  assert.ok(report.maxErrorBound <= 0.25); assert.equal(report.segments.length, report.outputSegments);
  for (const s of g.contours[0].segments) {
    near([s.to[1]], [20 * Math.sin(s.to[0] / 100 * Math.PI)]);
  }
  const p = point(f), t = f.nodes.find(n => n.id === 't') as LineNode, n = f.nodes.find(n => n.id === 'n') as LineNode;
  assert.ok(p.x >= 0 && p.x <= 100); near([p.y], [20 * Math.sin(p.x / 100 * Math.PI)], 0.5);
  const tv = [t.x2 - t.x1, t.y2 - t.y1], nv = [n.x2 - n.x1, n.y2 - n.y1];
  near([Math.hypot(...tv), Math.hypot(...nv), tv[0] * nv[0] + tv[1] * nv[1]], [20, 20, 0]);
  near([(t.x1 + t.x2) / 2, (t.y1 + t.y2) / 2], [p.x, p.y]);
});

test('source expression and track control writes run before deformation on another target', () => {
  const b = fixture(); dependents(b);
  b.tracks = [{target: 'src', property: 'geometry.c.s.c1', keys: [[0, [0, 100]], [2, [0, 200]]]}];
  b.expressions = {version: 1, parameters: {}, bindings: [{target: 'src', property: 'geometry.c.s.c2', expression: 'vec2(100bp,50bp*time/1s)'}]};
  b.deformations!.operations[0].expression = 'position + vec2(10bp,0bp)';
  const f = evaluate(b, 2), p = point(f); near([p.x, p.y], [60, 112.5]);
});

test('high-frequency deformation reaches downstream points without collapsing oscillations between endpoints', () => {
  const b = fixture(); linear(b); dependents(b);
  (b.nodes.find(n => n.id === 'p') as PointNode).progress = 0.137;
  Object.assign(b.deformations!.operations[0], {mode: 'pointwiseDeform',
    expression: 'position + vec2(0bp,20bp*sin(12*pi*parameter))', tolerance: 0.2});
  const f = evaluate(b, 0), p = point(f), vertices = path(f).geometry!.contours[0].segments.map(s => s.to);
  assert.ok(Math.max(...vertices.map(v => v[1])) > 19.5);
  assert.ok(Math.min(...vertices.map(v => v[1])) < -19.5);
  assert.ok(f.deformations!.warp.outputSegments > 24);
  near([p.y], [20 * Math.sin(12 * Math.PI * p.x / 100)], 0.2);
  const t = f.nodes.find(n => n.id === 't') as LineNode;
  near([(t.x1 + t.x2) / 2, (t.y1 + t.y2) / 2], [p.x, p.y]);
  assert.ok(Math.abs(t.y2 - t.y1) > 1, 'The downstream tangent must follow the oscillating output, not the undeformed horizontal source');
});

test('in-place deformation reads current frame geometry once without accumulating across seeks', () => {
  const b = fixture(); b.deformations!.operations[0].target = 'src';
  b.deformations!.operations[0].expression = 'position + vec2(10bp*time/1s,0bp)';
  const authored = structuredClone(b), run = createEvaluator(b), end = run(2);
  near(path(end, 'src').geometry!.contours[0].start, [20, 0]); run(0); run(1);
  assert.deepEqual(run(2), end); assert.deepEqual(b, authored);
  (path(end, 'src').geometry!.contours[0].start as number[])[0] = 999;
  near(path(run(2), 'src').geometry!.contours[0].start, [20, 0]);
});

test('separate target mapping uses numeric local coordinates without an implicit source world transform', () => {
  const b = fixture(); dependents(b);
  b.nodes[0].transform = {translate: [1000, 2000]};
  b.nodes[1].transform = {translate: [10, 20], scale: [2, 3]};
  const f = evaluate(b, 0); assert.deepEqual(path(f).geometry, geometry());
  near([point(f).x, point(f).y], [110, 245]);
});

test('global parameters, clamped time, independent runtimes and reports have no stale state', () => {
  const b = fixture(); b.expressions = {version: 1, parameters: {shift: {type: 'scalar', unit: 'bp', default: 10}}, bindings: []};
  b.deformations!.operations[0].expression = 'position + vec2(shift,10bp*time/1s)';
  const original = structuredClone(b), one = prepareScene(b), two = prepareScene(b), overrides = {shift: 30};
  const f = one.sample(1, overrides), expected = structuredClone(f); near(path(f).geometry!.contours[0].start, [30, 10]);
  one.sample(2); one.sample(0); two.sample(0, {shift: 0}); assert.deepEqual(one.sample(1, overrides), expected); assert.deepEqual(two.sample(1, overrides), expected);
  near(path(one.sample(100)).geometry!.contours[0].start, [10, 20]);
  assert.deepEqual(overrides, {shift: 30}); assert.deepEqual(b, original); assert.ok(Object.isFrozen(f.deformations!.warp));
  b.deformations!.operations[0].expression = 'vec2(0bp,0bp)'; assert.deepEqual(one.sample(1, overrides), expected);
});

test('deformation chains use source dependencies rather than authored operation order', () => {
  const b = fixture(); dependents(b); b.nodes.push({id: 'mid', kind: 'path', d: 'M0 0', geometry: geometry()});
  b.deformations!.operations = [
    {id: 'second', source: 'mid', target: 'dst', mode: 'controlDeform', expression: 'position + vec2(0bp,20bp)'},
    {id: 'first', source: 'src', target: 'mid', mode: 'controlDeform', expression: 'position*2'},
  ];
  const f = evaluate(b, 0); near([point(f).x, point(f).y], [100, 170]);
  assert.deepEqual(Object.keys(f.deformations!).sort(), ['first', 'second']);
});

test('cyclic deformation dependencies are diagnosed with authored source context', () => {
  const b = fixture(); b.deformations!.operations[0].sourceSpan = {file: 'curves.tex', start: {line: 5, column: 1}, end: {line: 5, column: 30}};
  b.deformations!.operations.push({id: 'back', source: 'dst', target: 'src', mode: 'controlDeform', expression: 'position'});
  assert.throws(() => createEvaluator(b), (error: any) => {
    const d = error.diagnostics?.find((d: any) => /CYCLE/.test(d.code)); assert.ok(d, String(error));
    assert.ok(d.sourceSpan?.file === 'curves.tex' || d.related?.some((r: any) => r.sourceSpan?.file === 'curves.tex')); return true;
  });
});

test('same-target deformation writers reject tracks, expressions, operation outputs and duplicate deformation writes', () => {
  const track = fixture(); track.tracks.push({target: 'dst', property: 'geometry.c.s.c1', keys: [[0, [1, 2]]]});
  const expression = fixture(); expression.expressions = {version: 1, parameters: {}, bindings: [{target: 'dst', property: 'geometry.c.s.c1', expression: 'vec2(1bp,2bp)'}]};
  const operation = fixture(); operation.operationGraph = {version: 1, operations: [{id: 'path', operator: 'pathValue', version: 1,
    spaces: {space: {kind: 'local', node: 'dst'}}, inputs: {value: {kind: 'literal', value: {type: 'path2d', space: {kind: 'local', node: 'dst'}, value: geometry()}}}}],
    bindings: [{target: 'dst', property: 'geometry', value: {operation: 'path', socket: 'value'}}]};
  const duplicate = fixture(); duplicate.deformations!.operations.push({...duplicate.deformations!.operations[0], id: 'other'});
  for (const b of [track, expression, operation, duplicate]) {
    assert.ok(validateBundle(b).some(d => /WRITER|CONFLICT/.test(d.code))); assert.throws(() => createEvaluator(b), /WRITER|CONFLICT/);
  }
});

test('same-topology fields observe deformed geometry while changed topology refuses implicit original-position matching', () => {
  const b = fixture(); b.deformations!.operations[0].expression = 'position + vec2(10bp,0bp)';
  b.fields = {version: 1, domains: [{id: 'sampled', geometry: 'dst', domain: 'curve-sample', samples: [{id: 'mid', parameter: 0.5}]}],
    operations: [{id: 'current', domain: 'sampled', kind: 'capture', expression: 'position'},
      {id: 'original', domain: 'sampled', kind: 'capture', expression: 'originalPosition'}], bindings: []};
  const f = evaluate(b, 0); assert.deepEqual(f.fields!.attributes.current.values.mid, [60, 75]);
  assert.deepEqual(f.fields!.attributes.original.values.mid, [50, 75]);
  b.deformations!.operations[0].mode = 'pointwiseDeform'; b.deformations!.operations[0].expression = 'position + vec2(0bp,20bp*sin(parameter*pi))';
  assert.throws(() => evaluate(b, 0), /TOPOLOGY/);
});

test('standalone validator contexts keep shared globals while checking deformation conflicts', () => {
  const b = fixture(); b.expressions = {version: 1, parameters: {shift: {type: 'scalar', unit: 'bp', default: 10}}, bindings: []};
  b.deformations!.operations[0].expression = 'position + vec2(shift,0bp)';
  b.operationGraph = {version: 1, operations: [], bindings: []}; b.fields = {version: 1, domains: [], operations: [], bindings: []};
  assert.deepEqual(validateDeformationProgram(b.deformations!, b), []);
  assert.deepEqual(validateExpressionProgram(b.expressions!, b), []);
  assert.deepEqual(validateOperationGraph(b.operationGraph, b), []);
  assert.deepEqual(validateFieldProgram(b.fields, b), []);
});

test('malformed declarations, wrong units and unsupported pointwise control locals are rejected as diagnostics', () => {
  for (const changes of [
    {source: {toString: null}}, {target: 'absent'}, {mode: 'unknown'}, {expression: 'vec2(1,2)'},
    {tolerance: 0}, {maxDepth: 0}, {maxSegments: 0}, {maxDepth: 25}, {mode: 'pointwiseDeform', expression: 'position + vec2(index*1bp,0bp)'},
  ]) {
    const b = fixture(); Object.assign(b.deformations!.operations[0], changes);
    assert.doesNotThrow(() => validateBundle(b)); assert.doesNotThrow(() => validateDeformationProgram(b.deformations!, b));
    assert.ok(validateBundle(b).some(d => d.severity === 'error')); assert.throws(() => createEvaluator(b));
  }
});

test('adaptive resource limits fail explicitly with operation and source locations', () => {
  const b = fixture(); linear(b);
  Object.assign(b.deformations!.operations[0], {mode: 'pointwiseDeform', expression: 'position + vec2(0bp,20bp*sin(3*pi*parameter))',
    tolerance: 1e-9, maxDepth: 1, maxSegments: 2,
    sourceSpan: {file: 'bounded.tex', start: {line: 9, column: 1}, end: {line: 9, column: 50}}});
  assert.throws(() => evaluate(b, 0), (error: any) => {
    const d = error.diagnostics?.[0]; assert.ok(d, String(error)); assert.match(`${d.code} ${d.message}`, /BUDGET|TOLERANCE|DEPTH|SEGMENT|BOUND/i);
    assert.equal(d.sourceSpan?.file, 'bounded.tex'); assert.match(d.path ?? '', /deformations.*operations\[0\]/); return true;
  });
});
