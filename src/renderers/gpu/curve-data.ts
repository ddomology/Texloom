import {copyCurve3DBuffers,type Curve3DResource} from '../../ir/curve3d.js';
import type {DeepReadonly} from '../../ir/operations.js';
import {finiteFloat32,GpuRenderError} from './data.js';

export const gpuCurveBufferSize=(r:DeepReadonly<Curve3DResource>):number=>r.positions.count*3*4;
/** Owned position uploads. A nonzero authored segment must survive backend conversion. */
export function prepareGpuCurveGeometry(resource:DeepReadonly<Curve3DResource>):{positions:Float32Array;bytes:number}{
  const owned=copyCurve3DBuffers(resource),positions=new Float32Array(owned.positions.length);
  for(let i=0;i<positions.length;i++)positions[i]=finiteFloat32(owned.positions[i],`curve positions[${i}]`);
  for(let i=3;i<positions.length;i+=3)if([0,1,2].every(k=>positions[i+k]===positions[i-3+k]))
    throw new GpuRenderError('GPU_PRECISION',`Curve segment ${i/3-1} collapses during float32 conversion.`);
  return {positions,bytes:positions.byteLength};
}
