import {OperationValidationError, type DeepReadonly, type SourceSpan} from '../ir/operations.js';
import {freezeSnapshot, validateJsonData} from '../operations/values.js';
import {assertCompatibleAttribute, assertFieldType, fieldTypesEqual} from '../operations/attributes.js';
import {assertFieldContext} from './context.js';
import {compileExpression, evaluateExpression} from './scalar.js';
import type {CompiledExpression, ExpressionType, ExpressionValue, ParameterDefinition} from './ast.js';
import type {FieldAttribute, FieldContext} from './types.js';

const own=(value:object,key:string)=>Object.prototype.hasOwnProperty.call(value,key);
const builtins:Readonly<Record<string,ExpressionType>>={
  position:{kind:'vec2',dimension:{length:1,time:0,angle:0}},
  originalPosition:{kind:'vec2',dimension:{length:1,time:0,angle:0}},
  index:{kind:'scalar',dimension:{length:0,time:0,angle:0}},
  count:{kind:'scalar',dimension:{length:0,time:0,angle:0}},
  parameter:{kind:'scalar',dimension:{length:0,time:0,angle:0}},
};

export interface CompiledFieldExpression extends CompiledExpression {
  /** Only captured attributes actually referenced by the expression. */
  readonly attributeTypes:Readonly<Record<string,DeepReadonly<ExpressionType>>>;
}

export function compileFieldExpression(text:string,parameterDefinitions:Readonly<Record<string,ParameterDefinition>>={},
  attributeTypes:Readonly<Record<string,ExpressionType>>={},sourceSpan?:SourceSpan):CompiledFieldExpression {
  const variables:Record<string,ExpressionType>=Object.assign(Object.create(null),builtins);
  const errors=validateJsonData(attributeTypes,'$.field.attributeTypes');
  if(errors.length)throw new OperationValidationError(errors);
  if(!attributeTypes||typeof attributeTypes!=='object'||Array.isArray(attributeTypes))throw new OperationValidationError([
    {severity:'error',code:'FIELD_ATTRIBUTE_TYPES',message:'Expected an attribute type dictionary.',path:'$.field.attributeTypes',...(sourceSpan?{sourceSpan}: {})},
  ]);
  for(const [name,type] of Object.entries(attributeTypes)) {
    if(own(builtins,name)||own(parameterDefinitions,name))throw new OperationValidationError([
      {severity:'error',code:'FIELD_NAME_CONFLICT',message:`Attribute ${name} collides with a field variable or parameter.`,path:'$.field.attributeTypes.'+name,...(sourceSpan?{sourceSpan}: {})},
    ]);
    try{assertFieldType(type,'$.field.attributeTypes.'+name);}
    catch(error){
      if(error instanceof OperationValidationError&&sourceSpan)throw new OperationValidationError(error.diagnostics.map(d=>({...d,sourceSpan})));
      throw error;
    }
    variables[name]=type;
  }
  const compiled=compileExpression(text,parameterDefinitions,sourceSpan,variables);
  const referenced:Record<string,ExpressionType>=Object.create(null);
  for(const name of Object.keys(compiled.parameterTypes))if(own(attributeTypes,name))referenced[name]=attributeTypes[name];
  return freezeSnapshot({...compiled,attributeTypes:referenced});
}

/** Evaluate stable IDs independently; attribute dictionaries are never zipped by order. */
export function evaluateFieldExpression(compiled:CompiledFieldExpression,context:DeepReadonly<FieldContext>,
  parameters:Readonly<Record<string,ExpressionValue>>={},attributes:Readonly<Record<string,DeepReadonly<FieldAttribute>>>={},
  position:'current'|'original'='current'):DeepReadonly<FieldAttribute> {
  const fail=(code:string,message:string,path:string):never=>{throw new OperationValidationError([
    {severity:'error',code,message,path,sourceSpan:structuredClone(compiled.ast.location.sourceSpan)},
  ]);};
  const checked=(check:()=>void):void=>{
    try{check();}catch(error){
      if(error instanceof OperationValidationError)throw new OperationValidationError(error.diagnostics.map(d=>({...d,
        ...(d.sourceSpan?{}:{sourceSpan:structuredClone(compiled.ast.location.sourceSpan)})})));
      throw error;
    }
  };
  checked(()=>assertFieldContext(context));
  if(position!=='current'&&position!=='original')fail('FIELD_POSITION_SOURCE','Position source must be current or original.','$.field.position');
  if(!compiled.attributeTypes||typeof compiled.attributeTypes!=='object'||Array.isArray(compiled.attributeTypes))
    fail('FIELD_COMPILED','Use compileFieldExpression to preserve captured attribute contracts.','$.field.attributeTypes');
  if(!attributes||typeof attributes!=='object'||Array.isArray(attributes))fail('FIELD_ATTRIBUTES','Expected an attribute dictionary.','$.field.attributes');
  for(const [name,type] of Object.entries(compiled.attributeTypes)) {
    if(!own(attributes,name))fail('FIELD_ATTRIBUTE_REFERENCE',`Missing captured attribute ${name}.`,'$.field.attributes.'+name);
    checked(()=>assertCompatibleAttribute(context,attributes[name]));
    if(!fieldTypesEqual(type,attributes[name].type))fail('FIELD_ATTRIBUTE_TYPE',`Captured attribute ${name} has incompatible dimensions or value type.`,'$.field.attributes.'+name);
  }
  const values:Record<string,ExpressionValue>=Object.create(null);
  for(const element of context.elements) {
    const locals:Record<string,ExpressionValue>=Object.assign(Object.create(null),parameters,{
      position:[...(position==='original'?element.originalPosition:element.position)],
      originalPosition:[...element.originalPosition],index:element.index,count:context.elements.length,parameter:element.parameter,
    });
    for(const name of Object.keys(compiled.attributeTypes))locals[name]=structuredClone(attributes[name].values[element.id]) as ExpressionValue;
    try {values[element.id]=evaluateExpression(compiled,{time:context.time,parameters:locals});}
    catch(error) {
      if(error instanceof OperationValidationError)throw new OperationValidationError(error.diagnostics.map(d=>({...d,
        path:`$.field.elements[${JSON.stringify(element.id)}]`,message:`Element ${element.id}: ${d.message}`})));
      throw error;
    }
  }
  return freezeSnapshot({domain:context.domain,geometry:context.geometry,type:compiled.type,values});
}
