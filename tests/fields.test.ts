import test from 'node:test';
import assert from 'node:assert/strict';
import {createFieldContext, compileFieldExpression, evaluateFieldExpression, captureAttribute, setFieldPositions,
  type PathGeometry, type FieldDomainDeclaration, type FieldAttribute, type DeepReadonly} from '../src/index.ts';

const geometry = (): PathGeometry => ({contours: [{id: 'c', start: [0, 0], segments: [
  {id: 's', kind: 'cubic', c1: [0, 100], c2: [100, 100], to: [100, 0]},
]}]});
const controls: FieldDomainDeclaration = {id: 'controls', geometry: 'curve', domain: 'path-control'};
const samples = (): FieldDomainDeclaration => ({id: 'samples', geometry: 'curve', domain: 'curve-sample',
  samples: [{id: 'start', parameter: 0}, {id: 'mid', parameter: 0.5}, {id: 'end', parameter: 1}]});
const id = (slot: string) => JSON.stringify(['c', slot === 'start' ? null : 's', slot]);
const position = compileFieldExpression('position');
const clone = <T>(value: T): T => structuredClone(value);

test('control domains carry stable structured IDs with separate original and current coordinates', () => {
  const original = geometry(), current = geometry();
  (current.contours[0].segments[0] as any).c1 = [10, 200];
  const context = createFieldContext(controls, original, current, 2);
  assert.deepEqual(context.elements.map(e => e.id), ['start', 'c1', 'c2', 'to'].map(id));
  assert.deepEqual(context.elements.map(e => e.index), [0, 1, 2, 3]);
  assert.deepEqual(context.elements.map(e => e.parameter), [0, 1 / 3, 2 / 3, 1]);
  assert.deepEqual(context.elements[1].position, [10, 200]);
  assert.deepEqual(context.elements[1].originalPosition, [0, 100]);
  current.contours[0].start[0] = 999;
  assert.deepEqual(context.elements[0].position, [0, 0]);
  assert.ok(Object.isFrozen(context.elements[0].position));
});

test('curve samples use explicit parameters and independently known cubic positions', () => {
  const original = geometry(), current = geometry();
  (current.contours[0].segments[0] as any).c1 = [0, 200];
  const context = createFieldContext(samples(), original, current, 2);
  assert.deepEqual(context.elements[1].position, [50, 112.5]);
  assert.deepEqual(context.elements[1].originalPosition, [50, 75]);
  const local = evaluateFieldExpression(compileFieldExpression('vec2(index*1bp, parameter*count*1bp)'), context);
  assert.deepEqual(local.values.mid, [1, 1.5]);
});

test('capture preserves the old dataset while setPosition changes only current positions', () => {
  const g = geometry(), authored = clone(g), context = createFieldContext(samples(), g, g, 2);
  const before = captureAttribute(context, evaluateFieldExpression(position, context));
  const displacement = evaluateFieldExpression(compileFieldExpression('position + vec2(10bp,20bp*time/1s)'), context);
  const changed = setFieldPositions(context, displacement);
  assert.deepEqual(before.values.mid, [50, 75]);
  assert.deepEqual(changed.elements[1].position, [60, 115]);
  assert.deepEqual(changed.elements[1].originalPosition, [50, 75]);
  assert.deepEqual(evaluateFieldExpression(position, changed, {}, {}, 'original').values.mid, [50, 75]);
  assert.deepEqual(evaluateFieldExpression(compileFieldExpression('originalPosition'), changed).values.mid, [50, 75]);
  assert.deepEqual(context.elements[1].position, [50, 75]); assert.deepEqual(g, authored);
  assert.throws(() => { (before.values.mid as any)[0] = 999; }, TypeError);
});

test('domain keys ignore coordinate/traversal changes and attributes join by stable ID', () => {
  const g = geometry(); g.contours.push({id: 'other', start: [200, 0], segments: [{id: 's', kind: 'line', to: [300, 0]}]});
  const before = createFieldContext(controls, g, g, 0);
  const values = evaluateFieldExpression(compileFieldExpression('index'), before);
  const reordered = clone(g); reordered.contours.reverse(); reordered.contours[0].start[0] = 220;
  const after = createFieldContext(controls, g, reordered, 1);
  assert.equal(before.domain.key, after.domain.key);
  const result = evaluateFieldExpression(compileFieldExpression('saved', {}, {saved: values.type}), after, {}, {saved: values});
  assert.deepEqual(result.values, values.values);
  assert.equal(result.values[JSON.stringify(['other', null, 'start'])], 4);
  assert.equal(after.elements[0].index, 0);
});

test('equal element counts do not allow cross-geometry or cross-domain attributes', () => {
  const g = geometry(), context = createFieldContext(samples(), g, g, 0);
  const attribute = evaluateFieldExpression(position, context);
  for (const declaration of [{...samples(), geometry: 'different'}, {...samples(), id: 'different'}]) {
    const other = createFieldContext(declaration, g, g, 0);
    assert.equal(context.elements.length, other.elements.length);
    assert.throws(() => captureAttribute(other, attribute), /FIELD_DOMAIN_MISMATCH/);
    assert.throws(() => evaluateFieldExpression(compileFieldExpression('saved', {}, {saved: attribute.type}), other, {}, {saved: attribute}), /FIELD_DOMAIN_MISMATCH/);
  }
  const movedSample = samples(); movedSample.samples![1].parameter = 0.25;
  const changed = createFieldContext(movedSample, g, g, 0);
  assert.notEqual(changed.domain.key, context.domain.key);
  assert.throws(() => setFieldPositions(changed, attribute), /FIELD_DOMAIN_MISMATCH/);
});

test('attribute validation rejects missing/extra IDs, incorrect values and non-position units', () => {
  const g = geometry(), context = createFieldContext(samples(), g, g, 0);
  const original = evaluateFieldExpression(position, context);
  for (const mutate of [
    (a: any) => { delete a.values.mid; }, (a: any) => { a.values.extra = [0, 0]; },
    (a: any) => { a.values.mid = true; }, (a: any) => { a.values.mid = [Infinity, 0]; },
  ]) { const attribute = clone(original); mutate(attribute); assert.throws(() => captureAttribute(context, attribute)); }
  for (const expression of ['1bp', 'vec2(1,2)'])
    assert.throws(() => setFieldPositions(context, evaluateFieldExpression(compileFieldExpression(expression), context)), /FIELD_POSITION_TYPE/);
});

test('time, declared parameters and captures combine without mutating caller data', () => {
  const g = geometry(), context = createFieldContext(samples(), g, g, 2);
  const before = evaluateFieldExpression(position, context);
  const compiled = compileFieldExpression('saved + vec2(amplitude*parameter, time/1s*1bp)',
    {amplitude: {type: 'scalar', unit: 'bp', default: 10}}, {saved: before.type});
  const parameters = {amplitude: 20}, snapshot = clone(before);
  assert.deepEqual(evaluateFieldExpression(compiled, context, parameters, {saved: before}).values.mid, [60, 77]);
  assert.deepEqual(parameters, {amplitude: 20}); assert.deepEqual(before, snapshot);
  assert.ok(Object.isFrozen(before.values));
});

test('invalid sample declarations and topology changes fail before field evaluation', () => {
  const g = geometry();
  for (const declaration of [
    {...samples(), samples: [{id: 'x', parameter: -0.1}]},
    {...samples(), samples: [{id: 'x', parameter: 0}, {id: 'x', parameter: 1}]},
    {...samples(), samples: []},
  ]) assert.throws(() => createFieldContext(declaration, g, g, 0));
  const changed = geometry(); changed.contours[0].segments[0].id = 'replaced';
  assert.throws(() => createFieldContext(controls, g, changed, 0), /FIELD_TOPOLOGY/);
});

test('field domains retain element identity and source location on expression errors', () => {
  const g = geometry(), context = createFieldContext(samples(), g, g, 0);
  const span = {file: 'fields.tex', start: {line: 7, column: 1}, end: {line: 7, column: 12}};
  const compiled = compileFieldExpression('1/parameter', {}, {}, span);
  assert.throws(() => evaluateFieldExpression(compiled, context), (error: any) => {
    const diagnostic = error.diagnostics?.[0]; assert.equal(diagnostic?.code, 'EXPRESSION_DOMAIN');
    assert.equal(diagnostic.sourceSpan?.file, 'fields.tex'); assert.match(diagnostic.path, /start/); return true;
  });
  assert.equal(evaluateFieldExpression(compileFieldExpression('mask(parameter > 0, 1/parameter, 0)'), context).values.start, 0);
});
