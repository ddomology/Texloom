import {validateBundle,type Bundle,type Resource} from '../schema.js';
import {OperationValidationError,type Diagnostic,type SourceSpan,type DeepReadonly} from '../ir/operations.js';
import {snapshotMeshResource,type MeshResource,type MeshUnit} from '../ir/mesh.js';
import {snapshotInstanceSet3D,type InstanceSet3D} from '../ir/instances.js';
import {realizeMeshInstances,derivedInstanceTopologyRevision} from './realize-instances.js';
import {attributeComponents,type AttributeDomain,type MeshAttribute} from '../ir/attributes.js';
import {createMeshFieldContext} from '../fields/mesh-context.js';
import {normalizeQuaternion,type Vec3,type Quaternion} from '../geometry/matrix4.js';
import {compileExpression,evaluateExpression} from '../fields/scalar.js';
import {prepareParameterResolver} from '../fields/program.js';
import type {CompiledExpression,ExpressionValue,ExpressionType} from '../fields/ast.js';
import {freezeSnapshot,validateSourceSpan} from './values.js';
import {validateAssetJson} from '../resources/package.js';
import {prepareSurfaceProgram,surfaceValidationResources} from './surface.js';
import {curveValidationResources} from './curve3d.js';
import {prepareMeshAttributeProgram,meshAttributeValidationResources} from './mesh-attributes.js';

export type InstanceSource={kind:'mesh';resourceId:string;domain:AttributeDomain}|{kind:'points';points:{id:string;position:Vec3}[]};
export interface InstanceRealization {
  resourceId:string;normalPolicy:'transform'|'drop';selection?:'selected'|'all';
  instanceColorAttribute?:string;instanceSelectionAttribute?:string;maxVertices?:number;maxBytes?:number;
}
export interface InstanceOperation {
  id:string;prototype:string;units:MeshUnit;seed:number;source:InstanceSource;
  position?:[string,string,string];rotation?:[string,string,string,string];scale?:[string,string,string];color?:[string,string,string];selection?:string;
  realize?:InstanceRealization;sourceSpan?:SourceSpan;
  expressionSpans?:{position?:SourceSpan[];rotation?:SourceSpan[];scale?:SourceSpan[];color?:SourceSpan[];selection?:SourceSpan};
}
export interface InstanceProgram {version:1;operations:InstanceOperation[]}
export interface InstanceProgramSample {
  instanceSets:Readonly<Record<string,DeepReadonly<InstanceSet3D>>>;
  resources:Readonly<Record<string,DeepReadonly<MeshResource>>>;
}
export interface PreparedInstanceProgram {
  resourceIds:readonly string[];baseInstanceSets:InstanceProgramSample['instanceSets'];baseResources:InstanceProgramSample['resources'];
  sample(time:number,parameters?:Readonly<Record<string,ExpressionValue>>,generatedResources?:Readonly<Record<string,DeepReadonly<Resource>>>):InstanceProgramSample;
}
export const INSTANCE_MAX_OPERATIONS=16,INSTANCE_MAX_COUNT=4096;
const object=(v:unknown):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const name=(v:unknown,max=512):v is string=>typeof v==='string'&&v.length>0&&v.length<=max&&v.trim()===v;
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
const hasErrors=(ds:readonly Diagnostic[])=>ds.some(d=>d.severity==='error');
const units=['unit','m','cm','mm'],domains=['vertex','face','corner'];
const vectorKeys=['position','rotation','scale','color'] as const;
const locals=['x','y','z','index','rand','rand1','rand2','rand3'];
const scalar:ExpressionType={kind:'scalar',dimension:{length:0,time:0,angle:0}};
const localTypes=Object.fromEntries(locals.map(key=>[key,scalar]));
type CompiledFields=Partial<Record<typeof vectorKeys[number],CompiledExpression[]>> & {selection?:CompiledExpression};
interface Entry {operation:DeepReadonly<InstanceOperation>;path:string;expressions:CompiledFields}
export interface InstanceResourceDeclaration {
  id:string;prototype:string;units:MeshUnit;
  source:{kind:'mesh';resourceId:string;domain:AttributeDomain}|{kind:'points'};resourceId?:string;
}
/** Lightweight dependency inventory, not a substitute for program validation. */
export function instanceResourceDeclarations(input:unknown):InstanceResourceDeclaration[]{
  if(input===undefined||validateAssetJson(input,'$.instances').length||!object(input)||input.version!==1||!Array.isArray(input.operations)||input.operations.length>INSTANCE_MAX_OPERATIONS)return [];
  return input.operations.filter((o:unknown)=>object(o)&&name(o.id,256)&&name(o.prototype)&&units.includes(o.units)&&object(o.source)&&
    (o.source.kind==='points'||o.source.kind==='mesh'&&name(o.source.resourceId)&&domains.includes(o.source.domain))&&
    (o.realize===undefined||object(o.realize)&&name(o.realize.resourceId))).map((o:InstanceOperation)=>({id:o.id,prototype:o.prototype,units:o.units,
      source:o.source.kind==='mesh'?{kind:'mesh',resourceId:o.source.resourceId,domain:o.source.domain}:{kind:'points'},...(o.realize?{resourceId:o.realize.resourceId}:{})}));
}
/** @internal Only for reference validation. Actual prepared sets replace these empty records. */
export function instanceValidationSets(input:unknown):Record<string,InstanceSet3D>{
  const sets:Record<string,InstanceSet3D>=Object.create(null);
  for(const d of instanceResourceDeclarations(input))sets[d.id]={version:1,prototypeResourceId:d.prototype,units:d.units,instances:[]};
  return sets;
}
/** @internal Empty typed realization metadata. Never published as a frame resource. */
export function instanceValidationResources(input:unknown,resources:Record<string,Resource>):Record<string,Resource>{
  const result={...resources};const declarations=instanceResourceDeclarations(input);
  for(const [i,d] of declarations.entries()){
    if(!d.resourceId||Object.hasOwn(result,d.resourceId))continue;
    const prototype=result[d.prototype],op=(input as InstanceProgram).operations.find(o=>object(o)&&o.id===d.id),values:Record<string,Pick<MeshAttribute,'domain'|'valueType'>>=Object.create(null);
    if(prototype?.kind==='mesh')for(const [n,a] of Object.entries(prototype.attributes?.values??{}))values[n]={domain:a.domain,valueType:a.valueType};
    if(name(op?.realize?.instanceColorAttribute))values[op!.realize!.instanceColorAttribute!]={domain:'vertex',valueType:'color'};
    if(name(op?.realize?.instanceSelectionAttribute))values[op!.realize!.instanceSelectionAttribute!]={domain:'vertex',valueType:'scalar'};
    const revision=`instance-validation-only:${i}`,buffer=(c:1|2|3)=>({version:1 as const,componentType:'float64' as const,components:c,count:0,byteOffset:0,byteStride:c*8,data:[]});
    const mesh:MeshResource={kind:'mesh',version:1,primitive:'triangles',units:d.units,coordinateSpace:'object',winding:'ccw',topologyRevision:revision,bounds:null,positions:buffer(3),
      indices:{version:1,componentType:'uint32',components:1,count:0,byteOffset:0,byteStride:4,data:[]},
      attributes:{version:1,topology:{revision,vertexCount:0,indices:[]},values:Object.fromEntries(Object.entries(values).map(([n,a])=>[n,{...a,buffer:buffer(attributeComponents(a.valueType))}]))}};
    Object.defineProperty(result,d.resourceId,{value:mesh,enumerable:true,configurable:true});
  }return result;
}
function located(cause:unknown,path:string,span?:DeepReadonly<SourceSpan>):OperationValidationError{
  const ds=(cause as {diagnostics?:readonly Diagnostic[]})?.diagnostics??[{severity:'error' as const,code:'INSTANCE_EVALUATION',message:String(cause)}];
  return new OperationValidationError(ds.map(d=>({...d,path:d.path?.startsWith('$.instances')?d.path:path,...(d.sourceSpan?{}:span?{sourceSpan:structuredClone(span)}:{})})));
}
function fail(code:string,message:string):never{throw new OperationValidationError([{severity:'error',code,message}]);}
function count(mesh:DeepReadonly<MeshResource>,domain:AttributeDomain):number{return domain==='vertex'?mesh.positions.count:domain==='face'?mesh.indices.count/3:mesh.indices.count;}
function upstreamResources(bundle:Bundle):Record<string,Resource>{return meshAttributeValidationResources(bundle.meshAttributes,curveValidationResources(bundle.curves3d,surfaceValidationResources(bundle.surfaces,bundle.resources)));}
function inspect(input:unknown,bundle:Bundle,inContext=false):{diagnostics:Diagnostic[];entries:Entry[]}{
  const diagnostics=validateAssetJson(input,'$.instances'),entries:Entry[]=[];
  const error=(code:string,message:string,path:string,sourceSpan?:SourceSpan)=>diagnostics.push({severity:'error',code,message,path,...(sourceSpan?{sourceSpan}:{})});
  const result=()=>({diagnostics,entries});
  if(hasErrors(diagnostics))return result();if(!object(bundle)){error('INSTANCE_CONTEXT','Expected a scene bundle.','$');return result();}
  if(!inContext){diagnostics.push(...validateAssetJson(bundle));if(hasErrors(diagnostics))return result();diagnostics.push(...validateBundle({...bundle,instances:input as InstanceProgram}));}
  if(!object(bundle.resources)){error('INSTANCE_CONTEXT','Expected an authored resource dictionary.','$.resources');return result();}
  if(bundle.version!=='0.3')error('INSTANCE_VERSION','Instance programs require Bundle 0.3.','$.version');
  if(hasErrors(diagnostics))return result();
  const keys=(v:Record<string,unknown>,allowed:readonly string[],path:string)=>{for(const k of Object.keys(v))if(!allowed.includes(k))error('INSTANCE_PROPERTY',`Unknown property ${k}.`,path+'.'+k);};
  if(!object(input)){error('INSTANCE_PROGRAM','Expected a versioned instance program.','$.instances');return result();}
  keys(input,['version','operations'],'$.instances');if(input.version!==1)error('INSTANCE_VERSION','Supported program version is 1.','$.instances.version');
  if(!Array.isArray(input.operations)||input.operations.length>INSTANCE_MAX_OPERATIONS){error('INSTANCE_BUDGET','Expected at most 16 operations.','$.instances.operations');return result();}
  const available=upstreamResources(bundle),outputs=new Set(Object.keys(available)),ids=new Set<string>();let total=0;
  for(const [i,raw] of input.operations.entries()){
    const path=`$.instances.operations[${i}]`,before=diagnostics.length;
    if(!object(raw)){error('INSTANCE_OPERATION','Expected an operation.',path);continue;}
    keys(raw,['id','prototype','units','seed','source','position','rotation','scale','color','selection','realize','sourceSpan','expressionSpans'],path);
    if(raw.sourceSpan!==undefined)diagnostics.push(...validateSourceSpan(raw.sourceSpan,path+'.sourceSpan'));const span=raw.sourceSpan as SourceSpan|undefined;
    if(!name(raw.id,256)||ids.has(raw.id))error('INSTANCE_ID','Operation IDs must be unique, nonempty and at most 256 characters.',path+'.id',span);else ids.add(raw.id);
    if(!Number.isInteger(raw.seed)||raw.seed<0||raw.seed>0xffffffff)error('INSTANCE_SEED','Seed must be an unsigned 32-bit integer.',path+'.seed',span);
    const prototype=name(raw.prototype)&&Object.hasOwn(available,raw.prototype)?available[raw.prototype]:undefined;
    if(prototype?.kind!=='mesh')error('INSTANCE_PROTOTYPE','Prototype must be an authored or upstream generated mesh.',path+'.prototype',span);
    if(!units.includes(raw.units)||prototype?.kind==='mesh'&&prototype.units!==raw.units)error('INSTANCE_UNITS','Explicit units must match the prototype and source mesh.',path+'.units',span);
    if(!object(raw.source))error('INSTANCE_SOURCE','Expected a mesh-domain or explicit point source.',path+'.source',span);
    else if(raw.source.kind==='mesh'){
      keys(raw.source,['kind','resourceId','domain'],path+'.source');const source=name(raw.source.resourceId)&&Object.hasOwn(available,raw.source.resourceId)?available[raw.source.resourceId]:undefined;
      if(source?.kind!=='mesh')error('INSTANCE_SOURCE','Source must be an authored or upstream generated mesh.',path+'.source.resourceId',span);
      if(!domains.includes(raw.source.domain))error('INSTANCE_DOMAIN','Expected vertex, face or corner.',path+'.source.domain',span);
      if(source?.kind==='mesh'){if(source.units!==raw.units)error('INSTANCE_UNITS','Source units must match the operation.',path+'.source',span);if(domains.includes(raw.source.domain))total+=count(source,raw.source.domain);}
    }else if(raw.source.kind==='points'){
      keys(raw.source,['kind','points'],path+'.source');if(!Array.isArray(raw.source.points)||raw.source.points.length>INSTANCE_MAX_COUNT)error('INSTANCE_BUDGET','Expected at most 4096 explicit points.',path+'.source.points',span);
      else {total+=raw.source.points.length;const pointIds=new Set<string>();for(const [j,p] of raw.source.points.entries()){
        const at=`${path}.source.points[${j}]`;if(!object(p)){error('INSTANCE_POINT','Expected a point record.',at,span);continue;}keys(p,['id','position'],at);
        if(!name(p.id,256)||pointIds.has(p.id))error('INSTANCE_POINT_ID','Point IDs must be unique nonempty strings of at most 256 characters.',at+'.id',span);else pointIds.add(p.id);
        if(!Array.isArray(p.position)||p.position.length!==3||!p.position.every(finite))error('INSTANCE_POINT','Expected three finite coordinates.',at+'.position',span);
      }}
    }else error('INSTANCE_SOURCE','Expected kind mesh or points.',path+'.source.kind',span);
    for(const local of locals)if(Object.hasOwn(bundle.expressions?.parameters??{},local))error('INSTANCE_PARAMETER_SHADOW',`Scene parameter ${local} conflicts with an instance local.`,path,span);
    if(raw.realize!==undefined){
      if(!object(raw.realize))error('INSTANCE_REALIZE','Expected explicit realization options.',path+'.realize',span);
      else {keys(raw.realize,['resourceId','normalPolicy','selection','instanceColorAttribute','instanceSelectionAttribute','maxVertices','maxBytes'],path+'.realize');
        if(!name(raw.realize.resourceId)||outputs.has(raw.realize.resourceId))error('INSTANCE_RESOURCE','Realized output ID must be new and unique.',path+'.realize.resourceId',span);else outputs.add(raw.realize.resourceId);
        if(!['transform','drop'].includes(raw.realize.normalPolicy))error('INSTANCE_NORMALS','Expected explicit normalPolicy transform or drop.',path+'.realize.normalPolicy',span);
        if(raw.realize.selection!==undefined&&!['selected','all'].includes(raw.realize.selection))error('INSTANCE_SELECTION','Expected selected or all.',path+'.realize.selection',span);
        for(const key of ['instanceColorAttribute','instanceSelectionAttribute'])if(raw.realize[key]!==undefined&&(!name(raw.realize[key])||!/^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(raw.realize[key])||['__proto__','prototype','constructor'].includes(raw.realize[key])||prototype?.kind==='mesh'&&Object.hasOwn(prototype.attributes?.values??{},raw.realize[key])))error('INSTANCE_ATTRIBUTE','New attribute names must be safe, unique and absent from the prototype.',path+'.realize.'+key,span);
        if(raw.realize.instanceColorAttribute!==undefined&&raw.realize.instanceColorAttribute===raw.realize.instanceSelectionAttribute)error('INSTANCE_ATTRIBUTE','Color and selection attribute names must differ.',path+'.realize',span);
        for(const key of ['maxVertices','maxBytes'])if(raw.realize[key]!==undefined&&(!Number.isSafeInteger(raw.realize[key])||raw.realize[key]<1))error('INSTANCE_BUDGET',`${key} must be a positive safe integer.`,path+'.realize.'+key,span);
      }
    }
    const expressions:CompiledFields={};
    if(raw.expressionSpans!==undefined){if(!object(raw.expressionSpans))error('INSTANCE_SOURCE_SPAN','Expected grouped expression spans.',path+'.expressionSpans',span);else keys(raw.expressionSpans,[...vectorKeys,'selection'],path+'.expressionSpans');}
    for(const key of [...vectorKeys,'selection'] as const){
      const value=raw[key],spans=raw.expressionSpans?.[key],n=key==='rotation'?4:key==='selection'?1:3;
      if(spans!==undefined){if(value===undefined)error('INSTANCE_SOURCE_SPAN','A span requires its expression field.',path+'.expressionSpans.'+key,span);
        const list=key==='selection'?[spans]:spans;if(!Array.isArray(list)||list.length!==n)error('INSTANCE_SOURCE_SPAN','Source span shape must match the expressions.',path+'.expressionSpans.'+key,span);else list.forEach((s:unknown,k:number)=>diagnostics.push(...validateSourceSpan(s,`${path}.expressionSpans.${key}[${k}]`)));}
      if(value===undefined)continue;const texts=key==='selection'?[value]:value;
      if(!Array.isArray(texts)||texts.length!==n||texts.some(t=>typeof t!=='string')){error('INSTANCE_EXPRESSION','Expected one boolean expression or a fixed-size numeric expression vector.',path+'.'+key,span);continue;}
      const compiled:CompiledExpression[]=[];for(const [j,text] of texts.entries())try{
        const source=key==='selection'?spans:spans?.[j],e=compileExpression(text,bundle.expressions?.parameters??{},source??span,localTypes);
        if(key==='selection'?e.type.kind!=='boolean':e.type.kind!=='scalar'||Object.values(e.type.dimension).some(v=>v!==0))error('INSTANCE_EXPRESSION_TYPE',key==='selection'?'Selection requires a boolean.':'Numeric components must be dimensionless in the declared mesh units.',`${path}.${key}${key==='selection'?'':`[${j}]`}`,source??span);
        compiled.push(e);
      }catch(cause){diagnostics.push(...located(cause,`${path}.${key}[${j}]`,span).diagnostics);}
      if(key==='selection')expressions.selection=compiled[0];else expressions[key]=compiled;
    }
    if(diagnostics.length===before){entries.push({operation:freezeSnapshot(raw as InstanceOperation),path,expressions});
      if(raw.realize){const virtual=instanceValidationResources({version:1,operations:[raw]},available);Object.defineProperty(available,raw.realize.resourceId,{value:virtual[raw.realize.resourceId],enumerable:true,configurable:true});}}
  }
  if(total>INSTANCE_MAX_COUNT)error('INSTANCE_BUDGET','At most 4096 sampled instances are supported across the program.','$.instances.operations');
  return result();
}
export function validateInstanceProgram(input:unknown,bundle:Bundle):Diagnostic[]{return inspect(input,bundle).diagnostics;}
/** @internal The caller validated JSON and expression parameter declarations. */
export function validateInstanceProgramInContext(input:unknown,bundle:Bundle):Diagnostic[]{return inspect(input,bundle,true).diagnostics;}
/** FNV-1a UTF-16 with a final avalanche; stable seed data, never playback state. */
function hash(text:string):number{let h=2166136261;for(let i=0;i<text.length;i++){h=Math.imul(h^text.charCodeAt(i),16777619);}h^=h>>>16;h=Math.imul(h,0x7feb352d);h^=h>>>15;h=Math.imul(h,0x846ca68b);return (h^(h>>>16))>>>0;}
function meshElementId(resourceId:string,revision:string,domain:AttributeDomain,index:number):string{
  const identity=JSON.stringify([resourceId,revision,domain]),digest=[0,1,2,3].map(lane=>hash(JSON.stringify([identity,lane])).toString(16).padStart(8,'0')).join('');
  return `mesh:${digest}:${domain}:${index}`;
}
export function prepareInstanceProgram(input:InstanceProgram,bundle:Bundle,generatedResources?:Readonly<Record<string,DeepReadonly<Resource>>>):PreparedInstanceProgram{
  const {diagnostics,entries}=inspect(input,bundle);if(hasErrors(diagnostics))throw new OperationValidationError(diagnostics);
  const resolve=prepareParameterResolver(bundle.expressions?.parameters??{}),authored=freezeSnapshot(bundle.resources);
  const supplied=(value:unknown):Readonly<Record<string,DeepReadonly<Resource>>>=>{const ds=validateAssetJson(value,'$.generatedResources');if(hasErrors(ds))throw new OperationValidationError(ds);if(!object(value))fail('INSTANCE_CONTEXT','Expected a generated resource dictionary.');return value as Readonly<Record<string,DeepReadonly<Resource>>>;};
  const defaults=freezeSnapshot(supplied(generatedResources??{})),surfaces=generatedResources===undefined&&bundle.surfaces?prepareSurfaceProgram(bundle.surfaces,bundle):undefined;
  const attributes=generatedResources===undefined&&bundle.meshAttributes?prepareMeshAttributeProgram(bundle.meshAttributes,bundle,{...surfaces?.baseResources}):undefined;
  const sample=(time:number,overrides?:Readonly<Record<string,ExpressionValue>>,generated?:Readonly<Record<string,DeepReadonly<Resource>>>):InstanceProgramSample=>{
    if(!Number.isFinite(time))throw new RangeError('Instance sample time must be finite.');const parameters=resolve(overrides);
    const surface=generated===undefined?surfaces?.sample(time,overrides):undefined;
    const current=generated===undefined?{...defaults,...surface?.resources,...attributes?.sample(time,overrides,surface?.resources??{}).resources}:supplied(generated);
    const instanceSets:Record<string,DeepReadonly<InstanceSet3D>>=Object.create(null),resources:Record<string,DeepReadonly<MeshResource>>=Object.create(null);let total=0;
    const mesh=(id:string,unit:MeshUnit):DeepReadonly<MeshResource>=>{const value=Object.hasOwn(resources,id)?resources[id]:Object.hasOwn(authored,id)?authored[id]:current[id];if(value?.kind!=='mesh'||value.units!==unit)fail('INSTANCE_RESOURCE','Supply the declared source/prototype mesh in matching units.');return snapshotMeshResource(value);};
    for(const {operation:o,path,expressions} of entries)try{
      const prototype=mesh(o.prototype,o.units);let elements:{id:string;position:DeepReadonly<Vec3>;index:number}[];
      if(o.source.kind==='points'){total+=o.source.points.length;if(total>INSTANCE_MAX_COUNT)fail('INSTANCE_BUDGET','More than 4096 sampled instances.');elements=o.source.points.map((p,index)=>({...p,index}));}
      else {const source=mesh(o.source.resourceId,o.units);total+=count(source,o.source.domain);if(total>INSTANCE_MAX_COUNT)fail('INSTANCE_BUDGET','More than 4096 sampled instances.');const {resourceId,domain}=o.source;
        elements=createMeshFieldContext(source,source,domain,time).elements.map(e=>({id:meshElementId(resourceId,source.topologyRevision,domain,e.index),position:e.position,index:e.index}));}
      const instances=elements.map(element=>{const [x,y,z]=element.position,random=Object.fromEntries(['rand','rand1','rand2','rand3'].map((key,i)=>[key,hash(JSON.stringify([o.seed,o.id,element.id,i]))/4294967296])),values={...parameters,x,y,z,index:element.index,...random};
        const numeric=(key:typeof vectorKeys[number],fallback:readonly number[]):number[]=>expressions[key]?.map((e,i)=>{try{return evaluateExpression(e,{time,parameters:values}) as number;}catch(cause){throw located(cause,`${path}.${key}[${i}]`,o.expressionSpans?.[key]?.[i]??o.sourceSpan);}})??[...fallback];
        let selected=true;if(expressions.selection)try{selected=evaluateExpression(expressions.selection,{time,parameters:values}) as boolean;}catch(cause){throw located(cause,path+'.selection',o.expressionSpans?.selection??o.sourceSpan);}
        let rotation:Quaternion;try{rotation=[...normalizeQuaternion(numeric('rotation',[0,0,0,1]) as Quaternion)] as Quaternion;}catch(cause){throw located(cause,path+'.rotation',o.sourceSpan);}
        return {id:element.id,transform:{translation:numeric('position',element.position) as Vec3,rotation,scale:numeric('scale',[1,1,1]) as Vec3},color:numeric('color',[1,1,1]) as Vec3,selected};
      });
      const set=snapshotInstanceSet3D({version:1,prototypeResourceId:o.prototype,units:o.units,instances},prototype);instanceSets[o.id]=set;
      if(o.realize){const {resourceId,...options}=o.realize;resources[resourceId]=realizeMeshInstances(set,prototype,{...options,topologyRevision:derivedInstanceTopologyRevision(set,prototype,options.selection)}).mesh;}
    }catch(cause){throw located(cause,path,o.sourceSpan);}
    return Object.freeze({instanceSets:Object.freeze(instanceSets),resources:Object.freeze(resources)});
  };
  const base=sample(0);return Object.freeze({resourceIds:Object.freeze(entries.flatMap(e=>e.operation.realize?[e.operation.realize.resourceId]:[])),baseInstanceSets:base.instanceSets,baseResources:base.resources,sample});
}
