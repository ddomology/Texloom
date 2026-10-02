import type {Camera, Node, PathNode, PointNode, TexNode, EllipseNode, LineNode, Transform, Matrix} from '../schema.js';
import {propertySpec} from '../schema.js';
import type {LiteralValue, DeepReadonly, OperationBinding} from '../ir/operations.js';
import {OperationValidationError} from '../ir/operations.js';
import {inverseMatrix, localMatrix, transformPoint, worldMatrix} from '../geometry.js';
import {geometryPointSlot} from '../path-contract.js';

function fail(binding: DeepReadonly<OperationBinding>, code: string, message: string): never {
  throw new OperationValidationError([{severity:'error',code,message,
    ...(binding.sourceSpan ? {sourceSpan:structuredClone(binding.sourceSpan)} : {})}]);
}

/** Preserve the renderer's TRS contract. Never silently discard affine shear. */
function toTransform(value: Matrix, binding: DeepReadonly<OperationBinding>): Transform {
  const [a,b,c,d,e,f] = value, sx = Math.hypot(a,b);
  const rotate = sx ? Math.atan2(b,a) : Math.atan2(-c,d);
  // A signed second scale retains reflections; the dot avoids determinant overflow.
  const sy = -Math.sin(rotate)*c + Math.cos(rotate)*d;
  const result: Transform = {translate:[e,f],rotate,scale:[sx,sy]};
  const composed = localMatrix(result);
  // Trigonometric roundoff scales with the entire column, even when a particular
  // component is mathematically zero (e.g. a quarter-turn with a large scale).
  const budgets = [sx,sx,Math.hypot(c,d),Math.hypot(c,d),Math.abs(e),Math.abs(f)];
  if (!composed.every(Number.isFinite) || value.some((v,i) => Math.abs(v-composed[i]) > 1e-12*Math.max(1,budgets[i])))
    fail(binding,'OPERATION_TRANSFORM_UNSUPPORTED','Whole-transform output must be representable as translate · rotate · scale; shear is unsupported.');
  return result;
}

/** Binding runs after its value producer and every matrix/property it consumes. */
export function applyOperationBinding(binding: DeepReadonly<OperationBinding>, value: LiteralValue,
  nodes: Map<string, Node>, camera: Camera): void {
  const target = binding.target === '$camera' ? camera : nodes.get(binding.target)!;
  const node = target as Node, property = binding.property;
  if (property === 'position' || property === 'start' || property === 'end') {
    if (value.type !== 'vec2') fail(binding,'OPERATION_BINDING_TYPE','A position binding requires a point.');
    const local = transformPoint(inverseMatrix(worldMatrix(node.id,nodes),`binding ${node.id}.${property}`),value.value);
    if (!local.every(Number.isFinite)) fail(binding,'OPERATION_NONFINITE_OUTPUT','Bound local position is not finite.');
    if (property === 'position') {
      if (node.kind === 'ellipse') [(node as EllipseNode).cx,(node as EllipseNode).cy] = local;
      else [(node as PointNode|TexNode).x,(node as PointNode|TexNode).y] = local;
    } else if (property === 'start') [(node as LineNode).x1,(node as LineNode).y1] = local;
    else [(node as LineNode).x2,(node as LineNode).y2] = local;
  } else if (property === 'geometry') {
    if (value.type !== 'path2d') fail(binding,'OPERATION_BINDING_TYPE','Geometry binding requires a path.');
    (node as PathNode).geometry = structuredClone(value.value);
  } else if (property === 'transform') {
    if (value.type !== 'transform2d') fail(binding,'OPERATION_BINDING_TYPE','Transform binding requires an affine matrix.');
    node.transform = toTransform(value.value,binding);
  } else if (property.startsWith('geometry.')) {
    if (value.type !== 'vec2') fail(binding,'OPERATION_BINDING_TYPE','A control binding requires a point.');
    const slot = geometryPointSlot((node as PathNode).geometry,property);
    if (!slot) fail(binding,'OPERATION_GEOMETRY_SLOT','Geometry no longer contains the bound control.');
    slot.set([...value.value]);
  } else {
    const spec = propertySpec(binding.target === '$camera' ? 'camera' : node.kind,property)!;
    const data = value.value;
    if (spec.size) {
      if (value.type !== 'vec2' || !value.value.every(Number.isFinite)) fail(binding,'OPERATION_BINDING_TYPE','Vector property requires two finite components.');
    } else if (value.type !== 'scalar' || !Number.isFinite(value.value) ||
      (spec.min !== undefined && value.value < spec.min) || (spec.max !== undefined && value.value > spec.max) ||
      (spec.strictMin !== undefined && value.value <= spec.strictMin))
      fail(binding,'OPERATION_PROPERTY_RANGE',`Bound value violates ${binding.target}.${property} constraints.`);
    const [head,tail] = property.split('.'), record = target as unknown as Record<string, any>;
    if (tail) {record[head] ??= {}; record[head][tail] = structuredClone(data);}
    else record[head] = structuredClone(data);
  }
}
