import type {DeepReadonly,Diagnostic} from './operations.js';
import type {MeshUnit} from './mesh.js';
import type {Bounds3D} from '../geometry/matrix4.js';
import {freezeSnapshot} from '../operations/values.js';
import {validateAssetJson} from '../resources/package.js';
import {copyNumericBuffer,validateNumericBuffer,type NumericBuffer} from '../resources/buffers.js';

/** Portable sampled polyline, with a repeated endpoint when closed. */
export interface Curve3DResource {
  kind:'curve3d';version:1;primitive:'line-strip';units:MeshUnit;coordinateSpace:'object';
  topologyRevision:string;positions:NumericBuffer;closed:boolean;
  bounds:Bounds3D|null;provenance?:Record<string,unknown>;
}
export interface OwnedCurve3DBuffers {
  positions:Float32Array|Float64Array;bounds:DeepReadonly<Bounds3D>|null;segmentCount:number;closed:boolean;
}
export const MAX_CURVE3D_VERTICES=65537;
export class CurveResource3DError extends Error {
  readonly code:string;readonly diagnostics:DeepReadonly<Diagnostic[]>;
  constructor(diagnostics:readonly Diagnostic[]){
    super(diagnostics.map(d=>`${d.code}: ${d.message} (${d.path??'$'})`).join('\n'));
    this.name='CurveResource3DError';this.code=diagnostics[0]?.code??'CURVE3D_RESOURCE';this.diagnostics=freezeSnapshot(diagnostics);
  }
}
const object=(v:unknown):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const triple=(v:unknown):v is number[]=>Array.isArray(v)&&v.length===3&&v.every(n=>typeof n==='number'&&Number.isFinite(n));
function inspect(input:unknown,path:string):{diagnostics:Diagnostic[];buffers?:OwnedCurve3DBuffers}{
  const diagnostics=validateAssetJson(input,path);if(diagnostics.length)return {diagnostics};
  const fail=(code:string,message:string,at=path)=>diagnostics.push({severity:'error',code,message,path:at});
  if(!object(input)){fail('CURVE3D_RESOURCE','Expected a sampled curve resource.');return {diagnostics};}
  for(const key of Object.keys(input))if(!['kind','version','primitive','units','coordinateSpace','topologyRevision','positions','closed','bounds','provenance'].includes(key))
    fail('CURVE3D_PROPERTY',`Unsupported property ${key}.`,path+'.'+key);
  if(input.kind!=='curve3d'||input.version!==1||input.primitive!=='line-strip')fail('CURVE3D_RESOURCE','Expected curve3d version 1 with line-strip primitive.');
  if(!['unit','m','cm','mm'].includes(input.units)||input.coordinateSpace!=='object')fail('CURVE3D_UNITS','Expected explicit unit/m/cm/mm and object coordinates.');
  if(typeof input.closed!=='boolean')fail('CURVE3D_CLOSED','closed must be an explicit boolean.');
  if(typeof input.topologyRevision!=='string'||!input.topologyRevision.trim()||input.topologyRevision.length>512)fail('CURVE3D_REVISION','Expected a nonblank topology revision of at most 512 characters.');
  if(input.provenance!==undefined&&!object(input.provenance))fail('CURVE3D_PROVENANCE','Expected a JSON provenance object.');
  const bufferErrors=validateNumericBuffer(input.positions,path+'.positions');diagnostics.push(...bufferErrors);
  if(!bufferErrors.length){const p=input.positions as NumericBuffer;
    if(!['float32','float64'].includes(p.componentType)||p.components!==3)fail('CURVE3D_POSITIONS','Positions require three float32/float64 components.');
    if(p.count>MAX_CURVE3D_VERTICES||p.count!==0&&p.count<(input.closed?4:2))fail('CURVE3D_COUNT',`Expected an empty curve, or 2–${MAX_CURVE3D_VERTICES} vertices (at least 4 when closed).`);
  }
  if(diagnostics.length)return {diagnostics};
  const resource=input as Curve3DResource;
  if(resource.positions.count===0){if(resource.bounds!==null)fail('CURVE3D_BOUNDS','Empty curves require null bounds.');}
  else if(!object(resource.bounds)||Object.keys(resource.bounds).some(k=>!['min','max'].includes(k))||!triple(resource.bounds.min)||!triple(resource.bounds.max)||resource.bounds.min.some((n,i)=>n>resource.bounds!.max[i]))
    fail('CURVE3D_BOUNDS','Bounds require finite ordered min/max triples.');
  if(diagnostics.length)return {diagnostics};
  const positions=copyNumericBuffer(resource.positions) as Float32Array|Float64Array;
  let bounds:Bounds3D|null=null;
  if(positions.length){bounds={min:[Infinity,Infinity,Infinity],max:[-Infinity,-Infinity,-Infinity]};
    for(let i=0;i<positions.length;i++){bounds.min[i%3]=Math.min(bounds.min[i%3],positions[i]);bounds.max[i%3]=Math.max(bounds.max[i%3],positions[i]);}
    if(bounds.min.some((n,i)=>n!==resource.bounds!.min[i])||bounds.max.some((n,i)=>n!==resource.bounds!.max[i]))fail('CURVE3D_BOUNDS','Bounds must equal the extrema of converted positions.');
    for(let i=3;i<positions.length;i+=3)if([0,1,2].every(k=>positions[i+k]===positions[i-3+k])){fail('CURVE3D_DEGENERATE','Adjacent positions must define nonzero segments.');break;}
    if(resource.closed&&[0,1,2].some(k=>positions[k]!==positions[positions.length-3+k]))fail('CURVE3D_CLOSED','Closed resources repeat the exact first converted position at their end.');
  }
  if(diagnostics.length)return {diagnostics};
  return {diagnostics,buffers:Object.freeze({positions,bounds:bounds?freezeSnapshot(bounds):null,segmentCount:Math.max(0,resource.positions.count-1),closed:resource.closed})};
}
export function validateCurve3DResource(input:unknown,path='$.curve3d'):Diagnostic[]{return inspect(input,path).diagnostics;}
export function snapshotCurve3DResource(input:unknown,path='$.curve3d'):DeepReadonly<Curve3DResource>{
  const {diagnostics}=inspect(input,path);if(diagnostics.length)throw new CurveResource3DError(diagnostics);return freezeSnapshot(input as Curve3DResource);
}
/** Typed storage is owned by this call, never shared with portable immutable JSON. */
export function copyCurve3DBuffers(input:unknown,path='$.curve3d'):OwnedCurve3DBuffers{
  const {diagnostics,buffers}=inspect(input,path);if(diagnostics.length)throw new CurveResource3DError(diagnostics);return buffers!;
}
