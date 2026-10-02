import {PathGeometryError,evaluateSegment,splitSegment,geometryLength,sampleGeometry,transformGeometry,
  type PathGeometry,type PathContour,type PathSegment,type PathPoint,type PathProgressMode,type PathMatrix} from '../path-geometry.js';
import {validatePathGeometry} from '../path-contract.js';
import type {DeepReadonly} from '../ir/operations.js';

export type CurveScope={kind:'whole'}|{kind:'contour';contourId:string};
export interface CurveOptions {mode?:PathProgressMode;scope?:CurveScope;tolerance?:number}
export interface CurveTrimOptions extends CurveOptions {wrap?:boolean}
export interface CurveResampleOptions extends CurveOptions {count?:number;spacing?:number}
export type CurveJoinPolicy='separate'|'coincident'|'bridge';
export interface CurveSourceRef {geometryId?:string;contourId:string;segmentId:string;parameterInterval:[number,number];closing:boolean}
export interface CurveProvenanceSegment {contourId:string;segmentId:string;mapping:'exact'|'approximate'|'synthetic';sources:CurveSourceRef[]}
export interface CurveProvenance {version:1;segments:CurveProvenanceSegment[]}
export interface CurveReport {
  operation:'trim'|'reverse'|'resample'|'join';representation:'exact'|'polyline';inputSegments:number;outputSegments:number;
  tolerance:number;sampleCount?:number;spacing?:number;policy?:CurveJoinPolicy;
}
export interface CurveResult {geometry:DeepReadonly<PathGeometry>;provenance:DeepReadonly<CurveProvenance>;report:DeepReadonly<CurveReport>}
export interface CurveSample {
  position:PathPoint;tangent:PathPoint;length:number;totalLength:number;contourId:string;segmentId:string;localParameter:number;
  mapping:'exact'|'approximate'|'synthetic';sourceRefs:CurveSourceRef[];
}
export interface CurveInput {geometry:DeepReadonly<PathGeometry>;provenance?:DeepReadonly<CurveProvenance>}
export interface TransformedCurveInput {geometry:DeepReadonly<PathGeometry>;provenance:DeepReadonly<CurveProvenance>}
const MAX_OUTPUT=131072,MAX_COUNT=65536;
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
const obj=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const same=(a:readonly number[],b:readonly number[])=>a[0]===b[0]&&a[1]===b[1];
const copy=(p:readonly [number,number]):PathPoint=>[...p];
const key=(contour:string,segment:string)=>JSON.stringify([contour,segment]);
const nonempty=(v:unknown):v is string=>typeof v==='string'&&v.length>0;
function fail(code:string,message:string):never {throw new PathGeometryError(code,message);}
function json(value:unknown,ancestors=new Set<object>(),depth=0):void {
  if(value===null||typeof value==='string'||typeof value==='boolean'||finite(value))return;
  if(depth>128||typeof value!=='object'||ancestors.has(value))fail('CURVE_DATA','Expected finite, acyclic JSON data.');
  const prototype=Object.getPrototypeOf(value),array=Array.isArray(value);
  if(array?prototype!==Array.prototype:prototype!==Object.prototype&&prototype!==null)fail('CURVE_DATA','Only plain JSON data is supported.');
  if(Object.getOwnPropertySymbols(value).length)fail('CURVE_DATA','Symbol keys are unsupported.');
  const descriptors=Object.getOwnPropertyDescriptors(value);ancestors.add(value);
  if(array)for(let i=0;i<value.length;i++)if(!Object.hasOwn(descriptors,String(i)))fail('CURVE_DATA','Sparse arrays are unsupported.');
  for(const [name,descriptor] of Object.entries(descriptors)) {
    if(array&&name==='length')continue;
    if(!descriptor.enumerable||!Object.hasOwn(descriptor,'value')||array&&!/^(0|[1-9]\d*)$/.test(name))fail('CURVE_DATA','Expected ordinary enumerable JSON properties.');
    json(descriptor.value,ancestors,depth+1);
  }
  ancestors.delete(value);
}
function keys(value:Record<string,unknown>,allowed:readonly string[]):void {
  if(Object.keys(value).some(k=>!allowed.includes(k)))fail('CURVE_OPTIONS','Unknown curve property.');
}
function frozen<T>(value:T):DeepReadonly<T> {
  const snapshot=structuredClone(value),freeze=(v:any):void=>{if(v&&typeof v==='object'){for(const child of Object.values(v))freeze(child);Object.freeze(v);}};
  freeze(snapshot);return snapshot as DeepReadonly<T>;
}
function geometry(value:DeepReadonly<PathGeometry>):PathGeometry {
  json(value);const errors=validatePathGeometry(value);if(errors.length)fail('INVALID_PATH_GEOMETRY',errors.map(e=>e.path+': '+e.message).join('\n'));
  return structuredClone(value) as PathGeometry;
}
interface Entry {contourId:string;contourIndex:number;start:PathPoint;segment:PathSegment;closing:boolean;drawable:boolean}
function inventory(g:PathGeometry):Entry[] {
  const entries:Entry[]=[];
  g.contours.forEach((c,contourIndex)=>{
    let start=c.start;
    for(const segment of c.segments) {
      entries.push({contourId:c.id,contourIndex,start,segment,closing:false,drawable:!same(start,segment.to)||segment.kind==='cubic'&&(!same(start,segment.c1)||!same(start,segment.c2))});
      start=segment.to;
    }
    if(c.closed&&!same(start,c.start))entries.push({contourId:c.id,contourIndex,start,segment:{kind:'line',id:c.id+':close',to:copy(c.start)},closing:true,drawable:true});
  });return entries;
}
export function seedCurveProvenance(input:DeepReadonly<PathGeometry>,geometryId?:string):DeepReadonly<CurveProvenance> {
  const g=geometry(input);if(geometryId!==undefined&&!nonempty(geometryId))fail('CURVE_PROVENANCE','geometryId must be nonempty.');
  return frozen({version:1,segments:inventory(g).map(e=>({contourId:e.contourId,segmentId:e.segment.id,mapping:'exact',sources:[{
    ...(geometryId===undefined?{}:{geometryId}),contourId:e.contourId,segmentId:e.segment.id,parameterInterval:[0,1],closing:e.closing}]}))} as CurveProvenance);
}
export function assertCurveProvenance(input:DeepReadonly<PathGeometry>,value:unknown):asserts value is DeepReadonly<CurveProvenance> {
  const g=geometry(input);json(value);
  if(!obj(value)||value.version!==1||!Array.isArray(value.segments))fail('CURVE_PROVENANCE','Expected curve provenance version 1.');keys(value,['version','segments']);
  const remaining=new Set(inventory(g).map(e=>key(e.contourId,e.segment.id)));let sourceCount=0;
  for(const item of value.segments) {
    if(!obj(item)||!nonempty(item.contourId)||!nonempty(item.segmentId)||!remaining.delete(key(item.contourId,item.segmentId))||
      !['exact','approximate','synthetic'].includes(item.mapping as string)||!Array.isArray(item.sources))fail('CURVE_PROVENANCE','Provenance must cover each current segment exactly once.');
    keys(item,['contourId','segmentId','mapping','sources']);
    if(item.mapping==='exact'&&item.sources.length!==1||item.mapping==='synthetic'&&item.sources.length!==0||item.mapping==='approximate'&&item.sources.length===0)
      fail('CURVE_PROVENANCE','Exact, approximate and synthetic mappings require one, nonempty and zero source ranges respectively.');
    sourceCount+=item.sources.length;if(sourceCount>MAX_OUTPUT*8)fail('CURVE_BUDGET','Provenance source ranges exceed the supported budget.');
    for(const source of item.sources) {
      if(!obj(source)||!nonempty(source.contourId)||!nonempty(source.segmentId)||source.geometryId!==undefined&&!nonempty(source.geometryId)||
        typeof source.closing!=='boolean'||!Array.isArray(source.parameterInterval)||source.parameterInterval.length!==2||
        !source.parameterInterval.every(v=>finite(v)&&v>=0&&v<=1))fail('CURVE_PROVENANCE','Invalid original segment range.');
      keys(source,['geometryId','contourId','segmentId','parameterInterval','closing']);
    }
  }
  if(remaining.size)fail('CURVE_PROVENANCE','Provenance is missing current segments.');
}
function sourceMap(g:PathGeometry,provenance?:DeepReadonly<CurveProvenance>,geometryId?:string):Map<string,CurveProvenanceSegment> {
  if(provenance!==undefined)assertCurveProvenance(g,provenance);
  const source=provenance??seedCurveProvenance(g,geometryId);
  return new Map(source.segments.map(s=>[key(s.contourId,s.segmentId),structuredClone(s) as CurveProvenanceSegment]));
}
function provenanceRange(source:CurveProvenanceSegment,a:number,b:number,contourId:string,segmentId:string):CurveProvenanceSegment {
  const result=structuredClone(source);result.contourId=contourId;result.segmentId=segmentId;
  if(result.mapping==='exact') {
    const [from,to]=result.sources[0].parameterInterval;
    result.sources[0].parameterInterval=[(1-a)*from+a*to,(1-b)*from+b*to];
  } else if(b<a)result.sources=result.sources.reverse().map(s=>({...s,parameterInterval:[s.parameterInterval[1],s.parameterInterval[0]]}));
  return result;
}
/** Forward singular transforms may collapse a formerly implicit closing edge.
 * Keep that source edge as an explicit degenerate line so its provenance does
 * not disappear or become stale. Historical transformGeometry is unchanged. */
export function transformCurveInput(input:CurveInput,matrix:readonly [number,number,number,number,number,number]):TransformedCurveInput {
  const g=geometry(input.geometry),sources=sourceMap(g,input.provenance);json(matrix);
  const transformed=transformGeometry(g,[...matrix] as PathMatrix),metadata:CurveProvenanceSegment[]=[];
  for(const entry of inventory(g)) {
    let segmentId=entry.segment.id;
    if(entry.closing) {
      const contour=transformed.contours[entry.contourIndex],endpoint=contour.segments.at(-1)?.to??contour.start;
      if(same(endpoint,contour.start)) {
        const ids=new Set(contour.segments.map(segment=>segment.id));segmentId='transform-close';
        for(let serial=1;ids.has(segmentId)||segmentId===contour.id+':close';serial++)segmentId='transform-close-'+serial;
        contour.segments.push({id:segmentId,kind:'line',to:copy(contour.start)});
      }
    }
    metadata.push(provenanceRange(sources.get(key(entry.contourId,entry.segment.id))!,0,1,entry.contourId,segmentId));
  }
  const provenance:CurveProvenance={version:1,segments:metadata};assertCurveProvenance(transformed,provenance);
  return frozen({geometry:transformed,provenance});
}
function settings(options:CurveOptions,extra:string[]=[]):Required<CurveOptions> {
  json(options);if(!obj(options))fail('CURVE_OPTIONS','Expected curve options.');keys(options,['mode','scope','tolerance',...extra]);
  const mode=options.mode??'length',scope=options.scope??{kind:'whole'},tolerance=options.tolerance??.05;
  if(mode!=='parameter'&&mode!=='length'||!finite(tolerance)||tolerance<=0)fail('CURVE_OPTIONS','Expected parameter/length mode and positive finite tolerance.');
  if(!obj(scope)||scope.kind!=='whole'&&scope.kind!=='contour'||scope.kind==='contour'&&!nonempty(scope.contourId))fail('CURVE_SCOPE','Expected whole or named contour scope.');
  keys(scope,scope.kind==='whole'?['kind']:['kind','contourId']);return {mode,scope:scope as CurveScope,tolerance};
}
function selection(g:PathGeometry,scope:CurveScope):PathGeometry {
  if(scope.kind==='whole')return g;const c=g.contours.find(c=>c.id===scope.contourId);
  if(!c)fail('CURVE_SCOPE',`Unknown contour ${scope.contourId}.`);return {contours:[c]};
}
const segmentGeometry=(start:PathPoint,segment:PathSegment):PathGeometry=>({contours:[{id:'measure',start,segments:[segment]}]});
const checked=(p:PathPoint):PathPoint=>{if(!p.every(Number.isFinite))fail('CURVE_NONFINITE','Curve produced nonfinite coordinates.');return p;};
function portion(entry:Entry,a:number,b:number):{start:PathPoint;segment:PathSegment} {
  const start=checked(evaluateSegment(entry.start,entry.segment,a));
  if(a===0&&b===1)return {start,segment:structuredClone(entry.segment)};
  const left=b===1?structuredClone(entry.segment):splitSegment(entry.start,entry.segment,b)[0];
  const segment=a===0?left:splitSegment(entry.start,left,a/b)[1];
  checked(segment.to);if(segment.kind==='cubic'){checked(segment.c1);checked(segment.c2);}return {start,segment};
}
interface Context {entries:Entry[];lengths:number[];prefix:number[];total:number;budget:number}
function context(g:PathGeometry,tolerance:number):Context {
  const entries=inventory(g).filter(e=>e.drawable),budget=tolerance/(8*Math.max(1,entries.length));
  if(budget===0)fail('CURVE_TOLERANCE','Length budget is below representable precision.');
  const lengths=entries.map(e=>geometryLength(segmentGeometry(e.start,e.segment),budget)),prefix=[0];
  for(const length of lengths){const sum=prefix.at(-1)!+length;if(!Number.isFinite(sum))fail('CURVE_NONFINITE','Total curve length is nonfinite.');prefix.push(sum);}
  return {entries,lengths,prefix,total:prefix.at(-1)!,budget};
}
interface Location {index:number;t:number}
function progress(value:number):void {if(!finite(value)||value<0||value>1)fail('CURVE_PROGRESS','Progress must be finite and in [0,1].');}
function locate(ctx:Context,p:number,mode:PathProgressMode,tolerance:number):Location {
  const n=ctx.entries.length;if(!n)fail('DEGENERATE_GEOMETRY','Curve sampling requires a drawable segment.');
  if(p===0)return {index:0,t:0};if(p===1)return {index:n-1,t:1};
  if(mode==='parameter'){const q=p*n,index=Math.min(n-1,Math.floor(q));return {index,t:q-index};}
  const target=p*ctx.total;let low=0,high=n;
  while(low<high){const mid=(low+high)>>>1;if(ctx.prefix[mid+1]<=target)low=mid+1;else high=mid;}
  const index=Math.min(n-1,low),remaining=target-ctx.prefix[index],entry=ctx.entries[index];
  if(remaining<=0)return {index,t:0};if(remaining>=ctx.lengths[index])return {index,t:1};
  if(entry.segment.kind==='line')return {index,t:remaining/ctx.lengths[index]};
  let lo=0,hi=1;
  for(let iteration=0;iteration<64;iteration++) {
    const mid=(lo+hi)/2,left=splitSegment(entry.start,entry.segment,mid)[0],length=geometryLength(segmentGeometry(entry.start,left),ctx.budget);
    if(Math.abs(length-remaining)<=tolerance/4)return {index,t:mid};
    if(length<remaining)lo=mid;else hi=mid;if(mid===(lo+hi)/2)break;
  }
  fail('ARC_LENGTH_TOLERANCE','Curve arc length cannot be inverted within tolerance.');
}
function cuts(ctx:Context,start:number,end:number,mode:PathProgressMode,tolerance:number):{entry:Entry;a:number;b:number}[] {
  if(start===end||!ctx.entries.length)return [];
  const from=locate(ctx,start,mode,tolerance),to=locate(ctx,end,mode,tolerance),result=[];
  for(let i=from.index;i<=to.index;i++){const a=i===from.index?from.t:0,b=i===to.index?to.t:1;if(b>a)result.push({entry:ctx.entries[i],a,b});}
  return result;
}
function finish(g:PathGeometry,segments:CurveProvenanceSegment[],report:Omit<CurveReport,'outputSegments'>):CurveResult {
  const count=inventory(g).length;if(count>MAX_OUTPUT)fail('CURVE_BUDGET','Curve output exceeds 131072 segments.');
  const provenance:CurveProvenance={version:1,segments};assertCurveProvenance(g,provenance);
  return frozen({geometry:g,provenance,report:{...report,outputSegments:count}});
}

export function sampleCurveGeometry(input:DeepReadonly<PathGeometry>,p:number,options:CurveOptions={},provenance?:DeepReadonly<CurveProvenance>):CurveSample {
  const g=geometry(input),opts=settings(options),selected=selection(g,opts.scope),sources=sourceMap(g,provenance),ctx=context(selected,opts.tolerance);progress(p);
  const at=locate(ctx,p,opts.mode,opts.tolerance),entry=ctx.entries[at.index],sample=sampleGeometry(segmentGeometry(entry.start,entry.segment),at.t,'parameter',opts.tolerance);
  const partial=at.t===0?0:at.t===1?ctx.lengths[at.index]:geometryLength(segmentGeometry(entry.start,splitSegment(entry.start,entry.segment,at.t)[0]),ctx.budget);
  const mapped=provenanceRange(sources.get(key(entry.contourId,entry.segment.id))!,at.t,at.t,entry.contourId,entry.segment.id);
  return {position:checked(sample.point),tangent:checked(sample.tangent),length:ctx.prefix[at.index]+partial,totalLength:ctx.total,
    contourId:entry.contourId,segmentId:entry.segment.id,localParameter:at.t,mapping:mapped.mapping,sourceRefs:mapped.sources};
}

export function trimCurveGeometry(input:DeepReadonly<PathGeometry>,start:number,end:number,options:CurveTrimOptions={},provenance?:DeepReadonly<CurveProvenance>):CurveResult {
  const g=geometry(input),opts=settings(options,['wrap']),selected=selection(g,opts.scope),sources=sourceMap(g,provenance);progress(start);progress(end);
  if(options.wrap!==undefined&&typeof options.wrap!=='boolean')fail('CURVE_OPTIONS','wrap must be boolean.');
  if(options.wrap&&(selected.contours.length!==1||!selected.contours[0].closed))fail('CURVE_WRAP','Wrap requires exactly one selected closed contour.');
  if(start>end&&!options.wrap)fail('CURVE_RANGE','A decreasing trim range requires explicit wrap.');
  const report={operation:'trim' as const,representation:'exact' as const,inputSegments:inventory(selected).length,tolerance:opts.tolerance};
  if(start===0&&end===1)return finish(selected,inventory(selected).map(e=>sources.get(key(e.contourId,e.segment.id))!),report);
  const ctx=context(selected,opts.tolerance),parts=start>end?[...cuts(ctx,start,1,opts.mode,opts.tolerance),...cuts(ctx,0,end,opts.mode,opts.tolerance)]:cuts(ctx,start,end,opts.mode,opts.tolerance);
  const out:PathGeometry={contours:[]},metadata:CurveProvenanceSegment[]=[];
  if(!parts.length) {
    if(selected.contours.length){let id=selected.contours[0].id;const point=ctx.entries.length?(()=>{const at=locate(ctx,start,opts.mode,opts.tolerance),e=ctx.entries[at.index];id=e.contourId;return evaluateSegment(e.start,e.segment,at.t);})():selected.contours[0].start;
      out.contours.push({id,start:checked(copy(point)),segments:[],closed:false});}
    return finish(out,metadata,report);
  }
  for(const part of parts) {
    let contour=out.contours.at(-1);const piece=portion(part.entry,part.a,part.b);
    if(!contour||contour.id!==part.entry.contourId){contour={id:part.entry.contourId,start:piece.start,segments:[],closed:false};out.contours.push(contour);}
    const id='trim-'+contour.segments.length;contour.segments.push({...piece.segment,id});
    metadata.push(provenanceRange(sources.get(key(part.entry.contourId,part.entry.segment.id))!,part.a,part.b,contour.id,id));
  }
  if(start<=end)for(const contour of out.contours) {
    const all=ctx.entries.filter(e=>e.contourId===contour.id),kept=parts.filter(p=>p.entry.contourId===contour.id),original=selected.contours.find(c=>c.id===contour.id)!;
    contour.closed=!!original.closed&&kept.length===all.length&&kept[0].a===0&&kept.at(-1)!.b===1;
  }
  return finish(out,metadata,report);
}

export function reverseCurveGeometry(input:DeepReadonly<PathGeometry>,options:CurveOptions={},provenance?:DeepReadonly<CurveProvenance>):CurveResult {
  const g=geometry(input),opts=settings(options),selected=selection(g,opts.scope),sources=sourceMap(g,provenance),entries=inventory(selected);
  const out:PathGeometry={contours:[]},metadata:CurveProvenanceSegment[]=[];
  for(const contour of [...selected.contours].reverse()) {
    const items=entries.filter(e=>e.contourId===contour.id).reverse(),reversed:PathContour={id:contour.id,start:copy(items[0]?.segment.to??contour.start),segments:[],closed:!!contour.closed};
    for(const [i,entry] of items.entries()) {
      const id='reverse-'+i,segment:PathSegment=entry.segment.kind==='line'?{id,kind:'line',to:copy(entry.start)}:
        {id,kind:'cubic',c1:copy(entry.segment.c2),c2:copy(entry.segment.c1),to:copy(entry.start)};
      reversed.segments.push(segment);metadata.push(provenanceRange(sources.get(key(entry.contourId,entry.segment.id))!,1,0,contour.id,id));
    }out.contours.push(reversed);
  }
  return finish(out,metadata,{operation:'reverse',representation:'exact',inputSegments:entries.length,tolerance:opts.tolerance});
}

export function resampleCurveGeometry(input:DeepReadonly<PathGeometry>,options:CurveResampleOptions,provenance?:DeepReadonly<CurveProvenance>):CurveResult {
  const g=geometry(input),opts=settings(options,['count','spacing']),selected=selection(g,opts.scope),sources=sourceMap(g,provenance);
  if((options.count===undefined)===(options.spacing===undefined))fail('CURVE_OPTIONS','Resample requires exactly one of count or spacing.');
  if(options.count!==undefined&&(!Number.isSafeInteger(options.count)||options.count<2||options.count>MAX_COUNT))fail('CURVE_COUNT','count must be an integer from 2 through 65536.');
  if(options.spacing!==undefined&&(!finite(options.spacing)||options.spacing<=0||opts.mode!=='length'))fail('CURVE_SPACING','spacing must be positive finite bp and requires length mode.');
  const out:PathGeometry={contours:[]},metadata:CurveProvenanceSegment[]=[];let sampleCount=0;
  for(const contour of selected.contours) {
    const ctx=context({contours:[contour]},opts.tolerance);
    if(!ctx.entries.length){out.contours.push({id:contour.id,start:copy(contour.start),segments:[],closed:!!contour.closed});
      if(++sampleCount>MAX_OUTPUT)fail('CURVE_BUDGET','Resampling exceeds the total sample budget.');continue;}
    const count=options.count??(contour.closed?Math.max(3,Math.ceil(ctx.total/options.spacing!)):Math.max(2,Math.ceil(ctx.total/options.spacing!)+1));
    if(count>(MAX_COUNT)||!Number.isFinite(count)||sampleCount+count>MAX_OUTPUT)fail('CURVE_BUDGET','Resampling exceeds the per-contour or total sample budget.');
    if(contour.closed&&count<3)fail('CURVE_COUNT','Closed contours require at least three samples.');sampleCount+=count;
    const denominator=contour.closed?count:count-1,points:PathPoint[]=[];
    for(let i=0;i<count;i++){const at=locate(ctx,i/denominator,opts.mode,opts.tolerance),entry=ctx.entries[at.index];points.push(checked(evaluateSegment(entry.start,entry.segment,at.t)));}
    const result:PathContour={id:contour.id,start:points[0],segments:[],closed:!!contour.closed},segmentCount=contour.closed?count:count-1;
    for(let i=0;i<segmentCount;i++) {
      const id='sample-'+i;result.segments.push({id,kind:'line',to:copy(points[(i+1)%count])});
      const refs:CurveSourceRef[]=[];
      for(const part of cuts(ctx,i/denominator,(i+1)/denominator,opts.mode,opts.tolerance))
        refs.push(...provenanceRange(sources.get(key(part.entry.contourId,part.entry.segment.id))!,part.a,part.b,contour.id,id).sources);
      metadata.push({contourId:contour.id,segmentId:id,mapping:refs.length?'approximate':'synthetic',sources:refs});
    }out.contours.push(result);
  }
  return finish(out,metadata,{operation:'resample',representation:'polyline',inputSegments:inventory(selected).length,tolerance:opts.tolerance,sampleCount,
    ...(options.spacing===undefined?{}:{spacing:options.spacing})});
}

export function joinCurveGeometries(inputs:readonly CurveInput[],options:{policy:CurveJoinPolicy;tolerance?:number}):CurveResult {
  json(options);if(!obj(options))fail('CURVE_OPTIONS','Expected join options.');keys(options,['policy','tolerance']);
  if(!['separate','coincident','bridge'].includes(options.policy))fail('CURVE_JOIN','Unknown join policy.');
  const tolerance=options.tolerance??.05;if(!finite(tolerance)||tolerance<=0)fail('CURVE_OPTIONS','Tolerance must be positive finite.');
  json(inputs);if(!Array.isArray(inputs))fail('CURVE_OPTIONS','Join inputs must be an array.');
  const out:PathGeometry={contours:[]},metadata:CurveProvenanceSegment[]=[];let inputSegments=0;
  for(const [inputIndex,input] of inputs.entries()) {
    if(!obj(input))fail('CURVE_OPTIONS','Expected geometry and optional provenance.');keys(input,['geometry','provenance']);
    const typed=input as unknown as CurveInput,g=geometry(typed.geometry),sources=sourceMap(g,typed.provenance,'join-input-'+inputIndex),entries=inventory(g);inputSegments+=entries.length;
    for(const [contourIndex,contour] of g.contours.entries()) {
      if(options.policy==='separate') {
        const id=`join-${inputIndex}-${contourIndex}`,cloned=structuredClone(contour);cloned.id=id;
        cloned.segments.forEach((segment,i)=>{segment.id='segment-'+i;});out.contours.push(cloned);
        let index=0;for(const entry of entries.filter(e=>e.contourId===contour.id))metadata.push(provenanceRange(sources.get(key(entry.contourId,entry.segment.id))!,0,1,id,entry.closing?id+':close':'segment-'+index++));
        continue;
      }
      if(contour.closed)fail('CURVE_JOIN_CLOSED','Stitching closed contours requires an explicit trim first.');
      let target=out.contours[0];if(!target){target={id:'join',start:copy(contour.start),segments:[],closed:false};out.contours.push(target);}
      const endpoint=target.segments.at(-1)?.to??target.start;
      if(!same(endpoint,contour.start)) {
        if(options.policy==='coincident')fail('CURVE_JOIN_GAP','Coincident join requires exactly equal endpoints.');
        const id='join-'+target.segments.length;target.segments.push({id,kind:'line',to:copy(contour.start)});metadata.push({contourId:'join',segmentId:id,mapping:'synthetic',sources:[]});
      }
      for(const entry of entries.filter(e=>e.contourId===contour.id)) {
        const id='join-'+target.segments.length;target.segments.push({...structuredClone(entry.segment),id});
        metadata.push(provenanceRange(sources.get(key(entry.contourId,entry.segment.id))!,0,1,'join',id));
      }
    }
  }
  return finish(out,metadata,{operation:'join',representation:'exact',inputSegments,tolerance,policy:options.policy});
}
