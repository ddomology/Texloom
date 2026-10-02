import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  createEvaluator, evaluate, prepareScene, validateBundle, SVG_2D_PROFILE, worldMatrix,
  type Bundle, type EvaluatedFrame, type InputRef, type LiteralValue, type Node,
  type Operation, type PointNode, type LineNode, type PathNode,
} from '../src/index.ts';
import {renderSvg} from '../src/render-svg.ts';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/operations/sample-curve.json', import.meta.url), 'utf8'));
const scene = {kind: 'scene'} as const;
const local = (node: string) => ({kind: 'local', node} as const);
const copy = <T>(x: T): T => structuredClone(x);
const literal = (value: LiteralValue): InputRef => ({kind: 'literal', value});
const scalar = (value: number) => literal({type: 'scalar', value});
const b = (): Bundle => copy(fixture);
function empty(): Bundle { const bundle = b(); bundle.operationGraph = {version: 1, operations: [], bindings: []}; return bundle; }
function near(actual: number[], expected: number[], tolerance = 1e-9) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, i) => assert.ok(Number.isFinite(value) && Math.abs(value - expected[i]) <= tolerance,
    `${JSON.stringify(actual)} != ${JSON.stringify(expected)}`));
}
function node<T extends Node>(frame: EvaluatedFrame, id: string): T {
  const found = frame.nodes.find(n => n.id === id); assert.ok(found, `node ${id}`); return found as T;
}
function bind(bundle: Bundle, operation: Operation, target: string, property: string, socket = 'value') {
  bundle.operationGraph!.operations.push(operation);
  bundle.operationGraph!.bindings.push({target, property, value: {operation: operation.id, socket}});
}
function producer(id: string, operator: string, value: LiteralValue, spaces: Operation['spaces'] = {}): Operation {
  return {id, operator, version: 1, spaces, inputs: {value: literal(value)}};
}
function labelResource(bundle: Bundle) {
  bundle.resources.label = {kind: 'vector', items: [{kind: 'path', d: 'M0 0L1 1', style: {fill: 'white'}}],
    metrics: {width: 1, height: 1, depth: 0}, inkBounds: [0, 0, 1, 1]};
}

test('authored curve samples have independently computed cubic coordinates and actual SVG output', () => {
  const bundle = b(), original = copy(bundle), frame = evaluate(bundle, 1);
  // B(1/2) = (P0 + 3 P1 + 3 P2 + P3) / 8 = (71.25, 17.5).
  // B'(1/2) = (142.5, 0), giving a unit tangent (1, 0).
  const point = node<PointNode>(frame, 'dot'), tangent = node<LineNode>(frame, 'tangent');
  near([point.x, point.y], [71.25, 17.5]);
  near([tangent.x1, tangent.y1, tangent.x2, tangent.y2], [71.25, 17.5, 96.25, 17.5]);
  assert.match(renderSvg(frame), /cx="71.25" cy="17.5"/);
  assert.match(renderSvg(frame), /x1="71.25" y1="17.5" x2="96.25" y2="17.5"/);
  assert.deepEqual(bundle, original);
});

test('offsetPoint uses the supplied vector magnitude and distance without implicit normalization', () => {
  const bundle = empty();
  bind(bundle, {id: 'offset', operator: 'offsetPoint', version: 1, spaces: {space: scene}, inputs: {
    origin: literal({type: 'vec2', role: 'point', space: scene, value: [2, 3]}),
    direction: literal({type: 'vec2', role: 'vector', space: scene, value: [3, 4]}), distance: scalar(2),
  }}, 'dot', 'position', 'position');
  const p = node<PointNode>(evaluate(bundle, 0), 'dot'); near([p.x, p.y], [8, 11]);
});

test('runtime execution resolves omitted defaults and accepts both exact curve endpoints', () => {
  const bundle = b(); delete bundle.operationGraph!.operations[1].inputs.parameter;
  const start = evaluate(bundle, 0), p = node<PointNode>(start, 'dot'), tangent = node<LineNode>(start, 'tangent');
  near([p.x, p.y], [10, 70]);
  near([tangent.x2, tangent.y2], [10 + 25 * 3 / Math.sqrt(58), 70 - 25 * 7 / Math.sqrt(58)]);
  bundle.operationGraph!.operations[1].inputs.parameter = scalar(1);
  const end = node<PointNode>(evaluate(bundle, 0), 'dot'); near([end.x, end.y], [140, 70]);
});

test('transformPoint applies the declared affine map including a reflected nonuniform scale', () => {
  const bundle = empty();
  bind(bundle, {id: 'transform', operator: 'transformPoint', version: 1, spaces: {from: local('curve'), to: scene}, inputs: {
    point: literal({type: 'vec2', role: 'point', space: local('curve'), value: [3, 4]}),
    transform: literal({type: 'transform2d', from: local('curve'), to: scene, value: [0, -2, -3, 0, 10, 20]}),
  }}, 'dot', 'position', 'position');
  const p = node<PointNode>(evaluate(bundle, 0), 'dot'); near([p.x, p.y], [-2, 14]);
});

test('scene-position sinks invert reflected ancestors and local translations independently of the camera', () => {
  const bundle = b();
  bundle.nodes.push({id: 'parent', kind: 'group', transform: {translate: [10, 20], rotate: Math.PI / 2, scale: [-2, 3]}});
  const dot = bundle.nodes.find(n => n.id === 'dot')!, line = bundle.nodes.find(n => n.id === 'tangent')!;
  dot.parent = 'parent'; dot.transform = {translate: [2, -1]};
  line.parent = 'parent'; line.transform = {translate: [-4, 2]};
  bundle.camera = {x: 300, y: -100, zoom: 7, rotation: 1.2};
  const frame = evaluate(bundle, 0), p = node<PointNode>(frame, 'dot'), t = node<LineNode>(frame, 'tangent');
  // Dot world mapping: (13 - 3y, 16 - 2x); line: (4 - 3y, 28 - 2x).
  near([p.x, p.y], [-0.75, -58.25 / 3]);
  near([t.x1, t.y1, t.x2, t.y2], [5.25, -67.25 / 3, 5.25, -92.25 / 3]);
  bundle.tracks.push({target: 'parent', property: 'transform.translate', keys: [[0, [10, 20]], [2, [30, 50]]]});
  const end = node<PointNode>(evaluate(bundle, 2), 'dot'); near([end.x, end.y], [14.25, -12.75]);
});

test('a scalar graph binding executes before the legacy point and tangent relations that consume it', () => {
  const bundle = empty(); bundle.nodes = [
    {id: 'ellipse', kind: 'ellipse', cx: 5, cy: 7, rx: 10, ry: 20},
    {id: 'orbit', kind: 'point', x: 0, y: 0, r: 1, phase: 0},
    {id: 'tangent', kind: 'line', x1: 0, y1: 0, x2: 0, y2: 0},
  ];
  bundle.relations = [
    {type: 'tangent', target: 'tangent', source: 'ellipse', point: 'orbit', length: 4},
    {type: 'pointOnEllipse', target: 'orbit', source: 'ellipse'},
  ];
  bind(bundle, producer('phase', 'scalarValue', {type: 'scalar', value: Math.PI / 2}), 'orbit', 'phase');
  const frame = evaluate(bundle, 0), p = node<PointNode>(frame, 'orbit'), t = node<LineNode>(frame, 'tangent');
  near([p.x, p.y], [5, 27]); near([t.x1, t.y1, t.x2, t.y2], [7, 27, 3, 27]);
});

test('an authored point output is visible to a legacy lineBetween dependent', () => {
  const bundle = b();
  bundle.nodes.push({id: 'other', kind: 'point', x: 5, y: 2, r: 1},
    {id: 'joined', kind: 'line', x1: 0, y1: 0, x2: 0, y2: 0});
  bundle.relations.push({type: 'lineBetween', target: 'joined', a: 'dot', b: 'other'});
  const t = node<LineNode>(evaluate(bundle, 0), 'joined'); near([t.x1, t.y1, t.x2, t.y2], [71.25, 17.5, 5, 2]);
});

test('a parent transform binding precedes a connector reading descendant anchors', () => {
  const bundle = empty(); bundle.nodes = [
    {id: 'parent', kind: 'group'}, {id: 'A', kind: 'group', parent: 'parent', anchors: {p: [0, 0]}},
    {id: 'B', kind: 'group', anchors: {p: [10, 0]}}, {id: 'edge', kind: 'path', d: 'M0 0'},
  ];
  bundle.relations = [{type: 'connect', target: 'edge', from: {node: 'A', anchor: 'p'}, to: {node: 'B', anchor: 'p'}}];
  bind(bundle, producer('translation', 'vectorValue', {type: 'vec2', role: 'vector', space: scene, value: [1, 2]}, {space: scene}),
    'parent', 'transform.translate');
  const path = node<PathNode>(evaluate(bundle, 0), 'edge');
  near(path.resolvedPath!.start, [1, 2]); near(path.resolvedPath!.end, [10, 0]);
});

test('scene-position binding waits for an authored ancestor transform regardless of binding order', () => {
  const bundle = b();
  bundle.nodes.push({id: 'parent', kind: 'group'});
  bundle.nodes.find(n => n.id === 'dot')!.parent = 'parent';
  // The position binding occurs first in authored order but must consume the final parent matrix.
  bind(bundle, producer('translation', 'vectorValue', {type: 'vec2', role: 'vector', space: scene, value: [10, 20]}, {space: scene}),
    'parent', 'transform.translate');
  const p = node<PointNode>(evaluate(bundle, 0), 'dot'); near([p.x, p.y], [61.25, -2.5]);
});

test('whole-path graph output is sampled by legacy relations before SVG lowering', () => {
  const bundle = empty();
  const geometry = {contours: [{id: 'new', start: [10, 20] as [number, number], segments: [{id: 'line', kind: 'line' as const, to: [50, 20] as [number, number]}]}]};
  bind(bundle, producer('path', 'pathValue', {type: 'path2d', space: local('curve'), value: geometry}, {space: local('curve')}), 'curve', 'geometry');
  (bundle.nodes.find(n => n.id === 'dot') as PointNode).progress = 0.25;
  bundle.relations = [{type: 'pointOnPath', target: 'dot', source: 'curve'}];
  const frame = evaluate(bundle, 0), p = node<PointNode>(frame, 'dot'), path = node<PathNode>(frame, 'curve');
  near([p.x, p.y], [20, 20]); assert.equal(path.d, 'M 10 20 L 50 20');
  assert.deepEqual(path.geometry, geometry);
});

test('control-point output precedes legacy sampling and preserves stable contour/segment IDs', () => {
  const bundle = empty();
  bind(bundle, producer('control', 'pointValue', {type: 'vec2', role: 'point', space: local('curve'), value: [40, 20]}, {space: local('curve')}),
    'curve', 'geometry.c.s.c1');
  (bundle.nodes.find(n => n.id === 'dot') as PointNode).progress = 0.5;
  bundle.relations = [{type: 'pointOnPath', target: 'dot', source: 'curve'}];
  const frame = evaluate(bundle, 0), p = node<PointNode>(frame, 'dot');
  near([p.x, p.y], [71.25, 25]);
  assert.match(node<PathNode>(frame, 'curve').d, /40 20/);
});

test('whole transform outputs retain rotation, nonuniform scale and reflection in rendered geometry', () => {
  const bundle = empty(); bundle.nodes = [
    {id: 'A', kind: 'group', anchors: {p: [3, 4]}},
    {id: 'B', kind: 'group', anchors: {p: [40, 30]}}, {id: 'edge', kind: 'path', d: 'M0 0'},
  ];
  bundle.relations = [{type: 'connect', target: 'edge', from: {node: 'A', anchor: 'p'}, to: {node: 'B', anchor: 'p'}}];
  bind(bundle, producer('matrix', 'transformValue', {type: 'transform2d', from: local('A'), to: scene, value: [0, -2, -3, 0, 10, 20]},
    {from: local('A'), to: scene}), 'A', 'transform');
  const path = node<PathNode>(evaluate(bundle, 0), 'edge'); near(path.resolvedPath!.start, [-2, 14]);
  near(path.resolvedPath!.end, [40, 30]);
});

test('whole transform bindings explicitly reject shear rather than silently approximating it', () => {
  const bundle = empty();
  bind(bundle, producer('shear', 'transformValue', {type: 'transform2d', from: local('dot'), to: scene, value: [1, 0, 0.5, 1, 0, 0]},
    {from: local('dot'), to: scene}), 'dot', 'transform');
  assert.throws(() => evaluate(bundle, 0), /shear/i);
});

test('exact quarter-turn transforms tolerate scale-amplified trigonometric roundoff by matrix column', () => {
  const bundle = empty();
  bind(bundle, producer('quarterTurn', 'transformValue', {
    type: 'transform2d', from: local('dot'), to: scene, value: [0, 1, -1_000_000, 0, 0, 0],
  }, {from: local('dot'), to: scene}), 'dot', 'transform');
  const frame = evaluate(bundle, 0);
  const matrix = worldMatrix('dot', new Map(frame.nodes.map(n => [n.id, n])));
  // A quarter-turn has an exact zero diagonal, but cos(pi/2) is not exactly zero.
  // The numerical budget follows each column's norm, not its individual entries.
  near(matrix.slice(0, 2), [0, 1], 1e-12);
  near(matrix.slice(2, 4), [-1_000_000, 0], 1e-12 * 1_000_000);
  near(matrix.slice(4), [0, 0], 1e-12);
});

test('frame state is independently mutable while runtime resource snapshots are shared and deeply frozen', () => {
  const bundle = b(); labelResource(bundle);
  bundle.nodes[0].source = {semantic: {name: 'curve'}};
  bundle.resources.field = {kind: 'scalar-field', columns: 1, rows: 1, times: [0, 2], samples: [[0], [1]], range: [0, 1], interpolation: 'linear'};
  bundle.nodes.push({id: 'field', kind: 'field', resourceId: 'field', x: 0, y: 0, width: 10, height: 10});
  const original = copy(bundle), firstRuntime = createEvaluator(bundle), otherRuntime = createEvaluator(bundle);
  const first = firstRuntime(1), other = otherRuntime(1), expected = copy(other);
  assert.deepEqual(bundle, original);
  assert.notEqual(first.resources, other.resources);
  assert.notEqual(first.resources.label, bundle.resources.label);
  assert.equal(first.resources, firstRuntime(1).resources);
  assert.ok(Object.isFrozen(first.resources));
  assert.ok(Object.isFrozen((first.resources.label as any).items[0].style));
  assert.ok(Object.isFrozen((first.resources.field as any).samples[0]));
  assert.equal(Object.isFrozen(bundle.resources), false);
  first.viewport.width = 99; first.camera.zoom = 10;
  node<PathNode>(first, 'curve').geometry!.contours[0].start[0] = 999;
  (first.nodes[0].source!.semantic as {name: string}).name = 'changed';
  assert.throws(() => { (first.resources.label as any).items[0].style.fill = 'red'; }, TypeError);
  assert.throws(() => { (first.resources.field as any).samples[0][0] = 500; }, TypeError);
  (first.nodes.find(n => n.id === 'field') as any).values[0] = 50;
  assert.deepEqual(other, expected); assert.deepEqual(bundle, original);
  assert.deepEqual(firstRuntime(1), expected); assert.deepEqual(otherRuntime(1), expected);
  (bundle.resources.label as any).items[0].d = 'M100 100';
  (bundle.operationGraph!.operations[1].inputs.parameter as any).value.value = 0;
  assert.deepEqual(firstRuntime(1), expected); assert.deepEqual(otherRuntime(1), expected);
});

test('graph transforms cannot bypass legacy local-identity constraints and retain the relation source span', () => {
  const bundle = empty();
  bundle.nodes.push({id: 'other', kind: 'point', x: 5, y: 2, r: 1});
  bundle.relations = [{type: 'lineBetween', target: 'tangent', a: 'dot', b: 'other',
    sourceSpan: {file: 'legacy.tex', start: {line: 7, column: 1}, end: {line: 7, column: 30}}}];
  bind(bundle, producer('translation', 'vectorValue', {type: 'vec2', role: 'vector', space: scene, value: [1, 0]}, {space: scene}),
    'dot', 'transform.translate');
  assert.throws(() => evaluate(bundle, 0), (error: any) => {
    const diagnostic = error.diagnostics?.find((d: any) => d.code === 'RELATION_LOCAL_TRANSFORM');
    assert.ok(diagnostic, String(error)); assert.equal(diagnostic.sourceSpan?.file, 'legacy.tex');
    assert.equal(diagnostic.path, '$.relations[0]'); return true;
  });
});

test('capability inventories include graph-produced opacity and transforms before frame evaluation', () => {
  const bundle = empty();
  bind(bundle, producer('opacity', 'scalarValue', {type: 'scalar', value: 0.5}), 'dot', 'style.opacity');
  bind(bundle, producer('translation', 'vectorValue', {type: 'vec2', role: 'vector', space: scene, value: [1, 0]}, {space: scene}),
    'dot', 'transform.translate');
  const runtime = prepareScene(bundle);
  assert.ok(runtime.manifest.features.includes('paint.opacity'));
  assert.ok(runtime.manifest.features.includes('transform.affine.2d'));
  assert.throws(() => runtime.require({id: 'limited', contract: 'texloom-render/1', features: ['path.2d', 'primitive.2d']}), /RENDER_CAPABILITY/);
  assert.doesNotThrow(() => runtime.require(SVG_2D_PROFILE));
  const point = node<PointNode>(runtime.sample(0), 'dot');
  assert.equal(point.style?.opacity, 0.5); assert.deepEqual(point.transform?.translate, [1, 0]);
});

test('reverse seeks and independent playback order produce identical authored-and-legacy frames', () => {
  const bundle = b();
  bundle.tracks = [{target: 'dot', property: 'r', keys: [[0, 2], [2, 6]]},
    {target: '$camera', property: 'x', keys: [[0, 0], [2, 40]]}];
  const one = prepareScene(bundle), two = prepareScene(bundle);
  const times = [0, 0.25, 0.75, 1, 2], frames = times.map(time => one.sample(time));
  for (const time of [2, 0, 1, 0.25, 0.75]) {
    const expected = frames[times.indexOf(time)];
    assert.deepEqual(one.sample(time), expected); assert.deepEqual(two.sample(time), expected);
    assert.equal(renderSvg(two.sample(time)), renderSvg(expected));
  }
  assert.throws(() => one.sample(NaN), /finite/i);
});

test('out-of-domain curve inputs fail with operation identity and source location', () => {
  for (const [name, value] of [['parameter', -0.1], ['parameter', 1.1], ['tolerance', 0], ['tolerance', -1]] as const) {
    const bundle = b(), op = bundle.operationGraph!.operations[1]; op.inputs[name] = scalar(value);
    assert.throws(() => evaluate(bundle, 0), (error: any) => {
      const diagnostic = error.diagnostics?.find((d: any) => d.code === 'OPERATION_DOMAIN');
      assert.ok(diagnostic, String(error)); assert.equal(diagnostic.sourceSpan?.file, 'sample-curve.tex');
      assert.equal(diagnostic.path, `$.operationGraph.operations[1].inputs.${name}`);
      return true;
    });
  }
});

test('finite inputs whose arithmetic overflows are rejected before invalid frames escape', () => {
  const offset = empty();
  bind(offset, {id: 'overflow', operator: 'offsetPoint', version: 1, spaces: {space: scene}, inputs: {
    origin: literal({type: 'vec2', role: 'point', space: scene, value: [Number.MAX_VALUE, 0]}),
    direction: literal({type: 'vec2', role: 'vector', space: scene, value: [1, 0]}), distance: scalar(Number.MAX_VALUE),
  }}, 'dot', 'position', 'position');
  assert.throws(() => evaluate(offset, 0), /OPERATION_NONFINITE_OUTPUT/);
  const transform = empty();
  bind(transform, {id: 'overflow', operator: 'transformPoint', version: 1, spaces: {from: scene, to: scene}, inputs: {
    point: literal({type: 'vec2', role: 'point', space: scene, value: [2, 0]}),
    transform: literal({type: 'transform2d', from: scene, to: scene, value: [Number.MAX_VALUE, 0, 0, 1, 0, 0]}),
  }}, 'dot', 'position', 'position');
  assert.throws(() => evaluate(transform, 0), /OPERATION_NONFINITE_OUTPUT/);
});

test('degenerate sampled paths fail even when their outputs have no scene bindings', () => {
  const bundle = b(); bundle.operationGraph!.bindings = [];
  (bundle.operationGraph!.operations[1].inputs.curve as any).value.value = {contours: [{id: 'still', start: [3, 4], segments: []}]};
  assert.throws(() => evaluate(bundle, 0), /sample|tangent|segment/i);
});

test('value producers do not bypass scalar property bounds at execution', () => {
  const bundle = empty();
  bind(bundle, producer('negativeRadius', 'scalarValue', {type: 'scalar', value: -1}), 'dot', 'r');
  assert.throws(() => evaluate(bundle, 0), /range|radius|negative|binding/i);
  bundle.operationGraph!.bindings[0].target = '$camera'; bundle.operationGraph!.bindings[0].property = 'zoom';
  bundle.operationGraph!.operations[0].inputs.value = scalar(0);
  assert.throws(() => evaluate(bundle, 0), /range|zoom|positive|binding/i);
});

test('authored dependency cycles retain source context and cannot enter runtime execution', () => {
  const bundle = b();
  bundle.operationGraph!.operations[0].inputs.origin = {kind: 'output', ref: {operation: 'tip', socket: 'position'}};
  const diagnostic = validateBundle(bundle).find(d => d.code === 'OPERATION_CYCLE');
  assert.equal(diagnostic?.sourceSpan?.file, 'sample-curve.tex');
  assert.throws(() => createEvaluator(bundle), /OPERATION_CYCLE/);
});
