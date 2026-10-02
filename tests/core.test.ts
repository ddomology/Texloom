import test from 'node:test';
import assert from 'node:assert/strict';
import { assertBundle, BundleValidationError, createEvaluator, evaluate, validateBundle, type Bundle, type EllipseNode, type LineNode, type PointNode, type TexNode } from '../src/index.js';

function fixture(): Bundle {
  return {
    version: '0.1', title: 'Moving ellipse', duration: 8, units: 'bp', viewport: { width: 640, height: 360 }, camera: { x: 320, y: 180, zoom: 1 },
    resources: {
      label: { kind: 'vector', metrics: { width: 13, height: 8, depth: 2 }, inkBounds: [0, -8, 13, 10], items: [{ kind: 'group', style: { opacity: 0.6 }, clip: { d: 'M0 0H10V10Z', transform: [1, 0, 0, 1, 2, 3] }, children: [{ kind: 'path', d: 'M0 0L4 -6L8 0Z', style: { fill: '#fff', fillRule: 'evenodd' } }] }] },
      wave: { kind: 'scalar-field', columns: 2, rows: 2, times: [1, 3, 6], samples: [[0, 1, 2, 3], [4, 5, 6, 7], [10, 11, 12, 13]], range: [0, 13], interpolation: 'linear' },
    },
    nodes: [
      { id: 'surface', kind: 'group', transform: { translate: [100, 40], rotate: 0.2 }, style: { opacity: 0.8 }, clip: { d: 'M-120 -120H120V120H-120Z' } },
      { id: 'ellipse', kind: 'ellipse', parent: 'surface', cx: 0, cy: 0, rx: 40, ry: 40 },
      { id: 'point', kind: 'point', parent: 'surface', x: 0, y: 0, r: 3, phase: 0 },
      { id: 'tangent', kind: 'line', parent: 'surface', x1: 0, y1: 0, x2: 0, y2: 0 },
      { id: 'label', kind: 'tex', parent: 'surface', resourceId: 'label', x: 0, y: 0 },
      { id: 'fixed', kind: 'point', parent: 'surface', x: 0, y: 0, r: 2 },
      { id: 'radius', kind: 'line', parent: 'surface', x1: 0, y1: 0, x2: 0, y2: 0 },
      { id: 'wave', kind: 'field', resourceId: 'wave', x: 10, y: 10, width: 100, height: 100 },
    ],
    tracks: [
      { target: 'ellipse', property: 'rx', keys: [[0, 40], [8, 100]], interpolation: 'smooth' },
      { target: 'ellipse', property: 'ry', keys: [[0, 40], [8, 25]] },
      { target: 'point', property: 'phase', keys: [[0, 0], [8, 4 * Math.PI]] },
      { target: '$camera', property: 'zoom', keys: [[0, 1], [4, 1.4], [8, 1]] },
      { target: 'surface', property: 'transform.translate', keys: [[0, [100, 40]], [8, [300, 160]]] },
    ],
    // Deliberately put dependants first: authoring order is not evaluation order.
    relations: [
      { type: 'attach', target: 'label', source: 'point', offset: [8, -10] },
      { type: 'tangent', target: 'tangent', source: 'ellipse', point: 'point', length: 90 },
      { type: 'lineBetween', target: 'radius', a: 'fixed', b: 'point' },
      { type: 'pointOnEllipse', target: 'point', source: 'ellipse' },
    ],
  };
}
const close = (actual: number, expected: number, tolerance = 1e-10) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
const codes = (value: unknown) => validateBundle(value).filter(d => d.severity === 'error').map(d => d.code);

test('ellipse, tangent, attached TeX baseline and line dependencies satisfy geometric invariants', () => {
  const at = createEvaluator(fixture());
  for (const time of [0, 0.123, 1.79, 3.99, 6.76, 8]) {
    const frame = at(time);
    const e = frame.nodes.find(n => n.id === 'ellipse') as EllipseNode;
    const p = frame.nodes.find(n => n.id === 'point') as PointNode;
    const tangent = frame.nodes.find(n => n.id === 'tangent') as LineNode;
    const label = frame.nodes.find(n => n.id === 'label') as TexNode;
    const radius = frame.nodes.find(n => n.id === 'radius') as LineNode;
    close(((p.x - e.cx) / e.rx) ** 2 + ((p.y - e.cy) / e.ry) ** 2, 1);
    close((tangent.x1 + tangent.x2) / 2, p.x); close((tangent.y1 + tangent.y2) / 2, p.y);
    close(Math.hypot(tangent.x2 - tangent.x1, tangent.y2 - tangent.y1), 90);
    close((tangent.x2 - tangent.x1) * (p.x - e.cx) / (e.rx ** 2) + (tangent.y2 - tangent.y1) * (p.y - e.cy) / (e.ry ** 2), 0);
    close(label.x, p.x + 8); close(label.y, p.y - 10); close(radius.x2, p.x); close(radius.y2, p.y);
  }
});

test('random seeking equals sequential evaluation and does not mutate input or retain frame mutations', () => {
  const bundle = fixture(), original = structuredClone(bundle), at = createEvaluator(bundle);
  const expected = Array.from({ length: 49 }, (_, index) => at(index / 6));
  for (const i of Array.from({ length: 49 }, (_, j) => (j * 19) % 49)) assert.deepEqual(at(i / 6), expected[i]);
  // The same absolute time is invariant under 30fps versus 60fps histories.
  for (let i = 0; i <= 60; i++) at(i / 30);
  const fps30 = at(2);
  for (let i = 0; i <= 120; i++) at(i / 60);
  assert.deepEqual(at(2), fps30);
  const modified = at(2); modified.nodes[0].id = 'changed'; modified.camera.zoom = 999;
  assert.deepEqual(at(2), fps30); assert.deepEqual(bundle, original);
  bundle.nodes[0].id = 'changed-after-preparation';
  assert.deepEqual(at(2), fps30, 'prepared evaluator owns a snapshot');
});

test('clamps absolute time, validates non-finite time, and preserves paint grouping and clip metadata', () => {
  const b = fixture(), at = createEvaluator(b);
  assert.deepEqual(at(-9), at(0)); assert.deepEqual(at(99), at(8));
  assert.throws(() => at(NaN), RangeError); assert.throws(() => at(Infinity), RangeError);
  const frame = at(3);
  assert.deepEqual(frame.nodes[0].clip, b.nodes[0].clip);
  assert.equal(frame.nodes[1].parent, 'surface'); assert.deepEqual(frame.resources.label, b.resources.label);
  assert.ok(Object.isFrozen(frame.resources.label)); assert.equal(frame.resources, at(4).resources, 'large resources are shared');
  assert.ok(!('tracks' in frame)); assert.ok(!('relations' in frame));
});

test('linear, smoothstep, vector, camera and right-continuous step interpolation', () => {
  const b = fixture();
  b.tracks.push({ target: 'fixed', property: 'r', interpolation: 'step', keys: [[1, 2], [3, 5], [7, 8]] });
  const at = createEvaluator(b);
  const radius = (t: number) => (at(t).nodes.find(n => n.id === 'fixed') as PointNode).r;
  assert.equal(radius(0), 2); assert.equal(radius(2.999), 2); assert.equal(radius(3), 5); assert.equal(radius(8), 8);
  close((at(2).nodes[1] as EllipseNode).rx, 40 + 60 * 0.15625);
  close((at(2).nodes[1] as EllipseNode).ry, 36.25);
  assert.deepEqual(at(2).nodes[0].transform?.translate, [150, 70]); close(at(2).camera.zoom, 1.2);
});

test('field interpolation matches sample times and handles clamping and step mode', () => {
  const b = fixture(), at = createEvaluator(b);
  const values = (time: number) => (at(time).nodes.find(n => n.kind === 'field') as any).values;
  assert.deepEqual(values(0), [0, 1, 2, 3]); assert.deepEqual(values(2), [2, 3, 4, 5]);
  assert.deepEqual(values(3), [4, 5, 6, 7]); assert.deepEqual(values(8), [10, 11, 12, 13]);
  if (b.resources.wave.kind === 'scalar-field') b.resources.wave.interpolation = 'step';
  const step = createEvaluator(b);
  assert.deepEqual((step(2.99).nodes[7] as any).values, [0, 1, 2, 3]);
  assert.deepEqual((step(3).nodes[7] as any).values, [4, 5, 6, 7]);
});

test('validates duplicate IDs, parent kinds, missing resources, bad numbers and JSON values', () => {
  const checks: [string, (b: any) => void][] = [
    ['DUPLICATE_ID', b => b.nodes.push(structuredClone(b.nodes[1]))],
    ['PARENT_KIND', b => b.nodes[2].parent = 'ellipse'],
    ['PARENT_REFERENCE', b => b.nodes[2].parent = 'missing'],
    ['RESOURCE_REFERENCE', b => b.nodes[4].resourceId = 'missing'],
    ['RESOURCE_MISMATCH', b => b.nodes[4].resourceId = 'wave'],
    ['NUMBER_RANGE', b => b.camera.zoom = 0],
    ['NON_JSON_VALUE', b => b.nodes[2].r = NaN],
    ['NON_JSON_VALUE', b => b.provenance = { function: () => 1 }],
    ['JSON_CYCLE', b => b.provenance = b],
    ['TUPLE_SIZE', b => b.nodes[0].transform.translate = [1]],
  ];
  for (const [code, change] of checks) { const b = fixture(); change(b); assert.ok(codes(b).includes(code), code); assert.throws(() => assertBundle(b), BundleValidationError); }
});

test('rejects unsupported or conflicting tracks, unordered times and invalid vector keyframes', () => {
  const checks: [string, (b: any) => void][] = [
    ['TRACK_PROPERTY', b => b.tracks[0].property = '__proto__.polluted'],
    ['TRACK_PROPERTY', b => b.tracks[0].property = 'd'],
    ['TRACK_REFERENCE', b => b.tracks[0].target = 'missing'],
    ['CONFLICTING_WRITERS', b => b.tracks.push(structuredClone(b.tracks[0]))],
    ['CONFLICTING_WRITERS', b => b.tracks.push({ target: 'point', property: 'x', keys: [[0, 5]] })],
    ['TIME_ORDER', b => b.tracks[0].keys = [[1, 50], [1, 60]]],
    ['NUMBER_RANGE', b => b.tracks[0].keys[0][0] = -1],
    ['NUMBER_RANGE', b => b.tracks[0].keys[1][0] = 9],
    ['NUMBER_RANGE', b => b.tracks[3].keys[0][1] = 0],
    ['TUPLE_SIZE', b => b.tracks[4].keys[0][1] = [1]],
  ];
  for (const [code, change] of checks) { const b = fixture(); change(b); assert.ok(codes(b).includes(code), code); }
});

test('rejects parent/dependency cycles, wrong relation kinds and local coordinate ambiguity', () => {
  const checks: [string, (b: any) => void][] = [
    ['PARENT_CYCLE', b => b.nodes[0].parent = 'surface'],
    ['RELATION_CYCLE', b => b.relations[3].source = 'point'],
    ['RELATION_NODE_KIND', b => b.relations[3].source = 'fixed'],
    ['RELATION_COORDINATE_SPACE', b => delete b.nodes[2].parent],
    ['RELATION_LOCAL_TRANSFORM', b => b.nodes[2].transform = { translate: [1, 0] }],
    ['RELATION_LOCAL_TRANSFORM', b => b.tracks.push({ target: 'point', property: 'transform.rotate', keys: [[0, 0]] })],
    ['RELATION_REFERENCE', b => b.relations[0].source = 'missing'],
    ['CONFLICTING_WRITERS', b => b.relations.push(structuredClone(b.relations[0]))],
  ];
  for (const [code, change] of checks) { const b = fixture(); change(b); assert.ok(codes(b).includes(code), code); }
  const b: any = fixture(); b.nodes[2].transform = { translate: 7 }; assert.doesNotThrow(() => validateBundle(b));
});

test('field samples and vector resources diagnose malformed grids, metadata and grouping', () => {
  const checks: [string, (b: any) => void][] = [
    ['FIELD_GRID_SIZE', b => b.resources.wave.samples[0].pop()],
    ['FIELD_SAMPLES', b => b.resources.wave.samples.pop()],
    ['TIME_ORDER', b => b.resources.wave.times = [1, 1, 6]],
    ['GRID_INTEGER', b => b.resources.wave.columns = 2.5],
    ['FIELD_RANGE', b => b.resources.wave.range = [1, 1]],
    ['METRICS', b => delete b.resources.label.metrics],
    ['PATH_CHILDREN', b => b.resources.label.items[0].children[0].children = []],
    ['STYLE_PROPERTY', b => b.resources.label.items[0].style.unsupported = 1],
  ];
  for (const [code, change] of checks) { const b = fixture(); change(b); assert.ok(codes(b).includes(code), code); }
});

test('compiler diagnostics retain warnings and prevent evaluation on reported errors', () => {
  const b = fixture();
  b.diagnostics = [{ severity: 'warning', code: 'SOURCE_WARNING', message: 'A source warning.' }];
  assert.doesNotThrow(() => evaluate(b, 1)); assert.equal(validateBundle(b)[0].code, 'SOURCE_WARNING');
  b.diagnostics.push({ severity: 'error', code: 'SOURCE_ERROR', message: 'Missing unsupported graphics.' });
  assert.throws(() => evaluate(b, 1), BundleValidationError);
});
