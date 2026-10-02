import {OperationValidationError,type DeepReadonly,type LiteralValue,type Operation,type OperatorDefinition,type SpaceRef} from '../ir/operations.js';
import {createPathDecoration,createBraceGeometry} from '../geometry/decorations.js';
import {validateJsonData,validateLiteralValue,validateSpaceRef} from './values.js';
import {sameSpace} from '../geometry/spaces.js';
import type {PathGeometry,PathPoint} from '../path-geometry.js';

const common={spacing:20,phase:0,origin:0,startMargin:0,endMargin:0,offset:0,size:6,orientation:0,corners:0,cusps:0,maxSamples:2048,tolerance:.05};
const defaults={decoratePath:{...common,mode:0,amplitude:5,resolution:16},repeatPathSymbols:{...common,symbolScale:1},bracePath:{amplitude:12,aspect:.5,offset:0}};
type Name=keyof typeof defaults;
const dimensionless=new Set(['mode','orientation','corners','cusps','maxSamples','resolution','symbolScale','aspect']);
const unit=(key:string):'1'|'bp'=>dimensionless.has(key)?'1':'bp';
const scalarInputs=(values:Record<string,number>)=>Object.fromEntries(Object.entries(values).map(([key,value])=>[key,{
  value:{type:'scalar' as const,unit:unit(key)},default:{type:'scalar' as const,unit:unit(key),value},
}]));
export const decorationOperatorDefinitions:OperatorDefinition[]=[
  {name:'decoratePath',version:1,spaces:['space'],pure:true,deterministic:true,
    inputs:{...scalarInputs(defaults.decoratePath),path:{value:{type:'path2d',space:'space'},required:true}},
    outputs:{path:{type:'path2d',space:'space'},count:{type:'scalar',unit:'1'}}},
  {name:'repeatPathSymbols',version:1,spaces:['space','symbol'],pure:true,deterministic:true,
    inputs:{...scalarInputs(defaults.repeatPathSymbols),path:{value:{type:'path2d',space:'space'},required:true},symbol:{value:{type:'path2d',space:'symbol'},required:true}},
    outputs:{path:{type:'path2d',space:'space'},count:{type:'scalar',unit:'1'}}},
  {name:'bracePath',version:1,spaces:['space'],pure:true,deterministic:true,
    inputs:{...scalarInputs(defaults.bracePath),from:{value:{type:'vec2',role:'point',space:'space'},required:true},to:{value:{type:'vec2',role:'point',space:'space'},required:true}},
    outputs:{path:{type:'path2d',space:'space'}}},
];
export const isDecorationOperator=(name:string,version:number)=>version===1&&Object.hasOwn(defaults,name);
export function executeDecorationOperation(op:DeepReadonly<Operation>,values:Readonly<Record<string,LiteralValue>>):Record<string,LiteralValue>|undefined {
  if(!isDecorationOperator(op.operator,op.version))return;
  function fail(code:string,message:string,suffix=''):never {throw new OperationValidationError([{severity:'error',code,
    message:`${op.operator}@1 (${op.id}): ${message}`,path:`$.operations[${JSON.stringify(op.id)}]${suffix}`,
    ...(op.sourceSpan?{sourceSpan:structuredClone(op.sourceSpan)}:{})}]);}
  try {
    const errors=validateJsonData(values,'$.inputs');if(errors.length)fail(errors[0].code,errors[0].message,'.inputs');
    if(!values||typeof values!=='object'||Array.isArray(values))fail('DECORATION_INPUT','Expected input record.');
    const name=op.operator as Name,profile=defaults[name];
    const allowed=[...Object.keys(profile),...(name==='bracePath'?['from','to']:name==='repeatPathSymbols'?['path','symbol']:['path'])];
    for(const key of Object.keys(values))if(!allowed.includes(key))fail('UNKNOWN_PROPERTY',`Unknown input ${key}.`,'.inputs.'+key);
    const space=(key:string):SpaceRef=>{const s=op.spaces?.[key];if(validateSpaceRef(s).length)fail('OPERATION_RUNTIME_SPACE',`Expected valid ${key} space.`,'.spaces.'+key);return structuredClone(s!) as SpaceRef;};
    const target=space('space');
    const input=(key:string):LiteralValue=>{const v=values[key],es=validateLiteralValue(v);if(es.length)fail(es[0].code,es[0].message,'.inputs.'+key);return v;};
    const numbers:Record<string,number>={};
    for(const [key,fallback] of Object.entries(profile)){
      if(!Object.hasOwn(values,key)){numbers[key]=fallback;continue;}
      const v=input(key);if(v.type!=='scalar')fail('DECORATION_INPUT',`${key} requires a scalar.`,'.inputs.'+key);
      if((v.unit??'1')!==unit(key))fail('OPERATION_RUNTIME_UNIT',`${key} requires ${unit(key)}.`,'.inputs.'+key);
      numbers[key]=v.value;
    }
    const point=(key:string):PathPoint=>{const v=input(key);if(v.type!=='vec2'||v.role!=='point')fail('DECORATION_INPUT',`${key} requires a point.`,'.inputs.'+key);
      if(!sameSpace(v.space,target))fail('OPERATION_RUNTIME_SPACE',`${key} must use declared space.`,'.inputs.'+key);return [...v.value];};
    const path=(key:string,chart:SpaceRef):PathGeometry=>{const v=input(key);if(v.type!=='path2d')fail('DECORATION_INPUT',`${key} requires path geometry.`,'.inputs.'+key);
      if(!sameSpace(v.space,chart))fail('OPERATION_RUNTIME_SPACE',`${key} must use declared space.`,'.inputs.'+key);return v.value;};
    const output=(value:DeepReadonly<PathGeometry>):LiteralValue=>({type:'path2d',space:target,value:structuredClone(value) as PathGeometry});
    if(name==='bracePath')return {path:output(createBraceGeometry(point('from'),point('to'),numbers))};
    const select=<T extends string>(key:string,choices:readonly T[]):T=>{const v=numbers[key];if(!Number.isInteger(v)||v<0||v>=choices.length)fail('DECORATION_ENUM',`${key} must be an integer in [0, ${choices.length-1}].`,'.inputs.'+key);return choices[v];};
    const {orientation,corners,cusps,mode,...numericOptions}=numbers;
    const options={...numericOptions,kind:name==='repeatPathSymbols'?'symbols' as const:select('mode',['ticks','marks','snake'] as const),
      orientation:select('orientation',['tangent','fixed','reverse'] as const),corner:select('corners',['following','skip','error'] as const),cusp:select('cusps',['error','skip'] as const)};
    const result=createPathDecoration(path('path',target),options,name==='repeatPathSymbols'?path('symbol',space('symbol')):undefined);
    return {path:output(result.geometry),count:{type:'scalar',unit:'1',value:result.report.emittedCount}};
  }catch(error){
    if(error instanceof OperationValidationError)throw error;
    fail((error as {code?:string})?.code??'DECORATION_DOMAIN',error instanceof Error?error.message:String(error));
  }
}
