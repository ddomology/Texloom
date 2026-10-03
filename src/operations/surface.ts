import {validateBundle,type Bundle,type Resource} from '../schema.js';
import {OperationValidationError,type Diagnostic,type DeepReadonly,type SourceSpan} from '../ir/operations.js';
import type {MeshResource,MeshUnit} from '../ir/mesh.js';
import type {Vec3} from '../geometry/matrix4.js';
import {freezeSnapshot,validateJsonData,validateSourceSpan} from './values.js';
import {compileExpression,evaluateExpression} from '../fields/scalar.js';
import {prepareParameterResolver} from '../fields/program.js';
import type {CompiledExpression,ExpressionType,ExpressionValue} from '../fields/ast.js';
import {prepareParametricSurface,sampleParametricSurface,validateParametricSurfaceOptions,
  type ParametricSurfaceOptions,type SurfaceSample} from '../geometry/parametric-surface.js';

export type SurfaceExpressionTriple=[string,string,string];
export interface SurfaceOperation {
  id:string;resourceId:string;units:MeshUnit;
  domain:{u:[number,number];v:[number,number]};segments:{u:number;v:number};
  position:SurfaceExpressionTriple;
  normals:{kind:'analytic';dU:SurfaceExpressionTriple;dV:SurfaceExpressionTriple}|{kind:'finite-difference'};
  orientation?:'uv'|'vu';seams?:{u?:'open'|'weld'|'duplicate';v?:'open'|'weld'|'duplicate'};
  collapsedBoundaries?:('u-min'|'u-max'|'v-min'|'v-max')[];seamTolerance?:number;
  sourceSpan?:SourceSpan;expressionSpans?:{position?:[SourceSpan,SourceSpan,SourceSpan];dU?:[SourceSpan,SourceSpan,SourceSpan];dV?:[SourceSpan,SourceSpan,SourceSpan]};
}
export interface SurfaceProgram {version:1;operations:SurfaceOperation[]}
export type SurfaceEvaluation=Readonly<Record<string,{readonly resourceId:string;readonly attributes:SurfaceSample['attributes'];readonly report:SurfaceSample['report']}>>;
export interface PreparedSurfaceProgram {
  readonly resourceIds:readonly string[];
  readonly baseResources:Readonly<Record<string,DeepReadonly<MeshResource>>>;
  sample(time:number,parameters?:Readonly<Record<string,ExpressionValue>>):{resources:Readonly<Record<string,DeepReadonly<MeshResource>>>;surfaces:DeepReadonly<SurfaceEvaluation>};
}
export const SURFACE_MAX_OPERATIONS=16,SURFACE_MAX_CELLS=65536;
const object=(v:unknown):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const name=(v:unknown,max:number):v is string=>typeof v==='string'&&v.length>0&&v.length<=max&&v.trim()===v;
const hasErrors=(d:readonly Diagnostic[])=>d.some(x=>x.severity==='error');
const localType:ExpressionType={kind:'scalar',dimension:{length:0,time:0,angle:0}};
type Expressions={position:CompiledExpression[];dU?:CompiledExpression[];dV?:CompiledExpression[]};
interface Entry {operation:DeepReadonly<SurfaceOperation>;path:string;expressions:Expressions;options:ParametricSurfaceOptions}

/** Lightweight package inventory of JSON declarations with valid IDs/units.
 * Full expression and topology validation requires the hydrated bundle context. */
export function surfaceResourceDeclarations(input:unknown):{resourceId:string;units:MeshUnit}[]{
  if(input===undefined||validateJsonData(input,'$.surfaces').length||!object(input)||input.version!==1||!Array.isArray(input.operations)||input.operations.length>SURFACE_MAX_OPERATIONS)return [];
  return input.operations.filter((o:unknown)=>object(o)&&name(o.resourceId,512)&&['unit','m','cm','mm'].includes(o.units)).map((o:SurfaceOperation)=>({resourceId:o.resourceId,units:o.units}));
}
/** @internal Empty validation metadata only: never published in the authored bundle or evaluated frame. */
export function surfaceValidationResources(input:unknown,resources:Record<string,Resource>):Record<string,Resource>{
  const result={...resources};
  for(const {resourceId,units} of surfaceResourceDeclarations(input))if(!Object.hasOwn(result,resourceId))Object.defineProperty(result,resourceId,{enumerable:true,configurable:true,value:{
    kind:'mesh',version:1,primitive:'triangles',units,coordinateSpace:'object',winding:'ccw',topologyRevision:'surface-validation-only',bounds:null,
    positions:{version:1,componentType:'float64',components:3,count:0,byteOffset:0,byteStride:24,data:[]},
    indices:{version:1,componentType:'uint32',components:1,count:0,byteOffset:0,byteStride:4,data:[]}}} satisfies PropertyDescriptor);
  return result;
}
function numericOptions(raw:SurfaceOperation):ParametricSurfaceOptions{
  const {units,domain,segments,orientation,seams,collapsedBoundaries,seamTolerance}=raw;
  return {units,domain,segments,normals:{kind:raw.normals.kind},...(orientation!==undefined?{orientation}:{}),...(seams!==undefined?{seams}:{}),
    ...(collapsedBoundaries!==undefined?{collapsedBoundaries}:{}),...(seamTolerance!==undefined?{seamTolerance}:{})};
}
function inspect(input:unknown,bundle:Bundle,inContext=false):{diagnostics:Diagnostic[];entries:Entry[]}{
  const diagnostics=validateJsonData(input,'$.surfaces'),entries:Entry[]=[];
  const error=(code:string,message:string,path:string,sourceSpan?:SourceSpan)=>diagnostics.push({severity:'error',code,message,path,...(sourceSpan?{sourceSpan}:{})});
  if(hasErrors(diagnostics))return {diagnostics,entries};
  if(!object(bundle)){error('SURFACE_CONTEXT','Expected a scene bundle.','$');return {diagnostics,entries};}
  if(!inContext){diagnostics.push(...validateJsonData(bundle));if(hasErrors(diagnostics))return {diagnostics,entries};}
  if(!object(bundle.resources)){error('SURFACE_CONTEXT','Expected an authored resource dictionary.','$.resources');return {diagnostics,entries};}
  if(!inContext){const {surfaces:ignored,...base}=bundle;diagnostics.push(...validateBundle({...base,resources:surfaceValidationResources(input,base.resources)}));}
  if(bundle.version!=='0.3')error('SURFACE_BUNDLE_VERSION','Surface programs require Bundle 0.3.','$.version');
  if(hasErrors(diagnostics))return {diagnostics,entries};
  const keys=(v:Record<string,unknown>,allowed:readonly string[],path:string)=>{for(const k of Object.keys(v))if(!allowed.includes(k))error('SURFACE_PROPERTY',`Unknown property ${k}.`,path+'.'+k);};
  if(!object(input)){error('SURFACE_PROGRAM','Expected a surface program.','$.surfaces');return {diagnostics,entries};}
  keys(input,['version','operations'],'$.surfaces');if(input.version!==1)error('SURFACE_VERSION','Supported surface version is 1.','$.surfaces.version');
  if(!Array.isArray(input.operations)||input.operations.length>SURFACE_MAX_OPERATIONS){error('SURFACE_BUDGET',`Expected at most ${SURFACE_MAX_OPERATIONS} surfaces.`,'$.surfaces.operations');return {diagnostics,entries};}
  const ids=new Set<string>(),resources=new Set<string>();let cells=0;
  input.operations.forEach((raw:unknown,index:number)=>{
    const path=`$.surfaces.operations[${index}]`,before=diagnostics.length;
    if(!object(raw)){error('SURFACE_OPERATION','Expected a surface operation.',path);return;}
    keys(raw,['id','resourceId','units','domain','segments','position','normals','orientation','seams','collapsedBoundaries','seamTolerance','sourceSpan','expressionSpans'],path);
    if(raw.sourceSpan!==undefined)diagnostics.push(...validateSourceSpan(raw.sourceSpan,path+'.sourceSpan'));
    const span=raw.sourceSpan as SourceSpan|undefined;
    if(!name(raw.id,256)||ids.has(raw.id))error('SURFACE_ID','Surface IDs must be unique, nonempty and at most 256 characters.',path+'.id',span);else ids.add(raw.id);
    if(!name(raw.resourceId,512)||resources.has(raw.resourceId)||Object.hasOwn(bundle.resources,raw.resourceId))error('SURFACE_RESOURCE','Generated resource IDs must be unique and cannot replace authored resources.',path+'.resourceId',span);else resources.add(raw.resourceId);
    if(!object(raw.normals)||!['analytic','finite-difference'].includes(raw.normals.kind)){error('SURFACE_NORMALS','Expected analytic or finite-difference normals.',path+'.normals',span);return;}
    keys(raw.normals,raw.normals.kind==='analytic'?['kind','dU','dV']:['kind'],path+'.normals');
    const expressionKeys=raw.normals.kind==='analytic'?['position','dU','dV'] as const:['position'] as const;
    if(raw.expressionSpans!==undefined){if(!object(raw.expressionSpans))error('SURFACE_SOURCE','Expected expression source spans.',path+'.expressionSpans',span);
      else {keys(raw.expressionSpans,expressionKeys,path+'.expressionSpans');for(const [k,v] of Object.entries(raw.expressionSpans)){if(!Array.isArray(v)||v.length!==3)error('SURFACE_SOURCE','Expected three expression spans.',path+'.expressionSpans.'+k,span);else v.forEach((s,i)=>diagnostics.push(...validateSourceSpan(s,`${path}.expressionSpans.${k}[${i}]`)));}}}
    const options=numericOptions(raw as SurfaceOperation);diagnostics.push(...validateParametricSurfaceOptions(options,path).map(d=>({...d,...(span?{sourceSpan:span}:{})})));
    if(object(raw.segments)&&Number.isInteger(raw.segments.u)&&Number.isInteger(raw.segments.v))cells+=raw.segments.u*raw.segments.v;
    for(const local of ['u','v'])if(Object.hasOwn(bundle.expressions?.parameters??{},local))error('SURFACE_PARAMETER_SHADOW',`Scene parameter ${local} conflicts with a surface local.`,path,span);
    if(diagnostics.slice(before).some(d=>d.severity==='error'))return;
    const expressions:Expressions={position:[]};
    for(const key of expressionKeys){
      const values=key==='position'?raw.position:raw.normals[key],at=key==='position'?path+'.position':path+'.normals.'+key;
      if(!Array.isArray(values)||values.length!==3||values.some(x=>typeof x!=='string')){error('SURFACE_EXPRESSION','Expected three scalar expression strings.',at,span);continue;}
      expressions[key]=values.flatMap((text,i)=>{const source=raw.expressionSpans?.[key]?.[i]??span;try{
        const compiled=compileExpression(text,bundle.expressions?.parameters??{},source,{u:localType,v:localType}),t=compiled.type;
        if(t.kind!=='scalar'||t.dimension.length!==0||t.dimension.time!==0||t.dimension.angle!==0){error('SURFACE_EXPRESSION_TYPE','Surface coordinates and derivatives must be dimensionless scalars in the declared mesh units.',`${at}[${i}]`,source);return [];}
        return [compiled];
      }catch(cause){const ds=(cause as {diagnostics?:Diagnostic[]}).diagnostics??[{severity:'error' as const,code:'SURFACE_EXPRESSION',message:String(cause)}];diagnostics.push(...ds.map(d=>({...d,path:`${at}[${i}]`,...(source?{sourceSpan:source}:{})})));return [];}});
    }
    if(diagnostics.length===before)entries.push({operation:freezeSnapshot(raw as SurfaceOperation),path,expressions,options});
  });
  if(cells>SURFACE_MAX_CELLS)error('SURFACE_BUDGET',`At most ${SURFACE_MAX_CELLS} grid cells are supported across the program.`,'$.surfaces.operations');
  return {diagnostics,entries};
}
export function validateSurfaceProgram(input:unknown,bundle:Bundle):Diagnostic[]{return inspect(input,bundle).diagnostics;}
/** @internal Base bundle and expression parameter declarations have already been validated. */
export function validateSurfaceProgramInContext(input:unknown,bundle:Bundle):Diagnostic[]{return inspect(input,bundle,true).diagnostics;}
function callbacks(entry:Entry,time:number,parameters:Readonly<Record<string,ExpressionValue>>){
  const triple=(key:keyof Expressions,u:number,v:number):Vec3=>{const values={...parameters,u,v};return entry.expressions[key]!.map((compiled,i)=>{try{return evaluateExpression(compiled,{time,parameters:values}) as number;}
    catch(cause){const ds=(cause as {diagnostics?:Diagnostic[]}).diagnostics??[{severity:'error' as const,code:'SURFACE_EVALUATION',message:String(cause)}];const source=entry.operation.expressionSpans?.[key]?.[i]??entry.operation.sourceSpan;
      throw new OperationValidationError(ds.map(d=>({...d,path:`${entry.path}.${key==='position'?'position':'normals.'+key}[${i}]`,...(source?{sourceSpan:source}:{})})));}}) as Vec3;};
  return {position:(u:number,v:number)=>triple('position',u,v),derivatives:entry.expressions.dU?(u:number,v:number)=>({dU:triple('dU',u,v),dV:triple('dV',u,v)}):undefined};
}
export function prepareSurfaceProgram(input:SurfaceProgram,bundle:Bundle):PreparedSurfaceProgram{
  const {diagnostics,entries}=inspect(input,bundle);if(hasErrors(diagnostics))throw new OperationValidationError(diagnostics);
  const resolve=prepareParameterResolver(bundle.expressions?.parameters??{}),defaults=resolve();
  const prepared=entries.map(entry=>{const c=callbacks(entry,0,defaults);try{return {entry,prepared:prepareParametricSurface(entry.options,c.position,c.derivatives)};}
    catch(cause){throw contextual(cause,entry);}});
  const baseResources=Object.freeze(Object.fromEntries(prepared.map(p=>[p.entry.operation.resourceId,p.prepared.baseMesh])));
  return Object.freeze({resourceIds:Object.freeze(entries.map(e=>e.operation.resourceId)),baseResources,sample(time:number,parameters?:Readonly<Record<string,ExpressionValue>>){
    if(!Number.isFinite(time))throw new RangeError('Surface sample time must be finite.');const values=resolve(parameters),resources:Record<string,DeepReadonly<MeshResource>>=Object.create(null),surfaces:Record<string,SurfaceEvaluation[string]>=Object.create(null);
    for(const {entry,prepared:p} of prepared){const c=callbacks(entry,time,values);try{const sample=sampleParametricSurface(p,c.position,c.derivatives);resources[entry.operation.resourceId]=sample.mesh;surfaces[entry.operation.id]=Object.freeze({resourceId:entry.operation.resourceId,attributes:sample.attributes,report:sample.report});}catch(cause){throw contextual(cause,entry);}}
    return {resources:Object.freeze(resources),surfaces:Object.freeze(surfaces)};
  }});
}
function contextual(cause:unknown,entry:Entry):OperationValidationError{
  const ds=(cause as {diagnostics?:readonly Diagnostic[]})?.diagnostics??[{severity:'error' as const,code:'SURFACE_EVALUATION',message:String(cause)}];
  return new OperationValidationError(ds.map(d=>({...d,path:d.path?.startsWith('$.surfaces')?d.path:entry.path,...(d.sourceSpan?{}:entry.operation.sourceSpan?{sourceSpan:entry.operation.sourceSpan}:{})})));
}
