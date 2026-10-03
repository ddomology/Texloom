import {validateBundle,type Bundle,type Resource} from '../schema.js';
import {OperationValidationError,type Diagnostic,type SourceSpan,type DeepReadonly} from '../ir/operations.js';
import {snapshotMeshResource,type MeshResource,type MeshUnit} from '../ir/mesh.js';
import {attachMeshAttributes,attributeComponents,MAX_MESH_ATTRIBUTES,MAX_MESH_ATTRIBUTE_COMPONENTS,type MeshAttribute} from '../ir/attributes.js';
import type {NumericBuffer} from '../resources/buffers.js';
import {prepareInlineBake,validateBakeManifest,type BakeManifest} from '../resources/bake.js';
import {validateAssetJson} from '../resources/package.js';
import {prepareParameterResolver} from '../fields/program.js';
import type {ExpressionValue} from '../fields/ast.js';
import {freezeSnapshot,validateSourceSpan} from './values.js';
import {prepareSurfaceProgram,surfaceValidationResources} from './surface.js';
import {curveValidationResources} from './curve3d.js';
import {prepareMeshAttributeProgram,meshAttributeValidationResources} from './mesh-attributes.js';
import {replaceMeshPositions} from './field-visualization-data.js';

export interface SampledFieldOperation {
  id:string;source:string;resourceId:string;bake:string;units:MeshUnit;
  attributes:{channel:string;name:string}[];
  position?:{channel:string;normalPolicy:'drop'|'recompute';degenerateNormalPolicy:'error'|'source'};
  sourceSpan?:SourceSpan;
}
export interface SampledFieldProgram {version:1;operations:SampledFieldOperation[]}
export interface SampledFieldEvaluation {
  [id:string]:{source:string;resourceId:string;bake:string;time:number;bracket:{left:number;right:number;alpha:number;sourceTime:number};
    attributes:{channel:string;name:string;valueType:'scalar'|'vec3';kind:'scalar'|'vector'|'position';unit:string}[];
    position?:{channel:string;normalOrigin:'source'|'none'|'recomputed'|'recomputed-with-source-fallback';sourceNormalFallbacks:number[]};
    provenance:{solver:BakeManifest['solver'];seed:number};interpolation:BakeManifest['interpolation'];outside:BakeManifest['outside']};
}
export interface SampledFieldSample {resources:Readonly<Record<string,DeepReadonly<MeshResource>>>;sampledFields:DeepReadonly<SampledFieldEvaluation>}
export interface PreparedSampledFieldProgram {
  resourceIds:readonly string[];baseResources:SampledFieldSample['resources'];
  sample(time:number,parameters?:Readonly<Record<string,ExpressionValue>>,generatedResources?:Readonly<Record<string,DeepReadonly<Resource>>>):SampledFieldSample;
}
export const SAMPLED_FIELD_MAX_OPERATIONS=16,SAMPLED_FIELD_MAX_VERTICES=65536,BAKE_REGISTRY_MAX_MANIFESTS=16,BAKE_REGISTRY_MAX_BYTES=64*1024*1024;
const object=(v:unknown):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const name=(v:unknown,max=512):v is string=>typeof v==='string'&&v.length>0&&v.length<=max&&v.trim()===v;
const attrName=(v:unknown):v is string=>name(v)&&/^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(v)&&!['__proto__','constructor','prototype'].includes(v);
const units=['unit','m','cm','mm'],hasErrors=(d:readonly Diagnostic[])=>d.some(x=>x.severity==='error');
const buffer=(components:1|2|3,data:number[],componentType:'float32'|'float64'='float64'):NumericBuffer=>({version:1,componentType,components,count:data.length/components,byteOffset:0,byteStride:components*(componentType==='float64'?8:4),data});
/** Bound the complete registry before any decoding, allocation or transport. */
export function validateBakeRegistry(input:unknown,path='$.bakes'):Diagnostic[]{
  if(input===undefined)return [];const diagnostics=validateAssetJson(input,path);if(hasErrors(diagnostics))return diagnostics;
  const error=(code:string,message:string,where=path)=>diagnostics.push({severity:'error',code,message,path:where});
  if(!object(input)){error('BAKE_REGISTRY','Expected a bake dictionary.');return diagnostics;}
  if(Object.keys(input).length>BAKE_REGISTRY_MAX_MANIFESTS){error('BAKE_REGISTRY_BUDGET','At most 16 bake manifests per scene.');return diagnostics;}
  let total=0;
  for(const [id,bake] of Object.entries(input)){
    if(!name(id))error('BAKE_REGISTRY_ID','Bake IDs must be nonempty and at most 512 characters.',`${path}[${JSON.stringify(id)}]`);
    const errors=validateBakeManifest(bake,undefined,`${path}[${JSON.stringify(id)}]`);diagnostics.push(...errors);
    if(!hasErrors(errors))for(const chunk of (bake as BakeManifest).chunks)total+=chunk.byteLength;
  }
  if(!Number.isSafeInteger(total)||total>BAKE_REGISTRY_MAX_BYTES)error('BAKE_REGISTRY_BUDGET','Aggregate declared bake payload exceeds 64 MiB.');
  return diagnostics;
}
export function sampledFieldResourceDeclarations(input:unknown):{id:string;source:string;resourceId:string;bake:string;units:MeshUnit}[]{
  if(input===undefined||validateAssetJson(input,'$.sampledFields').length||!object(input)||input.version!==1||!Array.isArray(input.operations)||input.operations.length>SAMPLED_FIELD_MAX_OPERATIONS)return [];
  return input.operations.filter((o:unknown)=>object(o)&&name(o.id,256)&&name(o.source)&&name(o.resourceId)&&name(o.bake)&&units.includes(o.units)).map((o:SampledFieldOperation)=>({id:o.id,source:o.source,resourceId:o.resourceId,bake:o.bake,units:o.units}));
}
/** @internal Typed validation placeholders, never published to a renderer. */
export function sampledFieldValidationResources(input:unknown,resources:Record<string,Resource>,bakes:Readonly<Record<string,DeepReadonly<BakeManifest>>>={}):Record<string,Resource>{
  const result={...resources};
  for(const d of sampledFieldResourceDeclarations(input)){
    if(Object.hasOwn(result,d.resourceId))continue;
    const source=result[d.source],o=(input as SampledFieldProgram).operations.find(o=>o.id===d.id),bake=Object.hasOwn(bakes,d.bake)?bakes[d.bake]:undefined,values:Record<string,Pick<MeshAttribute,'domain'|'valueType'>>=Object.create(null);
    if(source?.kind==='mesh')for(const [n,a] of Object.entries(source.attributes?.values??{}))values[n]={domain:a.domain,valueType:a.valueType};
    if(Array.isArray(o?.attributes)&&Array.isArray(bake?.channels))for(const a of o.attributes)if(object(a)&&attrName(a.name)){const channel=bake.channels.find(c=>c.id===a.channel);if(channel)values[a.name]={domain:'vertex',valueType:channel.kind==='scalar'?'scalar':'vec3'};}
    const revision='sampled-field-validation-only';const mesh:MeshResource={kind:'mesh',version:1,primitive:'triangles',units:d.units,coordinateSpace:'object',winding:'ccw',topologyRevision:revision,bounds:null,
      positions:buffer(3,[]),indices:{version:1,componentType:'uint32',components:1,count:0,byteOffset:0,byteStride:4,data:[]},
      attributes:{version:1,topology:{revision,vertexCount:0,indices:[]},values:Object.fromEntries(Object.entries(values).map(([n,a])=>[n,{...a,buffer:buffer(attributeComponents(a.valueType),[])}]))}};
    Object.defineProperty(result,d.resourceId,{value:mesh,enumerable:true,configurable:true});
  }return result;
}
function located(cause:unknown,path:string,span?:DeepReadonly<SourceSpan>):OperationValidationError{
  const ds=(cause as {diagnostics?:readonly Diagnostic[]})?.diagnostics??[{severity:'error' as const,code:'SAMPLED_FIELD_EVALUATION',message:String(cause)}];
  return new OperationValidationError(ds.map(d=>({...d,path:d.path?.startsWith('$.sampledFields')?d.path:path,...(d.sourceSpan?{}:span?{sourceSpan:structuredClone(span)}:{})})));
}
function fail(code:string,message:string):never{throw new OperationValidationError([{severity:'error',code,message}]);}
function inspect(input:unknown,bundle:Bundle,inContext=false):{diagnostics:Diagnostic[];entries:DeepReadonly<SampledFieldOperation>[]} {
  const diagnostics=validateAssetJson(input,'$.sampledFields'),entries:DeepReadonly<SampledFieldOperation>[]=[];
  const error=(code:string,message:string,path:string,sourceSpan?:SourceSpan)=>diagnostics.push({severity:'error',code,message,path,...(sourceSpan?{sourceSpan}:{})}),result=()=>({diagnostics,entries});
  if(hasErrors(diagnostics))return result();if(!object(bundle)){error('SAMPLED_FIELD_CONTEXT','Expected a scene bundle.','$');return result();}
  if(!inContext){diagnostics.push(...validateAssetJson(bundle));if(hasErrors(diagnostics))return result();diagnostics.push(...validateBundle({...bundle,sampledFields:input as SampledFieldProgram}));}
  if(!object(bundle.resources)){error('SAMPLED_FIELD_CONTEXT','Expected authored resources.','$.resources');return result();}
  diagnostics.push(...validateBakeRegistry(bundle.bakes));if(bundle.version!=='0.3')error('SAMPLED_FIELD_VERSION','Sampled fields require Bundle 0.3.','$.version');
  if(hasErrors(diagnostics))return result();
  const keys=(v:Record<string,unknown>,allowed:readonly string[],path:string)=>{for(const key of Object.keys(v))if(!allowed.includes(key))error('SAMPLED_FIELD_PROPERTY',`Unsupported property ${key}.`,path+'.'+key);};
  if(!object(input)){error('SAMPLED_FIELD_PROGRAM','Expected a versioned sampled field program.','$.sampledFields');return result();}
  keys(input,['version','operations'],'$.sampledFields');if(input.version!==1)error('SAMPLED_FIELD_VERSION','Supported sampled field version is 1.','$.sampledFields.version');
  if(!Array.isArray(input.operations)||input.operations.length>SAMPLED_FIELD_MAX_OPERATIONS){error('SAMPLED_FIELD_BUDGET','At most 16 sampled field operations.','$.sampledFields.operations');return result();}
  const available=meshAttributeValidationResources(bundle.meshAttributes,curveValidationResources(bundle.curves3d,surfaceValidationResources(bundle.surfaces,bundle.resources))),outputs=new Set(Object.keys(available)),ids=new Set<string>();let vertices=0;
  for(const [index,raw] of input.operations.entries()){
    const path=`$.sampledFields.operations[${index}]`,before=diagnostics.length;if(!object(raw)){error('SAMPLED_FIELD_OPERATION','Expected an operation.',path);continue;}
    keys(raw,['id','source','resourceId','bake','units','attributes','position','sourceSpan'],path);if(raw.sourceSpan!==undefined)diagnostics.push(...validateSourceSpan(raw.sourceSpan,path+'.sourceSpan'));const span=raw.sourceSpan as SourceSpan|undefined;
    if(!name(raw.id,256)||ids.has(raw.id))error('SAMPLED_FIELD_ID','Operation IDs must be unique and nonempty.',path+'.id',span);else ids.add(raw.id);
    if(!name(raw.resourceId)||outputs.has(raw.resourceId))error('SAMPLED_FIELD_RESOURCE','Output IDs must be new and unique.',path+'.resourceId',span);else outputs.add(raw.resourceId);
    const source=name(raw.source)&&Object.hasOwn(available,raw.source)?available[raw.source]:undefined,bake=name(raw.bake)&&Object.hasOwn(bundle.bakes??{},raw.bake)?bundle.bakes![raw.bake]:undefined;
    if(source?.kind!=='mesh')error('SAMPLED_FIELD_SOURCE','Source must be a mesh from an earlier phase or sampled operation.',path+'.source',span);
    if(!bake)error('SAMPLED_FIELD_BAKE','Reference an existing bake manifest.',path+'.bake',span);
    if(!units.includes(raw.units)||source?.kind==='mesh'&&source.units!==raw.units||bake&&bake.units!==raw.units)error('SAMPLED_FIELD_UNITS','Explicit units must match the source mesh and bake.',path+'.units',span);
    if(bake){vertices+=bake.topology.vertexCount;if(Object.hasOwn(bundle.resources,raw.source)&&source?.kind==='mesh')diagnostics.push(...validateBakeManifest(bake,source,path+'.bake'));}
    const originalAttributes=source?.kind==='mesh'?source.attributes?.values??{}:{},names=new Set(Object.keys(originalAttributes));
    let components=bake?Object.values(originalAttributes).reduce((n,a)=>n+attributeComponents(a.valueType)*(a.domain==='vertex'?bake.topology.vertexCount:a.domain==='face'?bake.topology.indices.length/3:bake.topology.indices.length),0):0;
    if(!Array.isArray(raw.attributes)||raw.attributes.length>MAX_MESH_ATTRIBUTES)error('SAMPLED_FIELD_ATTRIBUTES','Expected at most 32 named channel captures.',path+'.attributes',span);
    else for(const [i,a] of raw.attributes.entries()){
      const at=`${path}.attributes[${i}]`;if(!object(a)){error('SAMPLED_FIELD_ATTRIBUTE','Expected a channel and attribute name.',at,span);continue;}keys(a,['channel','name'],at);
      if(!attrName(a.name)||names.has(a.name))error('SAMPLED_FIELD_ATTRIBUTE','Capture requires a new safe attribute name.',at+'.name',span);else names.add(a.name);
      const channel=bake?.channels.find(c=>c.id===a.channel);if(!name(a.channel)||!channel)error('SAMPLED_FIELD_CHANNEL','Reference a declared channel.',at+'.channel',span);
      else components+=bake!.topology.vertexCount*(channel.kind==='scalar'?1:3);
    }
    if(names.size>MAX_MESH_ATTRIBUTES||components>MAX_MESH_ATTRIBUTE_COMPONENTS)error('SAMPLED_FIELD_BUDGET','At most 32 attributes and 262144 attribute components per mesh.',path+'.attributes',span);
    if(Array.isArray(raw.attributes)&&!raw.attributes.length&&raw.position===undefined)error('SAMPLED_FIELD_EMPTY','Capture an attribute or apply absolute positions.',path,span);
    if(raw.position!==undefined){if(!object(raw.position))error('SAMPLED_FIELD_POSITION','Expected explicit position options.',path+'.position',span);
      else {keys(raw.position,['channel','normalPolicy','degenerateNormalPolicy'],path+'.position');
        if(!name(raw.position.channel)||!bake?.channels.some(c=>c.id===raw.position.channel&&c.kind==='position'))error('SAMPLED_FIELD_CHANNEL','Position updates require a position channel.',path+'.position.channel',span);
        else if(bake.channels.find(c=>c.id===raw.position.channel)!.unit!==raw.units)error('SAMPLED_FIELD_UNITS','Absolute position channel units must match the declared mesh units; no implicit conversion.',path+'.position.channel',span);
        if(!['drop','recompute'].includes(raw.position.normalPolicy)||!['error','source'].includes(raw.position.degenerateNormalPolicy))error('SAMPLED_FIELD_NORMALS','Declare normalPolicy drop or recompute and degenerateNormalPolicy error or source.',path+'.position',span);}
    }
    if(diagnostics.length===before){entries.push(freezeSnapshot(raw as SampledFieldOperation));const virtual=sampledFieldValidationResources({version:1,operations:[raw]},available,bundle.bakes);Object.defineProperty(available,raw.resourceId,{value:virtual[raw.resourceId],enumerable:true,configurable:true});}
  }
  if(vertices>SAMPLED_FIELD_MAX_VERTICES)error('SAMPLED_FIELD_BUDGET','At most 65536 sampled vertices across the program.','$.sampledFields.operations');
  return result();
}
export function validateSampledFieldProgram(input:unknown,bundle:Bundle):Diagnostic[]{return inspect(input,bundle).diagnostics;}
/** @internal Bundle JSON and parameter declarations have already been checked. */
export function validateSampledFieldProgramInContext(input:unknown,bundle:Bundle):Diagnostic[]{return inspect(input,bundle,true).diagnostics;}
export function prepareSampledFieldProgram(input:SampledFieldProgram,bundle:Bundle,generatedResources?:Readonly<Record<string,DeepReadonly<Resource>>>):PreparedSampledFieldProgram{
  const {diagnostics,entries}=inspect(input,bundle);if(hasErrors(diagnostics))throw new OperationValidationError(diagnostics);
  const resolve=prepareParameterResolver(bundle.expressions?.parameters??{}),authored=freezeSnapshot(bundle.resources),bakes=Object.fromEntries([...new Set(entries.map(e=>e.bake))].map(id=>[id,prepareInlineBake(bundle.bakes![id])]));
  const supplied=(value:unknown):Readonly<Record<string,DeepReadonly<Resource>>>=>{const ds=validateAssetJson(value,'$.generatedResources');if(hasErrors(ds))throw new OperationValidationError(ds);if(!object(value))fail('SAMPLED_FIELD_CONTEXT','Expected generated resources.');return value as Readonly<Record<string,DeepReadonly<Resource>>>;};
  const defaults=freezeSnapshot(supplied(generatedResources??{})),surfaces=generatedResources===undefined&&bundle.surfaces?prepareSurfaceProgram(bundle.surfaces,bundle):undefined;
  const attributes=generatedResources===undefined&&bundle.meshAttributes?prepareMeshAttributeProgram(bundle.meshAttributes,bundle,{...surfaces?.baseResources}):undefined;
  const sample=(time:number,parameters?:Readonly<Record<string,ExpressionValue>>,generated?:Readonly<Record<string,DeepReadonly<Resource>>>):SampledFieldSample=>{
    if(!Number.isFinite(time))throw new RangeError('Sampled field time must be finite.');resolve(parameters);
    const surface=generated===undefined?surfaces?.sample(time,parameters):undefined,current=generated===undefined?{...defaults,...surface?.resources,...attributes?.sample(time,parameters,surface?.resources??{}).resources}:supplied(generated);
    const resources:Record<string,DeepReadonly<MeshResource>>=Object.create(null),reports:SampledFieldEvaluation=Object.create(null),bakeSamples=new Map<string,ReturnType<ReturnType<typeof prepareInlineBake>['sample']>>();let vertices=0;
    for(const [index,o] of entries.entries())try{
      const value=Object.hasOwn(resources,o.source)?resources[o.source]:Object.hasOwn(authored,o.source)?authored[o.source]:current[o.source];if(value?.kind!=='mesh')fail('SAMPLED_FIELD_SOURCE','Supply the declared source mesh.');
      const source=snapshotMeshResource(value),prepared=bakes[o.bake],errors=validateBakeManifest(prepared.manifest,source);if(hasErrors(errors))throw new OperationValidationError(errors);
      vertices+=source.positions.count;if(vertices>SAMPLED_FIELD_MAX_VERTICES)fail('SAMPLED_FIELD_BUDGET','More than 65536 sampled vertices.');
      let data=bakeSamples.get(o.bake);if(!data){data=prepared.sample(time);bakeSamples.set(o.bake,data);}
      const captures:Record<string,MeshAttribute>=Object.create(null),attributes:SampledFieldEvaluation[string]['attributes']=[];
      // Stored float32 endpoints interpolate in float64; do not quantize a second time.
      for(const a of o.attributes){const channel=data.channels[a.channel],valueType=channel.kind==='scalar'?'scalar':'vec3';captures[a.name]={domain:'vertex',valueType,buffer:buffer(channel.components,[...channel.values])};attributes.push({channel:a.channel,name:a.name,valueType,kind:channel.kind,unit:channel.unit});}
      let display=o.attributes.length?attachMeshAttributes(source,captures):source,position:SampledFieldEvaluation[string]['position'];
      if(o.position){const {channel,...options}=o.position,changed=replaceMeshPositions(display,data.channels[channel].values,options);display=changed.mesh;position={channel,normalOrigin:changed.normalOrigin,sourceNormalFallbacks:[...changed.sourceNormalFallbacks]};}
      resources[o.resourceId]=display;reports[o.id]={source:o.source,resourceId:o.resourceId,bake:o.bake,time:data.time,bracket:{...data.bracket},attributes,...(position?{position}:{}),
        provenance:{solver:prepared.manifest.solver as BakeManifest['solver'],seed:prepared.manifest.seed},interpolation:prepared.manifest.interpolation,outside:prepared.manifest.outside};
    }catch(cause){throw located(cause,`$.sampledFields.operations[${index}]`,o.sourceSpan);}
    return Object.freeze({resources:Object.freeze(resources),sampledFields:freezeSnapshot(reports)});
  };
  const base=sample(0);return Object.freeze({resourceIds:Object.freeze(entries.map(o=>o.resourceId)),baseResources:base.resources,sample});
}
