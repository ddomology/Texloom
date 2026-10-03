import {Matrix4} from 'three';
import type {EvaluatedInstanceBatch3D} from '../../ir/scene3d.js';
import type {MeshResource} from '../../ir/mesh.js';
import type {DeepReadonly} from '../../ir/operations.js';
import {GpuRenderError,finiteFloat32,validateGpuMatrix,validateGpuOrientation,validateGpuTransformBounds} from './data.js';

export interface GpuInstanceRun {
  reflected:boolean;count:number;matrices:Float32Array;colors:Float32Array;sourceIds:readonly string[];
}
export const GPU_INSTANCE_BYTES=19*4;
/** Preserve submission order, splitting only where Three's object-level front-face state changes.
 * R * (R * modelView) = modelView for R=diag(-1,1,1,1). The reflection on the
 * outer object supplies culling state; the inner upload retains the authoritative camera matrix.
 */
export function prepareGpuInstanceRuns(batch:DeepReadonly<EvaluatedInstanceBatch3D>,resource:DeepReadonly<MeshResource>,projection:readonly number[]):GpuInstanceRun[]{
  if(!Array.isArray(batch.instances)||batch.instances.length>4096)throw new GpuRenderError('GPU_BUDGET','At most 4096 instance records are supported.');
  const ids=new Set<string>(),groups:{reflected:boolean;items:typeof batch.instances[number][]}[]=[];
  for(const item of batch.instances){
    if(!item||typeof item.id!=='string'||!item.id.trim()||ids.has(item.id)||typeof item.selected!=='boolean')throw new GpuRenderError('GPU_INSTANCE','Instance records require unique IDs and explicit boolean selection.');
    ids.add(item.id);
    if(!Array.isArray(item.color)||item.color.length!==3||item.color.some((n:number)=>!Number.isFinite(n)||n<0||n>1))throw new GpuRenderError('GPU_COLOR','Instance colors require three linear RGB components in [0,1].');
    if(!item.selected)continue;
    validateGpuMatrix(item.worldMatrix,'instance world');validateGpuMatrix(item.modelViewMatrix,'instance model view');
    validateGpuOrientation(item.worldMatrix,item.orientation);
    if(Math.sign(new Matrix4().fromArray(item.worldMatrix).determinantAffine())!==item.orientation)throw new GpuRenderError('GPU_PRECISION','Backend determinant arithmetic cannot retain the evaluated front-face orientation.');
    validateGpuTransformBounds(resource.bounds,item.modelViewMatrix,projection);
    const reflected=item.orientation<0;
    if(!groups.length||groups.at(-1)!.reflected!==reflected)groups.push({reflected,items:[]});
    groups.at(-1)!.items.push(item);
  }
  return groups.map(({reflected,items})=>{
    const matrices=new Float32Array(items.length*16),colors=new Float32Array(items.length*3);
    items.forEach((item,i)=>{
      item.modelViewMatrix!.forEach((n:number,j:number)=>{matrices[i*16+j]=finiteFloat32(reflected&&j%4===0?-n:n,'instance model view');});
      item.color.forEach((n:number,j:number)=>{colors[i*3+j]=finiteFloat32(n,'instance color');});
    });
    return {reflected,count:items.length,matrices,colors,sourceIds:items.map(item=>item.id)};
  });
}
