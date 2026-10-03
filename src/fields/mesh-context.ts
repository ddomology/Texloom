import type {DeepReadonly} from '../ir/operations.js';
import type {Vec3} from '../geometry/matrix4.js';
import {copyMeshBuffers,snapshotMeshResource,type MeshResource} from '../ir/mesh.js';
import {MeshAttributeError,type AttributeDomain,type MeshAttributeTopology} from '../ir/attributes.js';
import {freezeSnapshot} from '../operations/values.js';

export interface MeshFieldElement {
  index:number;
  position:Vec3;
  originalPosition:Vec3;
  /** A face lists its three vertices; vertex/corner lists the single addressed vertex. */
  vertexIndices:number[];
  faceIndex?:number;
  /** Global triangle-corner ordinal, not the referenced vertex index. */
  cornerIndex?:number;
}
export interface MeshFieldContext {
  domain:AttributeDomain;
  time:number;
  topology:MeshAttributeTopology;
  elements:MeshFieldElement[];
}
const fail=(code:string,message:string):never=>{throw new MeshAttributeError([{severity:'error',code,message,path:'$.meshContext'}]);};
/** Stable means avoid overflow of the sum when all coordinates themselves are finite. */
export function meshComponentMean(values:readonly number[]):number {
  if(!values.length)return 0;
  let scale=0;for(const value of values)scale=Math.max(scale,Math.abs(value));
  if(scale===0)return 0;
  let sum=0,correction=0;
  for(const value of values){const term=value/scale/values.length-correction,next=sum+term;correction=(next-sum)-term;sum=next;}
  return Math.max(-1,Math.min(1,sum))*scale;
}
/** Current and original geometry must share exact converted index order, revision, units and vertex count. */
export function createMeshFieldContext(original:DeepReadonly<MeshResource>,current:DeepReadonly<MeshResource>,domain:AttributeDomain,time=0):DeepReadonly<MeshFieldContext>{
  if(!['vertex','face','corner'].includes(domain))fail('ATTRIBUTE_DOMAIN','Expected vertex, face or corner.');
  if(typeof time!=='number'||!Number.isFinite(time))fail('ATTRIBUTE_TIME','Context time must be finite.');
  const base=snapshotMeshResource(original),now=snapshotMeshResource(current),a=copyMeshBuffers(base),b=copyMeshBuffers(now);
  if(base.units!==now.units)fail('ATTRIBUTE_UNITS','Original and current mesh contexts must use the same explicit units.');
  if(base.topologyRevision!==now.topologyRevision||a.positions.length!==b.positions.length||a.indices.length!==b.indices.length||a.indices.some((value,i)=>value!==b.indices[i]))
    fail('ATTRIBUTE_TOPOLOGY','Original and current meshes require the same revision, vertex count and ordered converted indices.');
  const point=(positions:Float32Array|Float64Array,indices:readonly number[]):Vec3=>[0,1,2].map(axis=>meshComponentMean(indices.map(index=>positions[3*index+axis]))) as Vec3;
  const elements:MeshFieldElement[]=[];
  const count=domain==='vertex'?now.positions.count:domain==='face'?b.triangleCount:b.indices.length;
  for(let index=0;index<count;index++){
    const vertexIndices=domain==='vertex'?[index]:domain==='face'?Array.from(b.indices.slice(index*3,index*3+3)):[b.indices[index]];
    elements.push({index,position:point(b.positions,vertexIndices),originalPosition:point(a.positions,vertexIndices),vertexIndices,
      ...(domain==='face'?{faceIndex:index}:domain==='corner'?{faceIndex:Math.floor(index/3),cornerIndex:index}:{})});
  }
  return freezeSnapshot({domain,time,topology:{revision:now.topologyRevision,vertexCount:now.positions.count,indices:Array.from(b.indices)},elements});
}
