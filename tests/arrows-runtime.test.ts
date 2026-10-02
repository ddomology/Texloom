import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluate, createEvaluator, prepareScene, validateBundle, worldMatrix, type Bundle, type EvaluatedFrame, type PathNode, type PointNode, type TexNode, type Operation} from '../src/index.ts';
import {renderSvg} from '../src/render-svg.ts';

const scene = {kind: 'scene'} as const;
const local = (node: string) => ({kind: 'local', node} as const);
function fixture(): Bundle {
  return {version: '0.3', title: 'Shared arrow geometry', duration: 2, units: 'bp', viewport: {width: 220, height: 140}, camera: {x: 0, y: 0, zoom: 1},
    resources: {text: {kind: 'vector', metrics: {width: 10, height: 4, depth: 2}, inkBounds: [0, -4, 10, 6], items: []}},
    nodes: [{id: 'edge', kind: 'path', d: 'M0 0L100 0', geometry: {contours: [{id: 'c', start: [0, 0], segments: [{id: 's', kind: 'line', to: [100, 0]}]}]}, arrows: {}, style: {stroke: '#abcdef', fill: 'none', strokeWidth: 2}},
      {id: 'marker', kind: 'point', x: 0, y: 0, r: 1, progress: .5}, {id: 'label', kind: 'tex', resourceId: 'text', x: 0, y: 0}],
    tracks: [], relations: [], operationGraph: {version: 1, operations: [], bindings: []}};
}
const edge = (frame: EvaluatedFrame|Bundle) => frame.nodes.find(n => n.id === 'edge') as PathNode;
const marker = (frame: EvaluatedFrame) => frame.nodes.find(n => n.id === 'marker') as PointNode;
const label = (frame: EvaluatedFrame) => frame.nodes.find(n => n.id === 'label') as TexNode;
const near = (actual: readonly number[], expected: readonly number[], tolerance = 1e-7) => actual.forEach((n, i) => assert.ok(Number.isFinite(n) && Math.abs(n-expected[i]) <= tolerance, `${actual} != ${expected}`));
const end = (geometry: NonNullable<PathNode['geometry']>) => geometry.contours.at(-1)!.segments.at(-1)!.to;
function placeLabel(bundle: Bundle) {
  const operation: Operation = {id: 'labelPose', operator: 'placePathLabel', version: 1, spaces: {space: {kind: 'parent', node: 'label'}, label: local('label')}, inputs: {
    path: {kind: 'path', node: 'edge', space: {kind: 'parent', node: 'label'}}, anchor: {kind: 'textAnchor', node: 'label', anchor: 'center'},
  }};
  bundle.operationGraph!.operations.push(operation);
  for (const property of ['transform', 'x', 'y']) bundle.operationGraph!.bindings.push({target: 'label', property, value: {operation: operation.id, socket: property}});
}

test('triangle and stealth trim only visual shaft geometry with independent endpoint shortening', () => {
  for (const kind of [1, 2] as const) {
    const b = fixture(); edge(b).arrows = {end: kind, shortenEnd: 3};
    const e = edge(evaluate(b, 0)), resolved = e.resolvedArrows!;
    near(end(e.geometry!), [100, 0]); near(resolved.endTip.contours[0].start, [97, 0]);
    near(end(resolved.shaft), [kind === 1 ? 88 : 90.52, 0]); assert.equal(resolved.startTip.contours.length, 0);
    assert.equal(e.d, 'M 0 0 L 100 0', 'The logical path remains available for every consumer');
  }
});

test('current connector geometry produces arrow tips after graph execution while labels and samplers use the full path', () => {
  const b = fixture(); edge(b).arrows = {start: 1, end: 2};
  b.operationGraph!.operations.push({id: 'connector', operator: 'connectStraight', version: 1, spaces: {space: local('edge')}, inputs: {
    from: {kind: 'literal', value: {type: 'vec2', role: 'point', space: local('edge'), value: [0, 0]}},
    to: {kind: 'pointExpression', expression: 'vec2(100bp+20bp*time/1s,0bp)', space: local('edge')},
  }});
  b.operationGraph!.bindings.push({target: 'edge', property: 'geometry', value: {operation: 'connector', socket: 'path'}});
  b.relations.push({type: 'pointOnPath', source: 'edge', target: 'marker'}); placeLabel(b);
  const f = evaluate(b, 1), e = edge(f); near(end(e.geometry!), [120, 0]); near(e.resolvedArrows!.endTip.contours[0].start, [120, 0]);
  near([marker(f).x, marker(f).y], [60, 0]); near(label(f).transform!.translate!, [55, 1]);
  const noArrows = structuredClone(b); delete edge(noArrows).arrows;
  const plain = evaluate(noArrows, 1); assert.deepEqual(e.geometry, edge(plain).geometry); assert.deepEqual(label(f), label(plain));
  near([marker(plain).x, marker(plain).y], [60, 0]);
});

test('arrow scalar writers are sampled before property readers and the arrow postpass', () => {
  const b = fixture(); b.expressions = {version: 1, parameters: {}, bindings: [{target: 'edge', property: 'arrows.length', expression: '9bp+time*3bp/1s'}]};
  b.operationGraph!.operations.push({id: 'readLength', operator: 'offsetPoint', version: 1, spaces: {space: scene}, inputs: {
    origin: {kind: 'literal', value: {type: 'vec2', role: 'point', space: scene, value: [0, 0]}},
    direction: {kind: 'literal', value: {type: 'vec2', role: 'vector', space: scene, value: [1, 0]}},
    distance: {kind: 'property', node: 'edge', property: 'arrows.length', unit: 'bp'},
  }});
  b.operationGraph!.bindings.push({target: 'marker', property: 'position', value: {operation: 'readLength', socket: 'position'}});
  const f = evaluate(b, 1); near([marker(f).x, marker(f).y], [12, 0]); near(end(edge(f).resolvedArrows!.shaft), [88, 0]);
});

test('reveal changes visual shaft and tip visibility without changing sampled geometry', () => {
  const b = fixture(); edge(b).arrows = {start: 1, end: 1}; b.tracks.push({target: 'edge', property: 'reveal', keys: [[0, 0], [2, 1]]});
  b.relations.push({type: 'pointOnPath', source: 'edge', target: 'marker'});
  const run = createEvaluator(b), zero = edge(run(0)).resolvedArrows!, middle = edge(run(1)).resolvedArrows!, full = edge(run(2)).resolvedArrows!;
  assert.equal(zero.startTip.contours.length, 0); assert.equal(zero.endTip.contours.length, 0);
  assert.equal(middle.startTip.contours.length, 1); assert.equal(middle.endTip.contours.length, 0);
  assert.equal(full.startTip.contours.length, 1); assert.equal(full.endTip.contours.length, 1);
  assert.notDeepEqual(middle.shaft, full.shaft);
  for (const t of [0, 1, 2]) {const f = run(t); near(end(edge(f).geometry!), [100, 0]); near([marker(f).x, marker(f).y], [50, 0]);}
});

test('arrow geometry stays local under reflected nonuniform parents and camera changes', () => {
  const b = fixture(), plain = edge(evaluate(b, 0)).resolvedArrows;
  b.nodes.push({id: 'chart', kind: 'group', transform: {translate: [10, 20], rotate: Math.PI/2, scale: [-2, 3]}}); edge(b).parent = 'chart';
  const f = evaluate(b, 0); assert.deepEqual(edge(f).resolvedArrows, plain);
  const m = worldMatrix('edge', new Map(f.nodes.map(n => [n.id, n]))), tip = edge(f).resolvedArrows!.endTip.contours[0].start;
  near([m[0]*tip[0]+m[2]*tip[1]+m[4], m[1]*tip[0]+m[3]*tip[1]+m[5]], [10, -180]);
  b.camera = {x: 500, y: -700, zoom: 6}; assert.deepEqual(edge(evaluate(b, 0)).resolvedArrows, plain);
});

test('arrow output arrays and reverse seeks are independent of prior frames and mutable source inputs', () => {
  const b = fixture(); b.expressions = {version: 1, parameters: {}, bindings: [{target: 'edge', property: 'arrows.width', expression: '7.56bp+time*1bp/1s'}]};
  const authored = structuredClone(b), first = prepareScene(b), second = createEvaluator(b), initial = first.sample(0), saved = structuredClone(initial);
  const later = first.sample(2); assert.notDeepEqual(edge(later).resolvedArrows, edge(initial).resolvedArrows);
  assert.deepEqual(first.sample(0), saved); assert.deepEqual(second(0), saved); assert.deepEqual(second(2), later); assert.deepEqual(b, authored);
  (edge(initial).resolvedArrows as any).endTip.contours[0].start[0] = 999; edge(initial).geometry!.contours[0].start[0] = -99;
  edge(b).arrows!.length = 77; assert.deepEqual(first.sample(0), saved); assert.deepEqual(second(0), saved);
});

test('SVG uses inherited stroke paint, explicit unfilled butt-cap shaft, and one opacity/clip group', () => {
  const b = fixture(); b.nodes.push({id: 'paint', kind: 'group', style: {stroke: '#fedcba', strokeOpacity: .6, fill: '#ff0000'}});
  edge(b).parent = 'paint'; edge(b).arrows = {start: 1, end: 2}; edge(b).style = {opacity: .5, lineCap: 'round', fillOpacity: .2}; edge(b).clip = {d: 'M-5 -5H105V5H-5Z'};
  const svg = renderSvg(evaluate(b, 0));
  assert.match(svg, /<g data-node-id="edge"[^>]*opacity="0.5"[^>]*clip-path="url\(#tl-clip-0\)"[^>]*><path[^>]*fill="none" stroke-linecap="butt"/);
  assert.equal((svg.match(/opacity="0.5"/g) ?? []).length, 1);
  assert.equal((svg.match(/data-arrow="(?:start|end)"[^>]*fill="#fedcba" fill-opacity="0.6" stroke="none"/g) ?? []).length, 2);
  assert.doesNotMatch(svg, /<polygon/);
});

test('arrow data, enum interpolation, dimensions, units, and competing writers fail explicitly', () => {
  for (const arrows of [null, [], {end: .5}, {start: 3}, {length: 0}, {width: -1}, {shortenEnd: -1}, {extra: 3}]) {
    const b = fixture(); (edge(b) as any).arrows = arrows; assert.doesNotThrow(() => validateBundle(b)); assert.ok(validateBundle(b).some(d => d.severity === 'error'));
  }
  const dynamic = fixture(); dynamic.tracks.push({target: 'edge', property: 'arrows.end', keys: [[0, 1], [2, 2]]});
  const run = createEvaluator(dynamic); assert.throws(() => run(1), /ARROW|integer|kind/i);
  const unit = fixture(); unit.expressions = {version: 1, parameters: {}, bindings: [{target: 'edge', property: 'arrows.length', expression: '9'}]};
  assert.ok(validateBundle(unit).some(d => /UNIT/.test(d.code)));
  const conflict = fixture(); conflict.expressions = {version: 1, parameters: {}, bindings: [{target: 'edge', property: 'arrows.length', expression: '10bp'}]};
  conflict.tracks.push({target: 'edge', property: 'arrows.length', keys: [[0, 9]]}); assert.throws(() => prepareScene(conflict), /WRITER|CONFLICT/);
  const missing = fixture(); delete edge(missing).geometry; assert.ok(validateBundle(missing).some(d => d.code === 'ARROW_GEOMETRY'));
  const mixed = fixture(); edge(mixed).arrowEnd = true; assert.ok(validateBundle(mixed).some(d => d.code === 'ARROW_PROFILE_CONFLICT'));
  const short = fixture(); edge(short).geometry!.contours[0].segments[0].to = [4, 0]; assert.throws(() => evaluate(short, 0), /ARROW|collision|short/i);
});

test('legacy connect arrows retain polygon markup and an unshortened shaft', () => {
  const b = fixture(); delete edge(b).geometry; delete edge(b).arrows; edge(b).arrowStart = true; edge(b).arrowEnd = true; edge(b).arrowSize = 10;
  b.nodes.push({id: 'A', kind: 'group', anchors: {center: [0, 0]}}, {id: 'B', kind: 'group', anchors: {center: [100, 0]}});
  b.relations.push({type: 'connect', target: 'edge', from: {node: 'A', anchor: 'center'}, to: {node: 'B', anchor: 'center'}});
  const frame = evaluate(b, 0), svg = renderSvg(frame);
  assert.equal(edge(frame).resolvedArrows, undefined); near(edge(frame).resolvedPath!.end, [100, 0]);
  assert.match(svg, /<polygon data-arrow="start" points="0,0 10,-4.2 10,4.2" fill="#abcdef" fill-opacity="1" stroke="none"\/>/);
  assert.match(svg, /<polygon data-arrow="end" points="100,0 90,4.2 90,-4.2" fill="#abcdef" fill-opacity="1" stroke="none"\/>/);
  assert.match(svg, /<g data-node-id="edge"[^>]*><path d="M 0 0 C [^"]+ 100 0"\/>/);
});
