import {OperationValidationError, type DeepReadonly, type LiteralValue, type Operation, type OperatorDefinition,
  type SpaceRef} from '../ir/operations.js';
import {primitiveToPath, samplePrimitive, validatePrimitive, type Primitive2D, type PrimitivePathReport} from '../geometry/primitives.js';
import {transformGeometry} from '../path-geometry.js';
import {transformCurveInput,type CurveProvenance} from '../geometry/curves.js';
import type {PathGeometry} from '../path-geometry.js';
import {validateLiteralValue} from './values.js';

const point = {value:{type:'vec2',role:'point',space:'space'},required:true} as const;
const scalar = (unit:'1'|'bp'|'rad', fallback?:number):OperatorDefinition['inputs'][string] => ({value:{type:'scalar',unit},
  ...(fallback===undefined?{required:true as const}:{default:{type:'scalar' as const,unit,value:fallback}})});
const shape = {value:{type:'shape2d',space:'space'},required:true} as const;
const constructor = (name:string,inputs:OperatorDefinition['inputs']):OperatorDefinition => ({name,version:1,spaces:['space'],
  pure:true,deterministic:true,inputs,outputs:{shape:{type:'shape2d',space:'space'}}});

/** Analytic construction, approximation and sampling are separate graph nodes. */
export const shapeOperatorDefinitions:OperatorDefinition[] = [
  constructor('circle',{center:point,radius:scalar('bp')}),
  constructor('ellipse',{center:point,rx:scalar('bp'),ry:scalar('bp')}),
  constructor('arc',{center:point,rx:scalar('bp'),ry:scalar('bp'),startAngle:scalar('rad'),sweepAngle:scalar('rad')}),
  constructor('rectangle',{origin:point,width:scalar('bp'),height:scalar('bp')}),
  constructor('roundedRectangle',{origin:point,width:scalar('bp'),height:scalar('bp'),cornerRadius:scalar('bp')}),
  constructor('polyline',{points:{value:{type:'points2d',space:'space'},required:true},closed:scalar('1',0)}),
  ...['shapeToCubic','shapeToPolyline'].map(name=>({name,version:1,spaces:['space'],pure:true as const,deterministic:true as const,
    inputs:{shape,tolerance:scalar('bp',.1),maxSegments:scalar('1',4096)},outputs:{path:{type:'path2d' as const,space:'space'}}})),
  {name:'sampleShape',version:1,spaces:['space'],pure:true,deterministic:true,inputs:{shape,parameter:scalar('1')},
    outputs:{position:{type:'vec2',role:'point',space:'space'},tangent:{type:'vec2',role:'vector',space:'space'}}},
  {name:'transformPath',version:1,spaces:['from','to'],pure:true,deterministic:true,
    inputs:{path:{value:{type:'path2d',space:'from'},required:true},transform:{value:{type:'transform2d',from:'from',to:'to'},required:true}},
    outputs:{path:{type:'path2d',space:'to'}}},
];
const names=new Set(shapeOperatorDefinitions.map(definition=>definition.name));
export const isShapeOperator=(name:string,version:number)=>version===1&&names.has(name);

export interface ShapeEvaluation {
  definitions:Record<string,{space:SpaceRef;primitive:Primitive2D}>;
  /** Tolerance is measured in this space, before any later path transformation. */
  approximations:Record<string,{space:SpaceRef;report:PrimitivePathReport}>;
}
type Authored=DeepReadonly<Operation>;
type Inputs=Readonly<Record<string,LiteralValue>>;
function fail(operation:Authored,code:string,message:string,suffix=''):never {
  throw new OperationValidationError([{severity:'error',code,message:`${operation.operator}@${operation.version} (${operation.id}): ${message}`,
    path:`$.operations[${JSON.stringify(operation.id)}]${suffix}`,...(operation.sourceSpan?{sourceSpan:structuredClone(operation.sourceSpan)}:{})}]);
}
const sameSpace=(a:DeepReadonly<SpaceRef>,b:DeepReadonly<SpaceRef>)=>a.kind===b.kind&&(a.kind==='scene'||b.kind!=='scene'&&a.node===b.node);
function getSpace(operation:Authored,name:string):SpaceRef {
  const value=Object.hasOwn(operation.spaces,name)?operation.spaces[name]:undefined;
  if(!value||!['scene','local','parent','plot'].includes(value.kind))fail(operation,'SHAPE_SPACE','Missing coordinate space.',`.spaces.${name}`);
  return structuredClone(value) as SpaceRef;
}
function input<T extends LiteralValue['type']>(op:Authored,inputs:Inputs,name:string,type:T,space?:SpaceRef):Extract<LiteralValue,{type:T}> {
  const value=Object.hasOwn(inputs,name)?inputs[name]:undefined;
  if(!value||value.type!==type)fail(op,'OPERATION_RUNTIME_TYPE',`Input ${name} requires ${type}.`,`.inputs.${name}`);
  const errors=validateLiteralValue(value);
  if(errors.length)fail(op,errors[0].code,errors[0].message,`.inputs.${name}`);
  if(space&&(!('space'in value)||!sameSpace(value.space,space)))fail(op,'OPERATION_RUNTIME_SPACE',`Input ${name} has a different space.`,`.inputs.${name}`);
  return value as Extract<LiteralValue,{type:T}>;
}
function number(op:Authored,inputs:Inputs,name:string,unit:'1'|'bp'|'rad'):number {
  const value=input(op,inputs,name,'scalar');
  if((value.unit??'1')!==unit)fail(op,'OPERATION_RUNTIME_UNIT',`Input ${name} requires ${unit}.`,`.inputs.${name}`);
  return value.value;
}

export function executeShapeOperation(op:Authored,inputs:Inputs,metadata?:ShapeEvaluation):Record<string,LiteralValue>|undefined {
  if(!isShapeOperator(op.operator,op.version))return;
  try {
    if(op.operator==='transformPath') {
      const from=getSpace(op,'from'),to=getSpace(op,'to'),path=input(op,inputs,'path','path2d',from),matrix=input(op,inputs,'transform','transform2d');
      if(!sameSpace(matrix.from,from)||!sameSpace(matrix.to,to))fail(op,'OPERATION_RUNTIME_SPACE','Transform spaces differ from the declared mapping.','.inputs.transform');
      if(path.provenance){
        const transformed=transformCurveInput({geometry:path.value,provenance:path.provenance},matrix.value);
        return {path:{type:'path2d',space:to,value:structuredClone(transformed.geometry) as PathGeometry,
          provenance:structuredClone(transformed.provenance) as CurveProvenance}};
      }
      return {path:{type:'path2d',space:to,value:transformGeometry(path.value,matrix.value)}};
    }
    const space=getSpace(op,'space');
    if(op.operator==='shapeToCubic'||op.operator==='shapeToPolyline') {
      const primitive=input(op,inputs,'shape','shape2d',space).value;
      const result=primitiveToPath(primitive,{profile:op.operator==='shapeToCubic'?'cubic':'polyline',
        tolerance:number(op,inputs,'tolerance','bp'),maxSegments:number(op,inputs,'maxSegments','1')});
      if(metadata)metadata.approximations[op.id]={space:structuredClone(space),report:structuredClone(result.report) as PrimitivePathReport};
      return {path:{type:'path2d',space,value:structuredClone(result.geometry) as PathGeometry}};
    }
    if(op.operator==='sampleShape') {
      const parameter=number(op,inputs,'parameter','1');
      if(parameter<0||parameter>1)fail(op,'SHAPE_PARAMETER','Parameter must be in [0,1].','.inputs.parameter');
      const sample=samplePrimitive(input(op,inputs,'shape','shape2d',space).value,parameter);
      return {position:{type:'vec2',role:'point',space,value:[...sample.point]},
        tangent:{type:'vec2',role:'vector',space:structuredClone(space),value:[...sample.tangent]}};
    }
    const p=(name:string)=>{
      const value=input(op,inputs,name,'vec2',space);
      if(value.role!=='point')fail(op,'OPERATION_RUNTIME_TYPE',`Input ${name} must have point role.`,`.inputs.${name}`);
      return [...value.value] as [number,number];
    };
    const n=(name:string)=>number(op,inputs,name,'bp');
    let primitive:Primitive2D;
    switch(op.operator) {
      case 'circle': primitive={kind:'circle',center:p('center'),radius:n('radius')};break;
      case 'ellipse': primitive={kind:'ellipse',center:p('center'),rx:n('rx'),ry:n('ry')};break;
      case 'arc': primitive={kind:'arc',center:p('center'),rx:n('rx'),ry:n('ry'),startAngle:number(op,inputs,'startAngle','rad'),sweepAngle:number(op,inputs,'sweepAngle','rad')};break;
      case 'rectangle': primitive={kind:'rectangle',origin:p('origin'),width:n('width'),height:n('height')};break;
      case 'roundedRectangle': primitive={kind:'roundedRectangle',origin:p('origin'),width:n('width'),height:n('height'),cornerRadius:n('cornerRadius')};break;
      case 'polyline': {
        const closed=number(op,inputs,'closed','1');
        if(closed!==0&&closed!==1)fail(op,'SHAPE_CLOSED','closed must be 0 or 1.','.inputs.closed');
        primitive={kind:'polyline',points:structuredClone(input(op,inputs,'points','points2d',space).value),closed:closed===1};break;
      }
      default: return;
    }
    const errors=validatePrimitive(primitive);
    if(errors.length)fail(op,errors[0].code,errors[0].message,'.inputs');
    if(metadata)metadata.definitions[op.id]={space:structuredClone(space),primitive:structuredClone(primitive)};
    return {shape:{type:'shape2d',space,value:primitive}};
  } catch(error) {
    if(error instanceof OperationValidationError)throw error;
    fail(op,(error as {code?:string})?.code??'SHAPE_DOMAIN',error instanceof Error?error.message:String(error));
  }
}
