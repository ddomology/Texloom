import type {DeepReadonly,Diagnostic} from '../ir/operations.js';
import {validateJsonData} from '../operations/values.js';
import {validateMatrix4,type Matrix4,type Vec3} from './matrix4.js';

export type Projection3D=
  | {kind:'perspective';fovY:number;near:number;far:number}
  | {kind:'orthographic';height:number;near:number;far:number};
export interface Viewport3D {width:number;height:number}
export interface ProjectedPoint3D {
  /** Homogeneous OpenGL clip coordinates; near/far map to NDC -1/+1. */
  clip:[number,number,number,number];
  ndc:Vec3|null;
  /** Logical viewport bp, origin top left and +Y down. */
  position:[number,number]|null;
  /** Includes positive homogeneous w and the closed six-plane clip volume. */
  visible:boolean;
}
export class Projection3DError extends Error {
  readonly diagnostics:readonly Diagnostic[];
  constructor(readonly code:string,message:string,path='$') {
    super(`${code} at ${path}: ${message}`);this.name='Projection3DError';
    this.diagnostics=Object.freeze([Object.freeze({severity:'error' as const,code,message,path})]);
  }
}
const finite=(n:unknown):n is number=>typeof n==='number'&&Number.isFinite(n);
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const fail=(code:string,message:string,path='$'):never=>{throw new Projection3DError(code,message,path);};
function assertDiagnostics(d:readonly Diagnostic[]):void {if(d.some(x=>x.severity==='error')){const first=d.find(x=>x.severity==='error')!;fail(first.code,first.message,first.path);}}
function freeze<T>(value:T):DeepReadonly<T> {
  if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value as DeepReadonly<T>;
}
export function validateProjection3D(input:unknown,path='$'):Diagnostic[] {
  const out=validateJsonData(input,path);if(out.length)return out;
  const error=(code:string,message:string,at=path)=>out.push({severity:'error',code,message,path:at});
  if(!object(input)){error('PROJECTION3D_TYPE','Expected a projection descriptor.');return out;}
  if(input.kind!=='perspective'&&input.kind!=='orthographic'){error('PROJECTION3D_KIND','Expected perspective or orthographic.');return out;}
  const size=input.kind==='perspective'?'fovY':'height';
  for(const key of Object.keys(input))if(!['kind',size,'near','far'].includes(key))error('PROJECTION3D_FIELD',`Unknown projection property ${key}.`,`${path}.${key}`);
  if(!finite(input[size])||(input[size] as number)<=0||size==='fovY'&&(input[size] as number)>=Math.PI)
    error('PROJECTION3D_SIZE',size==='fovY'?'fovY must be radians strictly between zero and pi.':'height must be finite and positive.',`${path}.${size}`);
  if(!finite(input.near)||(input.near as number)<0||input.kind==='perspective'&&input.near===0)
    error('PROJECTION3D_NEAR','near must be positive for perspective, or nonnegative for orthographic.',`${path}.near`);
  if(!finite(input.far)||!finite(input.near)||input.far<=input.near)error('PROJECTION3D_FAR','far must be finite and greater than near.',`${path}.far`);
  return out;
}
export function validateViewport3D(input:unknown,path='$'):Diagnostic[] {
  const out=validateJsonData(input,path);if(out.length)return out;
  if(!object(input)||!finite(input.width)||input.width<=0||!finite(input.height)||input.height<=0)
    return [{severity:'error',code:'PROJECTION3D_VIEWPORT',message:'Expected finite positive viewport width and height.',path}];
  for(const key of Object.keys(input))if(!['width','height'].includes(key))out.push({severity:'error',code:'PROJECTION3D_VIEWPORT',message:`Unknown viewport property ${key}.`,path:`${path}.${key}`});
  const aspect=input.width/input.height;
  if(!Number.isFinite(aspect)||aspect===0)out.push({severity:'error',code:'PROJECTION3D_RANGE',message:'Viewport aspect is outside the finite nonzero range.',path});
  return out;
}
function checkMatrix(m:unknown):asserts m is Matrix4 {
  assertDiagnostics(validateJsonData(m));
  if(!Array.isArray(m)||m.length!==16||!m.every(finite))fail('PROJECTION3D_MATRIX','Expected sixteen finite column-major matrix coefficients.');
}
function range(values:readonly number[]):void {if(values.some(n=>!Number.isFinite(n)))fail('PROJECTION3D_RANGE','Projection arithmetic exceeded the finite numeric range.');}
/** Projection for a camera looking down local -Z, local +Y up. No pose or viewport pixels are baked in. */
export function projectionMatrix3D(projection:DeepReadonly<Projection3D>,viewport:DeepReadonly<Viewport3D>):DeepReadonly<Matrix4> {
  assertDiagnostics(validateProjection3D(projection));assertDiagnostics(validateViewport3D(viewport));
  const aspect=viewport.width/viewport.height,{near,far}=projection,span=far-near;
  let m:Matrix4;
  if(projection.kind==='perspective') {
    const f=1/Math.tan(projection.fovY/2);
    m=[f/aspect,0,0,0,0,f,0,0,0,0,-(far/span+near/span),-1,0,0,-2*(near*(far/span)),0];
  } else {
    const y=2/projection.height;
    m=[y/aspect,0,0,0,0,y,0,0,0,0,-2/span,0,0,0,-(far/span+near/span),1];
  }
  range(m);if(m[0]===0||m[5]===0||m[10]===0||projection.kind==='perspective'&&m[14]===0)
    fail('PROJECTION3D_RANGE','Projection scale is outside the finite nonzero range.');
  return freeze(m);
}
function sumProducts(a:readonly number[],b:readonly number[]):number {
  let total=0,error=0;
  for(let i=0;i<4;i++){const product=a[i]*b[i],next=total+product;
    error+=Math.abs(total)>=Math.abs(product)?(total-next)+product:(product-next)+total;total=next;}
  const result=total+error;range([result]);return result;
}
/** A projective product is kept separate from the affine-only matrix4 helpers. */
export function viewProjectionMatrix3D(projection:DeepReadonly<Matrix4>,view:DeepReadonly<Matrix4>):DeepReadonly<Matrix4> {
  checkMatrix(projection);assertDiagnostics(validateMatrix4(view));const out=Array<number>(16);
  for(let c=0;c<4;c++)for(let r=0;r<4;r++)out[c*4+r]=sumProducts([projection[r],projection[4+r],projection[8+r],projection[12+r]],view.slice(c*4,c*4+4));
  return freeze(out as Matrix4);
}
export function projectPoint3D(point:DeepReadonly<Vec3>,viewProjection:DeepReadonly<Matrix4>,viewport:DeepReadonly<Viewport3D>):DeepReadonly<ProjectedPoint3D> {
  assertDiagnostics(validateJsonData(point));if(!Array.isArray(point)||point.length!==3||!point.every(finite))fail('PROJECTION3D_POINT','Expected a finite world-space point.');
  checkMatrix(viewProjection);assertDiagnostics(validateViewport3D(viewport));
  const p=[...point,1],clip=[0,1,2,3].map(r=>sumProducts([viewProjection[r],viewProjection[r+4],viewProjection[r+8],viewProjection[r+12]],p)) as [number,number,number,number];
  const w=clip[3];let ndc:Vec3|null=w===0?null:[clip[0]/w,clip[1]/w,clip[2]/w];
  if(ndc?.some(n=>!Number.isFinite(n)))ndc=null;
  let position:[number,number]|null=ndc?[(ndc[0]/2+.5)*viewport.width,(.5-ndc[1]/2)*viewport.height]:null;
  if(position?.some(n=>!Number.isFinite(n)))position=null;
  // Matrix coefficients and dot products round independently at an authored near/far boundary.
  // A small relative roundoff allowance preserves that closed volume, without moving the point.
  const tolerance=8*Number.EPSILON*Math.max(Math.abs(w),...clip.slice(0,3).map(Math.abs));
  return freeze({clip,ndc,position,visible:w>0&&clip.slice(0,3).every(v=>v>=-w-tolerance&&v<=w+tolerance)&&position!==null});
}
