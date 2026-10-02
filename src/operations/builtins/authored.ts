import {OperationValidationError, type DeepReadonly, type Diagnostic, type LiteralValue,
  type Operation, type SpaceRef, type ValueType} from '../../ir/operations.js';
import {PathGeometryError, sampleGeometry} from '../../path-geometry.js';
import {validateLiteralValue} from '../values.js';
import {isCoordinateOperator, executeCoordinateOperation} from '../coordinates.js';
import {sameSpace} from '../../geometry/spaces.js';
import {isShapeOperator,executeShapeOperation,type ShapeEvaluation} from '../shapes.js';
import {isCurveOperator,executeCurveOperation,type CurveEvaluation} from '../curves.js';
import {isIntersectionOperator,executeIntersectionOperation,type IntersectionEvaluation} from '../intersections.js';
import {isConnectorOperator,executeConnectorOperation} from '../connectors.js';
import {isPathLabelOperator,executePathLabelOperation} from '../path-labels.js';
import {isArrowOperator,executeArrowOperation} from '../arrows.js';
import {isDecorationOperator,executeDecorationOperation} from '../decorations.js';
import {isLayoutOperator,executeLayoutOperation} from '../layout.js';
import {isAxesOperator,executeAxesOperation} from '../axes.js';

type AuthoredOperation = DeepReadonly<Operation>;
type Inputs = Readonly<Record<string, LiteralValue>>;
type Executor = (operation: AuthoredOperation, inputs: Inputs) => Record<string, LiteralValue>;
type ValueOf<T extends ValueType> = Extract<LiteralValue, {type: T}>;

function fail(operation: AuthoredOperation, code: string, message: string, suffix = ''): never {
  const diagnostic: Diagnostic = {severity: 'error', code,
    message: `${operation.operator}@${operation.version} (${operation.id}): ${message}`,
    path: `$.operations[${JSON.stringify(operation.id)}]${suffix}`};
  if (operation.sourceSpan) diagnostic.sourceSpan = {
    file: operation.sourceSpan.file, start: {...operation.sourceSpan.start}, end: {...operation.sourceSpan.end},
  };
  throw new OperationValidationError([diagnostic]);
}

function input<T extends ValueType>(operation: AuthoredOperation, inputs: Inputs, name: string, type: T): ValueOf<T> {
  const value = Object.prototype.hasOwnProperty.call(inputs, name) ? inputs[name] : undefined;
  if (!value || value.type !== type) fail(operation, 'OPERATION_RUNTIME_TYPE', `Input ${name} must be ${type}.`, `.inputs.${name}`);
  return value as ValueOf<T>;
}

function scalar(operation: AuthoredOperation, inputs: Inputs, name: string): number {
  const value = input(operation, inputs, name, 'scalar').value;
  if (!Number.isFinite(value)) fail(operation, 'OPERATION_DOMAIN', `Input ${name} must be finite.`, `.inputs.${name}`);
  return value;
}

function validSpace(value: DeepReadonly<SpaceRef> | undefined): value is DeepReadonly<SpaceRef> {
  return value?.kind === 'scene' || (!!value&&['local','parent','plot'].includes(value.kind)&&'node' in value&&typeof value.node==='string'&&value.node.length>0);
}

function boundSpace(operation: AuthoredOperation, name: string): DeepReadonly<SpaceRef> {
  const space = Object.prototype.hasOwnProperty.call(operation.spaces, name) ? operation.spaces[name] : undefined;
  if (!validSpace(space)) fail(operation, 'OPERATION_RUNTIME_SPACE', `Missing valid space binding ${name}.`, `.spaces.${name}`);
  return space;
}

function requireSpace(operation: AuthoredOperation, actual: SpaceRef | undefined, expected: DeepReadonly<SpaceRef>, path: string): void {
  if (!validSpace(actual) || !sameSpace(actual,expected))
    fail(operation, 'OPERATION_RUNTIME_SPACE', 'Input coordinate space does not match the operation binding.', path);
}

const copySpace = (space: DeepReadonly<SpaceRef>): SpaceRef => structuredClone(space) as SpaceRef;

function vector(operation: AuthoredOperation, inputs: Inputs, name: string, role: 'point' | 'vector', space: DeepReadonly<SpaceRef>): [number, number] {
  const value = input(operation, inputs, name, 'vec2');
  if (value.role !== role) fail(operation, 'OPERATION_RUNTIME_TYPE', `Input ${name} must have ${role} role.`, `.inputs.${name}`);
  if (!Array.isArray(value.value) || value.value.length !== 2 || !value.value.every(Number.isFinite))
    fail(operation, 'OPERATION_DOMAIN', `Input ${name} must contain two finite coordinates.`, `.inputs.${name}`);
  requireSpace(operation, value.space, space, `.inputs.${name}.space`);
  return value.value;
}

function result(operation: AuthoredOperation, socket: string, role: 'point' | 'vector', space: DeepReadonly<SpaceRef>, value: [number, number]): LiteralValue {
  if (!value.every(Number.isFinite))
    fail(operation, 'OPERATION_NONFINITE_OUTPUT', `Output ${socket} contains nonfinite coordinates.`, `.outputs.${socket}`);
  return {type: 'vec2', role, space: copySpace(space), value: [...value]};
}

/** Parameter sampling is strict here; the lower-level path kernel permits clamping. */
const sampleCurve: Executor = (operation, inputs) => {
  const curve = input(operation, inputs, 'curve', 'path2d');
  const space = boundSpace(operation, 'curve');
  requireSpace(operation, curve.space, space, '.inputs.curve.space');
  const parameter = scalar(operation, inputs, 'parameter'), tolerance = scalar(operation, inputs, 'tolerance');
  if (parameter < 0 || parameter > 1)
    fail(operation, 'OPERATION_DOMAIN', 'Parameter must be in [0, 1].', '.inputs.parameter');
  if (tolerance <= 0)
    fail(operation, 'OPERATION_DOMAIN', 'Tolerance must be strictly positive.', '.inputs.tolerance');
  try {
    const sample = sampleGeometry(curve.value, parameter, 'parameter', tolerance);
    return {
      position: result(operation, 'position', 'point', space, sample.point),
      tangent: result(operation, 'tangent', 'vector', space, sample.tangent),
    };
  } catch (error) {
    if (error instanceof PathGeometryError) fail(operation, error.code, error.message, '.inputs.curve');
    throw error;
  }
};

/** Direction is a vector multiplier, not an implicitly normalized heading. */
const offsetPoint: Executor = (operation, inputs) => {
  const space = boundSpace(operation, 'space');
  const origin = vector(operation, inputs, 'origin', 'point', space);
  const direction = vector(operation, inputs, 'direction', 'vector', space);
  const distance = scalar(operation, inputs, 'distance');
  return {position: result(operation, 'position', 'point', space,
    [origin[0] + distance * direction[0], origin[1] + distance * direction[1]])};
};

/** Forward affine mapping [a,b,c,d,e,f]. Singular forward maps are permitted. */
const transformPoint: Executor = (operation, inputs) => {
  const from = boundSpace(operation, 'from'), to = boundSpace(operation, 'to');
  const point = vector(operation, inputs, 'point', 'point', from);
  const transform = input(operation, inputs, 'transform', 'transform2d');
  requireSpace(operation, transform.from, from, '.inputs.transform.from');
  requireSpace(operation, transform.to, to, '.inputs.transform.to');
  const matrix = transform.value;
  if (!Array.isArray(matrix) || matrix.length !== 6 || !matrix.every(Number.isFinite))
    fail(operation, 'OPERATION_DOMAIN', 'Transform must contain six finite affine components.', '.inputs.transform');
  return {position: result(operation, 'position', 'point', to,
    [matrix[0] * point[0] + matrix[2] * point[1] + matrix[4],
      matrix[1] * point[0] + matrix[3] * point[1] + matrix[5]])};
};

const scalarValue: Executor = (operation, inputs) => {
  const literal=input(operation,inputs,'value','scalar');
  if((literal.unit??'1')!=='1')fail(operation,'OPERATION_RUNTIME_UNIT','scalarValue carries dimensionless values; units cannot be discarded.','.inputs.value');
  return {value: {type: 'scalar', value: scalar(operation, inputs, 'value')}};
};

function vec2Value(role: 'point' | 'vector'): Executor {
  return (operation, inputs) => {
    const space = boundSpace(operation, 'space');
    return {value: result(operation, 'value', role, space, vector(operation, inputs, 'value', role, space))};
  };
}

const pathValue: Executor = (operation, inputs) => {
  const value = input(operation, inputs, 'value', 'path2d'), space = boundSpace(operation, 'space');
  requireSpace(operation, value.space, space, '.inputs.value.space');
  const diagnostics = validateLiteralValue(value, '.inputs.value');
  if (diagnostics.length) fail(operation, diagnostics[0].code, diagnostics[0].message, diagnostics[0].path);
  return {value: {type: 'path2d', space: copySpace(space), value: structuredClone(value.value),
    ...(value.provenance?{provenance:structuredClone(value.provenance)}:{})}};
};

const transformValue: Executor = (operation, inputs) => {
  const value = input(operation, inputs, 'value', 'transform2d');
  const from = boundSpace(operation, 'from'), to = boundSpace(operation, 'to');
  requireSpace(operation, value.from, from, '.inputs.value.from');
  requireSpace(operation, value.to, to, '.inputs.value.to');
  if (!Array.isArray(value.value) || value.value.length !== 6 || !value.value.every(Number.isFinite))
    fail(operation, 'OPERATION_DOMAIN', 'Transform must contain six finite affine components.', '.inputs.value');
  return {value: {type: 'transform2d', from: copySpace(from), to: copySpace(to), value: [...value.value]}};
};

// An internal closed dispatch table: scene metadata never supplies executable code.
const implementations = new Map<string, ReadonlyMap<number, Executor>>([
  ['sampleCurve', new Map([[1, sampleCurve]])],
  ['offsetPoint', new Map([[1, offsetPoint]])],
  ['transformPoint', new Map([[1, transformPoint]])],
  ['scalarValue', new Map([[1, scalarValue]])],
  ['pointValue', new Map([[1, vec2Value('point')]])],
  ['vectorValue', new Map([[1, vec2Value('vector')]])],
  ['pathValue', new Map([[1, pathValue]])],
  ['transformValue', new Map([[1, transformValue]])],
]);

/** Fail during preparation if metadata describes an operation this runtime cannot execute. */
export function requireAuthoredImplementation(name: string, version: number): void {
  if(isAxesOperator(name,version))return;
  if(isArrowOperator(name,version))return;
  if(isDecorationOperator(name,version))return;
  if(isLayoutOperator(name,version))return;
  if(isConnectorOperator(name,version)||isPathLabelOperator(name,version))return;
  if(isIntersectionOperator(name,version))return;
  if(isCurveOperator(name,version))return;
  if(isShapeOperator(name,version))return;
  if(isCoordinateOperator(name,version))return;
  if (!implementations.get(name)?.has(version)) throw new OperationValidationError([
    {severity: 'error', code: 'OPERATION_IMPLEMENTATION', message: `No authored implementation for ${name}@${version}.`, path: '$.operator'},
  ]);
}

/** Execute already-resolved literals independently of other calls and caller-owned data. */
export function executeAuthoredOperation(operation: AuthoredOperation, inputs: Inputs,shapes?:ShapeEvaluation,curves?:CurveEvaluation,intersections?:IntersectionEvaluation): Record<string, LiteralValue> {
  const axes=executeAxesOperation(operation,inputs);
  if(axes)return axes;
  const arrows=executeArrowOperation(operation,inputs);
  const decorations=executeDecorationOperation(operation,inputs);
  const layout=executeLayoutOperation(operation,inputs);
  if(layout)return layout;
  if(decorations)return decorations;
  if(arrows)return arrows;
  const connector=executeConnectorOperation(operation,inputs);
  if(connector)return connector;
  const label=executePathLabelOperation(operation,inputs);
  if(label)return label;
  const intersection=executeIntersectionOperation(operation,inputs,intersections);
  if(intersection)return intersection;
  const curve=executeCurveOperation(operation,inputs,curves);
  if(curve)return curve;
  const shape=executeShapeOperation(operation,inputs,shapes);
  if(shape)return shape;
  const coordinate=executeCoordinateOperation(operation,inputs);
  if(coordinate)return coordinate;
  const implementation = implementations.get(operation.operator)?.get(operation.version);
  if (!implementation) fail(operation, 'OPERATION_IMPLEMENTATION', 'No authored implementation is registered.', '.operator');
  return implementation(operation, inputs);
}
