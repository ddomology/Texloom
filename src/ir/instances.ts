import type {DeepReadonly,Diagnostic} from './operations.js';
import {snapshotMeshResource,validateMeshResource,type MeshResource,type MeshUnit} from './mesh.js';
import {composeTransform3D,transformPoint3D,validateTransform3D,type Transform3D,type Vec3,type Bounds3D} from '../geometry/matrix4.js';
import {copyNumericBuffer} from '../resources/buffers.js';
import {validateAssetJson} from '../resources/package.js';
import {freezeSnapshot} from '../operations/values.js';

export interface Instance3D {
  /** Stable authored element identity; array position is not a substitute for this ID. */
  id:string;
  transform?:Transform3D;
  /** Linear-sRGB components. The default is white. */
  color?:Vec3;
  /** False keeps the record and identity but excludes it from selected-only consumption. */
  selected?:boolean;
}
/** Prototype geometry is resolved by the consumer, never duplicated inside this set. */
export interface InstanceSet3D {version:1;prototypeResourceId:string;units:MeshUnit;instances:Instance3D[]}
export type InstanceSelection='selected'|'all';
export interface InstanceBoundsOptions {selection?:InstanceSelection}
export const MAX_INSTANCES_PER_SET=4096;
export const MAX_INSTANCE_BOUND_VERTICES=4_000_000;
export class InstanceSetError extends Error {
  readonly code:string;readonly diagnostics:DeepReadonly<Diagnostic[]>;
  constructor(diagnostics:readonly Diagnostic[]){
    super(diagnostics.map(d=>`${d.code}: ${d.message} (${d.path??'$'})`).join('\n'));
    this.name='InstanceSetError';this.code=diagnostics.find(d=>d.severity==='error')?.code??'INSTANCE_INVALID';this.diagnostics=freezeSnapshot(diagnostics);
  }
}
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const name=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=512&&v.trim()===v;
const fatal=(ds:readonly Diagnostic[])=>ds.some(d=>d.severity==='error');

export function validateInstanceSet3D(input:unknown,prototype?:DeepReadonly<MeshResource>,path='$.instanceSet'):Diagnostic[]{
  const out=validateAssetJson(input,path);if(fatal(out))return out;
  const fail=(code:string,message:string,where=path)=>out.push({severity:'error' as const,code,message,path:where});
  if(!object(input)){fail('INSTANCE_SET','Expected an instance set.');return out;}
  for(const key of Object.keys(input))if(!['version','prototypeResourceId','units','instances'].includes(key))fail('INSTANCE_PROPERTY',`Unsupported property ${key}.`,`${path}.${key}`);
  if(input.version!==1)fail('INSTANCE_VERSION','Supported instance-set version is 1.',`${path}.version`);
  if(!name(input.prototypeResourceId))fail('INSTANCE_PROTOTYPE','Expected a literal prototype resource ID of at most 512 characters.',`${path}.prototypeResourceId`);
  if(!['unit','m','cm','mm'].includes(input.units as string))fail('INSTANCE_UNITS','Expected explicit unit, m, cm or mm.',`${path}.units`);
  if(!Array.isArray(input.instances)||input.instances.length>MAX_INSTANCES_PER_SET){fail('INSTANCE_LIMIT',`Expected at most ${MAX_INSTANCES_PER_SET} instance records.`,`${path}.instances`);return out;}
  const ids=new Set<string>();
  input.instances.forEach((value,index)=>{
    const p=`${path}.instances[${index}]`;
    if(!object(value)){fail('INSTANCE_RECORD','Expected an instance record.',p);return;}
    for(const key of Object.keys(value))if(!['id','transform','color','selected'].includes(key))fail('INSTANCE_PROPERTY',`Unsupported property ${key}.`,`${p}.${key}`);
    if(!name(value.id)||ids.has(value.id as string))fail('INSTANCE_ID','Instance IDs must be unique nonblank literals of at most 512 characters.',`${p}.id`);else ids.add(value.id);
    if(value.transform!==undefined)out.push(...validateTransform3D(value.transform,`${p}.transform`));
    if(value.color!==undefined&&(!Array.isArray(value.color)||value.color.length!==3||value.color.some(v=>typeof v!=='number'||!Number.isFinite(v)||v<0||v>1)))
      fail('INSTANCE_COLOR','Expected a linear-sRGB triple in [0,1].',`${p}.color`);
    if(value.selected!==undefined&&typeof value.selected!=='boolean')fail('INSTANCE_SELECTION','selected must be a boolean.',`${p}.selected`);
  });
  if(prototype!==undefined){
    const errors=validateMeshResource(prototype,'$.prototype');out.push(...errors);
    if(!fatal(errors)&&prototype.units!==input.units)fail('INSTANCE_UNIT_MISMATCH','Instance set and prototype mesh must use identical explicit units.',`${path}.units`);
  }
  return out;
}
export function snapshotInstanceSet3D(input:unknown,prototype?:DeepReadonly<MeshResource>,path='$.instanceSet'):DeepReadonly<InstanceSet3D>{
  const diagnostics=validateInstanceSet3D(input,prototype,path);if(fatal(diagnostics))throw new InstanceSetError(diagnostics);
  return freezeSnapshot(input as InstanceSet3D);
}
/** Exact extrema of transformed prototype vertices, including unreferenced vertices; null means no selected geometry. */
export function exactInstanceSetBounds(set:DeepReadonly<InstanceSet3D>,prototype:DeepReadonly<MeshResource>,options:InstanceBoundsOptions={}):DeepReadonly<Bounds3D>|null{
  const errors=validateAssetJson(options,'$.options');if(errors.length)throw new InstanceSetError(errors);
  if(!object(options)||Object.keys(options).some(k=>k!=='selection')||options.selection!==undefined&&options.selection!=='selected'&&options.selection!=='all')
    throw new InstanceSetError([{severity:'error',code:'INSTANCE_OPTIONS',message:'Expected an optional selected/all selection policy.',path:'$.options'}]);
  const frozen=snapshotInstanceSet3D(set,prototype),mesh=snapshotMeshResource(prototype);
  const records=frozen.instances.filter(instance=>options.selection==='all'||instance.selected!==false);
  if(records.length*mesh.positions.count>MAX_INSTANCE_BOUND_VERTICES)throw new InstanceSetError([{severity:'error',code:'INSTANCE_BOUND_BUDGET',message:`Exact bounds exceed ${MAX_INSTANCE_BOUND_VERTICES} transformed vertex visits.`,path:'$.instanceSet'}]);
  if(!records.length||!mesh.positions.count)return null;
  const positions=copyNumericBuffer(mesh.positions),bounds:Bounds3D={min:[Infinity,Infinity,Infinity],max:[-Infinity,-Infinity,-Infinity]};
  for(const instance of records){const matrix=composeTransform3D(instance.transform);
    for(let i=0;i<positions.length;i+=3){const point=transformPoint3D(matrix,[positions[i],positions[i+1],positions[i+2]]);
      for(let axis=0;axis<3;axis++){bounds.min[axis]=Math.min(bounds.min[axis],point[axis]);bounds.max[axis]=Math.max(bounds.max[axis],point[axis]);}}
  }
  return freezeSnapshot(bounds);
}
