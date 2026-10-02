import {OperationValidationError,type DeepReadonly,type LiteralValue,type Operation,type OperatorDefinition,type SpaceRef} from '../ir/operations.js';
import {intersectPathGeometries,type IntersectionSet} from '../geometry/intersections.js';
import {sameSpace} from '../geometry/spaces.js';
import {validateLiteralValue} from './values.js';

const scalar=(unit:'1'|'bp',fallback?:number):OperatorDefinition['inputs'][string]=>({value:{type:'scalar',unit},
  ...(fallback===undefined?{required:true as const}:{default:{type:'scalar' as const,unit,value:fallback}})});
const path={value:{type:'path2d',space:'space'},required:true} as const;
export const intersectionOperatorDefinitions:OperatorDefinition[]=[
  {name:'intersectPaths',version:1,spaces:['space'],pure:true,deterministic:true,
    inputs:{a:path,b:path,domainA:scalar('1',0),domainB:scalar('1',0),
      positionTolerance:scalar('bp',1e-7),parameterTolerance:scalar('1',1e-9)},
    outputs:{intersections:{type:'intersections2d',space:'space'},count:{type:'scalar',unit:'1'},overlapCount:{type:'scalar',unit:'1'}}},
  {name:'selectIntersection',version:1,spaces:['space'],pure:true,deterministic:true,
    inputs:{intersections:{value:{type:'intersections2d',space:'space'},required:true},along:scalar('1'),index:scalar('1',0),
      missing:scalar('1'),fallback:{value:{type:'vec2',role:'point',space:'space'},required:true},visibleOpacity:scalar('1',1)},
    outputs:{position:{type:'vec2',role:'point',space:'space'},found:{type:'scalar',unit:'1'},opacity:{type:'scalar',unit:'1'},
      parameterA:{type:'scalar',unit:'1'},parameterB:{type:'scalar',unit:'1'}}},
];
const names=new Set(intersectionOperatorDefinitions.map(definition=>definition.name));
export const isIntersectionOperator=(name:string,version:number)=>version===1&&names.has(name);

type PointResult=IntersectionSet['points'][number];
type Incident=PointResult['incidents'][number];
export interface IntersectionEvaluation {
  sets:Record<string,{space:SpaceRef;result:DeepReadonly<IntersectionSet>}>;
  selections:Record<string,{space:SpaceRef;along:'a'|'b';index:number;
    selected:DeepReadonly<PointResult>|null;incident:DeepReadonly<Incident>|null}>;
}
type Authored=DeepReadonly<Operation>;
type Inputs=Readonly<Record<string,LiteralValue>>;
function fail(op:Authored,code:string,message:string,suffix=''):never {
  throw new OperationValidationError([{severity:'error',code,message:`${op.operator}@${op.version} (${op.id}): ${message}`,
    path:`$.operations[${JSON.stringify(op.id)}]${suffix}`,...(op.sourceSpan?{sourceSpan:structuredClone(op.sourceSpan)}:{})}]);
}
function space(op:Authored):SpaceRef {
  const value=Object.hasOwn(op.spaces,'space')?op.spaces.space:undefined;
  if(!value||!['scene','local','parent','plot'].includes(value.kind))fail(op,'INTERSECTION_SPACE','Missing valid space.','.spaces.space');
  return structuredClone(value) as SpaceRef;
}
function input<T extends LiteralValue['type']>(op:Authored,inputs:Inputs,name:string,type:T,s?:SpaceRef):Extract<LiteralValue,{type:T}> {
  const value=Object.hasOwn(inputs,name)?inputs[name]:undefined;
  if(!value||value.type!==type)fail(op,'OPERATION_RUNTIME_TYPE',`Input ${name} requires ${type}.`,`.inputs.${name}`);
  const diagnostics=validateLiteralValue(value);
  if(diagnostics.length)fail(op,diagnostics[0].code,diagnostics[0].message,`.inputs.${name}`);
  if(s&&(!('space'in value)||!sameSpace(value.space,s)))fail(op,'OPERATION_RUNTIME_SPACE',`Input ${name} uses a different space.`,`.inputs.${name}`);
  return value as Extract<LiteralValue,{type:T}>;
}
function number(op:Authored,inputs:Inputs,name:string,unit:'1'|'bp'='1'):number {
  const value=input(op,inputs,name,'scalar');
  if((value.unit??'1')!==unit)fail(op,'OPERATION_RUNTIME_UNIT',`Input ${name} requires ${unit}.`,`.inputs.${name}`);
  return value.value;
}
function binary(op:Authored,inputs:Inputs,name:string):number {
  const value=number(op,inputs,name);
  if(value!==0&&value!==1)fail(op,'INTERSECTION_POLICY',`${name} must be 0 or 1.`,`.inputs.${name}`);
  return value;
}
const compareNumber=(a:number,b:number)=>a<b?-1:a>b?1:0;
const compareText=(a:string,b:string)=>a<b?-1:a>b?1:0;
function compareSide(a:Incident,b:Incident,side:'a'|'b'):number {
  const ar=a[side],br=b[side],parameter=side==='a'?'parameterA':'parameterB';
  return compareNumber(ar.contourIndex,br.contourIndex)||compareNumber(ar.segmentIndex,br.segmentIndex)||
    compareNumber(a[parameter],b[parameter])||compareText(ar.contourId,br.contourId)||compareText(ar.segmentId,br.segmentId);
}
function compareIncident(a:Incident,b:Incident,along:'a'|'b'):number {
  return compareSide(a,b,along)||compareSide(a,b,along==='a'?'b':'a')||compareText(a.contact,b.contact);
}

/** Selection is stateless and separate from solving. Overlaps are never points. */
export function executeIntersectionOperation(op:Authored,inputs:Inputs,metadata?:IntersectionEvaluation):Record<string,LiteralValue>|undefined {
  if(!isIntersectionOperator(op.operator,op.version))return;
  try {
    const s=space(op);
    if(op.operator==='intersectPaths') {
      const a=input(op,inputs,'a','path2d',s),b=input(op,inputs,'b','path2d',s);
      const result=intersectPathGeometries(a.value,b.value,{
        modeA:binary(op,inputs,'domainA')===0?'segment':'line',modeB:binary(op,inputs,'domainB')===0?'segment':'line',
        positionTolerance:number(op,inputs,'positionTolerance','bp'),parameterTolerance:number(op,inputs,'parameterTolerance'),
      });
      if(metadata)metadata.sets[op.id]={space:structuredClone(s),result:structuredClone(result)};
      return {intersections:{type:'intersections2d',space:s,value:structuredClone(result) as IntersectionSet},
        count:{type:'scalar',unit:'1',value:result.points.length},overlapCount:{type:'scalar',unit:'1',value:result.overlaps.length}};
    }
    const result=input(op,inputs,'intersections','intersections2d',s).value;
    const along=binary(op,inputs,'along')===0?'a':'b',missing=binary(op,inputs,'missing'),index=number(op,inputs,'index');
    if(!Number.isSafeInteger(index)||index<0)fail(op,'INTERSECTION_INDEX','Index must be a nonnegative safe integer.','.inputs.index');
    const fallback=input(op,inputs,'fallback','vec2',s),visibleOpacity=number(op,inputs,'visibleOpacity');
    if(fallback.role!=='point')fail(op,'OPERATION_RUNTIME_TYPE','Fallback requires a point.','.inputs.fallback');
    if(visibleOpacity<0||visibleOpacity>1)fail(op,'INTERSECTION_OPACITY','Visible opacity must be in [0,1].','.inputs.visibleOpacity');
    if(result.overlaps.length)fail(op,'INTERSECTION_OVERLAP','Overlapping intervals cannot be selected as isolated intersection points.','.inputs.intersections');
    const candidates=result.points.map(point=>({point,incident:[...point.incidents].sort((a,b)=>compareIncident(a,b,along))[0]}));
    candidates.sort((a,b)=>compareIncident(a.incident,b.incident,along)||compareNumber(a.point.point[0],b.point.point[0])||compareNumber(a.point.point[1],b.point.point[1]));
    const selected=candidates[index];
    if(!selected&&missing===0)fail(op,'INTERSECTION_MISSING',`No isolated intersection at index ${index}.`,'.inputs.index');
    if(metadata)metadata.selections[op.id]={space:structuredClone(s),along,index,
      selected:selected?structuredClone(selected.point):null,incident:selected?structuredClone(selected.incident):null};
    return {position:{type:'vec2',role:'point',space:s,value:[...(selected?.point.point??fallback.value)]},
      found:{type:'scalar',unit:'1',value:selected?1:0},opacity:{type:'scalar',unit:'1',value:selected?visibleOpacity:0},
      parameterA:{type:'scalar',unit:'1',value:selected?.incident.parameterA??0},
      parameterB:{type:'scalar',unit:'1',value:selected?.incident.parameterB??0}};
  }catch(error){
    if(error instanceof OperationValidationError)throw error;
    fail(op,(error as {code?:string})?.code??'INTERSECTION_DOMAIN',error instanceof Error?error.message:String(error));
  }
}
