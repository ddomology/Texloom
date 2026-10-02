import {OperationValidationError, type DeepReadonly, type Diagnostic, type OperatorDefinition} from '../ir/operations.js';
import {freezeSnapshot, validateJsonData, validateLiteralValue} from './values.js';
import {coordinateOperatorDefinitions} from './coordinates.js';
import {shapeOperatorDefinitions} from './shapes.js';
import {curveOperatorDefinitions} from './curves.js';

export interface OperatorRegistry {
  get(name: string, version: number): DeepReadonly<OperatorDefinition> | undefined;
  list(): readonly DeepReadonly<OperatorDefinition>[];
}

type RecordValue = Record<string, unknown>;
const object = (value: unknown): value is RecordValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const name = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.trim() === value;
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);

/** Metadata registry only: no implementation, implicit version lookup or execution. */
export function createOperatorRegistry(definitions: readonly OperatorDefinition[]): OperatorRegistry {
  const errors = validateJsonData(definitions, '$.definitions');
  if (errors.length) throw new OperationValidationError(errors);
  const fail = (code: string, message: string, path: string) => errors.push({severity: 'error', code, message, path} as Diagnostic);
  const keys = (value: RecordValue, allowed: readonly string[], path: string) => {
    for (const key of Object.keys(value)) if (!allowed.includes(key)) fail('UNKNOWN_PROPERTY', `Unsupported property ${key}.`, `${path}.${key}`);
  };
  if (!Array.isArray(definitions)) throw new OperationValidationError([{severity: 'error', code: 'OPERATOR_DEFINITIONS', message: 'Expected an array of operator definitions.', path: '$.definitions'}]);
  const pairs = new Set<string>();
  definitions.forEach((raw: unknown, index: number) => {
    const path = `$.definitions[${index}]`;
    if (!object(raw)) { fail('OPERATOR_DEFINITION', 'Expected an operator definition.', path); return; }
    keys(raw, ['name', 'version', 'spaces', 'inputs', 'outputs', 'pure', 'deterministic'], path);
    if (!name(raw.name)) fail('OPERATOR_NAME', 'Operator name must be a nonempty string without surrounding whitespace.', `${path}.name`);
    if (!Number.isSafeInteger(raw.version) || (raw.version as number) < 1) fail('OPERATOR_VERSION', 'Operator version must be a positive safe integer.', `${path}.version`);
    const pair = JSON.stringify([raw.name, raw.version]);
    if (pairs.has(pair)) fail('OPERATOR_DUPLICATE', 'Operator name and version must be unique.', path);
    pairs.add(pair);
    if (raw.pure !== true) fail('OPERATOR_PURITY', 'Operators must declare pure: true.', `${path}.pure`);
    if (raw.deterministic !== true) fail('OPERATOR_DETERMINISM', 'Operators must declare deterministic: true.', `${path}.deterministic`);
    const spaces = new Set<string>();
    if (!Array.isArray(raw.spaces)) fail('OPERATOR_SPACES', 'Expected an array of space variable names.', `${path}.spaces`);
    else raw.spaces.forEach((space: unknown, j: number) => {
      if (!name(space)) fail('OPERATOR_SPACE', 'Expected a nonempty space variable without surrounding whitespace.', `${path}.spaces[${j}]`);
      else if (spaces.has(space)) fail('OPERATOR_SPACE_DUPLICATE', `Duplicate space variable ${space}.`, `${path}.spaces[${j}]`);
      else spaces.add(space);
    });
    const socketType = (input: unknown, location: string): void => {
      if (!object(input)) { fail('SOCKET_TYPE', 'Expected a socket value type.', location); return; }
      const space = (key: string) => {
        if (!name(input[key]) || !spaces.has(input[key] as string)) fail('SOCKET_SPACE', 'Socket space must reference a declared space variable.', `${location}.${key}`);
      };
      switch (input.type) {
        case 'scalar':
          keys(input, ['type','unit'], location);
          if(input.unit!==undefined&&!['1','bp','s','rad'].includes(input.unit as string))fail('SOCKET_UNIT','Expected 1, bp, s or rad.',location+'.unit');
          break;
        case 'vec2':
          keys(input, ['type', 'role', 'space'], location);
          if (input.role !== 'point' && input.role !== 'vector') fail('SOCKET_ROLE', 'Expected point or vector role.', `${location}.role`);
          space('space'); break;
        case 'points2d': case 'shape2d': case 'path2d': keys(input, ['type', 'space'], location); space('space'); break;
        case 'transform2d': keys(input, ['type', 'from', 'to'], location); space('from'); space('to'); break;
        default: fail('SOCKET_TYPE', 'Expected scalar, vec2, path2d or transform2d socket type.', `${location}.type`);
      }
    };
    if (!object(raw.inputs)) fail('OPERATOR_INPUTS', 'Expected an input socket dictionary.', `${path}.inputs`);
    else for (const [id, input] of Object.entries(raw.inputs)) {
      const ip = `${path}.inputs.${id}`;
      if (!name(id)) fail('SOCKET_NAME', 'Socket names must be nonempty without surrounding whitespace.', ip);
      if (!object(input)) { fail('SOCKET_INPUT', 'Expected an input socket definition.', ip); continue; }
      keys(input, ['value', 'required', 'default'], ip);
      socketType(input.value, `${ip}.value`);
      const required = own(input, 'required'), fallback = own(input, 'default');
      if (required === fallback || (required && input.required !== true))
        fail('SOCKET_REQUIRED_DEFAULT', 'An input must have exactly one of required: true or a default literal.', ip);
      if (fallback) {
        errors.push(...validateLiteralValue(input.default, `${ip}.default`));
        if (object(input.default) && object(input.value) && (input.default.type !== input.value.type ||
            (input.value.type === 'vec2' && input.default.role !== input.value.role)))
          fail('SOCKET_DEFAULT_TYPE', 'Default literal type and vector role must match the socket.', `${ip}.default`);
        if(object(input.default)&&object(input.value)&&input.value.type==='scalar'&&input.value.unit!==undefined&&
            (input.default.unit??'1')!==input.value.unit)fail('SOCKET_DEFAULT_UNIT','Default scalar unit must match the socket.',`${ip}.default`);
      }
    }
    if (!object(raw.outputs) || !Object.keys(raw.outputs).length) fail('OPERATOR_OUTPUTS', 'Expected at least one output socket.', `${path}.outputs`);
    else for (const [id, output] of Object.entries(raw.outputs)) {
      const op = `${path}.outputs.${id}`;
      if (!name(id)) fail('SOCKET_NAME', 'Socket names must be nonempty without surrounding whitespace.', op);
      socketType(output, op);
    }
  });
  if (errors.length) throw new OperationValidationError(errors);
  const snapshot = freezeSnapshot(definitions);
  const lookup = new Map(snapshot.map(definition => [JSON.stringify([definition.name, definition.version]), definition]));
  return Object.freeze({
    get(name: string, version: number) { return lookup.get(JSON.stringify([name, version])); },
    list() { return snapshot; },
  });
}

export const defaultOperatorRegistry: OperatorRegistry = createOperatorRegistry([
  ...coordinateOperatorDefinitions,
  ...shapeOperatorDefinitions,
  ...curveOperatorDefinitions,
  {
    name: 'sampleCurve', version: 1, spaces: ['curve'], pure: true, deterministic: true,
    inputs: {
      curve: {value: {type: 'path2d', space: 'curve'}, required: true},
      parameter: {value: {type: 'scalar'}, default: {type: 'scalar', value: 0}},
      tolerance: {value: {type: 'scalar'}, default: {type: 'scalar', value: 0.25}},
    },
    outputs: {
      position: {type: 'vec2', role: 'point', space: 'curve'},
      tangent: {type: 'vec2', role: 'vector', space: 'curve'},
    },
  },
  {
    name: 'offsetPoint', version: 1, spaces: ['space'], pure: true, deterministic: true,
    inputs: {
      origin: {value: {type: 'vec2', role: 'point', space: 'space'}, required: true},
      direction: {value: {type: 'vec2', role: 'vector', space: 'space'}, required: true},
      distance: {value: {type: 'scalar'}, default: {type: 'scalar', value: 1}},
    },
    outputs: {position: {type: 'vec2', role: 'point', space: 'space'}},
  },
  {
    name: 'transformPoint', version: 1, spaces: ['from', 'to'], pure: true, deterministic: true,
    inputs: {
      point: {value: {type: 'vec2', role: 'point', space: 'from'}, required: true},
      transform: {value: {type: 'transform2d', from: 'from', to: 'to'}, required: true},
    },
    outputs: {position: {type: 'vec2', role: 'point', space: 'to'}},
  },
  {
    name: 'scalarValue', version: 1, spaces: [], pure: true, deterministic: true,
    inputs: {value: {value: {type: 'scalar',unit:'1'}, required: true}},
    outputs: {value: {type: 'scalar',unit:'1'}},
  },
  {
    name: 'pointValue', version: 1, spaces: ['space'], pure: true, deterministic: true,
    inputs: {value: {value: {type: 'vec2', role: 'point', space: 'space'}, required: true}},
    outputs: {value: {type: 'vec2', role: 'point', space: 'space'}},
  },
  {
    name: 'vectorValue', version: 1, spaces: ['space'], pure: true, deterministic: true,
    inputs: {value: {value: {type: 'vec2', role: 'vector', space: 'space'}, required: true}},
    outputs: {value: {type: 'vec2', role: 'vector', space: 'space'}},
  },
  {
    name: 'pathValue', version: 1, spaces: ['space'], pure: true, deterministic: true,
    inputs: {value: {value: {type: 'path2d', space: 'space'}, required: true}},
    outputs: {value: {type: 'path2d', space: 'space'}},
  },
  {
    name: 'transformValue', version: 1, spaces: ['from', 'to'], pure: true, deterministic: true,
    inputs: {value: {value: {type: 'transform2d', from: 'from', to: 'to'}, required: true}},
    outputs: {value: {type: 'transform2d', from: 'from', to: 'to'}},
  },
]);
