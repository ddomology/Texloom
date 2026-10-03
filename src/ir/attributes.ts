import type {DeepReadonly,Diagnostic} from './operations.js';
import type {MeshResource} from './mesh.js';
import {snapshotMeshResource} from './mesh.js';
import {freezeSnapshot} from '../operations/values.js';
import {validateAssetJson} from '../resources/package.js';
import {copyNumericBuffer,validateNumericBuffer,type NumericBuffer} from '../resources/buffers.js';

export type AttributeDomain='vertex'|'face'|'corner';
export type AttributeValueType='scalar'|'vec2'|'vec3'|'color';
export interface MeshAttribute {domain:AttributeDomain;valueType:AttributeValueType;buffer:NumericBuffer}
/** Coordinates may change; index order, vertex count and explicit revision must remain identical. */
export interface MeshAttributeTopology {revision:string;vertexCount:number;indices:number[]}
export interface MeshAttributeCollection {version:1;topology:MeshAttributeTopology;values:Record<string,MeshAttribute>}
export interface OwnedMeshAttribute {domain:AttributeDomain;valueType:AttributeValueType;values:Float32Array|Float64Array}
export const MAX_MESH_ATTRIBUTES=32;
export const MAX_MESH_ATTRIBUTE_COMPONENTS=262_144;
export class MeshAttributeError extends Error {
  readonly code:string;readonly diagnostics:DeepReadonly<Diagnostic[]>;
  constructor(diagnostics:readonly Diagnostic[]){
    super(diagnostics.map(d=>`${d.code}: ${d.message} (${d.path??'$'})`).join('\n'));
    this.name='MeshAttributeError';this.code=diagnostics.find(d=>d.severity==='error')?.code??'ATTRIBUTE_INVALID';
    this.diagnostics=freezeSnapshot(diagnostics);
  }
}
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const fatal=(ds:readonly Diagnostic[])=>ds.some(d=>d.severity==='error');
export const attributeComponents=(type:AttributeValueType):1|2|3=>type==='scalar'?1:type==='vec2'?2:3;
export function meshDomainCount(topology:DeepReadonly<MeshAttributeTopology>,domain:AttributeDomain):number {
  return domain==='vertex'?topology.vertexCount:domain==='face'?topology.indices.length/3:topology.indices.length;
}
function topologyDiagnostics(input:unknown,path:string):Diagnostic[]{
  const out:Diagnostic[]=[];const fail=(message:string,where=path)=>out.push({severity:'error' as const,code:'ATTRIBUTE_TOPOLOGY',message,path:where});
  if(!object(input)){fail('Expected an exact mesh topology snapshot.');return out;}
  for(const k of Object.keys(input))if(!['revision','vertexCount','indices'].includes(k))fail(`Unsupported topology property ${k}.`,`${path}.${k}`);
  if(typeof input.revision!=='string'||!input.revision.trim()||input.revision.length>512)fail('Expected a nonblank topology revision with at most 512 characters.');
  if(!Number.isSafeInteger(input.vertexCount)||(input.vertexCount as number)<0||(input.vertexCount as number)>262_144/3)fail('Invalid vertex count.');
  if(!Array.isArray(input.indices)||input.indices.length%3||input.indices.length>262_144)fail('Expected at most 262144 triangle indices.');
  else if(input.indices.some(n=>!Number.isSafeInteger(n)||n<0||n>=(input.vertexCount as number)))fail('An index is outside this topology.');
  return out;
}

/** Validate a collection against a separately supplied topology, never by array length alone. */
export function validateMeshAttributeCollection(input:unknown,topology:DeepReadonly<MeshAttributeTopology>,path='$.attributes'):Diagnostic[]{
  const out=[...validateAssetJson(input,path),...validateAssetJson(topology,'$.topology')];if(fatal(out))return out;
  out.push(...topologyDiagnostics(topology,'$.topology'));if(fatal(out))return out;
  const fail=(code:string,message:string,where=path)=>out.push({severity:'error' as const,code,message,path:where});
  if(!object(input)){fail('ATTRIBUTE_COLLECTION','Expected a versioned attribute collection.');return out;}
  for(const k of Object.keys(input))if(!['version','topology','values'].includes(k))fail('ATTRIBUTE_PROPERTY',`Unsupported property ${k}.`,`${path}.${k}`);
  if(input.version!==1)fail('ATTRIBUTE_VERSION','Supported attribute collection version is 1.',`${path}.version`);
  out.push(...topologyDiagnostics(input.topology,`${path}.topology`));
  if(!fatal(out)){
    const actual=input.topology as unknown as MeshAttributeTopology;
    if(actual.revision!==topology.revision||actual.vertexCount!==topology.vertexCount||actual.indices.length!==topology.indices.length||
      actual.indices.some((value,i)=>value!==topology.indices[i]))fail('ATTRIBUTE_TOPOLOGY','Captured attributes require the same revision, vertex count and ordered converted indices.',`${path}.topology`);
  }
  if(!object(input.values)){fail('ATTRIBUTE_VALUES','Expected a named attribute record.',`${path}.values`);return out;}
  const entries=Object.entries(input.values);if(entries.length>MAX_MESH_ATTRIBUTES){fail('ATTRIBUTE_LIMIT',`At most ${MAX_MESH_ATTRIBUTES} named attributes are supported.`);return out;}
  let components=0;
  for(const [name,value] of entries){
    const p=`${path}.values[${JSON.stringify(name)}]`;
    if(!/^[A-Za-z_][A-Za-z0-9_.:-]{0,511}$/.test(name)||['__proto__','constructor','prototype'].includes(name))fail('ATTRIBUTE_NAME','Expected a safe literal attribute name of at most 512 characters.',p);
    if(!object(value)){fail('ATTRIBUTE_VALUE','Expected a typed domain attribute.',p);continue;}
    for(const k of Object.keys(value))if(!['domain','valueType','buffer'].includes(k))fail('ATTRIBUTE_PROPERTY',`Unsupported property ${k}.`,`${p}.${k}`);
    const domainValid=['vertex','face','corner'].includes(value.domain as string),typeValid=['scalar','vec2','vec3','color'].includes(value.valueType as string);
    if(!domainValid)fail('ATTRIBUTE_DOMAIN','Expected vertex, face or corner domain.',`${p}.domain`);
    if(!typeValid)fail('ATTRIBUTE_TYPE','Expected scalar, vec2, vec3 or color.',`${p}.valueType`);
    const bufferDiagnostics=validateNumericBuffer(value.buffer,`${p}.buffer`);out.push(...bufferDiagnostics);
    if(bufferDiagnostics.length)continue;
    const buffer=value.buffer as unknown as NumericBuffer;components+=buffer.data.length;
    if(components>MAX_MESH_ATTRIBUTE_COMPONENTS){fail('ATTRIBUTE_LIMIT',`Attribute backing arrays exceed ${MAX_MESH_ATTRIBUTE_COMPONENTS} total components.`);return out;}
    if(!['float32','float64'].includes(buffer.componentType))fail('ATTRIBUTE_COMPONENT_TYPE','Attributes require float32 or float64 components.',`${p}.buffer.componentType`);
    if(typeValid&&buffer.components!==attributeComponents(value.valueType as AttributeValueType))fail('ATTRIBUTE_COMPONENTS','Buffer component count must match the declared value type.',`${p}.buffer.components`);
    if(domainValid&&buffer.count!==meshDomainCount(topology,value.domain as AttributeDomain))fail('ATTRIBUTE_COUNT','Buffer count must match its explicit mesh domain.',`${p}.buffer.count`);
    if(value.valueType==='color'){
      const values=copyNumericBuffer(buffer);
      if(values.some(n=>n<0||n>1))fail('ATTRIBUTE_COLOR','Color components are linear-sRGB triples in [0,1].',`${p}.buffer.data`);
    }
  }
  return out;
}

export function meshAttributeTopology(mesh:DeepReadonly<MeshResource>):DeepReadonly<MeshAttributeTopology>{
  // Validation of the mesh itself is independent of the optional captured collection.
  const checked=snapshotMeshResource(mesh);
  return freezeSnapshot({revision:checked.topologyRevision,vertexCount:checked.positions.count,indices:Array.from(copyNumericBuffer(checked.indices))});
}
/** Every numeric array is newly allocated and intentionally writable by its caller. */
export function copyMeshAttributeCollection(collection:DeepReadonly<MeshAttributeCollection>,topology:DeepReadonly<MeshAttributeTopology>):Record<string,OwnedMeshAttribute>{
  const diagnostics=validateMeshAttributeCollection(collection,topology);if(fatal(diagnostics))throw new MeshAttributeError(diagnostics);
  return Object.fromEntries(Object.entries(collection.values).map(([name,attribute])=>[name,{domain:attribute.domain,valueType:attribute.valueType,
    values:copyNumericBuffer(attribute.buffer) as Float32Array|Float64Array}]));
}
export function copyMeshAttribute(mesh:DeepReadonly<MeshResource>,name:string):Float32Array|Float64Array{
  const checked=snapshotMeshResource(mesh);
  if(typeof name!=='string'||!checked.attributes||!Object.hasOwn(checked.attributes.values,name))
    throw new MeshAttributeError([{severity:'error',code:'ATTRIBUTE_MISSING',message:'The requested named attribute does not exist.',path:'$.attributes.values'}]);
  return copyNumericBuffer(checked.attributes.values[name].buffer) as Float32Array|Float64Array;
}
/** Captures are detached immutable resource data. Overwriting a name requires explicit replace:true. */
export function attachMeshAttributes(mesh:DeepReadonly<MeshResource>,values:DeepReadonly<Record<string,MeshAttribute>>,options:{replace?:boolean}={}):DeepReadonly<MeshResource>{
  const ds=[...validateAssetJson(values,'$.values'),...validateAssetJson(options,'$.options')];if(fatal(ds))throw new MeshAttributeError(ds);
  if(!object(options)||Object.keys(options).some(k=>k!=='replace')||(options.replace!==undefined&&typeof options.replace!=='boolean'))
    throw new MeshAttributeError([{severity:'error',code:'ATTRIBUTE_OPTIONS',message:'Only an optional boolean replace flag is supported.',path:'$.options'}]);
  if(!object(values))throw new MeshAttributeError([{severity:'error',code:'ATTRIBUTE_VALUES',message:'Expected a named attribute record.',path:'$.values'}]);
  const checked=snapshotMeshResource(mesh);const prior=checked.attributes?.values??{};
  if(!options.replace&&Object.keys(values).some(k=>Object.hasOwn(prior,k)))throw new MeshAttributeError([{severity:'error',code:'ATTRIBUTE_EXISTS',message:'Replacing a captured name requires replace:true.',path:'$.values'}]);
  const collection={version:1 as const,topology:{revision:checked.topologyRevision,vertexCount:checked.positions.count,indices:Array.from(copyNumericBuffer(checked.indices))},values:{...prior,...values}};
  return snapshotMeshResource({...checked,attributes:collection});
}
