import {PathGeometryError, type PathGeometry, type PathContour, type PathPoint} from '../path-geometry.js';
import type {DeepReadonly} from '../ir/operations.js';

export interface AdaptiveSamplingOptions {
  /** Parameter intervals, in increasing order. Distinct intervals are never joined. */
  domains:[number,number][];
  /** Topological holes only: a break is not a finite-width clipping region around a pole. */
  breaks?:number[];
  /** Probe tolerance at the caller's chart density; chart-bp tolerance is tolerance / pixelsPerBp. */
  tolerance?:number; pixelsPerBp?:number;
  initialSegments?:number; maxDepth?:number; maxSamples?:number; maxSegments?:number;
  /** Maximum accepted chord/probe separation, in the evaluator's chart bp. */
  maxJump?:number;
}
export interface DataSamplingOptions {maxSamples?:number;maxSegments?:number;maxJump?:number}
export interface SamplingGap {domain:[number,number];reason:'masked'|'break'}
export interface SamplingReport {
  sampleCount:number;segmentCount:number;contourCount:number;maskedIntervals:number;
  maxDepthReached:number;maxObservedError:number;maxAcceptedError:number;
  /** These errors describe evaluated probes, never a global approximation guarantee. */
  qualityMetric:'observed-probes';tolerance:number;pixelsPerBp:number;gaps:SamplingGap[];
}
export interface SampledPlot {geometry:PathGeometry;report:SamplingReport}
export type CurveEvaluator=(parameter:number)=>DeepReadonly<PathPoint>|null;
const MAX_SAMPLES=262144,MAX_SEGMENTS=131072,MAX_INTERVALS=1024,MAX_BREAKS=4096;
const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value);
const copy=(p:DeepReadonly<PathPoint>):PathPoint=>[p[0],p[1]];
function fail(code:string,message:string):never {throw new PathGeometryError(code,message);}
function freeze<T>(value:T):T {
  if(value!==null&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;
}
function plain(value:unknown,allowed:readonly string[]):asserts value is Record<string,unknown> {
  if(value===null||typeof value!=='object'||Array.isArray(value))fail('PLOT_OPTIONS','Expected ordinary plot options.');
  const proto=Object.getPrototypeOf(value);
  if(proto!==null&&proto!==Object.prototype||Object.getOwnPropertySymbols(value).length)fail('PLOT_OPTIONS','Expected plain plot options.');
  for(const [key,d] of Object.entries(Object.getOwnPropertyDescriptors(value)))
    if(!allowed.includes(key)||!d.enumerable||!Object.hasOwn(d,'value'))fail('PLOT_OPTIONS',`Unsupported plot option ${key}.`);
}
function array(value:unknown,limit:number,name:string):asserts value is unknown[] {
  if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype||Object.getOwnPropertySymbols(value).length)
    fail('PLOT_OPTIONS',`${name} must be an ordinary array.`);
  if(value.length>limit)fail('PLOT_BUDGET',`${name} exceeds its ${limit} element budget.`);
  const descriptors=Object.getOwnPropertyDescriptors(value);
  if(Object.keys(descriptors).length!==value.length+1)fail('PLOT_OPTIONS',`${name} must be a dense ordinary array.`);
  for(let i=0;i<value.length;i++){
    const d=descriptors[String(i)];if(!d?.enumerable||!Object.hasOwn(d,'value'))fail('PLOT_OPTIONS',`${name} must contain ordinary values.`);
  }
}
function checkedPoint(value:unknown):PathPoint {
  array(value,2,'sample point');
  if(value.length!==2||!finite(value[0])||!finite(value[1]))fail('PLOT_SAMPLE','Curve samples must be finite coordinate pairs or explicit null masks.');
  return [value[0],value[1]];
}
function integer(value:unknown,fallback:number,min:number,max:number,name:string):number {
  value=value===undefined?fallback:value;
  if(!Number.isInteger(value)||!finite(value)||value<min||value>max)fail('PLOT_BUDGET',`${name} must be an integer from ${min} to ${max}.`);
  return value;
}
function positive(value:unknown,fallback:number,name:string):number {
  value=value===undefined?fallback:value;
  if(!finite(value)||value<=0)fail('PLOT_OPTIONS',`${name} must be finite and positive.`);return value;
}
interface Interval {a:number;b:number}
interface Options {intervals:Interval[];breaks:Set<number>;tolerance:number;pixelsPerBp:number;initialSegments:number;maxDepth:number;maxSamples:number;maxSegments:number;maxJump:number}
function normalize(options:DeepReadonly<AdaptiveSamplingOptions>):Options {
  plain(options,['domains','breaks','tolerance','pixelsPerBp','initialSegments','maxDepth','maxSamples','maxSegments','maxJump']);
  array(options.domains,MAX_INTERVALS,'domains');
  if(!options.domains.length)fail('PLOT_DOMAIN','At least one parameter interval is required.');
  const domains:Interval[]=[];
  for(const domain of options.domains){
    array(domain,2,'domain');
    if(domain.length!==2||!finite(domain[0])||!finite(domain[1])||domain[0]>=domain[1])fail('PLOT_DOMAIN','Domains must be finite strictly increasing pairs.');
    if(domains.length&&domain[0]<domains.at(-1)!.b)fail('PLOT_DOMAIN','Domains must be sorted and must not overlap.');
    domains.push({a:domain[0],b:domain[1]});
  }
  const breaks=new Set<number>();
  if(options.breaks!==undefined){
    array(options.breaks,MAX_BREAKS,'breaks');
    for(const value of options.breaks){
      if(!finite(value)||breaks.has(value))fail('PLOT_DOMAIN','Breaks must be distinct finite parameter values.');
      if(!domains.some(d=>value>=d.a&&value<=d.b))fail('PLOT_DOMAIN','A break must belong to an authored parameter domain.');
      breaks.add(value);
    }
  }
  const sorted=[...breaks].sort((a,b)=>a-b),intervals:Interval[]=[];
  for(const domain of domains){let start=domain.a;for(const b of sorted){if(b>start&&b<domain.b){intervals.push({a:start,b});start=b;}}intervals.push({a:start,b:domain.b});}
  const tolerance=positive(options.tolerance,.5,'tolerance'),pixelsPerBp=positive(options.pixelsPerBp,1,'pixelsPerBp');
  if(!finite(tolerance/pixelsPerBp)||tolerance/pixelsPerBp===0)fail('PLOT_OPTIONS','Effective bp tolerance must remain finite and positive.');
  return {intervals,breaks,tolerance,pixelsPerBp,
    initialSegments:integer(options.initialSegments,16,1,4096,'initialSegments'),maxDepth:integer(options.maxDepth,16,0,24,'maxDepth'),
    maxSamples:integer(options.maxSamples,16384,1,MAX_SAMPLES,'maxSamples'),maxSegments:integer(options.maxSegments,8192,1,MAX_SEGMENTS,'maxSegments'),
    maxJump:options.maxJump===undefined?Infinity:positive(options.maxJump,1,'maxJump')};
}
function report(tolerance:number,pixelsPerBp:number):SamplingReport {
  return {sampleCount:0,segmentCount:0,contourCount:0,maskedIntervals:0,maxDepthReached:0,maxObservedError:0,maxAcceptedError:0,
    qualityMetric:'observed-probes',tolerance,pixelsPerBp,gaps:[]};
}
function finish(geometry:PathGeometry,r:SamplingReport):DeepReadonly<SampledPlot> {
  r.contourCount=geometry.contours.length;
  r.gaps.sort((a,b)=>a.domain[0]-b.domain[0]||a.domain[1]-b.domain[1]);
  const merged:SamplingGap[]=[];
  for(const gap of r.gaps){const previous=merged.at(-1);
    if(previous?.reason===gap.reason&&previous.domain[1]===gap.domain[0])previous.domain[1]=gap.domain[1];else merged.push(gap);
  }
  r.gaps=merged;r.maskedIntervals=merged.filter(g=>g.reason==='masked').length;
  return freeze({geometry,report:r});
}
const interpolate=(a:number,b:number,fraction:number):number=>(1-fraction)*a+fraction*b;
const probeFractions=[.25,(3-Math.sqrt(5))/2,.5,.75] as const;
interface TraceSample {parameter:number;points:PathPoint[]}
/**
 * This is deterministic probing, not interval arithmetic. No finite sampler can
 * certify an arbitrary callback: unobserved spikes, holes or valid islands may be missed.
 * Null masks split contours. Finite cells that exhaust refinement fail explicitly.
 */
function sample(evaluators:readonly CurveEvaluator[],options:DeepReadonly<AdaptiveSamplingOptions>,area:boolean):DeepReadonly<SampledPlot> {
  if(evaluators.some(e=>typeof e!=='function'))fail('PLOT_OPTIONS','A curve evaluator must be a function.');
  const c=normalize(options),r=report(c.tolerance,c.pixelsPerBp),cache=new Map<number,PathPoint[]|null>(),chains:TraceSample[][]=[];
  let current:TraceSample[]|undefined;
  for(const b of c.breaks)r.gaps.push({domain:[b,b],reason:'break'});
  function evaluate(u:number):PathPoint[]|null {
    if(c.breaks.has(u))return null;
    if(cache.has(u))return cache.get(u)!;
    if(r.sampleCount>=c.maxSamples)fail('PLOT_BUDGET',`Plot exceeds maxSamples=${c.maxSamples}.`);
    r.sampleCount++;
    const points:PathPoint[]=[];let masked=false;
    for(const evaluator of evaluators){
      let value:DeepReadonly<PathPoint>|null;
      try{value=evaluator(u);}catch(error){fail('PLOT_SAMPLE',`Curve evaluation failed at parameter ${u}: ${error instanceof Error?error.message:String(error)}`);}
      if(value===null)masked=true;else points.push(checkedPoint(value));
    }
    const value=masked?null:points;cache.set(u,value);return value;
  }
  function mask(a:number,b:number):void {current=undefined;r.gaps.push({domain:[a,b],reason:'masked'});}
  function accept(a:number,b:number,start:PathPoint[],end:PathPoint[],error:number):void {
    const continuing=current?.at(-1)?.parameter===a,cost=area?2+(continuing?0:2):1;
    if(r.segmentCount+cost>c.maxSegments)fail('PLOT_BUDGET',`Plot exceeds maxSegments=${c.maxSegments}.`);
    if(!continuing){current=[{parameter:a,points:start}];chains.push(current);}
    current!.push({parameter:b,points:end});r.segmentCount+=cost;r.maxAcceptedError=Math.max(r.maxAcceptedError,error);
  }
  function refine(a:number,b:number,depth:number):void {
    r.maxDepthReached=Math.max(r.maxDepthReached,depth);
    const us=[a,...probeFractions.map(f=>interpolate(a,b,f)),b];
    if(us.some((u,i)=>!finite(u)||i>0&&u<=us[i-1]))fail('PLOT_RESOLUTION','Parameter probes collapse at floating point precision.');
    const values=us.map(evaluate),valid=values.filter(v=>v!==null).length;
    if(valid===0){mask(a,b);return;}
    if(valid!==values.length){
      if(depth>=c.maxDepth){mask(a,b);return;}
      const mid=us[3];refine(a,mid,depth+1);refine(mid,b,depth+1);return;
    }
    const points=values as PathPoint[][],start=points[0],end=points.at(-1)!;
    let error=0,jump=Math.max(...start.map((p,i)=>Math.hypot(p[0]-end[i][0],p[1]-end[i][1])));
    for(let i=1;i<points.length;i++)for(let channel=0;channel<evaluators.length;channel++){
      const p=points[i][channel],previous=points[i-1][channel];
      jump=Math.max(jump,Math.hypot(p[0]-previous[0],p[1]-previous[1]));
      if(i<points.length-1){const fraction=probeFractions[i-1];
        error=Math.max(error,Math.hypot(p[0]-interpolate(start[channel][0],end[channel][0],fraction),p[1]-interpolate(start[channel][1],end[channel][1],fraction))*c.pixelsPerBp);
      }
    }
    if(!finite(error)||!finite(jump))fail('PLOT_RESOLUTION','Mapped probe distances exceed the finite numeric range.');
    r.maxObservedError=Math.max(r.maxObservedError,error);
    if(error<=c.tolerance&&jump<=c.maxJump){accept(a,b,start,end,error);return;}
    if(depth>=c.maxDepth)fail('PLOT_RESOLUTION',`Finite curve interval [${a}, ${b}] exceeds probe quality after maxDepth=${c.maxDepth}; declare domain masks or increase bounded quality budgets.`);
    const mid=us[3];refine(a,mid,depth+1);refine(mid,b,depth+1);
  }
  for(const interval of c.intervals){
    current=undefined;
    for(let i=0;i<c.initialSegments;i++){
      const a=i===0?interval.a:interpolate(interval.a,interval.b,i/c.initialSegments),b=i===c.initialSegments-1?interval.b:interpolate(interval.a,interval.b,(i+1)/c.initialSegments);
      refine(a,b,0);
    }
  }
  const contours:PathContour[]=chains.map((chain,index)=>{
    const vertices=area?[...chain.map(s=>s.points[0]),...[...chain].reverse().map(s=>s.points[1])]:chain.map(s=>s.points[0]);
    return {id:`plot-${index}`,start:copy(vertices[0]),segments:vertices.slice(1).map((p,i)=>({kind:'line',id:`segment-${i}`,to:copy(p)})),...(area?{closed:true}:{})};
  });
  return finish({contours},r);
}
/** Evaluator returns already mapped scene-bp points; renderers receive ordinary paths. */
export function adaptiveSampleCurve(evaluate:CurveEvaluator,options:DeepReadonly<AdaptiveSamplingOptions>):DeepReadonly<SampledPlot> {return sample([evaluate],options,false);}
/** Common parameter probes and masks keep the two boundaries aligned before polygon closure. */
export function areaBetweenCurves(top:CurveEvaluator,bottom:CurveEvaluator,options:DeepReadonly<AdaptiveSamplingOptions>):DeepReadonly<SampledPlot> {return sample([top,bottom],options,true);}
/** Exact polyline input. Nulls and explicit maxJump gaps are never interpolated across. */
export function sampledDataPlot(samples:readonly(DeepReadonly<PathPoint>|null)[],options:DeepReadonly<DataSamplingOptions>={}):DeepReadonly<SampledPlot> {
  plain(options,['maxSamples','maxSegments','maxJump']);
  const maxSamples=integer(options.maxSamples,16384,1,MAX_SAMPLES,'maxSamples'),maxSegments=integer(options.maxSegments,8192,1,MAX_SEGMENTS,'maxSegments'),
    maxJump=options.maxJump===undefined?Infinity:positive(options.maxJump,1,'maxJump');
  array(samples,maxSamples,'samples');
  const r=report(0,1),contours:PathContour[]=[];let current:PathContour|undefined,lastIndex=-1;
  for(let i=0;i<samples.length;i++){
    r.sampleCount++;
    if(samples[i]===null){r.gaps.push({domain:[i,i],reason:'masked'});current=undefined;continue;}
    const p=checkedPoint(samples[i]);
    if(current){const previous=current.segments.at(-1)?.to??current.start;
      const separation=Math.hypot(p[0]-previous[0],p[1]-previous[1]);
      if(!finite(separation))fail('PLOT_RESOLUTION','Sampled data chord exceeds the finite numeric range.');
      if(separation>maxJump){r.gaps.push({domain:[lastIndex,i],reason:'break'});current=undefined;}
    }
    if(!current){current={id:`plot-${contours.length}`,start:p,segments:[]};contours.push(current);}
    else {if(r.segmentCount>=maxSegments)fail('PLOT_BUDGET',`Plot exceeds maxSegments=${maxSegments}.`);
      current.segments.push({kind:'line',id:`segment-${current.segments.length}`,to:p});r.segmentCount++;}
    lastIndex=i;
  }
  return finish({contours},r);
}
