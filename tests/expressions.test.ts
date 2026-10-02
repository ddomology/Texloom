import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseExpression, compileExpression, evaluateExpression,
  type ParameterDefinition, type ExpressionValue, type SourceSpan,
} from '../src/index.ts';

const source: SourceSpan = {file: 'lecture.tex', start: {line: 10, column: 7}, end: {line: 11, column: 5}};
const dimension = (length = 0, time = 0, angle = 0) => ({length, time, angle});
function run(text: string, parameters: Record<string, ExpressionValue> = {}, definitions: Record<string, ParameterDefinition> = {}, time = 0) {
  return evaluateExpression(compileExpression(text, definitions), {time, parameters});
}
function fails(text: string, pattern: RegExp) {
  assert.throws(() => run(text), pattern);
}

test('arithmetic precedence, right-associative powers and unary signs follow mathematical conventions', () => {
  for (const [text, expected] of [
    ['2 + 3 * 4', 14], ['(2 + 3) * 4', 20], ['2^3^2', 512],
    ['-2^2', -4], ['(-2)^2', 4], ['2^-2', 0.25], ['1e2 + .5', 100.5], ['8/2/2', 2],
  ] as const) assert.equal(run(text), expected, text);
});

test('parsed AST nodes preserve offsets and multiline source coordinates', () => {
  const ast = parseExpression('2bp +\n 3bp', source);
  assert.equal(ast.kind, 'binary');
  if (ast.kind !== 'binary') throw new Error('Expected binary AST');
  assert.equal(ast.operator, '+');
  assert.deepEqual([ast.location.start, ast.location.end], [0, 10]);
  assert.deepEqual([ast.right.location.start, ast.right.location.end], [7, 10]);
  assert.deepEqual(ast.right.location.sourceSpan, {file: 'lecture.tex', start: {line: 11, column: 2}, end: {line: 11, column: 5}});
  assert.deepEqual(ast.left.location.sourceSpan.start, {line: 10, column: 7});
});

test('constant folding produces a frozen value while retaining its complete source span', () => {
  const compiled = compileExpression('2 + 3 * 4', {}, source);
  assert.equal(compiled.ast.kind, 'number');
  if (compiled.ast.kind !== 'number') throw new Error('Expected folded number');
  assert.equal(compiled.ast.value, 14);
  assert.equal(compiled.ast.unit, '1');
  assert.deepEqual([compiled.ast.location.start, compiled.ast.location.end], [0, 9]);
  assert.deepEqual(compiled.ast.location.sourceSpan.start, source.start);
  assert.ok(Object.isFrozen(compiled)); assert.ok(Object.isFrozen(compiled.ast));
  assert.ok(Object.isFrozen(compiled.type));
});

test('units propagate through products, quotients, powers and time without discarding dimensions', () => {
  const distance = compileExpression('20bp * time / 1s');
  assert.deepEqual(distance.type, {kind: 'scalar', dimension: dimension(1)});
  assert.equal(evaluateExpression(distance, {time: 2, parameters: {}}), 40);
  const area = compileExpression('(2bp)^2');
  assert.deepEqual(area.type, {kind: 'scalar', dimension: dimension(2)});
  assert.equal(evaluateExpression(area, {time: 0, parameters: {}}), 4);
  assert.deepEqual(compileExpression('3bp / 2s').type, {kind: 'scalar', dimension: dimension(1, -1)});
  assert.deepEqual(compileExpression('1rad * time / 1s').type, {kind: 'scalar', dimension: dimension(0, 0, 1)});
});

test('dimensional powers recognize fixed lazy branches while still checking all branch types', () => {
  for (const exponent of ['true ? 2 : time/1s', 'mask(true, 2, time/1s)', 'if(false, time/1s, 2)', 'true ? 2 : 1/0']) {
    const compiled = compileExpression(`(2bp)^(${exponent})`);
    assert.deepEqual(compiled.type, {kind: 'scalar', dimension: dimension(2)});
    assert.equal(evaluateExpression(compiled, {time: 3, parameters: {}}), 4);
  }
  fails('(2bp)^(true ? time/1s : 2)', /EXPRESSION_POWER/);
  fails('(2bp)^mask(false, 2, time/1s)', /EXPRESSION_POWER/);
  fails('(2bp)^(true ? 2 : false)', /EXPRESSION_TYPE/);
  fails('(2bp)^mask(true, 2, 1bp)', /EXPRESSION_UNIT/);
  fails('(2bp)^if(true, 2, missing)', /EXPRESSION_IDENTIFIER/);
  fails('(2bp)^(true ? 1/0 : 2)', /EXPRESSION_DOMAIN/);
});

test('vector construction, scalar scaling, dot, length and normalization have analytic values and units', () => {
  assert.deepEqual(run('vec2(3bp, 4bp) * 2'), [6, 8]);
  assert.deepEqual(run('2 * vec2(3bp, 4bp) - vec2(1bp, 2bp)'), [5, 6]);
  assert.equal(run('dot(vec2(1bp, 2bp), vec2(3bp, 4bp))'), 11);
  assert.deepEqual(compileExpression('dot(vec2(1bp,2bp),vec2(3bp,4bp))').type, {kind: 'scalar', dimension: dimension(2)});
  assert.equal(run('length(vec2(3bp, 4bp))'), 5);
  assert.deepEqual(compileExpression('length(vec2(3bp,4bp))').type, {kind: 'scalar', dimension: dimension(1)});
  assert.deepEqual(run('normalize(vec2(3bp, 4bp))'), [0.6, 0.8]);
  assert.deepEqual(compileExpression('normalize(vec2(3bp,4bp))').type, {kind: 'vec2', dimension: dimension()});
});

test('trigonometry accepts radians and dimensionless mathematical angles', () => {
  assert.equal(run('sin(pi/2)'), 1);
  assert.equal(run('sin(pi/2 * 1rad)'), 1);
  assert.equal(run('cos(0rad)'), 1);
  assert.deepEqual(compileExpression('sin(1rad)').type, {kind: 'scalar', dimension: dimension()});
  fails('sin(1bp)', /EXPRESSION_UNIT/); fails('cos(1s)', /EXPRESSION_UNIT/);
});

test('comparison and boolean precedence are typed and return actual booleans', () => {
  assert.equal(run('1bp < 2bp && 3s >= 3s'), true);
  assert.equal(run('1 > 2 || 3 == 3 && !false'), true);
  assert.equal(run('!(1 == 1) || 2 != 2'), false);
  assert.deepEqual(compileExpression('time <= 1s').type, {kind: 'boolean'});
  fails('1 && true', /EXPRESSION_TYPE/);
  fails('1bp < 2s', /EXPRESSION_UNIT/);
});

test('ternaries and masks select one branch and preserve vector units', () => {
  assert.equal(run('true ? 2bp : 3bp'), 2);
  assert.equal(run('false ? 1 : true ? 2 : 3'), 2);
  assert.deepEqual(run('mask(true, vec2(2bp,3bp), vec2(4bp,5bp))'), [2, 3]);
  assert.deepEqual(compileExpression('mask(false,vec2(2bp,3bp),vec2(4bp,5bp))').type,
    {kind: 'vec2', dimension: dimension(1)});
});

test('short-circuit evaluation also protects inactive branches during constant folding', () => {
  assert.equal(run('false && (1/0 > 0)'), false);
  assert.equal(run('true || (1/0 > 0)'), true);
  assert.equal(run('false ? 1/0 : 2'), 2);
  assert.equal(run('mask(true, 7, 1/0)'), 7);
  assert.deepEqual(run('true ? vec2(1,0) : normalize(vec2(0,0))'), [1, 0]);
});

test('dead branches still reject unknown identifiers and incompatible types or units', () => {
  fails('true ? 1 : missing', /EXPRESSION_IDENTIFIER/);
  fails('false && missing', /EXPRESSION_IDENTIFIER/);
  fails('true ? 1bp : 2s', /EXPRESSION_UNIT/);
  fails('mask(false, true, 1)', /EXPRESSION_TYPE/);
  fails('true || (vec2(1,2) + 1 > 0)', /EXPRESSION_TYPE/);
});

test('unit errors cannot be hidden by arithmetic or function boundaries', () => {
  for (const text of ['1bp + 1s', 'vec2(1bp,2s)', '(2bp)^time', 'dot(vec2(1,2), 3)']) {
    fails(text, /EXPRESSION_(UNIT|TYPE|POWER)/);
  }
});

test('division by zero, zero normalization and arithmetic overflow are diagnosed', () => {
  for (const text of ['1 / 0', 'normalize(vec2(0,0))', '(-1)^0.5']) fails(text, /EXPRESSION_DOMAIN/);
  fails('1e308 * 1e308', /EXPRESSION_(NONFINITE|DOMAIN)/);
});

test('dynamic lazy masks guard domains at singular times without retaining evaluation state', () => {
  const compiled = compileExpression('mask(time > 0s, 10bp * 1s / time, 0bp)');
  assert.equal(evaluateExpression(compiled, {time: 0, parameters: {}}), 0);
  assert.equal(evaluateExpression(compiled, {time: 2, parameters: {}}), 5);
  assert.equal(evaluateExpression(compiled, {time: 0, parameters: {}}), 0);
});

test('potentially inactive constant errors are deferred until their dynamic branch is selected', () => {
  for (const text of ['mask(time > 0s, 1/0, 0)', 'time > 0s ? 1/0 : 0', 'time > 0s && (1/0 > 0)']) {
    const compiled = compileExpression(text);
    assert.equal(evaluateExpression(compiled, {time: 0, parameters: {}}), text.includes('&&') ? false : 0);
    assert.throws(() => evaluateExpression(compiled, {time: 1, parameters: {}}), /EXPRESSION_DOMAIN/);
  }
});

test('declared scalar, boolean and vector parameters retain their types and caller ownership', () => {
  const definitions: Record<string, ParameterDefinition> = {
    enabled: {type: 'boolean', default: true}, scale: {type: 'scalar', unit: '1', default: 2},
    shift: {type: 'vec2', unit: 'bp', default: [3, 4]},
  };
  const before = structuredClone(definitions), compiled = compileExpression('enabled ? shift * scale : vec2(0bp,0bp)', definitions);
  const parameters = {enabled: true, scale: 2, shift: [3, 4] as [number, number]}, original = structuredClone(parameters);
  assert.deepEqual(evaluateExpression(compiled, {time: 0, parameters}), [6, 8]);
  assert.deepEqual(definitions, before); assert.deepEqual(parameters, original);
  assert.deepEqual(compiled.type, {kind: 'vec2', dimension: dimension(1)});
  definitions.shift.unit = 's';
  assert.deepEqual(compiled.type, {kind: 'vec2', dimension: dimension(1)});
});

test('direct evaluation validates consumed parameter types even when the overall result is boolean', () => {
  const compiled = compileExpression('enabled ? scale == scale : true', {
    enabled: {type: 'boolean', default: true}, scale: {type: 'scalar', unit: '1', default: 2},
  });
  assert.equal(evaluateExpression(compiled, {time: 0, parameters: {enabled: false, scale: true}}), true);
  assert.throws(() => evaluateExpression(compiled, {time: 0, parameters: {enabled: true, scale: true}}), /EXPRESSION_TYPE/);
});

test('syntax rejects JavaScript property access, statements and arbitrary callable names', () => {
  for (const text of ['Math.sin(0)', 'time.toString()', '1; 2', '"text"', '[1,2]', 'eval(1)', 'unknown(1)']) {
    assert.throws(() => compileExpression(text), /EXPRESSION_(TOKEN|SYNTAX|IDENTIFIER|FUNCTION)/, text);
  }
});

test('parse errors identify the source file and the invalid character location', () => {
  assert.throws(() => parseExpression('1 + @', source), (error: any) => {
    const diagnostic = error.diagnostics?.[0]; assert.ok(diagnostic, String(error));
    assert.equal(diagnostic.sourceSpan?.file, 'lecture.tex');
    assert.deepEqual(diagnostic.sourceSpan?.start, {line: 10, column: 11});
    return true;
  });
});
