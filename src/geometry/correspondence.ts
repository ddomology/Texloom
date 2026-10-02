import {PathGeometryError,type PathGeometry,type PathContour,type PathSegment,type PathPoint} from '../path-geometry.js';
import {validatePathGeometry} from '../path-contract.js';
import type {DeepReadonly} from '../ir/operations.js';
import {resampleCurveGeometry} from './curves.js';

export interface SegmentCorrespondence {source:string;target:string}
export interface ContourCorrespondence {source:string;target:string;segments?:SegmentCorrespondence[];reverseTarget?:boolean}
export interface CorrespondenceOptions {
  /** Correspondence is an author decision, never a nearest-shape guess. */
  approved:true;contours:ContourCorrespondence[];
  resample?:{count:number;tolerance?:number};unmatched?:'error'|'fade'|'create';
}
export interface CorrespondencePairReport {
  id:string;sourceContour:string;targetContour:string;reverseTarget:boolean;closed:boolean;
  sourceWinding:-1|0|1;targetWinding:-1|0|1;alignedTargetWinding:-1|0|1;
  representation:'controls'|'arc-length-polyline';sourceSegments:number;targetSegments:number;outputSegments:number;
  sourceZeroSegments:number;targetZeroSegments:number;
  segments:{source:string;target:string;promotedSource:boolean;promotedTarget:boolean}[];
  sampleCount?:number;tolerance?:number;
}
export interface CorrespondenceReport {
  version:1;approved:true;unmatched:'error'|'fade'|'create';pairs:CorrespondencePairReport[];
  sourceOnly:string[];targetOnly:string[];resampled:boolean;outputSegments:number;
  /** Original endpoints remain exact even when the interior uses a polyline. */
  endpointPolicy:'original-snapshots';
}
export interface PreparedCorrespondence {
  contract:'texloom-correspondence/1';source:PathGeometry;target:PathGeometry;
  pairs:{id:string;sourceContour:string;targetContour:string;source:PathContour;target:PathContour}[];
  sourceOnly:PathContour[];targetOnly:PathContour[];report:CorrespondenceReport;
}
export interface CorrespondenceSample {
  /** Full geometric union. Per-part opacity/reveal below is not baked into it. */
  geometry:PathGeometry;matched:PathGeometry;sourceOnly:PathGeometry;targetOnly:PathGeometry;
  sourceOpacity:number;targetOpacity:number;sourceReveal:number;targetReveal:number;
}
export const CORRESPONDENCE_MAX_CONTOURS=128,CORRESPONDENCE_MAX_SEGMENTS=8192,CORRESPONDENCE_MAX_SAMPLES=4096;
const MAX_OUTPUT=32768,MAX_RESAMPLE_WORK=2097152;
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
const object=(v:unknown):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const name=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.trim()===v;
const same=(a:readonly number[],b:readonly number[])=>a[0]===b[0]&&a[1]===b[1];
const copy=(p:DeepReadonly<PathPoint>):PathPoint=>[p[0],p[1]];
function fail(code:string,message:string):never{throw new PathGeometryError(code,message);}
function json(value:unknown,ancestors=new Set<object>(),depth=0):void {
  if(value===null||typeof value==='string'||typeof value==='boolean'||finite(value))return;
  if(depth>128||typeof value!=='object'||ancestors.has(value))fail('CORRESPONDENCE_DATA','Expected bounded, finite, acyclic JSON data.');
  const array=Array.isArray(value),prototype=Object.getPrototypeOf(value);
  if(array?prototype!==Array.prototype:prototype!==Object.prototype&&prototype!==null)fail('CORRESPONDENCE_DATA','Only ordinary JSON objects and arrays are supported.');
  if(Object.getOwnPropertySymbols(value).length)fail('CORRESPONDENCE_DATA','Symbol keys are unsupported.');
  const descriptors=Object.getOwnPropertyDescriptors(value);ancestors.add(value);
  if(array)for(let i=0;i<value.length;i++)if(!Object.hasOwn(descriptors,String(i)))fail('CORRESPONDENCE_DATA','Sparse arrays are unsupported.');
  for(const [key,d] of Object.entries(descriptors)){
    if(array&&key==='length')continue;
    if(!d.enumerable||!Object.hasOwn(d,'value')||array&&!/^(0|[1-9]\d*)$/.test(key))fail('CORRESPONDENCE_DATA','Accessors and non-JSON properties are unsupported.');
    json(d.value,ancestors,depth+1);
  }ancestors.delete(value);
}
function keys(value:object,allowed:string[]):void {for(const key of Object.keys(value))if(!allowed.includes(key))fail('CORRESPONDENCE_OPTIONS',`Unknown property ${key}.`);}
function freeze<T>(value:T):DeepReadonly<T>{
  const snapshot=structuredClone(value),visit=(v:any):void=>{if(v&&typeof v==='object'){Object.values(v).forEach(visit);Object.freeze(v);}};
  visit(snapshot);return snapshot as DeepReadonly<T>;
}
function geometry(input:DeepReadonly<PathGeometry>):PathGeometry{
  json(input);const errors=validatePathGeometry(input);if(errors.length)fail('CORRESPONDENCE_GEOMETRY',errors.map(e=>e.path+': '+e.message).join('\n'));
  if(input.contours.length>CORRESPONDENCE_MAX_CONTOURS||input.contours.reduce((n,c)=>n+c.segments.length,0)>CORRESPONDENCE_MAX_SEGMENTS)
    fail('CORRESPONDENCE_BUDGET','Geometry exceeds 128 contours or 8192 authored segments.');
  return structuredClone(input) as PathGeometry;
}
function blend(a:number,b:number,p:number):number{
  if(a===b||p===0)return a;if(p===1)return b;
  const difference=b-a,result=Number.isFinite(difference)?a+difference*p:(1-p)*a+p*b;
  if(!Number.isFinite(result))fail('CORRESPONDENCE_NONFINITE','Interpolation exceeded finite coordinates.');return result;
}
const mix=(a:DeepReadonly<PathPoint>,b:DeepReadonly<PathPoint>,p:number):PathPoint=>[blend(a[0],b[0],p),blend(a[1],b[1],p)];
function reverse(contour:PathContour):PathContour {
  const starts=[contour.start,...contour.segments.map(s=>s.to)];
  return {...structuredClone(contour),start:copy(starts.at(-1)!),segments:contour.segments.map((s,i)=>({s,i})).reverse().map(({s,i}):PathSegment=>
    s.kind==='line'?{kind:'line',id:s.id,to:copy(starts[i])}:{kind:'cubic',id:s.id,c1:copy(s.c2),c2:copy(s.c1),to:copy(starts[i])})};
}
function zeroCount(contour:PathContour):number{
  let previous=contour.start,count=0;
  for(const s of contour.segments){if(same(previous,s.to)&&(s.kind==='line'||same(previous,s.c1)&&same(previous,s.c2)))count++;previous=s.to;}
  return count;
}
/** Signed area integrates every cubic analytically in the Bernstein basis.
 * Coordinates are scaled and translated first, so finite large translations
 * do not overflow products. Near-zero area is explicitly degenerate. */
function winding(contour:PathContour):-1|0|1 {
  if(!contour.closed)return 0;
  const points=[contour.start,...contour.segments.flatMap(s=>s.kind==='line'?[s.to]:[s.c1,s.c2,s.to])];
  const scale=Math.max(...points.flatMap(p=>p.map(Math.abs)),Number.MIN_VALUE);
  const origin=[contour.start[0]/scale,contour.start[1]/scale],norm=(p:PathPoint):PathPoint=>[p[0]/scale-origin[0],p[1]/scale-origin[1]];
  const cross=(a:PathPoint,b:PathPoint)=>a[0]*b[1]-a[1]*b[0];
  let area=0,absolute=0,correction=0,start=norm(contour.start);
  const add=(value:number)=>{const corrected=value-correction,next=area+corrected;correction=(next-area)-corrected;area=next;absolute+=Math.abs(value);};
  for(const s of contour.segments){
    const to=norm(s.to);
    if(s.kind==='line')add(cross(start,to));
    else{
      const controls=[start,norm(s.c1),norm(s.c2),to],choose3=[1,3,3,1],choose2=[1,2,1],choose5=[1,5,10,10,5,1];
      for(let i=0;i<4;i++)for(let j=0;j<3;j++)add(.5*choose3[i]*choose2[j]/choose5[i+j]*cross(controls[i],[controls[j+1][0]-controls[j][0],controls[j+1][1]-controls[j][1]]));
    }
    start=to;
  }
  add(cross(start,norm(contour.start)));
  if(Math.abs(area)<=64*Number.EPSILON*absolute)return 0;
  return area>0?1:-1;
}
function normalized(contour:PathContour,id:string):PathContour{
  return {...structuredClone(contour),id,segments:contour.segments.map((s,i)=>({...structuredClone(s),id:`segment-${i}`}))};
}
function sampled(contour:PathContour,count:number,tolerance:number):PathContour {
  if(contour.closed&&count<3)fail('CORRESPONDENCE_RESAMPLE','Closed contours require at least three samples.');
  const drawable=contour.segments.length>zeroCount(contour);
  if(!drawable)return {id:contour.id,start:copy(contour.start),segments:Array.from({length:contour.closed?count:count-1},(_,i)=>({id:`sample-${i}`,kind:'line' as const,to:copy(contour.start)})),...(contour.closed===undefined?{}:{closed:contour.closed})};
  return structuredClone(resampleCurveGeometry({contours:[contour]},{mode:'length',count,tolerance}).geometry.contours[0]) as PathContour;
}
function promote(start:PathPoint,segment:PathSegment):PathSegment{
  return segment.kind==='cubic'?segment:{id:segment.id,kind:'cubic',c1:mix(start,segment.to,1/3),c2:mix(start,segment.to,2/3),to:copy(segment.to)};
}

export function prepareCorrespondence(sourceInput:DeepReadonly<PathGeometry>,targetInput:DeepReadonly<PathGeometry>,options:DeepReadonly<CorrespondenceOptions>):DeepReadonly<PreparedCorrespondence>{
  const source=geometry(sourceInput),target=geometry(targetInput);json(options);
  if(!object(options))fail('CORRESPONDENCE_OPTIONS','Expected correspondence options.');
  keys(options,['approved','contours','resample','unmatched']);
  if(options.approved!==true)fail('CORRESPONDENCE_APPROVAL','Explicit approved:true is required; suggestions do not authorize a morph.');
  if(!Array.isArray(options.contours)||options.contours.length>CORRESPONDENCE_MAX_CONTOURS)fail('CORRESPONDENCE_MAP','Expected at most 128 contour correspondences.');
  const policy=options.unmatched===undefined?'error':options.unmatched;
  if(!['error','fade','create'].includes(policy))fail('CORRESPONDENCE_UNMATCHED','Expected error, fade or create for unmatched contours.');
  let resample:{count:number;tolerance:number}|undefined;
  if(options.resample!==undefined){
    if(!object(options.resample))fail('CORRESPONDENCE_RESAMPLE','Expected explicit count resampling.');keys(options.resample,['count','tolerance']);
    const count=options.resample.count,tolerance=options.resample.tolerance===undefined?.05:options.resample.tolerance;
    if(!Number.isSafeInteger(count)||count<2||count>CORRESPONDENCE_MAX_SAMPLES||!finite(tolerance)||tolerance<=0)
      fail('CORRESPONDENCE_RESAMPLE','Resampling requires count 2..4096 and positive finite arc-length tolerance.');
    resample={count,tolerance};
  }
  const sourceById=new Map(source.contours.map(c=>[c.id,c])),targetById=new Map(target.contours.map(c=>[c.id,c]));
  const seenSource=new Set<string>(),seenTarget=new Set<string>(),pairs:PreparedCorrespondence['pairs']=[],reports:CorrespondencePairReport[]=[];
  let totalOutput=0,resampleWork=0;
  for(const [index,mapping] of options.contours.entries()){
    if(!object(mapping))fail('CORRESPONDENCE_MAP','Expected a contour mapping.');keys(mapping,['source','target','segments','reverseTarget']);
    if(!name(mapping.source)||!name(mapping.target)||!sourceById.has(mapping.source)||!targetById.has(mapping.target))fail('CORRESPONDENCE_MAP','Contour mapping must name existing source and target IDs.');
    if(seenSource.has(mapping.source)||seenTarget.has(mapping.target))fail('CORRESPONDENCE_DUPLICATE','Contour mapping must be one-to-one; clone instances explicitly.');
    seenSource.add(mapping.source);seenTarget.add(mapping.target);
    if(mapping.reverseTarget!==undefined&&typeof mapping.reverseTarget!=='boolean')fail('CORRESPONDENCE_MAP','reverseTarget must be boolean.');
    const a=sourceById.get(mapping.source)!,originalB=targetById.get(mapping.target)!,b=mapping.reverseTarget?reverse(originalB):structuredClone(originalB);
    if(!!a.closed!==!!b.closed)fail('CORRESPONDENCE_CLOSED',`Closed state differs for ${a.id} and ${b.id}; use explicit unmatched contours instead.`);
    const wa=winding(a),wb=winding(originalB),aligned=winding(b);
    if(a.closed&&wa!==aligned)fail('CORRESPONDENCE_WINDING',`Winding differs for ${a.id} (${wa}) and ${b.id} (${aligned}); reverse explicitly or choose another mapping.`);
    const id=`morph-pair-${index}`,segmentReport:CorrespondencePairReport['segments']=[];
    let from:PathContour,to:PathContour;
    if(resample){
      if(mapping.segments!==undefined)fail('CORRESPONDENCE_MAP','Arc-length resampling and authored segment correspondence cannot be combined.');
      totalOutput+=a.closed?resample.count:resample.count-1;
      resampleWork+=resample.count*Math.max(1,a.segments.length+b.segments.length);
      if(totalOutput>MAX_OUTPUT||resampleWork>MAX_RESAMPLE_WORK)fail('CORRESPONDENCE_BUDGET','Resampling exceeds the total output or preparation work budget.');
      from=normalized(sampled(a,resample.count,resample.tolerance),id);to=normalized(sampled(b,resample.count,resample.tolerance),id);
    }else{
      if(!Array.isArray(mapping.segments)||mapping.segments.length!==a.segments.length||mapping.segments.length!==b.segments.length)
        fail('CORRESPONDENCE_TOPOLOGY','Control correspondence must cover every authored segment; unequal counts require explicit resampling.');
      const usedA=new Set<string>(),usedB=new Set<string>();
      mapping.segments.forEach((pair:any,i:number)=>{
        if(!object(pair))fail('CORRESPONDENCE_MAP','Expected a segment mapping.');keys(pair,['source','target']);
        if(!name(pair.source)||!name(pair.target)||usedA.has(pair.source)||usedB.has(pair.target))fail('CORRESPONDENCE_DUPLICATE','Segment mapping must contain unique explicit IDs.');
        usedA.add(pair.source);usedB.add(pair.target);
        if(pair.source!==a.segments[i].id||pair.target!==b.segments[i].id)fail('CORRESPONDENCE_ORDER','Segment mappings must follow both contour traversals; arbitrary reordering would disconnect the path.');
        segmentReport.push({source:pair.source,target:pair.target,promotedSource:a.segments[i].kind==='line'&&b.segments[i].kind==='cubic',promotedTarget:a.segments[i].kind==='cubic'&&b.segments[i].kind==='line'});
      });
      from=normalized(a,id);to=normalized(b,id);let aStart=copy(from.start),bStart=copy(to.start);
      for(let i=0;i<from.segments.length;i++){
        if(from.segments[i].kind!==to.segments[i].kind){from.segments[i]=promote(aStart,from.segments[i]);to.segments[i]=promote(bStart,to.segments[i]);}
        aStart=copy(from.segments[i].to);bStart=copy(to.segments[i].to);
      }
      totalOutput+=from.segments.length;
      if(totalOutput>MAX_OUTPUT)fail('CORRESPONDENCE_BUDGET','Control correspondence exceeds the output segment budget.');
    }
    pairs.push({id,sourceContour:a.id,targetContour:b.id,source:from,target:to});
    reports.push({id,sourceContour:a.id,targetContour:b.id,reverseTarget:!!mapping.reverseTarget,closed:!!a.closed,
      sourceWinding:wa,targetWinding:wb,alignedTargetWinding:aligned,representation:resample?'arc-length-polyline':'controls',
      sourceSegments:a.segments.length,targetSegments:b.segments.length,outputSegments:from.segments.length,
      sourceZeroSegments:zeroCount(a),targetZeroSegments:zeroCount(originalB),segments:segmentReport,...(resample?{sampleCount:resample.count,tolerance:resample.tolerance}:{})});
  }
  const sourceOnly=source.contours.filter(c=>!seenSource.has(c.id)),targetOnly=target.contours.filter(c=>!seenTarget.has(c.id));
  if(policy==='error'&&(sourceOnly.length||targetOnly.length))fail('CORRESPONDENCE_UNMATCHED',`Unmatched contours: source [${sourceOnly.map(c=>c.id)}], target [${targetOnly.map(c=>c.id)}].`);
  totalOutput+=[...sourceOnly,...targetOnly].reduce((count,contour)=>count+contour.segments.length,0);
  if(totalOutput>MAX_OUTPUT)fail('CORRESPONDENCE_BUDGET','Matched and unmatched contours together exceed the output segment budget.');
  return freeze({contract:'texloom-correspondence/1',source,target,pairs,sourceOnly,targetOnly,
    report:{version:1,approved:true,unmatched:policy,pairs:reports,sourceOnly:sourceOnly.map(c=>c.id),targetOnly:targetOnly.map(c=>c.id),
      resampled:!!resample,outputSegments:totalOutput,endpointPolicy:'original-snapshots'}} as PreparedCorrespondence);
}

function interpolateContour(a:DeepReadonly<PathContour>,b:DeepReadonly<PathContour>,progress:number):PathContour{
  return {id:a.id,start:mix(a.start,b.start,progress),...(a.closed===undefined?{}:{closed:a.closed}),segments:a.segments.map((s,i):PathSegment=>{
    const t=b.segments[i];
    if(s.kind!==t.kind)fail('CORRESPONDENCE_PREPARED','Prepared segment kinds do not match.');
    return s.kind==='cubic'&&t.kind==='cubic'?{id:s.id,kind:'cubic',c1:mix(s.c1,t.c1,progress),c2:mix(s.c2,t.c2,progress),to:mix(s.to,t.to,progress)}:
      {id:s.id,kind:'line',to:mix(s.to,t.to,progress)};
  })};
}
/** Prepared records are immutable and portable; consumers should only pass a
 * record produced by prepareCorrespondence, not infer geometric alignment. */
export function sampleCorrespondence(prepared:DeepReadonly<PreparedCorrespondence>,progress:number):DeepReadonly<CorrespondenceSample>{
  if(!finite(progress)||progress<0||progress>1)fail('CORRESPONDENCE_PROGRESS','Progress must be finite and in [0,1].');
  if(!prepared||prepared.contract!=='texloom-correspondence/1')fail('CORRESPONDENCE_PREPARED','Expected prepared correspondence version 1.');
  const sourceMapped=new Set(prepared.pairs.map(p=>p.sourceContour)),targetMapped=new Set(prepared.pairs.map(p=>p.targetContour));
  const matched:PathGeometry=progress===0?{contours:structuredClone(prepared.source.contours.filter(c=>sourceMapped.has(c.id))) as PathContour[]}:
    progress===1?{contours:structuredClone(prepared.target.contours.filter(c=>targetMapped.has(c.id))) as PathContour[]}:
    {contours:prepared.pairs.map(p=>interpolateContour(p.source,p.target,progress))};
  const sourceOnly:PathGeometry={contours:prepared.sourceOnly.map((c,i)=>progress===0||progress===1?structuredClone(c) as PathContour:normalized(structuredClone(c) as PathContour,`morph-source-${i}`))};
  const targetOnly:PathGeometry={contours:prepared.targetOnly.map((c,i)=>progress===0||progress===1?structuredClone(c) as PathContour:normalized(structuredClone(c) as PathContour,`morph-target-${i}`))};
  const geometry:PathGeometry=progress===0?structuredClone(prepared.source) as PathGeometry:progress===1?structuredClone(prepared.target) as PathGeometry:
    {contours:[...matched.contours,...sourceOnly.contours,...targetOnly.contours]};
  const create=prepared.report.unmatched==='create';
  return freeze({geometry,matched,sourceOnly,targetOnly,sourceOpacity:progress===1?0:create?1:1-progress,
    targetOpacity:progress===0?0:create?1:progress,sourceReveal:create?1-progress:1,targetReveal:create?progress:1});
}
