import {OperationValidationError, type DeepReadonly} from '../ir/operations.js';
import type {ExpressionType, ExpressionValue} from '../fields/ast.js';
import type {FieldAttribute, FieldContext} from '../fields/types.js';
import {assertFieldContext} from '../fields/context.js';
import {freezeSnapshot, validateJsonData} from './values.js';

const own=(value:object,key:string)=>Object.prototype.hasOwnProperty.call(value,key);
function fail(code:string,message:string,path:string):never {throw new OperationValidationError([{severity:'error',code,message,path}]);}

export function assertFieldType(type:DeepReadonly<ExpressionType>,path='$.attribute.type'):void {
  if(!type||!['scalar','vec2','boolean'].includes(type.kind))fail('FIELD_TYPE','Expected scalar, vec2 or boolean attribute type.',path);
  if(type.kind!=='boolean'&&(!type.dimension||!['length','time','angle'].every(key=>Number.isSafeInteger(type.dimension[key as keyof typeof type.dimension]))))
    fail('FIELD_TYPE','Attribute dimensions require integer length, time and angle exponents.',path+'.dimension');
}
export function fieldTypesEqual(a:DeepReadonly<ExpressionType>,b:DeepReadonly<ExpressionType>):boolean {
  return a.kind===b.kind&&(a.kind==='boolean'||b.kind==='boolean'||
    a.dimension.length===b.dimension.length&&a.dimension.time===b.dimension.time&&a.dimension.angle===b.dimension.angle);
}
function valueMatches(type:DeepReadonly<ExpressionType>,value:DeepReadonly<ExpressionValue>):boolean {
  if(type.kind==='boolean')return typeof value==='boolean';
  if(type.kind==='scalar')return typeof value==='number'&&Number.isFinite(value);
  return Array.isArray(value)&&value.length===2&&value.every(v=>typeof v==='number'&&Number.isFinite(v));
}

/** Dataset identity is geometry + full domain handle + exact stable element IDs. */
export function assertCompatibleAttribute(context:DeepReadonly<FieldContext>,attribute:DeepReadonly<FieldAttribute>):void {
  assertFieldContext(context);
  const errors=validateJsonData(attribute,'$.attribute');
  if(errors.length)throw new OperationValidationError(errors);
  if(!attribute||!attribute.geometry||attribute.geometry.id!==context.geometry.id||!attribute.domain||
      attribute.domain.id!==context.domain.id||attribute.domain.kind!==context.domain.kind||attribute.domain.key!==context.domain.key)
    fail('FIELD_DOMAIN_MISMATCH','Attribute geometry and full domain identity must match the context.','$.attribute.domain');
  assertFieldType(attribute.type);
  if(!attribute.values||typeof attribute.values!=='object'||Array.isArray(attribute.values))fail('FIELD_VALUES','Expected a stable-ID value dictionary.','$.attribute.values');
  const ids=new Set(context.elements.map(element=>element.id)),keys=Object.keys(attribute.values);
  if(keys.length!==ids.size||keys.some(id=>!ids.has(id))||context.elements.some(element=>!own(attribute.values,element.id)))
    fail('FIELD_ELEMENT_MISMATCH','Attribute values must cover exactly the context stable IDs.','$.attribute.values');
  for(const id of keys)if(!valueMatches(attribute.type,attribute.values[id]))fail('FIELD_VALUE','Attribute values must match the declared finite type.',`$.attribute.values[${JSON.stringify(id)}]`);
}

/** Captured data owns a frozen snapshot, independent of later context updates. */
export function captureAttribute(context:DeepReadonly<FieldContext>,attribute:DeepReadonly<FieldAttribute>):DeepReadonly<FieldAttribute> {
  assertCompatibleAttribute(context,attribute);
  return freezeSnapshot(attribute);
}

/** Change only dataset current positions. This never rewrites a source path. */
export function setFieldPositions(context:DeepReadonly<FieldContext>,attribute:DeepReadonly<FieldAttribute>):DeepReadonly<FieldContext> {
  assertCompatibleAttribute(context,attribute);
  const type=attribute.type;
  if(type.kind!=='vec2'||type.dimension.length!==1||type.dimension.time!==0||type.dimension.angle!==0)
    fail('FIELD_POSITION_TYPE','SetPosition requires vec2 positions in bp.','$.attribute.type');
  const result=structuredClone(context) as FieldContext;
  for(const element of result.elements)element.position=[...(attribute.values[element.id] as readonly [number,number])];
  return freezeSnapshot(result);
}
