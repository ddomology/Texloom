import {OperationValidationError,type DeepReadonly,type LiteralValue,type Operation,type OperatorDefinition,type SpaceRef} from '../ir/operations.js';
import type {PathGeometry,PathPoint,PathSegment} from '../path-geometry.js';
import {validateJsonData,validateLiteralValue,validateSpaceRef} from './values.js';

const pointInput=()=>({value:{type:'vec2' as const,role:'point' as const,space:'space'},required:true as const});
const definition=(name:string,inputs:OperatorDefinition['inputs']):OperatorDefinition=>({
  name,version:1,spaces:['space'],pure:true,deterministic:true,inputs,outputs:{path:{type:'path2d',space:'space'}},
});

/** Authored endpoint/control-point construction; routing does not inspect obstacles. */
export const connectorOperatorDefinitions:OperatorDefinition[]=[
  definition('connectStraight',{from:pointInput(),to:pointInput()}),
  definition('connectOrthogonal',{from:pointInput(),to:pointInput(),order:{
    value:{type:'scalar',unit:'1'},default:{type:'scalar',unit:'1',value:0},
  }}),
  definition('connectCubic',{from:pointInput(),to:pointInput(),handleA:pointInput(),handleB:pointInput()}),
];
const names=new Set(['connectStraight','connectOrthogonal','connectCubic']);
export const isConnectorOperator=(name:string,version:number):boolean=>version===1&&names.has(name);

type Authored=DeepReadonly<Operation>;
type Inputs=Readonly<Record<string,LiteralValue>>;
function fail(op:Authored,code:string,message:string,suffix=''):never {
  throw new OperationValidationError([{severity:'error',code,message:`${op.operator}@${op.version} (${op.id}): ${message}`,
    path:`$.operations[${JSON.stringify(op.id)}]${suffix}`,...(op.sourceSpan?{sourceSpan:structuredClone(op.sourceSpan)}:{})}]);
}
const sameSpace=(a:SpaceRef,b:DeepReadonly<SpaceRef>):boolean=>a.kind===b.kind&&(a.kind==='scene'||b.kind!=='scene'&&a.node===b.node);
function literal(op:Authored,inputs:Inputs,name:string):LiteralValue {
  const value=Object.hasOwn(inputs,name)?inputs[name]:undefined;
  if(!value)fail(op,'OPERATION_RUNTIME_TYPE',`Missing input ${name}.`,`.inputs.${name}`);
  const errors=validateLiteralValue(value,`$.inputs.${name}`);
  if(errors.length)fail(op,errors[0].code,errors[0].message,errors[0].path?.replace(/^\$/,'')??`.inputs.${name}`);
  return value;
}
function point(op:Authored,inputs:Inputs,name:string,space:DeepReadonly<SpaceRef>):PathPoint {
  const value=literal(op,inputs,name);
  if(value.type!=='vec2'||value.role!=='point')fail(op,'OPERATION_RUNTIME_TYPE',`Input ${name} requires a point.`,`.inputs.${name}`);
  if(!sameSpace(value.space,space))fail(op,'OPERATION_RUNTIME_SPACE',`Input ${name} must use the connector's declared space.`,`.inputs.${name}.space`);
  return [...value.value];
}

/** Results own every coordinate array; zero-length legs keep their stable identities. */
export function executeConnectorOperation(op:Authored,inputs:Inputs):Record<string,LiteralValue>|undefined {
  if(!isConnectorOperator(op.operator,op.version))return;
  const errors=validateJsonData(inputs,'$.inputs');
  if(errors.length)fail(op,errors[0].code,errors[0].message,errors[0].path?.replace(/^\$/,'')??'.inputs');
  if(inputs===null||typeof inputs!=='object'||Array.isArray(inputs))fail(op,'OPERATION_RUNTIME_TYPE','Expected an input record.','.inputs');
  const allowed=op.operator==='connectCubic'?['from','to','handleA','handleB']:op.operator==='connectOrthogonal'?['from','to','order']:['from','to'];
  for(const key of Object.keys(inputs))if(!allowed.includes(key))fail(op,'UNKNOWN_PROPERTY',`Unknown connector input ${key}.`,`.inputs.${key}`);
  const space=op.spaces&&Object.hasOwn(op.spaces,'space')?op.spaces.space:undefined;
  if(validateSpaceRef(space).length)fail(op,'OPERATION_RUNTIME_SPACE','Missing valid connector space.','.spaces.space');
  const from=point(op,inputs,'from',space!),to=point(op,inputs,'to',space!);
  let segments:PathSegment[];
  if(op.operator==='connectCubic')segments=[{id:'segment-0',kind:'cubic',c1:point(op,inputs,'handleA',space!),c2:point(op,inputs,'handleB',space!),to}];
  else if(op.operator==='connectOrthogonal'){
    let order=0;
    if(Object.hasOwn(inputs,'order')){
      const value=literal(op,inputs,'order');
      if(value.type!=='scalar')fail(op,'OPERATION_RUNTIME_TYPE','Input order requires a scalar.','.inputs.order');
      if((value.unit??'1')!=='1')fail(op,'OPERATION_RUNTIME_UNIT','Input order requires dimensionless units.','.inputs.order.unit');
      if(value.value!==0&&value.value!==1)fail(op,'CONNECTOR_ORDER','Order must be 0 (horizontal then vertical) or 1 (vertical then horizontal).','.inputs.order');
      order=value.value;
    }
    const elbow:PathPoint=order===0?[to[0],from[1]]:[from[0],to[1]];
    segments=[{id:'segment-0',kind:'line',to:elbow},{id:'segment-1',kind:'line',to}];
  }else segments=[{id:'segment-0',kind:'line',to}];
  const geometry:PathGeometry={contours:[{id:'connector',start:from,segments}]};
  return {path:{type:'path2d',space:structuredClone(space!),value:geometry}};
}
