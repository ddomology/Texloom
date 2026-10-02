import type {DeepReadonly, Diagnostic} from '../ir/operations.js';
import {validatePathGeometry} from '../path-contract.js';

type RecordValue = Record<string, unknown>;
const object = (value: unknown): value is RecordValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const fail = (errors: Diagnostic[], code: string, message: string, path: string) =>
  errors.push({severity: 'error', code, message, path});
const keys = (value: RecordValue, allowed: readonly string[], path: string, errors: Diagnostic[]) => {
  for (const key of Object.keys(value)) if (!allowed.includes(key))
    fail(errors, 'UNKNOWN_PROPERTY', `Unsupported property ${key}.`, `${path}.${key}`);
};

/** Inspect descriptors without invoking getters. Shared subobjects are not cycles. */
export function validateJsonData(input: unknown, path = '$'): Diagnostic[] {
  const errors: Diagnostic[] = [], ancestors = new Set<object>();
  const visit = (value: unknown, location: string, depth: number): void => {
    if (depth > 128) { fail(errors, 'JSON_DEPTH', 'Maximum JSON nesting depth is 128.', location); return; }
    if (value === null || typeof value === 'string' || typeof value === 'boolean' || finite(value)) return;
    if (typeof value !== 'object') {
      fail(errors, 'NON_JSON_VALUE', 'Expected finite JSON data, without functions or undefined.', location); return;
    }
    if (ancestors.has(value)) { fail(errors, 'JSON_CYCLE', 'JSON data must not contain object cycles.', location); return; }
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
    if (!array && prototype !== Object.prototype && prototype !== null) {
      fail(errors, 'NON_JSON_OBJECT', 'Only plain JSON objects are supported.', location); return;
    }
    if (array && prototype !== Array.prototype) {
      fail(errors, 'NON_JSON_OBJECT', 'Only ordinary JSON arrays are supported.', location); return;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.getOwnPropertySymbols(value).length)
      fail(errors, 'NON_JSON_KEY', 'JSON objects cannot contain symbol properties.', location);
    ancestors.add(value);
    if (array) {
      for (let i = 0; i < value.length; i++) if (!Object.prototype.hasOwnProperty.call(descriptors, String(i)))
        fail(errors, 'NON_JSON_VALUE', 'Sparse array entries are not JSON values.', `${location}[${i}]`);
    }
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (array && key === 'length') continue;
      const childPath = array ? `${location}[${key}]` : `${location}.${key}`;
      if (!descriptor.enumerable || (array && !/^(0|[1-9]\d*)$/.test(key))) {
        fail(errors, 'NON_JSON_KEY', 'Only enumerable JSON properties and array indices are supported.', childPath); continue;
      }
      if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        fail(errors, 'NON_JSON_VALUE', 'Accessor properties are not JSON values.', childPath); continue;
      }
      visit(descriptor.value, childPath, depth + 1);
    }
    ancestors.delete(value);
  };
  visit(input, path, 0);
  return errors;
}

export function validateSpaceRef(input: unknown, path = '$'): Diagnostic[] {
  const errors = validateJsonData(input, path);
  if (errors.length) return errors;
  if (!object(input)) { fail(errors, 'SPACE_TYPE', 'Expected a scene or node-local space.', path); return errors; }
  if (input.kind === 'scene') keys(input, ['kind'], path, errors);
  else if (input.kind === 'local') {
    keys(input, ['kind', 'node'], path, errors);
    if (!nonempty(input.node)) fail(errors, 'SPACE_NODE', 'A local space requires a nonempty node ID.', `${path}.node`);
  } else fail(errors, 'SPACE_KIND', 'Expected scene or local space kind.', `${path}.kind`);
  return errors;
}

export function validateSourceSpan(input: unknown, path = '$'): Diagnostic[] {
  const errors = validateJsonData(input, path);
  if (errors.length) return errors;
  if (!object(input)) { fail(errors, 'SOURCE_SPAN_TYPE', 'Expected a source span object.', path); return errors; }
  keys(input, ['file', 'start', 'end'], path, errors);
  if (!nonempty(input.file)) fail(errors, 'SOURCE_SPAN_FILE', 'Source file must be nonempty.', `${path}.file`);
  const position = (value: unknown, location: string): value is {line: number; column: number} => {
    if (!object(value)) { fail(errors, 'SOURCE_SPAN_POSITION', 'Expected line and column.', location); return false; }
    keys(value, ['line', 'column'], location, errors);
    let valid = true;
    for (const key of ['line', 'column']) if (!Number.isSafeInteger(value[key]) || (value[key] as number) < 1) {
      fail(errors, 'SOURCE_SPAN_POSITION', 'Line and column must be positive safe integers.', `${location}.${key}`); valid = false;
    }
    return valid;
  };
  const startValid = position(input.start, `${path}.start`), endValid = position(input.end, `${path}.end`);
  if (startValid && endValid) {
    const start = input.start as {line: number; column: number}, end = input.end as {line: number; column: number};
    if (end.line < start.line || (end.line === start.line && end.column < start.column))
      fail(errors, 'SOURCE_SPAN_ORDER', 'Exclusive end must not precede start.', `${path}.end`);
  }
  return errors;
}

export function validateLiteralValue(input: unknown, path = '$'): Diagnostic[] {
  const errors = validateJsonData(input, path);
  if (errors.length) return errors;
  if (!object(input)) { fail(errors, 'LITERAL_TYPE', 'Expected a typed literal.', path); return errors; }
  const tuple = (size: number) => {
    if (!Array.isArray(input.value) || input.value.length !== size || !input.value.every(finite))
      fail(errors, 'LITERAL_VALUE', `Expected exactly ${size} finite numeric components.`, `${path}.value`);
  };
  switch (input.type) {
    case 'scalar':
      keys(input, ['type', 'value'], path, errors);
      if (!finite(input.value)) fail(errors, 'LITERAL_VALUE', 'Expected a finite scalar.', `${path}.value`);
      break;
    case 'vec2':
      keys(input, ['type', 'role', 'space', 'value'], path, errors);
      if (input.role !== 'point' && input.role !== 'vector') fail(errors, 'LITERAL_ROLE', 'Expected point or vector role.', `${path}.role`);
      errors.push(...validateSpaceRef(input.space, `${path}.space`)); tuple(2);
      break;
    case 'path2d':
      keys(input, ['type', 'space', 'value'], path, errors);
      errors.push(...validateSpaceRef(input.space, `${path}.space`));
      for (const diagnostic of validatePathGeometry(input.value))
        fail(errors, 'LITERAL_PATH', diagnostic.message, `${path}.value${diagnostic.path}`);
      if (object(input.value)) {
        keys(input.value, ['contours'], `${path}.value`, errors);
        if (Array.isArray(input.value.contours)) input.value.contours.forEach((contour: unknown, index: number) => {
          if (!object(contour)) return;
          const cp = `${path}.value.contours[${index}]`;
          keys(contour, ['id', 'start', 'segments', 'closed'], cp, errors);
          if (Array.isArray(contour.segments)) contour.segments.forEach((segment: unknown, j: number) => {
            if (object(segment)) keys(segment, segment.kind === 'cubic' ? ['kind', 'id', 'to', 'c1', 'c2'] : ['kind', 'id', 'to'], `${cp}.segments[${j}]`, errors);
          });
        });
      }
      break;
    case 'transform2d':
      keys(input, ['type', 'from', 'to', 'value'], path, errors);
      errors.push(...validateSpaceRef(input.from, `${path}.from`), ...validateSpaceRef(input.to, `${path}.to`)); tuple(6);
      break;
    default: fail(errors, 'LITERAL_TYPE', 'Expected scalar, vec2, path2d or transform2d.', `${path}.type`);
  }
  return errors;
}

/** A detached, recursively frozen snapshot. Never freezes any caller-owned value. */
export function freezeSnapshot<T>(value: T): DeepReadonly<T> {
  const snapshot = structuredClone(value), visited = new Set<object>();
  const freeze = (item: unknown): void => {
    if (item === null || typeof item !== 'object' || visited.has(item)) return;
    visited.add(item);
    for (const child of Object.values(item)) freeze(child);
    Object.freeze(item);
  };
  freeze(snapshot);
  return snapshot as DeepReadonly<T>;
}
