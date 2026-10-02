import {OperationValidationError,type DeepReadonly,type LiteralValue,type Operation,type OperatorDefinition,type SpaceRef} from '../ir/operations.js';
import {trimCurveGeometry,resampleCurveGeometry,reverseCurveGeometry,joinCurveGeometries,sampleCurveGeometry,seedCurveProvenance,
  type CurveProvenance,type CurveReport,type CurveOptions} from '../geometry/curves.js';
import {validateLiteralValue} from './values.js';

const pathInput={value:{type:'path2d',space:'space'},required:true} as const;
const scalar=(unit:'1'|'bp',fallback?:number):OperatorDefinition['inputs'][string]=>({value:{type:'scalar',unit},
  ...(fallback===undefined?{required:true as const}:{default:{type:'scalar' as const,unit,value:fallback}})});
const common=()=>({contour:scalar('1',-1),tolerance:scalar('bp',.05)});
const pathDefinition=(name:string,inputs:OperatorDefinition['inputs']):OperatorDefinition=>({name,version:1,spaces:['space'],
  pure:true,deterministic:true,inputs,outputs:{path:{type:'path2d',space:'space'}}});
/** Version 1 parameter-only sampling stays in the historical registry. */
export const curveOperatorDefinitions:OperatorDefinition[]=[
  pathDefinition('trimPath',{path:pathInput,start:scalar('1'),end:scalar('1'),mode:scalar('1',1),wrap:scalar('1',0),...common()}),
  pathDefinition('resamplePathCount',{path:pathInput,count:scalar('1'),...common()}),
  pathDefinition('resamplePathSpacing',{path:pathInput,spacing:scalar('bp'),...common()}),
  pathDefinition('reversePath',{path:pathInput,...common()}),
  pathDefinition('joinPaths',{a:pathInput,b:pathInput,policy:scalar('1'),tolerance:scalar('bp',.05)}),
  {name:'sampleCurve',version:2,spaces:['space'],pure:true,deterministic:true,
    inputs:{path:pathInput,parameter:scalar('1'),mode:scalar('1',1),...common()},outputs:{
      position:{type:'vec2',role:'point',space:'space'},tangent:{type:'vec2',role:'vector',space:'space'},
      normal2d:{type:'vec2',role:'vector',space:'space'},distance:{type:'scalar',unit:'bp'},
      totalLength:{type:'scalar',unit:'bp'},localParameter:{type:'scalar',unit:'1'}}},
];
const identities=new Set(curveOperatorDefinitions.map(d=>JSON.stringify([d.name,d.version])));
export const isCurveOperator=(name:string,version:number)=>identities.has(JSON.stringify([name,version]));
export interface CurveEvaluation {
  operations:Record<string,{space:SpaceRef;report:DeepReadonly<CurveReport>;provenance:DeepReadonly<CurveProvenance>}>;
  samples:Record<string,{space:SpaceRef;sample:ReturnType<typeof sampleCurveGeometry>}>;
}
type Authored=DeepReadonly<Operation>;
type Inputs=Readonly<Record<string,LiteralValue>>;
function fail(op:Authored,code:string,message:string,suffix=''):never {
  throw new OperationValidationError([{severity:'error',code,message:`${op.operator}@${op.version} (${op.id}): ${message}`,
    path:`$.operations[${JSON.stringify(op.id)}]${suffix}`,...(op.sourceSpan?{sourceSpan:structuredClone(op.sourceSpan)}:{})}]);
}
const sameSpace=(a:DeepReadonly<SpaceRef>,b:DeepReadonly<SpaceRef>)=>a.kind===b.kind&&(a.kind==='scene'||b.kind!=='scene'&&a.node===b.node);
function space(op:Authored):SpaceRef {
  const s=Object.hasOwn(op.spaces,'space')?op.spaces.space:undefined;
  if(!s||!['scene','local','parent','plot'].includes(s.kind))fail(op,'CURVE_SPACE','Missing curve coordinate space.','.spaces.space');
  return structuredClone(s) as SpaceRef;
}
function input<T extends LiteralValue['type']>(op:Authored,inputs:Inputs,name:string,type:T):Extract<LiteralValue,{type:T}> {
  const value=Object.hasOwn(inputs,name)?inputs[name]:undefined;
  if(!value||value.type!==type)fail(op,'OPERATION_RUNTIME_TYPE',`Input ${name} requires ${type}.`,`.inputs.${name}`);
  const errors=validateLiteralValue(value);
  if(errors.length)fail(op,errors[0].code,errors[0].message,`.inputs.${name}`);
  return value as Extract<LiteralValue,{type:T}>;
}
function number(op:Authored,inputs:Inputs,name:string,unit:'1'|'bp'):number {
  const value=input(op,inputs,name,'scalar');
  if((value.unit??'1')!==unit)fail(op,'OPERATION_RUNTIME_UNIT',`Input ${name} requires ${unit}.`,`.inputs.${name}`);
  return value.value;
}
function path(op:Authored,inputs:Inputs,name:string,s:SpaceRef):Extract<LiteralValue,{type:'path2d'}> {
  const value=input(op,inputs,name,'path2d');
  if(!sameSpace(value.space,s))fail(op,'OPERATION_RUNTIME_SPACE',`Path ${name} uses a different space.`,`.inputs.${name}`);
  return value.provenance?value:{...value,provenance:structuredClone(seedCurveProvenance(value.value,
    'curve-input:'+JSON.stringify([op.id,name]))) as CurveProvenance};
}
function options(op:Authored,inputs:Inputs,value:Extract<LiteralValue,{type:'path2d'}>,withMode=false):CurveOptions {
  const index=number(op,inputs,'contour','1'),tolerance=number(op,inputs,'tolerance','bp');
  if(!Number.isSafeInteger(index)||index< -1||index>=value.value.contours.length&&index!==-1)
    fail(op,'CURVE_CONTOUR','Contour must be -1 (whole) or an existing contour index.','.inputs.contour');
  const mode=withMode?number(op,inputs,'mode','1'):1;
  if(mode!==0&&mode!==1)fail(op,'CURVE_MODE','Mode must be 0 (parameter) or 1 (length).','.inputs.mode');
  return {mode:mode===0?'parameter':'length',tolerance,
    scope:index===-1?{kind:'whole'}:{kind:'contour',contourId:value.value.contours[index].id}};
}
/** Pure geometry operations return typed paths; lineage never changes drawing. */
export function executeCurveOperation(op:Authored,inputs:Inputs,metadata?:CurveEvaluation):Record<string,LiteralValue>|undefined {
  if(!isCurveOperator(op.operator,op.version))return;
  try {
    const s=space(op);
    let result:ReturnType<typeof trimCurveGeometry>;
    if(op.operator==='joinPaths') {
      const a=path(op,inputs,'a',s),b=path(op,inputs,'b',s),policy=number(op,inputs,'policy','1');
      if(![0,1,2].includes(policy))fail(op,'CURVE_JOIN_POLICY','Policy must be 0 (separate), 1 (coincident), or 2 (bridge).','.inputs.policy');
      result=joinCurveGeometries([{geometry:a.value,...(a.provenance?{provenance:a.provenance}:{})},
        {geometry:b.value,...(b.provenance?{provenance:b.provenance}:{})}],
        {policy:(['separate','coincident','bridge'] as const)[policy],tolerance:number(op,inputs,'tolerance','bp')});
    }else {
      const source=path(op,inputs,'path',s),config=options(op,inputs,source,op.operator==='trimPath'||op.operator==='sampleCurve');
      if(op.operator==='sampleCurve') {
        const sample=sampleCurveGeometry(source.value,number(op,inputs,'parameter','1'),config,source.provenance);
        if(metadata)metadata.samples[op.id]={space:structuredClone(s),sample:structuredClone(sample)};
        const point=(value:readonly [number,number],role:'point'|'vector'):LiteralValue=>({type:'vec2',role,space:structuredClone(s),value:[...value]});
        return {position:point(sample.position,'point'),tangent:point(sample.tangent,'vector'),
          normal2d:point([-sample.tangent[1],sample.tangent[0]],'vector'),
          distance:{type:'scalar',unit:'bp',value:sample.length},totalLength:{type:'scalar',unit:'bp',value:sample.totalLength},
          localParameter:{type:'scalar',unit:'1',value:sample.localParameter}};
      }
      if(op.operator==='trimPath') {
        const wrap=number(op,inputs,'wrap','1');
        if(wrap!==0&&wrap!==1)fail(op,'CURVE_WRAP','Wrap must be 0 or 1.','.inputs.wrap');
        result=trimCurveGeometry(source.value,number(op,inputs,'start','1'),number(op,inputs,'end','1'),{...config,wrap:wrap===1},source.provenance);
      }else if(op.operator==='reversePath')result=reverseCurveGeometry(source.value,config,source.provenance);
      else if(op.operator==='resamplePathCount')result=resampleCurveGeometry(source.value,{...config,count:number(op,inputs,'count','1')},source.provenance);
      else result=resampleCurveGeometry(source.value,{...config,spacing:number(op,inputs,'spacing','bp')},source.provenance);
    }
    if(metadata)metadata.operations[op.id]={space:structuredClone(s),report:structuredClone(result.report),provenance:structuredClone(result.provenance)};
    return {path:{type:'path2d',space:s,value:structuredClone(result.geometry) as Extract<LiteralValue,{type:'path2d'}>['value'],
      provenance:structuredClone(result.provenance) as CurveProvenance}};
  }catch(error){
    if(error instanceof OperationValidationError)throw error;
    fail(op,(error as {code?:string})?.code??'CURVE_DOMAIN',error instanceof Error?error.message:String(error));
  }
}
