import {PathGeometryError,type PathGeometry,type PathPoint} from '../path-geometry.js';
import {validatePathGeometry} from '../path-contract.js';
import {sampleCurveGeometry,trimCurveGeometry} from './curves.js';
import type {DeepReadonly} from '../ir/operations.js';

export interface ArrowOptions {
  start?:0|1|2;end?:0|1|2;length?:number;width?:number;inset?:number;
  shortenStart?:number;shortenEnd?:number;collision?:'error'|'clamp';tolerance?:number;
}
export const ARROW_DEFAULTS:Readonly<Required<ArrowOptions>>=Object.freeze({
  start:0,end:1,length:9,width:7.56,inset:2.52,shortenStart:0,shortenEnd:0,collision:'error',tolerance:.05,
});
export interface ArrowEndpointReport {
  endpoint:PathPoint;visualTip:PathPoint;shaftEndpoint:PathPoint;
  /** Outward unit tip direction: reverse traversal at the start, forward at the end. */
  tangent:PathPoint;
}
export interface ArrowReport {
  totalLength:number;scale:number;shortenStart:number;shortenEnd:number;
  shaftTrimStart:number;shaftTrimEnd:number;start:ArrowEndpointReport;end:ArrowEndpointReport;
}
export interface ArrowGeometry {shaft:PathGeometry;startTip:PathGeometry;endTip:PathGeometry;report:ArrowReport}
export type ArrowGeometryResult=ArrowGeometry;
type ResolvedPath={start:readonly [number,number];c1:readonly [number,number];c2:readonly [number,number];end:readonly [number,number]};
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
function fail(code:string,message:string):never {throw new PathGeometryError(code,message);}
function json(value:unknown,ancestors=new Set<object>(),depth=0):void {
  if(value===null||typeof value==='string'||typeof value==='boolean'||finite(value))return;
  if(depth>128||typeof value!=='object'||ancestors.has(value!))fail('ARROW_DATA','Expected finite acyclic JSON data.');
  const array=Array.isArray(value),prototype=Object.getPrototypeOf(value);
  if(array?prototype!==Array.prototype:prototype!==Object.prototype&&prototype!==null)fail('ARROW_DATA','Expected plain JSON data.');
  if(Object.getOwnPropertySymbols(value).length)fail('ARROW_DATA','Symbol properties are not JSON.');
  const descriptors=Object.getOwnPropertyDescriptors(value);ancestors.add(value);
  if(array)for(let i=0;i<value.length;i++)if(!Object.hasOwn(descriptors,String(i)))fail('ARROW_DATA','Sparse arrays are not JSON.');
  for(const [key,d] of Object.entries(descriptors)){
    if(array&&key==='length')continue;
    if(!Object.hasOwn(d,'value')||!d.enumerable||array&&!/^(0|[1-9]\d*)$/.test(key))fail('ARROW_DATA','Expected ordinary enumerable JSON values.');
    json(d.value,ancestors,depth+1);
  }ancestors.delete(value);
}
function keys(value:object,allowed:string[]):void {
  if(Object.keys(value).some(key=>!allowed.includes(key)))fail('ARROW_DATA','Unknown arrow geometry or option property.');
}
function frozen<T>(value:T):DeepReadonly<T> {
  const result=structuredClone(value),visit=(v:any):void=>{if(v&&typeof v==='object'){Object.values(v).forEach(visit);Object.freeze(v);}};
  visit(result);return result as DeepReadonly<T>;
}
export function normalizeArrowOptions(value:ArrowOptions={}):Required<ArrowOptions> {
  json(value);if(!object(value))fail('ARROW_OPTIONS','Expected arrow options.');
  keys(value,['start','end','length','width','inset','shortenStart','shortenEnd','collision','tolerance']);
  const o:Required<ArrowOptions>={...ARROW_DEFAULTS,...value};
  if(![0,1,2].includes(o.start)||![0,1,2].includes(o.end))fail('ARROW_TIP','Tip must be 0 (none), 1 (triangle), or 2 (stealth).');
  for(const name of ['length','width','tolerance'] as const)if(!finite(o[name])||o[name]<=0)fail('ARROW_DIMENSION',`${name} must be positive and finite.`);
  for(const name of ['shortenStart','shortenEnd'] as const)if(!finite(o[name])||o[name]<0)fail('ARROW_DIMENSION',`${name} must be nonnegative and finite.`);
  if(!finite(o.inset)||o.inset<0)fail('ARROW_DIMENSION','Inset must be nonnegative and finite.');
  if((o.start===2||o.end===2)&&o.inset>=o.length)fail('ARROW_INSET','Stealth inset must be in [0,length).');
  if(o.collision!=='error'&&o.collision!=='clamp')fail('ARROW_COLLISION_POLICY','Collision policy must be error or clamp.');
  return o;
}
function tipGeometry(tip:0|1|2,nose:PathPoint,tangent:PathPoint,length:number,width:number,inset:number,id:string):PathGeometry {
  if(tip===0)return {contours:[]};
  const [ux,uy]=tangent,bx=nose[0]-ux*length,by=nose[1]-uy*length,half=width/2;
  const points:PathPoint[]=[[...nose],[bx-uy*half,by+ux*half]];
  if(tip===2)points.push([bx+ux*inset,by+uy*inset]);
  points.push([bx+uy*half,by-ux*half]);
  if(points.some(p=>p.some(v=>!finite(v))))fail('ARROW_NONFINITE','Arrow tip coordinates are nonfinite.');
  return {contours:[{id,start:points[0],closed:true,segments:points.slice(1).map((to,i)=>({id:`edge-${i}`,kind:'line',to}))}]};
}

/** Rigid tips and exact trimmed cubic subcurves, in the original local chart. */
export function createArrowGeometry(input:DeepReadonly<PathGeometry>,configuration:ArrowOptions={}):DeepReadonly<ArrowGeometry> {
  json(input);const errors=validatePathGeometry(input);if(errors.length)fail('INVALID_PATH_GEOMETRY',errors.map(e=>e.message).join('\n'));
  keys(input,['contours']);
  if(input.contours.length!==1||input.contours[0].closed)fail('ARROW_CONTOUR','Arrows require exactly one open contour.');
  const contour=input.contours[0];keys(contour,['id','start','segments','closed']);
  for(const s of contour.segments)keys(s,s.kind==='line'?['id','kind','to']:['id','kind','c1','c2','to']);
  const o=normalizeArrowOptions(configuration),geometry=structuredClone(input) as PathGeometry;
  const sampleOptions={mode:'length' as const,tolerance:o.tolerance};
  const start=sampleCurveGeometry(geometry,0,sampleOptions),end=sampleCurveGeometry(geometry,1,sampleOptions),total=start.totalLength;
  if(!finite(total)||total<=0)fail('ARROW_DEGENERATE','Arrow path must have positive finite length.');
  const requested=o.shortenStart+o.shortenEnd+(o.start?o.length:0)+(o.end?o.length:0);
  if(!finite(requested))fail('ARROW_NONFINITE','Requested arrow reservation is nonfinite.');
  let scale=1;
  if(requested>=total){
    if(o.collision==='error')fail('ARROW_COLLISION','Arrow tips and shortening consume the entire path.');
    scale=(total/requested)*(1-1e-6);
    if(!finite(scale)||scale<=0)fail('ARROW_NONFINITE','Collision scale is not representable.');
  }
  const length=o.length*scale,width=o.width*scale,inset=o.inset*scale,shortenStart=o.shortenStart*scale,shortenEnd=o.shortenEnd*scale;
  if((o.start!==0||o.end!==0)&&(length<=0||width<=0))
    fail('ARROW_PRECISION','Scaled arrow length and width must remain representably positive.');
  const reservation=(tip:0|1|2)=>tip===0?0:tip===1?length:length-inset;
  const shaftTrimStart=shortenStart+reservation(o.start),shaftTrimEnd=shortenEnd+reservation(o.end);
  const shaft=trimCurveGeometry(geometry,shaftTrimStart/total,1-shaftTrimEnd/total,sampleOptions).geometry;
  const visibleStart=sampleCurveGeometry(geometry,shortenStart/total,sampleOptions),visibleEnd=sampleCurveGeometry(geometry,1-shortenEnd/total,sampleOptions);
  const startTangent:PathPoint=[-visibleStart.tangent[0],-visibleStart.tangent[1]],endTangent:PathPoint=[...visibleEnd.tangent];
  const body=shaft.contours[0];
  const report:ArrowReport={totalLength:total,scale,shortenStart,shortenEnd,shaftTrimStart,shaftTrimEnd,
    start:{endpoint:[...start.position],visualTip:[...visibleStart.position],shaftEndpoint:[...body.start],tangent:startTangent},
    end:{endpoint:[...end.position],visualTip:[...visibleEnd.position],shaftEndpoint:[...(body.segments.at(-1)?.to??body.start)],tangent:endTangent}};
  return frozen({shaft:structuredClone(shaft) as PathGeometry,
    startTip:tipGeometry(o.start,visibleStart.position,startTangent,length,width,inset,'arrow-start'),
    endTip:tipGeometry(o.end,visibleEnd.position,endTangent,length,width,inset,'arrow-end'),report});
}

/** Historical triangle arithmetic intentionally remains byte-for-byte in the same order. */
export function legacyArrowPoints(path:ResolvedPath,end:boolean,size=9):readonly [PathPoint,PathPoint,PathPoint] {
  json(path);if(!object(path))fail('ARROW_DATA','Expected a resolved legacy path.');keys(path,['start','c1','c2','end']);
  if(typeof end!=='boolean'||!finite(size)||size<=0||!['start','c1','c2','end'].every(key=>{
    const p=path[key as keyof ResolvedPath];return Array.isArray(p)&&p.length===2&&p.every(finite);
  }))fail('ARROW_DATA','Legacy arrow requires finite points and a positive size.');
  const tip=end?path.end:path.start,inner=end?path.c2:path.c1;
  let dx=tip[0]-inner[0],dy=tip[1]-inner[1];
  if(Math.hypot(dx,dy)<1e-10){const opposite=end?path.start:path.end;dx=tip[0]-opposite[0];dy=tip[1]-opposite[1];}
  const length=Math.hypot(dx,dy);if(length<1e-10)fail('ARROW_DIRECTION','Arrow path has no direction');
  const ux=dx/length,uy=dy/length,bx=tip[0]-ux*size,by=tip[1]-uy*size;
  const result:[PathPoint,PathPoint,PathPoint]=[[...tip],[bx-uy*size*.42,by+ux*size*.42],[bx+uy*size*.42,by-ux*size*.42]];
  if(result.some(p=>p.some(v=>!finite(v))))fail('ARROW_NONFINITE','Legacy arrow coordinates are nonfinite.');
  return result;
}
