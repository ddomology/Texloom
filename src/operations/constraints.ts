import {OperationValidationError, type DeepReadonly, type Diagnostic, type LiteralValue,
  type Operation, type OperatorDefinition, type SpaceRef} from '../ir/operations.js';
import {validateJsonData, validateLiteralValue, validateSpaceRef} from './values.js';

const point = {type:'vec2', role:'point', space:'space'} as const;
const vector = {type:'vec2', role:'vector', space:'space'} as const;
const angle = {type:'scalar', unit:'rad'} as const;
const scalar = {type:'scalar', unit:'1'} as const;

/** Stateless relations. Every fallback and threshold is explicit authored data. */
export const constraintOperatorDefinitions:OperatorDefinition[] = [
  {name:'followPoint', version:1, spaces:['space'], pure:true, deterministic:true,
    inputs:{point:{value:point, required:true}, offset:{value:vector, required:true}},
    outputs:{position:point}},
  {name:'alignDirection', version:1, spaces:['space'], pure:true, deterministic:true,
    inputs:{direction:{value:vector, required:true}, fallbackAngle:{value:angle, required:true}},
    outputs:{angle, valid:scalar}},
  {name:'lookAt', version:1, spaces:['space'], pure:true, deterministic:true,
    inputs:{from:{value:point, required:true}, to:{value:point, required:true}, fallbackAngle:{value:angle, required:true}},
    outputs:{angle, direction:vector, valid:scalar}},
  {name:'thresholdOpacity', version:1, spaces:[], pure:true, deterministic:true,
    inputs:{value:{value:scalar, required:true}, threshold:{value:scalar, required:true}},
    outputs:{opacity:scalar}},
  {name:'transformVector', version:1, spaces:['from','to'], pure:true, deterministic:true,
    inputs:{vector:{value:{type:'vec2', role:'vector', space:'from'}, required:true},
      transform:{value:{type:'transform2d', from:'from', to:'to'}, required:true}},
    outputs:{vector:{type:'vec2', role:'vector', space:'to'}}},
];

const names = new Set(constraintOperatorDefinitions.map(definition => definition.name));
export const isConstraintOperator = (name:string, version:number):boolean => version === 1 && names.has(name);
type Authored = DeepReadonly<Operation>;
type Inputs = Readonly<Record<string, LiteralValue>>;
type Pair = [number, number];
const sameSpace = (a:DeepReadonly<SpaceRef>, b:DeepReadonly<SpaceRef>):boolean =>
  a.kind === b.kind && (a.kind === 'scene' || b.kind !== 'scene' && a.node === b.node);

/** Scale first so normalization also covers subnormal vectors and huge finite components. */
function normalized(value:Pair):Pair|undefined {
  const scale = Math.max(Math.abs(value[0]), Math.abs(value[1]));
  if (scale === 0) return;
  const x = value[0] / scale, y = value[1] / scale, length = Math.hypot(x, y);
  return [x === 0 ? 0 : x / length, y === 0 ? 0 : y / length];
}

/** A direction can remain finite even when the unnormalized endpoint gap overflows. */
function towards(from:Pair, to:Pair):Pair|undefined {
  if (from[0] === to[0] && from[1] === to[1]) return;
  const dx = to[0] - from[0], dy = to[1] - from[1];
  if (Number.isFinite(dx) && Number.isFinite(dy)) return normalized([dx, dy]);
  const scale = Math.max(...from.map(Math.abs), ...to.map(Math.abs));
  return normalized([to[0] / scale - from[0] / scale, to[1] / scale - from[1] / scale]);
}

/** Closed pure dispatch; resolved values and returned records never alias caller data. */
export function executeConstraintOperation(operation:Authored, inputs:Inputs):Record<string, LiteralValue>|undefined {
  if (!isConstraintOperator(operation.operator, operation.version)) return;
  function fail(code:string, message:string, suffix=''):never {
    const diagnostic:Diagnostic = {severity:'error', code,
      message:`${operation.operator}@1 (${operation.id}): ${message}`,
      path:`$.operations[${JSON.stringify(operation.id)}]${suffix}`,
      ...(operation.sourceSpan ? {sourceSpan:structuredClone(operation.sourceSpan)} : {})};
    throw new OperationValidationError([diagnostic]);
  }
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs))
    fail('CONSTRAINT_INPUT', 'Expected an input record.', '.inputs');
  const jsonErrors = validateJsonData(inputs, '.inputs');
  if (jsonErrors.length) fail(jsonErrors[0].code, jsonErrors[0].message, jsonErrors[0].path);
  const operator = operation.operator;
  const allowed = operator === 'followPoint' ? ['point','offset']
    : operator === 'alignDirection' ? ['direction','fallbackAngle']
    : operator === 'lookAt' ? ['from','to','fallbackAngle']
    : operator === 'thresholdOpacity' ? ['value','threshold'] : ['vector','transform'];
  for (const key of Object.keys(inputs)) if (!allowed.includes(key))
    fail('UNKNOWN_PROPERTY', `Unknown input ${key}.`, `.inputs.${key}`);
  const spaces = operator === 'thresholdOpacity' ? [] : operator === 'transformVector' ? ['from','to'] : ['space'];
  if (!operation.spaces || typeof operation.spaces !== 'object' || Array.isArray(operation.spaces))
    fail('OPERATION_RUNTIME_SPACE', 'Expected a coordinate space record.', '.spaces');
  const spaceErrors = validateJsonData(operation.spaces, '.spaces');
  if (spaceErrors.length) fail(spaceErrors[0].code, spaceErrors[0].message, spaceErrors[0].path);
  for (const key of Object.keys(operation.spaces)) if (!spaces.includes(key))
    fail('OPERATION_RUNTIME_SPACE', `Unknown coordinate space ${key}.`, `.spaces.${key}`);
  const space = (name:string):SpaceRef => {
    const value = Object.hasOwn(operation.spaces, name) ? operation.spaces[name] : undefined;
    if (validateSpaceRef(value).length) fail('OPERATION_RUNTIME_SPACE', `Expected ${name} coordinate space.`, `.spaces.${name}`);
    return structuredClone(value!) as SpaceRef;
  };
  const input = (name:string):LiteralValue => {
    if (!Object.hasOwn(inputs, name)) fail('CONSTRAINT_INPUT', `Missing required input ${name}.`, `.inputs.${name}`);
    const value = inputs[name], errors = validateLiteralValue(value, `.inputs.${name}`);
    if (errors.length) fail(errors[0].code, errors[0].message, errors[0].path);
    return value;
  };
  const number = (name:string, unit:'1'|'rad'):number => {
    const value = input(name);
    if (value.type !== 'scalar') fail('OPERATION_RUNTIME_TYPE', `Input ${name} requires a scalar.`, `.inputs.${name}`);
    if ((value.unit ?? '1') !== unit) fail('OPERATION_RUNTIME_UNIT', `Input ${name} requires ${unit} units.`, `.inputs.${name}.unit`);
    return value.value;
  };
  const pair = (name:string, role:'point'|'vector', chart:SpaceRef):Pair => {
    const value = input(name);
    if (value.type !== 'vec2' || value.role !== role)
      fail('OPERATION_RUNTIME_TYPE', `Input ${name} requires a ${role}.`, `.inputs.${name}`);
    if (!sameSpace(value.space, chart)) fail('OPERATION_RUNTIME_SPACE', `Input ${name} must use the declared space.`, `.inputs.${name}.space`);
    return [...value.value];
  };
  const result = (socket:string, role:'point'|'vector', chart:SpaceRef, value:Pair):LiteralValue => {
    if (!value.every(Number.isFinite)) fail('OPERATION_NONFINITE_OUTPUT', `Output ${socket} is not finite.`, `.outputs.${socket}`);
    return {type:'vec2', role, space:structuredClone(chart), value};
  };
  const scalarResult = (value:number, unit:'1'|'rad'='1'):LiteralValue => ({type:'scalar', unit, value});

  if (operator === 'thresholdOpacity')
    return {opacity:scalarResult(number('value', '1') >= number('threshold', '1') ? 1 : 0)};
  if (operator === 'transformVector') {
    const from = space('from'), to = space('to'), v = pair('vector', 'vector', from), matrix = input('transform');
    if (matrix.type !== 'transform2d') fail('OPERATION_RUNTIME_TYPE', 'Input transform requires an affine transform.', '.inputs.transform');
    if (!sameSpace(matrix.from, from) || !sameSpace(matrix.to, to))
      fail('OPERATION_RUNTIME_SPACE', 'Transform must map the declared from space to the declared to space.', '.inputs.transform');
    const [a,b,c,d] = matrix.value;
    return {vector:result('vector', 'vector', to, [a * v[0] + c * v[1], b * v[0] + d * v[1]])};
  }
  const chart = space('space');
  if (operator === 'followPoint') {
    const p = pair('point', 'point', chart), offset = pair('offset', 'vector', chart);
    return {position:result('position', 'point', chart, [p[0] + offset[0], p[1] + offset[1]])};
  }
  const fallback = number('fallbackAngle', 'rad');
  const direction = operator === 'alignDirection' ? normalized(pair('direction', 'vector', chart))
    : towards(pair('from', 'point', chart), pair('to', 'point', chart));
  const value = direction ? Math.atan2(direction[1], direction[0]) : fallback;
  return {angle:scalarResult(value, 'rad'), valid:scalarResult(direction ? 1 : 0),
    ...(operator === 'lookAt' ? {direction:result('direction', 'vector', chart,
      direction ?? [Math.cos(fallback), Math.sin(fallback)])} : {})};
}
