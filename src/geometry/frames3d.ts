import type {DeepReadonly,Diagnostic} from '../ir/operations.js';
import type {Vec3,Quaternion} from './matrix4.js';
import {validateAssetJson} from '../resources/package.js';
import {freezeSnapshot} from '../operations/values.js';
import {assertPreparedCurve3D,sampleCurve3DAt,unitDirection3D,Curve3DError,type SampledCurve3D,type CurvePositionSample3D} from './curve3d.js';

export interface TransportFrameOptions3D {
  seed:{kind:'up';up:Vec3}|{kind:'quaternion';rotation:Quaternion};
  /** Total radians distributed by cumulative sampled chord length. */
  twist?:number;closedSeam?:'preserve'|'distribute';
}
export interface CurveFrameSample3D extends CurvePositionSample3D {tangent:Vec3;normal:Vec3;binormal:Vec3;quaternion:Quaternion}
export interface PreparedTransportFrames3D {
  contract:'texloom-transport-frames/1';curve:SampledCurve3D;options:TransportFrameOptions3D & {twist:number;closedSeam:'preserve'|'distribute'};
  frames:CurveFrameSample3D[];
  report:{algorithm:'discrete-parallel-transport';closedSeam:'preserve'|'distribute';twist:number;baseSeamAngle:number|null;appliedCorrection:number;finalSeamAngle:number|null};
}
const object=(v:unknown):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
const dot=(a:readonly number[],b:readonly number[])=>a.reduce((s,x,i)=>s+x*b[i],0);
const cross=(a:readonly number[],b:readonly number[]):Vec3=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const unit=(v:readonly number[])=>unitDirection3D(v,'FRAME3D_DIRECTION');
const trustedFrames=new WeakMap<object,DeepReadonly<SampledCurve3D>>();
const fail=(code:string,message:string):never=>{throw new Curve3DError(code,message,'$.frames3d');};
export function validateTransportFrameOptions3D(input:unknown,path='$.frames3d'):Diagnostic[]{
  const out=validateAssetJson(input,path);if(out.length)return out;
  const error=(code:string,message:string,at=path)=>out.push({severity:'error',code,message,path:at});
  if(!object(input)){error('FRAME3D_OPTIONS','Expected frame options.');return out;}
  for(const key of Object.keys(input))if(!['seed','twist','closedSeam'].includes(key))error('FRAME3D_OPTIONS',`Unknown property ${key}.`);
  if(!object(input.seed)||!['up','quaternion'].includes(input.seed.kind))error('FRAME3D_SEED','An explicit up or quaternion seed is required.');
  else{
    const key=input.seed.kind==='up'?'up':'rotation',count=input.seed.kind==='up'?3:4,value=input.seed[key];
    for(const name of Object.keys(input.seed))if(!['kind',key].includes(name))error('FRAME3D_SEED',`Unknown seed property ${name}.`);
    if(!Array.isArray(value)||value.length!==count||!value.every(finite)||!value.some(x=>x!==0))error('FRAME3D_SEED','Seed must be a finite nonzero vector or quaternion.');
  }
  if(input.twist!==undefined&&(!finite(input.twist)||Math.abs(input.twist)>2*Math.PI*1_000_000))error('FRAME3D_TWIST','Twist must be finite and at most one million turns in magnitude.');
  if(input.closedSeam!==undefined&&!['preserve','distribute'].includes(input.closedSeam))error('FRAME3D_SEAM','Expected preserve or distribute.');
  return out;
}
function rotate(v:readonly number[],axis:readonly number[],angle:number):Vec3{
  const cosine=Math.cos(angle),sine=Math.sin(angle),along=dot(v,axis),side=cross(axis,v);
  return v.map((x,i)=>x*cosine+side[i]*sine+axis[i]*along*(1-cosine)) as Vec3;
}
function orthogonal(normal:readonly number[],tangent:readonly number[]):Vec3{
  const along=dot(normal,tangent),projected=normal.map((n,i)=>n-along*tangent[i]);
  if(Math.hypot(...projected)<1e-10)fail('FRAME3D_SEED_PARALLEL','The seed up direction must not be parallel to the tangent.');
  return unit(projected);
}
function transport(normal:readonly number[],a:readonly number[],b:readonly number[]):Vec3{
  const cosine=Math.max(-1,Math.min(1,dot(a,b))),axis=cross(a,b),sine=Math.hypot(...axis);
  if(cosine<0&&sine<1e-10)fail('FRAME3D_ANTIPODAL','Antipodal sampled tangents do not define a unique shortest transport rotation.');
  return orthogonal(sine<1e-15?normal:rotate(normal,axis.map(n=>n/sine),Math.atan2(sine,cosine)),b);
}
function unitQuaternion(q:readonly number[]):Quaternion{
  const scale=Math.max(...q.map(Math.abs)),a=q.map(n=>n/scale),length=Math.hypot(...a);
  return a.map(n=>n/length) as Quaternion;
}
function axes(q:readonly number[]):{tangent:Vec3;normal:Vec3;binormal:Vec3}{
  const [x,y,z,w]=q;return {
    tangent:[1-2*(y*y+z*z),2*(x*y+z*w),2*(x*z-y*w)],
    normal:[2*(x*y-z*w),1-2*(x*x+z*z),2*(y*z+x*w)],
    binormal:[2*(x*z+y*w),2*(y*z-x*w),1-2*(x*x+y*y)]};
}
function quaternion(t:readonly number[],n:readonly number[],b:readonly number[]):Quaternion{
  const trace=t[0]+n[1]+b[2];let q:Quaternion;
  if(trace>0){const s=Math.sqrt(trace+1)*2;q=[(n[2]-b[1])/s,(b[0]-t[2])/s,(t[1]-n[0])/s,s/4];}
  else if(t[0]>n[1]&&t[0]>b[2]){const s=Math.sqrt(1+t[0]-n[1]-b[2])*2;q=[s/4,(n[0]+t[1])/s,(b[0]+t[2])/s,(n[2]-b[1])/s];}
  else if(n[1]>b[2]){const s=Math.sqrt(1+n[1]-t[0]-b[2])*2;q=[(n[0]+t[1])/s,s/4,(b[1]+n[2])/s,(b[0]-t[2])/s];}
  else{const s=Math.sqrt(1+b[2]-t[0]-n[1])*2;q=[(b[0]+t[2])/s,(b[1]+n[2])/s,s/4,(t[1]-n[0])/s];}
  return unitQuaternion(q);
}
const signedAngle=(a:readonly number[],b:readonly number[],axis:readonly number[])=>Math.atan2(dot(axis,cross(a,b)),Math.max(-1,Math.min(1,dot(a,b))));
function interpolateQuaternion(a:readonly number[],original:readonly number[],fraction:number):Quaternion{
  let b=[...original],cosine=dot(a,b);if(cosine<0){b=b.map(n=>-n);cosine=-cosine;}
  if(cosine>.9995)return unitQuaternion(a.map((x,i)=>x+(b[i]-x)*fraction));
  const angle=Math.acos(Math.max(-1,Math.min(1,cosine))),sine=Math.sin(angle),left=Math.sin((1-fraction)*angle)/sine,right=Math.sin(fraction*angle)/sine;
  return unitQuaternion(a.map((x,i)=>left*x+right*b[i]));
}
/** Discrete shortest-rotation transport of unit-chord vertex bisectors. No curvature division/Frenet normal. */
export function prepareTransportFrames3D(curve:DeepReadonly<SampledCurve3D>,options:DeepReadonly<TransportFrameOptions3D>):DeepReadonly<PreparedTransportFrames3D>{
  assertPreparedCurve3D(curve);const diagnostics=validateTransportFrameOptions3D(options);if(diagnostics.length){const d=diagnostics[0];throw new Curve3DError(d.code,d.message,d.path);}
  const resolved={...structuredClone(options),twist:options.twist??0,closedSeam:options.closedSeam??'preserve'};
  if(!curve.closed&&resolved.closedSeam==='distribute')fail('FRAME3D_SEAM','Seam distribution requires a closed curve.');
  const tangents=curve.vertexTangents,n=tangents.length-1,baseNormals:Vec3[]=[];let seedRotation:Quaternion|undefined;
  if(resolved.seed.kind==='up')baseNormals.push(orthogonal(unit(resolved.seed.up),tangents[0]));
  else{
    seedRotation=unitQuaternion(resolved.seed.rotation);const seedAxes=axes(seedRotation);
    if(Math.hypot(...seedAxes.tangent.map((x,i)=>x-tangents[0][i]))>1e-8)fail('FRAME3D_SEED_ALIGNMENT','Quaternion seed local +X must align with the first sampled tangent.');
    baseNormals.push(orthogonal(seedAxes.normal,tangents[0]));
  }
  for(let i=1;i<=n;i++)baseNormals.push(transport(baseNormals[i-1],tangents[i-1],tangents[i]));
  const baseSeamAngle=curve.closed?signedAngle(baseNormals[n],baseNormals[0],tangents[0]):null;
  const appliedCorrection=curve.closed&&resolved.closedSeam==='distribute'?baseSeamAngle!:0;
  for(let i=0;i<n;i++)if(Math.abs(appliedCorrection+resolved.twist)*(curve.cumulativeLengths[i+1]-curve.cumulativeLengths[i])/curve.totalLength>=Math.PI)
    fail('FRAME3D_TWIST_RESOLUTION','A chord must span less than pi radians of distributed twist; increase fixed sampling resolution.');
  const frames:CurveFrameSample3D[]=[];
  for(let i=0;i<=n;i++){
    const progress=curve.cumulativeLengths[i]/curve.totalLength,tangent=[...tangents[i]] as Vec3;
    const normal=orthogonal(rotate(baseNormals[i],tangent,(appliedCorrection+resolved.twist)*progress),tangent),binormal=unit(cross(tangent,normal));
    let q=quaternion(tangent,normal,binormal);const previous=i?frames[i-1].quaternion:seedRotation;
    if(previous?dot(previous,q)<0:q[3]<0)q=q.map(x=>-x) as Quaternion;
    const segmentIndex=Math.min(i,n-1),a=curve.positions[segmentIndex],b=curve.positions[segmentIndex+1];
    frames.push({position:[...curve.positions[i]],tangent,normal,binormal,quaternion:q,chordTangent:unit(b.map((x,k)=>x-a[k])),
      parameter:curve.parameters[i],length:curve.cumulativeLengths[i],totalLength:curve.totalLength,progress,segmentIndex,localFraction:i===n?1:0});
  }
  const prepared=freezeSnapshot({contract:'texloom-transport-frames/1' as const,curve,options:resolved,frames,
    report:{algorithm:'discrete-parallel-transport' as const,closedSeam:resolved.closedSeam,twist:resolved.twist,baseSeamAngle,appliedCorrection,
      finalSeamAngle:curve.closed?signedAngle(frames[n].normal,frames[0].normal,tangents[0]):null}});
  // Keep the trusted original curve out of serialized payload concerns; the public snapshot has no mutable alias.
  trustedFrames.set(prepared,curve);return prepared;
}
/** Position follows a sampled chord; orientation uses shortest quaternion interpolation of its endpoint frames. */
export function sampleTransportFrame3D(prepared:DeepReadonly<PreparedTransportFrames3D>,progress:number):DeepReadonly<CurveFrameSample3D>{
  const curve=trustedFrames.get(prepared);if(!curve)fail('FRAME3D_PREPARED','Expected an immutable result of prepareTransportFrames3D.');
  const sample=sampleCurve3DAt(curve!,progress),index=sample.segmentIndex;
  if(sample.localFraction===0)return freezeSnapshot({...prepared.frames[index],...sample});
  if(sample.localFraction===1)return freezeSnapshot({...prepared.frames[index+1],...sample});
  const q=interpolateQuaternion(prepared.frames[index].quaternion,prepared.frames[index+1].quaternion,sample.localFraction);
  return freezeSnapshot({...sample,...axes(q),quaternion:q});
}
