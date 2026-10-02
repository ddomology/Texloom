import test from 'node:test';
import assert from 'node:assert/strict';
import type {EvaluatedFrame} from '../src/schema.ts';
import {renderCanvas} from '../src/render-canvas.ts';

const frame: EvaluatedFrame = {
  time: 0, viewport: {width: 100, height: 100}, camera: {x: 0, y: 0, zoom: 1},
  nodes: [], resources: {},
};
// These boundary checks run before any Canvas API operation. Raster fidelity
// is covered by real browser fixtures, not simulated drawing contexts.
const uninitializedHost = {canvas: {width: 100, height: 100}} as CanvasRenderingContext2D;

test('Canvas rejects invalid dimensions before accessing drawing APIs', () => {
  for (const width of [0, -1, NaN, Infinity]) {
    assert.throws(() => renderCanvas(frame, uninitializedHost, {width}), /Canvas width/);
  }
  assert.throws(() => renderCanvas({...frame, viewport: {width: 0, height: 10}}, uninitializedHost), /Scene width/);
  assert.throws(() => renderCanvas({...frame, camera: {...frame.camera, zoom: 0}}, uninitializedHost), /Camera zoom/);
});

test('Canvas rejects unsupported contextual paints and paint servers explicitly', () => {
  for (const background of ['url(#gradient)', 'var(--foreground)', 'context-fill', 'inherit', '']) {
    assert.throws(() => renderCanvas(frame, uninitializedHost, {background}), /Unsupported Canvas paint/);
  }
  const bad: EvaluatedFrame = {...frame, nodes: [{id: 'a', kind: 'point', x: 0, y: 0, r: 1,
    style: {fill: 'url(#gradient)'}}]};
  assert.throws(() => renderCanvas(bad, uninitializedHost), /Unsupported Canvas paint/);
});

test('Canvas rejects invalid object hierarchy before clearing its host', () => {
  const group = {id: 'g', kind: 'group'} as const;
  assert.throws(() => renderCanvas({...frame, nodes: [group, group]}, uninitializedHost), /Duplicate/);
  assert.throws(() => renderCanvas({...frame, nodes: [{...group, parent: 'missing'}]}, uninitializedHost), /Invalid scene parent/);
  assert.throws(() => renderCanvas({...frame, nodes: [{...group, parent: 'g'}]}, uninitializedHost), /unreachable parent cycle/);
});
