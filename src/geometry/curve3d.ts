import type {DeepReadonly,Diagnostic} from '../ir/operations.js';
import {validateAssetJson} from '../resources/package.js';
import {freezeSnapshot} from '../operations/values.js';
import type {Vec3} from './matrix4.js';

export interface Curve3DOptions {domain:[number,number];segments:number;closed?:boolean;closureTolerance?:number}
export type CurvePosition3D=(parameter:number)=>readonly [number,number,number];
export interface SampledCurve3D {
  contract:'texloom-sampled-curve3d/1';domain:[number,number];closed:boolean;
  positions:Vec3[];parameters:number[];cumulativeLengths:number[];totalLength:number;vertexTangents:Vec3[];
  report:{representation:'polyline';lengthPolicy:'chord-sum';tangentPolicy:'unit-chord-bisectors';segments:number;evaluations:number;closureAdjusted:boolean};
}
export interface CurvePositionSample3D {
  position:Vec3;chordTangent:Vec3;parameter:number;length:number;totalLength:number;progress:number;segmentIndex:number;localFraction:number;
}
export const MAX_CURVE3D_SEGMENTS=8192;
export class Curve3DError extends Error {
  readonly diagnostics:DeepReadonly<Diagnostic[]>;
  constructor(readonly code:string,message:string,path='$.curve3d'){
    super(`${code}: ${message}`);this.name='Curve3DError';this.diagnostics=freezeSnapshot([{severity:'error' as const,code,message,path}]);
  }
}
const object=(v:unknown):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
const preparedCurves=new WeakSet<object>();
const parameter=(domain:readonly number[],segments:number,i:number)=>i===segments?domain[1]:domain[0]+(domain[1]-domain[0])*(i/segments);
export function validateCurve3DOptions(input:unknown,path='$.curve3d'):Diagnostic[]{
  const out=validateAssetJson(input,path);if(out.length)return out;
  const error=(code:string,message:string,at=path)=>out.push({severity:'error',code,message,path:at});
  if(!object(input)){error('CURVE3D_OPTIONS','Expected curve sampling options.');return out;}
  for(const key of Object.keys(input))if(!['domain','segments','closed','closureTolerance'].includes(key))error('CURVE3D_OPTIONS',`Unknown property ${key}.`,`${path}.${key}`);
  if(!Array.isArray(input.domain)||input.domain.length!==2||!input.domain.every(finite)||!(input.domain[1]>input.domain[0])||!Number.isFinite(input.domain[1]-input.domain[0]))
    error('CURVE3D_DOMAIN','Expected finite increasing endpoints with finite interval length.',path+'.domain');
  if(!Number.isSafeInteger(input.segments)||input.segments<1||input.segments>MAX_CURVE3D_SEGMENTS)
    error('CURVE3D_BUDGET',`segments must be an integer in [1,${MAX_CURVE3D_SEGMENTS}].`,path+'.segments');
  if(input.closed!==undefined&&typeof input.closed!=='boolean')error('CURVE3D_OPTIONS','closed must be boolean.',path+'.closed');
  if(input.closed&&input.segments<3)error('CURVE3D_TOPOLOGY','Closed curves require at least three segments.');
  if(input.closureTolerance!==undefined&&(!finite(input.closureTolerance)||input.closureTolerance<0))error('CURVE3D_OPTIONS','closureTolerance must be finite and nonnegative.');
  if(out.length)return out;
  let previous=input.domain[0];for(let i=1;i<=input.segments;i++){
    const next=parameter(input.domain,input.segments,i);
    if(!(next>previous)){error('CURVE3D_PRECISION','Every grid coordinate must advance at the declared numeric precision.');break;}previous=next;
  }
  return out;
}
/** Stable normalization for direction vectors; no arbitrary direction is chosen for zero input. */
export function unitDirection3D(value:readonly number[],code='CURVE3D_DIRECTION'):Vec3{
  const scale=Math.max(...value.map(Math.abs));
  if(!(scale>0)||!Number.isFinite(scale))throw new Curve3DError(code,'A finite nonzero direction is required.');
  const scaled=value.map(x=>x/scale),length=Math.hypot(...scaled);
  return scaled.map(x=>x/length) as Vec3;
}
const chord=(a:readonly number[],b:readonly number[]):Vec3=>b.map((x,i)=>x-a[i]) as Vec3;
export function assertPreparedCurve3D(curve:unknown):asserts curve is DeepReadonly<SampledCurve3D>{
  if(!object(curve)||!preparedCurves.has(curve))throw new Curve3DError('CURVE3D_PREPARED','Expected an immutable result of prepareCurve3D.');
}
/** Fixed parameter samples. Chord lengths and bisector tangents are discrete approximations. */
export function prepareCurve3D(options:DeepReadonly<Curve3DOptions>,position:CurvePosition3D):DeepReadonly<SampledCurve3D>{
  const diagnostics=validateCurve3DOptions(options);if(diagnostics.length){const d=diagnostics[0];throw new Curve3DError(d.code,d.message,d.path);}
  if(typeof position!=='function')throw new Curve3DError('CURVE3D_CALLBACK','Position must be a function.');
  const source=structuredClone(options),parameters:number[]=[],positions:Vec3[]=[],n=source.segments;
  for(let i=0;i<=n;i++){
    const u=parameter(source.domain,n,i),point=position(u);parameters.push(u);
    if(!Array.isArray(point)||point.length!==3||!point.every(finite))throw new Curve3DError('CURVE3D_NONFINITE',`Position at parameter ${u} must have three finite components.`);
    positions.push([point[0],point[1],point[2]]);
  }
  let closureAdjusted=false;
  if(source.closed){
    if(Math.hypot(...chord(positions[0],positions[n]))>(source.closureTolerance??1e-9))throw new Curve3DError('CURVE3D_CLOSURE','Closed endpoints do not coincide within closureTolerance.');
    closureAdjusted=positions[0].some((x,i)=>x!==positions[n][i]);positions[n]=[...positions[0]];
  }
  const cumulativeLengths=[0],directions:Vec3[]=[];let totalLength=0,correction=0;
  for(let i=0;i<n;i++){
    const delta=chord(positions[i],positions[i+1]),length=Math.hypot(...delta);
    if(!(length>0)||!Number.isFinite(length))throw new Curve3DError('CURVE3D_SEGMENT',`Chord ${i} must have finite nonzero length.`);
    directions.push(unitDirection3D(delta));
    const adjusted=length-correction,next=totalLength+adjusted;correction=(next-totalLength)-adjusted;
    if(!Number.isFinite(next)||!(next>totalLength))throw new Curve3DError('CURVE3D_PRECISION','Cumulative chord length must remain finite and strictly increasing.');
    totalLength=next;cumulativeLengths.push(totalLength);
  }
  const bisector=(a:Vec3,b:Vec3):Vec3=>{
    const sum=a.map((x,i)=>x+b[i]);if(Math.hypot(...sum)<1e-10)throw new Curve3DError('CURVE3D_CUSP','Reversing adjacent chords do not define a stable vertex tangent.');
    return unitDirection3D(sum);
  };
  const vertexTangents:Vec3[]=[];
  for(let i=0;i<=n;i++)vertexTangents.push(i===0?(source.closed?bisector(directions[n-1],directions[0]):[...directions[0]]):
    i===n?(source.closed?[...vertexTangents[0]]:[...directions[n-1]]):bisector(directions[i-1],directions[i]));
  const curve=freezeSnapshot({contract:'texloom-sampled-curve3d/1' as const,domain:source.domain,closed:source.closed??false,positions,parameters,cumulativeLengths,totalLength,vertexTangents,
    report:{representation:'polyline' as const,lengthPolicy:'chord-sum' as const,tangentPolicy:'unit-chord-bisectors' as const,segments:n,evaluations:n+1,closureAdjusted}});
  preparedCurves.add(curve);return curve;
}
/** Arc-length fraction of the sampled polyline, without any time/history state. */
export function sampleCurve3DAt(curve:DeepReadonly<SampledCurve3D>,progress:number):DeepReadonly<CurvePositionSample3D>{
  assertPreparedCurve3D(curve);
  if(!finite(progress)||progress<0||progress>1)throw new Curve3DError('CURVE3D_PROGRESS','Progress must be finite and in [0,1].');
  const n=curve.positions.length-1,length=progress===1?curve.totalLength:progress*curve.totalLength;
  let low=0,high=n;
  while(low+1<high){const middle=Math.floor((low+high)/2);if(curve.cumulativeLengths[middle]<=length)low=middle;else high=middle;}
  const index=Math.min(low,n-1),a=curve.positions[index],b=curve.positions[index+1],start=curve.cumulativeLengths[index],end=curve.cumulativeLengths[index+1];
  const fraction=progress===1?1:(length-start)/(end-start);
  const interpolate=(x:number,y:number)=>fraction===0?x:fraction===1?y:x+(y-x)*fraction;
  return freezeSnapshot({position:a.map((x,i)=>interpolate(x,b[i])) as Vec3,chordTangent:unitDirection3D(chord(a,b)),
    parameter:interpolate(curve.parameters[index],curve.parameters[index+1]),length,totalLength:curve.totalLength,progress,segmentIndex:index,localFraction:fraction});
}
