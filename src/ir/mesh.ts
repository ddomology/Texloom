import type {DeepReadonly, Diagnostic} from './operations.js';
import type {Bounds3D, Vec3} from '../geometry/matrix4.js';
import {freezeSnapshot} from '../operations/values.js';
import {validateAssetJson} from '../resources/package.js';
import {copyNumericBuffer,validateNumericBuffer,type NumericBuffer} from '../resources/buffers.js';

export type MeshBounds=Bounds3D;
export type MeshUnit='unit'|'m'|'cm'|'mm';
export interface MeshResource {
  kind:'mesh';version:1;primitive:'triangles';units:MeshUnit;coordinateSpace:'object';winding:'ccw';
  /** Authored topology identity, not a substitute for hashing the resource payload. */
  topologyRevision:string;
  positions:NumericBuffer;indices:NumericBuffer;normals?:NumericBuffer;
  /** Exact extrema of all converted positions; null only for a mesh with no vertices or indices. */
  bounds:Bounds3D|null;
  provenance?:Record<string,unknown>;
}
export interface OwnedMeshBuffers {
  positions:Float32Array|Float64Array;
  indices:Uint16Array|Uint32Array;
  normals?:Float32Array|Float64Array;
  bounds:DeepReadonly<Bounds3D>|null;
  triangleCount:number;
  /** Numerically degenerate triangles remain present in the buffers. */
  degenerateTriangles:readonly number[];
}
export class MeshError extends Error {
  readonly code:string;readonly diagnostics:DeepReadonly<Diagnostic[]>;
  constructor(diagnostics:readonly Diagnostic[]) {
    super(diagnostics.map(d=>`${d.code}: ${d.message} (${d.path??'$'})`).join('\n'));
    this.name='MeshError';this.code=diagnostics.find(d=>d.severity==='error')?.code??'MESH_INVALID';
    this.diagnostics=freezeSnapshot(diagnostics);
  }
}
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
const vec3=(v:unknown):v is Vec3=>Array.isArray(v)&&v.length===3&&v.every(finite);
const fatal=(out:Diagnostic[])=>out.some(d=>d.severity==='error');
export const MESH_NORMAL_TOLERANCE=1e-4;

function inspect(input:unknown,path:string):{diagnostics:Diagnostic[];buffers?:OwnedMeshBuffers} {
  const out=validateAssetJson(input,path);if(out.length)return {diagnostics:out};
  const fail=(code:string,message:string,where=path)=>out.push({severity:'error',code,message,path:where});
  if(!object(input)){fail('MESH_TYPE','Expected a mesh resource.');return {diagnostics:out};}
  for(const key of Object.keys(input))if(!['kind','version','primitive','units','coordinateSpace','winding','topologyRevision','positions','indices','normals','bounds','provenance'].includes(key))
    fail('MESH_PROPERTY',`Unsupported property ${key}.`,`${path}.${key}`);
  if(input.kind!=='mesh'||input.version!==1)fail('MESH_VERSION','Expected kind mesh and version 1.');
  if(input.primitive!=='triangles')fail('MESH_PRIMITIVE','Only indexed triangles are supported.',`${path}.primitive`);
  if(!['unit','m','cm','mm'].includes(input.units as string))fail('MESH_UNIT','Expected unit, m, cm or mm.',`${path}.units`);
  if(input.coordinateSpace!=='object')fail('MESH_SPACE','Mesh positions belong to object space.',`${path}.coordinateSpace`);
  if(input.winding!=='ccw')fail('MESH_WINDING','Triangle front faces use counterclockwise index order.',`${path}.winding`);
  if(typeof input.topologyRevision!=='string'||!input.topologyRevision.trim()||input.topologyRevision.length>512)
    fail('MESH_REVISION','topologyRevision requires 1–512 nonblank characters.',`${path}.topologyRevision`);
  if(input.provenance!==undefined&&!object(input.provenance))fail('MESH_PROVENANCE','Expected a JSON provenance object.',`${path}.provenance`);
  for(const name of ['positions','indices','normals'] as const){
    if(name==='normals'&&input[name]===undefined)continue;
    const diagnostics=validateNumericBuffer(input[name],`${path}.${name}`);out.push(...diagnostics);
    if(diagnostics.length)continue;
    const b=input[name] as unknown as NumericBuffer;
    if(name==='indices'){
      if(!['uint16','uint32'].includes(b.componentType)||b.components!==1||b.count%3!==0)
        fail('MESH_INDICES','Indices require uint16/uint32 scalars with a count divisible by three.',`${path}.${name}`);
    }else if(!['float32','float64'].includes(b.componentType)||b.components!==3)
      fail('MESH_ATTRIBUTE','Positions and normals require three float32/float64 components per vertex.',`${path}.${name}`);
  }
  if(fatal(out))return {diagnostics:out};
  const resource=input as unknown as MeshResource;
  if((resource.positions.count===0)!==(resource.indices.count===0))
    fail('MESH_EMPTY','An empty mesh has both zero vertices and zero indices.');
  if(resource.normals&&resource.normals.count!==resource.positions.count)
    fail('MESH_NORMAL_COUNT','Normals must have one element per vertex.',`${path}.normals.count`);
  if(resource.positions.count===0){
    if(resource.bounds!==null)fail('MESH_BOUNDS','Empty meshes require null bounds.',`${path}.bounds`);
  }else if(!object(resource.bounds)||Object.keys(resource.bounds).some(k=>!['min','max'].includes(k))||
    !vec3(resource.bounds.min)||!vec3(resource.bounds.max)||resource.bounds.min.some((n,i)=>n>resource.bounds!.max[i]))
    fail('MESH_BOUNDS','Bounds require ordered finite min/max 3D vectors.',`${path}.bounds`);
  if(fatal(out))return {diagnostics:out};
  const positions=copyNumericBuffer(resource.positions) as Float32Array|Float64Array;
  const indices=copyNumericBuffer(resource.indices) as Uint16Array|Uint32Array;
  const normals=resource.normals?copyNumericBuffer(resource.normals) as Float32Array|Float64Array:undefined;
  let bounds:Bounds3D|null=null;
  if(positions.length){
    bounds={min:[Infinity,Infinity,Infinity],max:[-Infinity,-Infinity,-Infinity]};
    for(let i=0;i<positions.length;i++){
      const axis=i%3;bounds.min[axis]=Math.min(bounds.min[axis],positions[i]);bounds.max[axis]=Math.max(bounds.max[axis],positions[i]);
    }
    if(bounds.min.some((n,i)=>n!==resource.bounds!.min[i])||bounds.max.some((n,i)=>n!==resource.bounds!.max[i]))
      fail('MESH_BOUNDS','Bounds must equal the extrema of all converted position components.',`${path}.bounds`);
  }
  if(normals)for(let i=0;i<normals.length;i+=3){
    const length=Math.hypot(normals[i],normals[i+1],normals[i+2]);
    if(!finite(length)||Math.abs(length-1)>MESH_NORMAL_TOLERANCE){
      fail('MESH_NORMAL','Normals must have unit length within 1e-4 after component conversion.',`${path}.normals.data`);break;
    }
  }
  for(let i=0;i<indices.length;i++)if(indices[i]>=resource.positions.count){
    fail('MESH_INDEX_RANGE','A triangle index is outside the position buffer.',`${path}.indices.data`);break;
  }
  if(fatal(out))return {diagnostics:out};
  const degenerateTriangles:number[]=[];
  for(let i=0;i<indices.length;i+=3){
    const a=indices[i]*3,b=indices[i+1]*3,c=indices[i+2]*3;
    // Subtract before scaling so a large shared translation does not erase small edges.
    // Half-coordinate subtraction is only needed when a finite endpoint difference overflows.
    // Numerical degeneracy does not establish manifoldness or outward orientation.
    const edge=(end:number)=>{
      let result=[0,1,2].map(k=>positions[end+k]-positions[a+k]);
      if(!result.every(Number.isFinite))result=[0,1,2].map(k=>positions[end+k]/2-positions[a+k]/2);
      const scale=Math.max(...result.map(Math.abs))||1;
      return result.map(n=>n/scale);
    };
    const ab=edge(b),ac=edge(c);
    const area=Math.hypot(ab[1]*ac[2]-ab[2]*ac[1],ab[2]*ac[0]-ab[0]*ac[2],ab[0]*ac[1]-ab[1]*ac[0]);
    if(area===0)degenerateTriangles.push(i/3);
  }
  if(degenerateTriangles.length)out.push({severity:'warning',code:'MESH_DEGENERATE',
    message:`${degenerateTriangles.length} numerically degenerate triangle(s) remain in the mesh.`,path:`${path}.indices`});
  return {diagnostics:out,buffers:Object.freeze({positions,indices,...(normals?{normals}:{}),
    bounds:bounds?freezeSnapshot(bounds):null,triangleCount:indices.length/3,degenerateTriangles:Object.freeze(degenerateTriangles)})};
}

export function validateMeshResource(input:unknown,path='$.mesh'):Diagnostic[] {return inspect(input,path).diagnostics;}
export function snapshotMeshResource(input:unknown,path='$.mesh'):DeepReadonly<MeshResource> {
  const {diagnostics}=inspect(input,path);if(fatal(diagnostics))throw new MeshError(diagnostics);
  return freezeSnapshot(input as MeshResource);
}
/** Array buffers are private to this call and intentionally writable; resource snapshots remain JSON-only. */
export function copyMeshBuffers(input:unknown,path='$.mesh'):OwnedMeshBuffers {
  const {diagnostics,buffers}=inspect(input,path);if(fatal(diagnostics))throw new MeshError(diagnostics);
  return buffers!;
}
