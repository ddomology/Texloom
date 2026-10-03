import {copyMeshBuffers,type MeshResource} from '../../ir/mesh.js';
import type {MeshAttribute} from '../../ir/attributes.js';
import type {DeepReadonly} from '../../ir/operations.js';
import {orientationMatrix4,type Matrix4} from '../../geometry/matrix4.js';

export class GpuRenderError extends Error {
  constructor(readonly code:string,message:string){super(`${code}: ${message}`);this.name='GpuRenderError';}
}
export const MAX_GPU_DIMENSION=4096;
export const MAX_GPU_PIXELS=16_777_216;
export const MAX_GPU_BUFFER_BYTES=128*1024*1024;
export const MAX_GPU_TRIANGLES=1_000_000;

export function validateGpuSize(width:number,height:number):void {
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||
    width>MAX_GPU_DIMENSION||height>MAX_GPU_DIMENSION||width*height>MAX_GPU_PIXELS)
    throw new GpuRenderError('GPU_SIZE',`Output dimensions must be integers in [1,${MAX_GPU_DIMENSION}] and at most ${MAX_GPU_PIXELS} pixels.`);
}
export function validateGpuColor(value:unknown,transparent=false):asserts value is string {
  if(typeof value!=='string'||!(transparent&&value==='transparent')&&!/^#[0-9a-f]{6}$/i.test(value))
    throw new GpuRenderError('GPU_COLOR',`Expected ${transparent?'transparent or ':''}an opaque #rrggbb color.`);
}
export function finiteFloat32(value:number,label:string):number {
  const converted=Math.fround(value);
  if(!Number.isFinite(value)||!Number.isFinite(converted)||(value!==0&&converted===0))
    throw new GpuRenderError('GPU_PRECISION',`${label} cannot be represented as a finite nonzero float32 value.`);
  return converted;
}
export function validateGpuMatrix(value:readonly number[]|null|undefined,label:string):asserts value is readonly number[] {
  if(!Array.isArray(value)||value.length!==16)throw new GpuRenderError('GPU_MATRIX',`${label} requires 16 matrix components.`);
  value.forEach((n,i)=>finiteFloat32(n,`${label}[${i}]`));
}
export function validateGpuOrientation(matrix:readonly number[],orientation:-1|0|1):void {
  const converted=matrix.map((n,i)=>finiteFloat32(n,`world matrix[${i}]`)) as Matrix4;
  if(orientationMatrix4(converted)!==orientation)
    throw new GpuRenderError('GPU_PRECISION','Float32 conversion changes the transform orientation or rank.');
}
function colorSelection(resource:DeepReadonly<MeshResource>,name?:string):DeepReadonly<MeshAttribute>|undefined {
  if(name===undefined)return;
  const attribute=typeof name==='string'&&Object.hasOwn(resource.attributes?.values??{},name)?resource.attributes!.values[name]:undefined;
  if(!attribute||attribute.valueType!=='color')throw new GpuRenderError('GPU_COLOR_ATTRIBUTE','colorAttribute must name an explicit linear RGB color attribute.');
  return attribute;
}
export function gpuBufferSize(resource:DeepReadonly<MeshResource>,colorAttribute?:string):number {
  const attribute=colorSelection(resource,colorAttribute),expanded=attribute&&attribute.domain!=='vertex';
  const count=expanded?resource.indices.count:resource.positions.count;
  return count*3*4*(attribute?2:1)+resource.indices.count*(expanded?(count>=65535?4:2):(resource.indices.componentType==='uint16'?2:4));
}
/** Three retains its derived edge index until geometry disposal. */
export function gpuWireBufferSize(resource:DeepReadonly<MeshResource>,colorAttribute?:string):number {
  const attribute=colorSelection(resource,colorAttribute),count=attribute&&attribute.domain!=='vertex'?resource.indices.count:resource.positions.count;
  return resource.indices.count*2*(count>=65535?4:2);
}
/** Conservative float32 interval arithmetic bounds both shader stages, including intermediate products. */
export function validateGpuTransformBounds(bounds:DeepReadonly<MeshResource['bounds']>,modelView:readonly number[],projection:readonly number[]):void {
  if(!bounds)return;
  const multiply=(matrix:readonly number[],input:readonly (readonly [number,number])[]):[number,number][]=>[0,1,2,3].map(row=>{
    let low=0,high=0;
    for(let column=0;column<4;column++){
      const coefficient=finiteFloat32(matrix[column*4+row],'matrix coefficient');
      const a=finiteFloat32(coefficient*input[column][0],'shader product'),b=finiteFloat32(coefficient*input[column][1],'shader product');
      low=finiteFloat32(low+Math.min(a,b),'shader partial sum');high=finiteFloat32(high+Math.max(a,b),'shader partial sum');
    }
    return [low,high];
  });
  const points:[number,number][]=[0,1,2].map(i=>[finiteFloat32(bounds.min[i],'position bound'),finiteFloat32(bounds.max[i],'position bound')]);
  points.push([1,1]);multiply(projection,multiply(modelView,points));
}
/** An owned float32 upload copy; no renderer can mutate a shared JSON resource. */
export function prepareGpuGeometry(resource:DeepReadonly<MeshResource>,colorAttribute?:string):{positions:Float32Array;indices:Uint16Array|Uint32Array;colors?:Float32Array;bytes:number} {
  const owned=copyMeshBuffers(resource),positions=new Float32Array(owned.positions.length),authoredDegenerate=new Set(owned.degenerateTriangles);
  for(let i=0;i<positions.length;i++)positions[i]=finiteFloat32(owned.positions[i],`positions[${i}]`);
  for(let i=0;i<owned.indices.length;i+=3){
    if(authoredDegenerate.has(i/3))continue;
    const a=owned.indices[i]*3,b=owned.indices[i+1]*3,c=owned.indices[i+2]*3;
    const u=[0,1,2].map(k=>positions[b+k]-positions[a+k]),v=[0,1,2].map(k=>positions[c+k]-positions[a+k]);
    if(Math.hypot(u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0])===0)
      throw new GpuRenderError('GPU_PRECISION',`Triangle ${i/3} collapses during float32 conversion.`);
  }
  const attribute=colorSelection(resource,colorAttribute);
  if(!attribute)return {positions,indices:owned.indices,bytes:positions.byteLength+owned.indices.byteLength};
  const values=owned.attributes![colorAttribute!].values,expanded=attribute.domain!=='vertex';
  const count=expanded?owned.indices.length:positions.length/3,colors=new Float32Array(count*3);
  const uploadPositions=expanded?new Float32Array(count*3):positions;
  const indices=expanded?(count>=65535?new Uint32Array(count):new Uint16Array(count)):owned.indices;
  for(let i=0;i<count;i++){
    const source=attribute.domain==='face'?Math.floor(i/3):i;
    for(let axis=0;axis<3;axis++){
      colors[i*3+axis]=finiteFloat32(values[source*3+axis],`color ${colorAttribute}[${source*3+axis}]`);
      if(expanded)uploadPositions[i*3+axis]=positions[owned.indices[i]*3+axis];
    }
    if(expanded)indices[i]=i;
  }
  return {positions:uploadPositions,indices,colors,bytes:uploadPositions.byteLength+indices.byteLength+colors.byteLength};
}
