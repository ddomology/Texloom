import {OperationValidationError,type DeepReadonly,type LiteralValue,type Operation,type OperatorDefinition} from '../ir/operations.js';
import {createArrowGeometry,normalizeArrowOptions,type ArrowOptions} from '../geometry/arrowheads.js';
import {validateJsonData,validateLiteralValue,validateSpaceRef} from './values.js';
import {sameSpace} from '../geometry/spaces.js';
import type {PathGeometry} from '../path-geometry.js';

const defaults={start:0,end:1,length:9,width:7.56,inset:2.52,shortenStart:0,shortenEnd:0,tolerance:.05};
type Key=keyof typeof defaults;
const unit=(key:Key):'1'|'bp'=>key==='start'||key==='end'?'1':'bp';
const inputs=Object.fromEntries(Object.entries(defaults).map(([key,value])=>[key,{
  value:{type:'scalar' as const,unit:unit(key as Key)},default:{type:'scalar' as const,unit:unit(key as Key),value},
}]));
const outputs=Object.fromEntries((Object.keys(defaults) as Key[]).map(key=>[key,{type:'scalar' as const,unit:unit(key)}]));
export const arrowOperatorDefinitions:OperatorDefinition[]=[
  {name:'arrowStyle',version:1,spaces:[],pure:true,deterministic:true,inputs,outputs},
  {name:'arrowPath',version:1,spaces:['space'],pure:true,deterministic:true,
    inputs:{...inputs,path:{value:{type:'path2d',space:'space'},required:true},
      collision:{value:{type:'scalar',unit:'1'},default:{type:'scalar',unit:'1',value:0}}},
    outputs:{shaft:{type:'path2d',space:'space'},startTip:{type:'path2d',space:'space'},endTip:{type:'path2d',space:'space'},
      scale:{type:'scalar',unit:'1'},totalLength:{type:'scalar',unit:'bp'}}},
];
export const isArrowOperator=(name:string,version:number)=>version===1&&(name==='arrowStyle'||name==='arrowPath');
export function executeArrowOperation(op:DeepReadonly<Operation>,values:Readonly<Record<string,LiteralValue>>):Record<string,LiteralValue>|undefined {
  if(!isArrowOperator(op.operator,op.version))return;
  function fail(code:string,message:string,suffix=''):never {throw new OperationValidationError([{severity:'error',code,
    message:`${op.operator}@1 (${op.id}): ${message}`,path:`$.operations[${JSON.stringify(op.id)}]${suffix}`,
    ...(op.sourceSpan?{sourceSpan:structuredClone(op.sourceSpan)}:{})}]);}
  try {
    const errors=validateJsonData(values,'$.inputs');if(errors.length)fail(errors[0].code,errors[0].message,'.inputs');
    if(!values||typeof values!=='object'||Array.isArray(values))fail('ARROW_INPUT','Expected input record.');
    const allowed=[...Object.keys(defaults),...(op.operator==='arrowPath'?['path','collision']:[])];
    for(const key of Object.keys(values))if(!allowed.includes(key))fail('UNKNOWN_PROPERTY',`Unknown input ${key}.`,'.inputs.'+key);
    const scalar=(key:string,fallback:number,expected:'bp'|'1'):number=>{
      if(!Object.hasOwn(values,key))return fallback;
      const value=values[key], errors=validateLiteralValue(value);
      if(errors.length)fail(errors[0].code,errors[0].message,'.inputs.'+key);
      if(value.type!=='scalar')fail('ARROW_INPUT',`${key} requires a scalar.`,'.inputs.'+key);
      if((value.unit??'1')!==expected)fail('OPERATION_RUNTIME_UNIT',`${key} requires ${expected}.`,'.inputs.'+key);
      return value.value;
    };
    const options:ArrowOptions={};
    for(const key of Object.keys(defaults) as Key[])(options as Record<string,number>)[key]=scalar(key,defaults[key],unit(key));
    const normalized=normalizeArrowOptions(options);
    if(op.operator==='arrowStyle')return Object.fromEntries((Object.keys(defaults) as Key[]).map(key=>[key,{type:'scalar',unit:unit(key),value:normalized[key]}]));
    const collision=scalar('collision',0,'1');
    if(collision!==0&&collision!==1)fail('ARROW_COLLISION_POLICY','collision must be 0 (error) or 1 (clamp).','.inputs.collision');
    const path=values.path,space=op.spaces?.space;
    if(validateSpaceRef(space).length)fail('OPERATION_RUNTIME_SPACE','Expected valid space.','.spaces.space');
    const pathErrors=validateLiteralValue(path);if(pathErrors.length)fail(pathErrors[0].code,pathErrors[0].message,'.inputs.path');
    if(path.type!=='path2d')fail('ARROW_INPUT','Expected path geometry.','.inputs.path');
    if(!sameSpace(path.space,space!))fail('OPERATION_RUNTIME_SPACE','Path must use declared space.','.inputs.path');
    const result=createArrowGeometry(path.value,{...normalized,collision:collision===0?'error':'clamp'});
    const geometry=(value:DeepReadonly<PathGeometry>):LiteralValue=>({type:'path2d',space:structuredClone(space!),value:structuredClone(value) as PathGeometry});
    return {shaft:geometry(result.shaft),startTip:geometry(result.startTip),endTip:geometry(result.endTip),
      scale:{type:'scalar',unit:'1',value:result.report.scale},totalLength:{type:'scalar',unit:'bp',value:result.report.totalLength}};
  }catch(error){
    if(error instanceof OperationValidationError)throw error;
    fail((error as {code?:string})?.code??'ARROW_DOMAIN',error instanceof Error?error.message:String(error));
  }
}
