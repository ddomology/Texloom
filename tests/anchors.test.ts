import test from 'node:test';
import assert from 'node:assert/strict';
import { BundleValidationError, createEvaluator, evaluate, inverseMatrix, localMatrix, multiplyMatrix, pathPoint, pathTangent, transformPath, transformPoint, transformVector, validateBundle, worldMatrix, type Bundle, type GroupNode, type Node, type PathNode, type Point, type TexNode } from '../src/index.js';

const close = (actual: number, expected: number, tolerance = 1e-8) => assert.ok(Math.abs(actual-expected) < tolerance, `${actual} != ${expected}`);
const pointClose = (actual: Point, expected: Point) => { close(actual[0], expected[0]); close(actual[1], expected[1]); };
const codes = (bundle: unknown) => validateBundle(bundle).filter(d => d.severity === 'error').map(d => d.code);

function fixture(): Bundle {
  return {
    version: '0.2', title: 'Live PGF anchors', duration: 8, units: 'bp', viewport: { width: 640, height: 360 }, camera: { x: 0, y: 0, zoom: 1 },
    resources: { text: { kind: 'vector', metrics: { width: 24, height: 9, depth: 3 }, inkBounds: [-2, -11, 30, 15], items: [{ kind: 'path', d: 'M0 0L24 0', style: { stroke: '#fff' } }] } },
    nodes: [
      { id: 'left', kind: 'group', transform: { translate: [80, 70], rotate: 0.4, scale: [1.6, 0.7] } },
      { id: 'right', kind: 'group', transform: { translate: [360, 220], rotate: -0.5, scale: [0.8, 1.4] } },
      { id: 'edge-group', kind: 'group', transform: { translate: [40, 20], rotate: 0.8, scale: [0.6, 1.8] } },
      { id: 'label-group', kind: 'group', transform: { translate: [30, 60], rotate: -0.2, scale: [1.2, 0.7] } },
      { id: 'A', kind: 'group', parent: 'left', transform: { translate: [10, 20], rotate: 0.3, scale: [0.9, 1.2] }, anchors: { east: [22, -2], center: [0, 0] } },
      { id: 'B', kind: 'group', parent: 'right', transform: { translate: [20, 10], rotate: -0.1 }, anchors: { west: [-18, 3], center: [0, 0] } },
      { id: 'edge', kind: 'path', parent: 'edge-group', d: 'M0 0', transform: { translate: [12, -4], rotate: 0.7, scale: [0.8, 1.1] }, arrowEnd: true },
      { id: 'label', kind: 'tex', parent: 'label-group', resourceId: 'text', x: 0, y: 0, scale: 1.8, transform: { translate: [5, -6], rotate: 0.45, scale: [0.9, 1.3] } },
    ],
    tracks: [
      { target: 'A', property: 'transform.translate', interpolation: 'smooth', keys: [[0, [10, 20]], [8, [70, 120]]] },
      { target: 'B', property: 'transform.rotate', keys: [[0, -0.1], [8, 1.3]] },
      { target: 'right', property: 'transform.scale', keys: [[0, [0.8, 1.4]], [8, [1.2, 0.5]]] },
      { target: 'edge-group', property: 'transform.rotate', keys: [[0, 0.8], [8, -0.4]] },
    ],
    // Reverse dependency order on purpose.
    relations: [
      { type: 'pathLabel', target: 'label', path: 'edge', position: 0.37, offset: -14 },
      { type: 'connect', target: 'edge', from: { node: 'A', anchor: 'east' }, to: { node: 'B', anchor: 'west' }, bend: 38 },
    ],
  };
}

test('cross-parent connector endpoints remain on transformed PGF anchors throughout motion', () => {
  const bundle = fixture(), at = createEvaluator(bundle);
  assert.deepEqual(codes(bundle), []);
  for (const time of [0, 0.001, 1.37, 3.14159, 6.75, 8]) {
    const nodes = new Map(at(time).nodes.map(n => [n.id, n]));
    const edge = nodes.get('edge') as PathNode;
    for (const [endpoint, ownerId, anchor] of [['start', 'A', 'east'], ['end', 'B', 'west']] as const) {
      const owner = nodes.get(ownerId) as GroupNode;
      pointClose(transformPoint(worldMatrix(edge.id, nodes), edge.resolvedPath![endpoint]), transformPoint(worldMatrix(ownerId, nodes), owner.anchors![anchor]));
    }
    assert.ok(edge.d.startsWith('M ')); assert.ok(edge.d.includes(' C '));
  }
});

test('bend displacement is measured in target-parent coordinates, independent of target transforms', () => {
  const bundle = fixture(), frame = evaluate(bundle, 2.1), nodes = new Map(frame.nodes.map(n => [n.id, n]));
  const edge = nodes.get('edge') as PathNode;
  const p = transformPath(localMatrix(edge.transform), edge.resolvedPath!);
  const dx = p.end[0]-p.start[0], dy = p.end[1]-p.start[1], distance = Math.hypot(dx, dy);
  pointClose(p.c1, [p.start[0]+dx/3-dy/distance*38, p.start[1]+dy/3+dx/distance*38]);
  pointClose(p.c2, [p.start[0]+dx*2/3-dy/distance*38, p.start[1]+dy*2/3+dx/distance*38]);
});

test('path label centers the TeX logical box, uses parent-space normal offset, and preserves authored rotation', () => {
  const at = createEvaluator(fixture());
  for (const time of [0, 2, 5.7, 8]) {
    const frame = at(time), nodes = new Map(frame.nodes.map(n => [n.id, n]));
    const edge = nodes.get('edge') as PathNode, label = nodes.get('label') as TexNode;
    const path = transformPath(multiplyMatrix(inverseMatrix(worldMatrix(label.parent, nodes)), worldMatrix(edge.id, nodes)), edge.resolvedPath!);
    const p = pathPoint(path, 0.37), tangent = pathTangent(path, 0.37), length = Math.hypot(...tangent);
    const expectedCenter: Point = [p[0]+tangent[1]/length*14, p[1]-tangent[0]/length*14];
    const renderedCenter = transformPoint(localMatrix(label.transform), [label.x+24*1.8/2, label.y+(3-9)*1.8/2]);
    pointClose(renderedCenter, expectedCenter);
    close(label.transform!.rotate!, 0.45);
  }
});

test('rotated labels align their rendered baseline to the tangent under scaled and reflected transforms', () => {
  for (const sx of [0.9, -0.9]) for (const parentScale of [[1.2, 0.7], [-1.2, 0.7], [1.2, -0.7], [-1.2, -0.7]] as Point[]) {
    const bundle = fixture();
    (bundle.relations[0] as any).rotate = true;
    bundle.nodes[7].transform!.scale![0] = sx;
    bundle.nodes[3].transform!.scale = parentScale;
    const frame = evaluate(bundle, 3.3), nodes = new Map(frame.nodes.map(n => [n.id, n]));
    const edge = nodes.get('edge') as PathNode, label = nodes.get('label') as TexNode;
    const worldPath = transformPath(worldMatrix(edge.id, nodes), edge.resolvedPath!);
    const tangent = pathTangent(worldPath, 0.37);
    const baseline = transformVector(worldMatrix(label.id, nodes), [1, 0]);
    close((baseline[0]*tangent[1]-baseline[1]*tangent[0])/Math.hypot(...baseline)/Math.hypot(...tangent), 0);
    assert.ok(baseline[0]*tangent[0]+baseline[1]*tangent[1] > 0, 'baseline must face forward along the curve');
  }
});

test('style tracks may coexist with geometry writers but duplicate style writers are rejected', () => {
  const bundle = fixture();
  bundle.tracks.push({ target: 'edge', property: 'style.opacity', keys: [[0, 0.3], [8, 0.9]] });
  bundle.tracks.push({ target: 'edge', property: 'style.strokeWidth', keys: [[0, 1], [8, 5]] });
  bundle.tracks.push({ target: 'label', property: 'style.fillOpacity', keys: [[0, 0.5], [8, 1]] });
  assert.deepEqual(codes(bundle), []);
  const edge = evaluate(bundle, 4).nodes[6] as PathNode;
  close(edge.style!.opacity!, 0.6); close(edge.style!.strokeWidth!, 3);
  bundle.tracks.push({ target: 'edge', property: 'style.opacity', keys: [[0, 1]] });
  assert.ok(codes(bundle).includes('CONFLICTING_WRITERS'));
});

test('generated paths and labels support arbitrary seeking without source or cached-frame mutation', () => {
  const bundle = fixture(), original = structuredClone(bundle), at = createEvaluator(bundle);
  const reference = [0, 1.25, 2.5, 5, 8].map(t => at(t));
  for (const i of [4, 1, 3, 0, 2, 1]) assert.deepEqual(at(reference[i].time), reference[i]);
  const altered = at(1.25);
  (altered.nodes[6] as PathNode).resolvedPath!.start[0] = 999;
  altered.nodes[4].transform!.translate![0] = 999;
  assert.deepEqual(at(1.25), reference[1]); assert.deepEqual(bundle, original);
  assert.ok(!('resolvedPath' in bundle.nodes[6]));
});

test('connection endpoints reduce to an exact straight segment at zero bend', () => {
  const bundle = fixture(); (bundle.relations[1] as any).bend = 0;
  const edge = evaluate(bundle, 1).nodes[6] as PathNode, p = edge.resolvedPath!;
  for (const t of [0, 0.2, 0.5, 1]) pointClose(pathPoint(p, t), [p.start[0]+(p.end[0]-p.start[0])*t, p.start[1]+(p.end[1]-p.start[1])*t]);
});

test('malformed anchor references, relation shapes, and same-property writers are rejected', () => {
  const changes: [string, (b: any) => void][] = [
    ['ANCHOR_REFERENCE', b => b.relations[1].from.anchor = 'northeast'],
    ['ANCHOR_REFERENCE', b => b.relations[1].to = 'B.west'],
    ['RELATION_REFERENCE', b => b.relations[1].from.node = 'absent'],
    ['RELATION_NODE_KIND', b => b.relations[1].from.node = 'label'],
    ['TUPLE_SIZE', b => b.nodes[4].anchors.east = [1]],
    ['FINITE_NUMBER', b => b.relations[1].bend = '3'],
    ['NUMBER_RANGE', b => b.relations[0].position = 1.01],
    ['LABEL_ROTATE', b => b.relations[0].rotate = 'yes'],
    ['RESOURCE_REFERENCE', b => b.nodes[7].resourceId = 'absent'],
    ['CONFLICTING_WRITERS', b => b.tracks.push({ target: 'label', property: 'x', keys: [[0, 10]] })],
    ['CONFLICTING_WRITERS', b => { b.relations[0].rotate = true; b.tracks.push({ target: 'label', property: 'transform.rotate', keys: [[0, 0]] }); }],
    ['CONFLICTING_WRITERS', b => b.relations.push(structuredClone(b.relations[1]))],
    ['PATH_LABEL_GEOMETRY', b => b.relations.pop()],
    ['ARROW_GEOMETRY', b => b.relations.pop()],
    ['GENERATED_GEOMETRY', b => b.nodes[6].resolvedPath = { start: [0, 0], c1: [1, 0], c2: [2, 0], end: [3, 0] }],
  ];
  for (const [expected, change] of changes) {
    const b = fixture(); change(b); assert.ok(codes(b).includes(expected), `${expected}: ${codes(b)}`);
    assert.throws(() => createEvaluator(b), BundleValidationError);
  }
});

test('singular inverse spaces and continuous scales crossing zero are rejected before playback', () => {
  const changes: ((b: Bundle) => void)[] = [
    b => b.nodes[6].transform!.scale = [0, 1],
    b => b.nodes[2].transform!.scale = [1, 0],
    b => b.nodes[3].transform!.scale = [0, 1],
    b => b.tracks.push({ target: 'edge-group', property: 'transform.scale', keys: [[0, [1, 1]], [8, [-1, 1]]] }),
    b => b.tracks.push({ target: 'label', property: 'transform.scale', keys: [[0, [1, 1]], [8, [0, 1]]] }),
  ];
  for (const change of changes) { const b = fixture(); change(b); assert.ok(codes(b).includes('SINGULAR_TRANSFORM')); }
  const step = fixture();
  step.tracks.push({ target: 'edge-group', property: 'transform.scale', interpolation: 'step', keys: [[0, [1, 1]], [4, [-1, 1]]] });
  assert.deepEqual(codes(step), []); assert.doesNotThrow(() => evaluate(step, 4));
  assert.throws(() => inverseMatrix([1, 0, 0, 0, 2, 3]), /SINGULAR_TRANSFORM/);
});

test('dependency validation includes hierarchy edges as well as relation edges', () => {
  const bundle: any = fixture();
  // Invalid parent kind and a mixed hierarchy/relation cycle must both diagnose.
  // Merely checking parents or relations alone would miss this loop.
  bundle.nodes[4].parent = 'edge';
  assert.ok(codes(bundle).includes('PARENT_KIND'));
  assert.ok(codes(bundle).includes('RELATION_CYCLE'));
});

test('degenerate connections report undefined arrow or label direction', () => {
  const bundle = fixture(), relation = bundle.relations[1];
  if (relation.type !== 'connect') throw new Error('fixture');
  relation.to = { ...relation.from }; relation.bend = 0;
  assert.throws(() => evaluate(bundle, 0), /CONNECT_DEGENERATE/);
  (bundle.nodes[6] as PathNode).arrowEnd = false;
  assert.throws(() => evaluate(bundle, 0), /PATH_LABEL_TANGENT/);
  bundle.relations.shift();
  assert.doesNotThrow(() => evaluate(bundle, 0), 'a plain unlabelled zero-length path is valid');
});

test('affine helpers match SVG transform order and invert deep nested transforms', () => {
  const nodes: Node[] = [
    { id: 'outer', kind: 'group', transform: { translate: [7, -4], rotate: Math.PI/2, scale: [2, 3] } },
    { id: 'inner', kind: 'group', parent: 'outer', transform: { translate: [5, 1], rotate: -0.3, scale: [-0.8, 1.7] } },
  ];
  pointClose(transformPoint(localMatrix(nodes[0].transform), [2, 3]), [-2, 0]);
  const matrix = worldMatrix('inner', new Map(nodes.map(n => [n.id, n])));
  pointClose(transformPoint(inverseMatrix(matrix), transformPoint(matrix, [23, -17])), [23, -17]);
});
