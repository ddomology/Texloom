import type {DeepReadonly} from '../ir/operations.js';
import {copyMeshBuffers,snapshotMeshResource,type MeshResource} from '../ir/mesh.js';
import {attributeComponents,meshDomainCount,MeshAttributeError,type AttributeDomain,type MeshAttribute} from '../ir/attributes.js';
import {copyNumericBuffer,MAX_BUFFER_COMPONENTS} from '../resources/buffers.js';
import {validateAssetJson} from '../resources/package.js';
import {freezeSnapshot} from './values.js';
import {meshComponentMean} from '../fields/mesh-context.js';

export interface MeshDomainTransferOptions {
  to:AttributeDomain;
  method:'mean'|'uniform'|'area-weighted'|'promote';
  /** A destination vertex with no contributing corners/faces defaults to an error. */
  orphan?:'error'|'zero';
  /** Relevant only to area-weighted transfer; zero-area faces default to an error. */
  zeroArea?:'error'|'ignore';
}
const fail=(code:string,message:string):never=>{throw new MeshAttributeError([{severity:'error',code,message,path:'$.transfer'}]);};
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);

/** Log-area lets relative area weights remain finite even when physical triangle areas overflow. */
function logTriangleArea(positions:Float32Array|Float64Array,indices:Uint16Array|Uint32Array,face:number):number{
  const a=indices[3*face]*3,b=indices[3*face+1]*3,c=indices[3*face+2]*3;
  const edge=(end:number)=>{
    let v=[0,1,2].map(axis=>positions[end+axis]-positions[a+axis]),logScale=0;
    if(!v.every(Number.isFinite)){v=[0,1,2].map(axis=>positions[end+axis]/2-positions[a+axis]/2);logScale=Math.LN2;}
    return {v,logScale};
  };
  const first=edge(b),second=edge(c),cross=(u:number[],v:number[])=>[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];
  const raw=cross(first.v,second.v),rawScale=Math.max(...raw.map(Math.abs));
  if(Number.isFinite(rawScale)&&rawScale>0)return Math.log(rawScale)+Math.log(Math.hypot(...raw.map(n=>n/rawScale)))+first.logScale+second.logScale-Math.LN2;
  const p=Math.max(...first.v.map(Math.abs)),q=Math.max(...second.v.map(Math.abs));
  if(p===0||q===0)return -Infinity;
  const normalized=cross(first.v.map(n=>n/p),second.v.map(n=>n/q)),length=Math.hypot(...normalized);
  if(length===0)return -Infinity;
  return Math.log(length)+Math.log(p)+Math.log(q)+first.logScale+second.logScale-Math.LN2;
}
function weightedMean(values:readonly number[],logs:readonly number[]):number{
  let maximum=-Infinity,scale=0;for(let i=0;i<values.length;i++){maximum=Math.max(maximum,logs[i]);scale=Math.max(scale,Math.abs(values[i]));}
  if(scale===0)return 0;
  // A tiny weight may have a representable contribution when its value is huge.
  // Combine their logarithms before exponentiation instead of underflowing the
  // weight (or value/scale) on its own.
  let denominator=0,largestTerm=-Infinity;
  const terms=values.map((value,i)=>value===0?-Infinity:Math.log(Math.abs(value))+logs[i]-maximum);
  for(let i=0;i<values.length;i++){denominator+=Math.exp(logs[i]-maximum);largestTerm=Math.max(largestTerm,terms[i]);}
  let numerator=0,correction=0;
  for(let i=0;i<values.length;i++){
    if(terms[i]===-Infinity)continue;
    const term=Math.sign(values[i])*Math.exp(terms[i]-largestTerm)-correction,next=numerator+term;correction=(next-numerator)-term;numerator=next;
  }
  if(numerator===0)return 0;
  const magnitude=Math.exp(Math.min(Math.log(scale),largestTerm+Math.log(Math.abs(numerator))-Math.log(denominator)));
  return Math.sign(numerator)*Math.min(scale,magnitude);
}
/** Only the explicitly registered domain conversions below are supported; no inferred interpolation. */
export function transferMeshAttribute(mesh:DeepReadonly<MeshResource>,name:string,options:DeepReadonly<MeshDomainTransferOptions>):DeepReadonly<MeshAttribute>{
  const diagnostics=validateAssetJson(options,'$.transfer');if(diagnostics.length)throw new MeshAttributeError(diagnostics);
  if(!object(options)||Object.keys(options).some(key=>!['to','method','orphan','zeroArea'].includes(key))||
    !['vertex','face','corner'].includes(options.to as string)||!['mean','uniform','area-weighted','promote'].includes(options.method as string)||
    (options.orphan!==undefined&&!['error','zero'].includes(options.orphan))||(options.zeroArea!==undefined&&!['error','ignore'].includes(options.zeroArea)))
    fail('ATTRIBUTE_TRANSFER','Invalid explicit domain transfer options.');
  const resource=snapshotMeshResource(mesh),buffers=copyMeshBuffers(resource);
  if(typeof name!=='string'||!resource.attributes||!Object.hasOwn(resource.attributes.values,name))fail('ATTRIBUTE_MISSING','The requested source attribute does not exist.');
  const source=resource.attributes!.values[name],to=options.to,method=options.method;
  const supported=(source.domain==='vertex'&&to==='face'&&method==='mean')||
    (source.domain==='face'&&to==='vertex'&&['uniform','area-weighted'].includes(method))||
    (['vertex','face'].includes(source.domain)&&to==='corner'&&method==='promote')||
    (source.domain==='corner'&&['vertex','face'].includes(to)&&method==='mean');
  if(!supported)fail('ATTRIBUTE_TRANSFER','This source domain, destination domain and method are not a registered conversion.');
  if(options.zeroArea!==undefined&&method!=='area-weighted')fail('ATTRIBUTE_TRANSFER','zeroArea is only meaningful for area-weighted transfer.');
  if(options.orphan!==undefined&&to!=='vertex')fail('ATTRIBUTE_TRANSFER','orphan is only meaningful for transfers to vertices.');
  const components=attributeComponents(source.valueType),input=copyNumericBuffer(source.buffer),topology=resource.attributes!.topology;
  const count=meshDomainCount(topology,to);
  if(count*components>MAX_BUFFER_COMPONENTS)fail('ATTRIBUTE_LIMIT',`Transferred buffer exceeds ${MAX_BUFFER_COMPONENTS} components.`);
  const groups:number[][]=Array.from({length:count},()=>[]);
  if(to==='face')for(let face=0;face<buffers.triangleCount;face++)groups[face]=[0,1,2].map(corner=>source.domain==='vertex'?buffers.indices[3*face+corner]:3*face+corner);
  else if(to==='corner')for(let corner=0;corner<buffers.indices.length;corner++)groups[corner]=[source.domain==='vertex'?buffers.indices[corner]:Math.floor(corner/3)];
  else for(let face=0;face<buffers.triangleCount;face++){
    if(source.domain==='face')for(const vertex of new Set(buffers.indices.slice(3*face,3*face+3)))groups[vertex].push(face);
    else for(let corner=0;corner<3;corner++)groups[buffers.indices[3*face+corner]].push(3*face+corner);
  }
  const areas=method==='area-weighted'?Array.from({length:buffers.triangleCount},(_,face)=>logTriangleArea(buffers.positions,buffers.indices,face)):undefined;
  if(areas?.some(value=>value===-Infinity)&&options.zeroArea!=='ignore')fail('ATTRIBUTE_ZERO_AREA','Area-weighted transfer encountered a zero-area triangle; choose zeroArea:ignore explicitly to exclude it.');
  const data:number[]=[];
  for(let index=0;index<count;index++){
    const group=areas?groups[index].filter(face=>areas[face]!==-Infinity):groups[index];
    if(group.length===0&&options.orphan!=='zero')fail('ATTRIBUTE_ORPHAN','A destination vertex has no contributing values; choose orphan:zero explicitly.');
    for(let component=0;component<components;component++){
      const values=group.map(element=>input[element*components+component]);
      const value=values.length===0?0:areas?weightedMean(values,group.map(face=>areas[face])):meshComponentMean(values);
      if(!Number.isFinite(value))fail('ATTRIBUTE_RANGE','Transferred components must remain finite.');
      // Computation is float64. The returned descriptor makes the conversion explicit.
      data.push(value);
    }
  }
  return freezeSnapshot({domain:to,valueType:source.valueType,buffer:{version:1,componentType:'float64',components,count,byteOffset:0,byteStride:components*8,data}});
}
