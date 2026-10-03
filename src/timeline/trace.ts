import {validateBundle,type Bundle,type EvaluatedFrame,type Node,type PathNode} from '../schema.js';
import {OperationValidationError,type Diagnostic,type SourceSpan,type DeepReadonly} from '../ir/operations.js';
import {validateJsonData,validateSourceSpan,freezeSnapshot} from '../operations/values.js';
import type {ExecutionAccess} from '../operations/plan.js';
import type {ExpressionValue} from '../fields/ast.js';
import {prepareParameterResolver} from '../fields/program.js';
import {nodePosition} from '../geometry/spaces.js';
import {inverseMatrix,worldMatrix,transformPoint} from '../geometry.js';
import {pathGeometryData,type PathGeometry,type PathPoint} from '../path-geometry.js';
import {morphWrites} from './morph.js';

export interface TraceOperation {
  id:string;target:string;source:{kind:'node';node:string;property:'position';space:{kind:'scene'}};
  domain:[number,number];step:number;tolerance?:number;maxDepth?:number;maxSamples?:number;
  /** Version 1 has no random sampling; zero is the only supported seed. */
  seed:0;missing:'break';reveal:'progress'|'full';sourceSpan?:SourceSpan;
}
export interface TraceProgram {version:1;operations:TraceOperation[]}
export interface TraceGap {domain:[number,number];reason:'hidden'|'missing'|'visibility-boundary'}
export interface TraceReport {
  domain:[number,number];step:number;tolerance:number;seed:0;
  sampleCount:number;segmentCount:number;contourCount:number;maskedIntervals:number;maxDepthReached:number;
  maxObservedError:number;maxAcceptedError:number;qualityMetric:'observed-probes';gaps:TraceGap[];
  reveal:{mode:'progress'|'full';time:number;end:number;segmentCount:number;contourCount:number};
}
export type TraceEvaluation=Readonly<Record<string,DeepReadonly<TraceReport>>>;
export interface PreparedTraceProgram {apply(frame:EvaluatedFrame,parameters?:Readonly<Record<string,ExpressionValue>>):TraceEvaluation}
type BaseEvaluator=(time:number,parameters?:Readonly<Record<string,ExpressionValue>>)=>EvaluatedFrame;
interface Normalized extends TraceOperation {tolerance:number;maxDepth:number;maxSamples:number}
interface Entry {operation:Normalized;path:string}
type PointSample={point:PathPoint}|{reason:'hidden'|'missing'};
interface Segment {a:number;b:number;from:PathPoint;to:PathPoint}
interface Sampled {segments:Segment[];report:Omit<TraceReport,'reveal'>}
const MAX_OPERATIONS=32,MAX_SAMPLES=32768,MAX_TOTAL_SAMPLES=65536;
type Obj=Record<string,any>;
const object=(v:unknown):v is Obj=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
const named=(v:unknown):v is string=>typeof v==='string'&&v.trim()===v&&v.length>0&&v.length<=256;
const blend=(a:number,b:number,t:number)=>a*(1-t)+b*t;
function fail(code:string,message:string,entry:Entry,related?:Diagnostic['related']):never {
  throw new OperationValidationError([{severity:'error',code,message,path:entry.path,...(entry.operation.sourceSpan?{sourceSpan:entry.operation.sourceSpan}:{}),...(related?{related}:{})}]);
}
/** Detect authored references without interpreting expression text or paint. */
function references(value:unknown,target:string,key=''):boolean {
  if(typeof value==='string')return ['node','target','source','a','b','point','path','targets'].includes(key)&&value===target;
  if(Array.isArray(value))return value.some(v=>references(v,target,key));
  return object(value)&&Object.entries(value).some(([k,v])=>references(v,target,k));
}
function inspect(input:unknown,bundle:Bundle,inContext=false):{diagnostics:Diagnostic[];entries:Entry[]} {
  const diagnostics=validateJsonData(input,'$.traces'),entries:Entry[]=[];
  if(!object(bundle)){diagnostics.push({severity:'error',code:'TRACE_CONTEXT',message:'Expected a scene bundle.',path:'$'});return {diagnostics,entries};}
  if(!inContext){const {traces:ignored,...base}=bundle;diagnostics.push(...validateBundle(base));}
  if(diagnostics.some(d=>d.severity==='error'))return {diagnostics,entries};
  const error=(code:string,message:string,path:string,span?:SourceSpan)=>diagnostics.push({severity:'error',code,message,path,...(span?{sourceSpan:span}:{})});
  if(bundle.version!=='0.3')error('TRACE_VERSION','Traces require Bundle 0.3.','$.version');
  if(!object(input)||input.version!==1||Object.keys(input).some(k=>!['version','operations'].includes(k))||!Array.isArray(input.operations)||input.operations.length>MAX_OPERATIONS){
    error('TRACE_PROGRAM','Expected trace version 1 with at most 32 operations.','$.traces');return {diagnostics,entries};
  }
  const nodes=new Map(bundle.nodes.map(n=>[n.id,n])),ids=new Set<string>(),targets=new Set<string>();let total=0;
  for(const [i,raw] of input.operations.entries()){
    const path=`$.traces.operations[${i}]`,before=diagnostics.length;
    if(!object(raw)){error('TRACE_OPERATION','Expected a trace operation.',path);continue;}
    if(raw.sourceSpan!==undefined){const ds=validateSourceSpan(raw.sourceSpan,path+'.sourceSpan');diagnostics.push(...ds);if(ds.length)continue;}
    const span=raw.sourceSpan as SourceSpan|undefined;
    const invalid=(code:string,message:string,key='')=>error(code,message,path+key,span);
    for(const key of Object.keys(raw))if(!['id','target','source','domain','step','tolerance','maxDepth','maxSamples','seed','missing','reveal','sourceSpan'].includes(key))invalid('TRACE_PROPERTY',`Unknown trace field ${key}.`,'.'+key);
    if(!named(raw.id)||ids.has(raw.id))invalid('TRACE_ID','Trace IDs must be unique nonempty names.','.id');else ids.add(raw.id);
    const target=nodes.get(raw.target);
    if(!named(raw.target)||target?.kind!=='path'||targets.has(raw.target))invalid('TRACE_TARGET','Each trace needs a distinct authored path target.','.target');else targets.add(raw.target);
    if(target?.kind==='path'&&(target.reveal!==undefined||target.resolvedPath!==undefined))invalid('TRACE_TARGET','A trace controls its own reveal and geometry; target reveal/resolvedPath must be absent.','.target');
    if(target?.kind==='path'&&['arrows','arrowStart','arrowEnd','arrowSize','resolvedArrows'].some(key=>(target as unknown as Obj)[key]!==undefined))invalid('TRACE_TARGET','Trace targets do not support arrow decorations in this version.','.target');
    const source=raw.source,sourceNode=object(source)?nodes.get(source.node):undefined;
    if(!object(source)||Object.keys(source).some(k=>!['kind','node','property','space'].includes(k))||source.kind!=='node'||source.property!=='position'||!object(source.space)||source.space.kind!=='scene'||Object.keys(source.space).length!==1||!sourceNode||!['point','ellipse','tex'].includes(sourceNode.kind))
      invalid('TRACE_SOURCE','Source requires an existing point/ellipse/TeX position reference in scene space.','.source');
    if(!Array.isArray(raw.domain)||raw.domain.length!==2||!raw.domain.every(finite)||raw.domain[0]<0||raw.domain[0]>=raw.domain[1]||raw.domain[1]>bundle.duration)
      invalid('TRACE_DOMAIN','Domain must be a finite increasing interval inside scene duration.','.domain');
    if(!finite(raw.step)||raw.step<=0)invalid('TRACE_STEP','Step must be a positive finite number of seconds.','.step');
    const tolerance=raw.tolerance===undefined?.5:raw.tolerance,maxDepth=raw.maxDepth===undefined?12:raw.maxDepth,maxSamples=raw.maxSamples===undefined?8192:raw.maxSamples;
    if(!finite(tolerance)||tolerance<=0)invalid('TRACE_TOLERANCE','Tolerance must be positive finite scene bp.','.tolerance');
    if(!Number.isInteger(maxDepth)||maxDepth<0||maxDepth>20)invalid('TRACE_BUDGET','maxDepth must be an integer from 0 to 20.','.maxDepth');
    if(!Number.isInteger(maxSamples)||maxSamples<5||maxSamples>MAX_SAMPLES)invalid('TRACE_BUDGET','maxSamples must be an integer from 5 to 32768.','.maxSamples');else total+=maxSamples;
    if(raw.seed!==0)invalid('TRACE_SEED','This deterministic version requires seed:0; it does not use random samples.','.seed');
    if(raw.missing!=='break'||!['progress','full'].includes(raw.reveal))invalid('TRACE_POLICY','Specify missing:break and reveal:progress or full.');
    if(named(raw.target)){
      if((bundle.morphs?.operations??[]).some(op=>morphWrites(op.instance).some(slot=>slot.node===raw.target)))invalid('TRACE_DEPENDENCY','Trace target is owned by a geometry morph.','.target');
      if(bundle.nodes.some(n=>n.parent===raw.target))invalid('TRACE_DEPENDENCY','A trace target cannot be an ancestor of another node.','.target');
      for(const key of ['tracks','relations','operationGraph','expressions','fields','deformations','plots','morphs','mathTransforms','constraints'])
        if(references((bundle as unknown as Obj)[key],raw.target))invalid('TRACE_DEPENDENCY',`Trace target is reserved and cannot be read or written by ${key}; animate a parent instead.`,'.target');
    }
    if(diagnostics.length===before){
      const operation={...structuredClone(raw),tolerance,maxDepth,maxSamples} as Normalized;
      const count=Math.ceil((operation.domain[1]-operation.domain[0])/operation.step);
      if(!Number.isSafeInteger(count)||count<1||count*4+1>maxSamples)invalid('TRACE_BUDGET','Initial fixed-domain probes exceed maxSamples; increase step or budget.','.step');
      else if(operation.domain[0]+(operation.domain[1]-operation.domain[0])/count<=operation.domain[0])invalid('TRACE_PRECISION','Initial sample spacing cannot advance absolute time.','.step');
      else entries.push({operation,path});
    }
  }
  if(total>MAX_TOTAL_SAMPLES)error('TRACE_BUDGET','Sum of configured trace maxSamples must not exceed 65536.','$.traces.operations');
  return {diagnostics,entries};
}
export function validateTraceProgram(input:unknown,bundle:Bundle):Diagnostic[]{return inspect(input,bundle).diagnostics;}
export function validateTraceProgramInContext(input:unknown,bundle:Bundle):Diagnostic[]{return inspect(input,bundle,true).diagnostics;}

function visible(id:string,nodes:ReadonlyMap<string,Node>):boolean {
  let node=nodes.get(id);const seen=new Set<string>();
  while(node&&!seen.has(node.id)){seen.add(node.id);if(node.visible===false||(node.style?.opacity??1)<=0)return false;node=node.parent?nodes.get(node.parent):undefined;}return true;
}
function sample(entry:Entry,evaluate:BaseEvaluator,parameters?:Readonly<Record<string,ExpressionValue>>):Sampled {
  const op=entry.operation,cache=new Map<number,PointSample>(),segments:Segment[]=[],gaps:TraceGap[]=[];
  let maxObservedError=0,maxAcceptedError=0,maxDepthReached=0,maskedIntervals=0;
  const at=(time:number):PointSample=>{
    const prior=cache.get(time);if(prior)return prior;
    if(cache.size>=op.maxSamples)fail('TRACE_BUDGET','Adaptive trace sampling exhausted maxSamples.',entry);
    let point:PointSample;
    try{
      const frame=evaluate(time,parameters),nodes=new Map(frame.nodes.map(n=>[n.id,n]));
      point=!nodes.has(op.source.node)?{reason:'missing'}:!visible(op.source.node,nodes)?{reason:'hidden'}:{point:nodePosition(op.source.node,{kind:'scene'},nodes)};
    }catch(error){
      const diagnostics=(error as {diagnostics?:Diagnostic[]})?.diagnostics;
      if(diagnostics)throw new OperationValidationError(diagnostics.map(d=>({...d,related:[...(d.related??[]),{message:`While sampling trace ${op.id} at ${time} seconds.`,path:entry.path,...(op.sourceSpan?{sourceSpan:op.sourceSpan}:{})}]})));
      throw error;
    }
    cache.set(time,point);return point;
  };
  const mask=(a:number,b:number,reason:TraceGap['reason'])=>{
    maskedIntervals++;const prior=gaps.at(-1);
    if(prior&&prior.domain[1]===a&&prior.reason===reason)prior.domain[1]=b;else gaps.push({domain:[a,b],reason});
  };
  const refine=(a:number,b:number,depth:number)=>{
    maxDepthReached=Math.max(maxDepthReached,depth);
    const times=[a,blend(a,b,.25),blend(a,b,.5),blend(a,b,.75),b];
    if(times.some((t,i)=>i>0&&t<=times[i-1]))fail('TRACE_PRECISION','Adaptive probes cannot advance absolute time.',entry);
    const samples=times.map(at),missing=samples.filter((p):p is {reason:'hidden'|'missing'}=>'reason'in p);
    if(missing.length===5){mask(a,b,missing.some(p=>p.reason==='missing')?'missing':'hidden');return;}
    if(missing.length){
      if(depth===op.maxDepth){mask(a,b,'visibility-boundary');return;}
      refine(a,times[2],depth+1);refine(times[2],b,depth+1);return;
    }
    const points=(samples as {point:PathPoint}[]).map(p=>p.point),from=points[0],to=points[4];
    if(!Number.isFinite(Math.hypot(to[0]-from[0],to[1]-from[1])))fail('TRACE_GEOMETRY','Trace chord length exceeds finite geometry.',entry);
    let error=0;
    for(let i=1;i<4;i++)error=Math.max(error,Math.hypot(points[i][0]-blend(from[0],to[0],i/4),points[i][1]-blend(from[1],to[1],i/4)));
    if(!Number.isFinite(error))fail('TRACE_GEOMETRY','Trace error metric exceeds finite geometry.',entry);
    maxObservedError=Math.max(maxObservedError,error);
    if(error>op.tolerance){
      if(depth===op.maxDepth)fail('TRACE_RESOLUTION',`Observed trace error ${error} bp exceeds tolerance ${op.tolerance} at maxDepth.`,entry);
      refine(a,times[2],depth+1);refine(times[2],b,depth+1);return;
    }
    maxAcceptedError=Math.max(maxAcceptedError,error);segments.push({a,b,from:[...from],to:[...to]});
  };
  const [start,end]=op.domain,count=Math.ceil((end-start)/op.step);
  for(let i=0;i<count;i++)refine(i===0?start:blend(start,end,i/count),i===count-1?end:blend(start,end,(i+1)/count),0);
  const contourCount=segments.reduce((sum,s,i)=>sum+(i===0||segments[i-1].b!==s.a?1:0),0);
  return {segments,report:{domain:[...op.domain],step:op.step,tolerance:op.tolerance,seed:0,sampleCount:cache.size,segmentCount:segments.length,contourCount,
    maskedIntervals,maxDepthReached,maxObservedError,maxAcceptedError,qualityMetric:'observed-probes',gaps}};
}

/** The callback is a private prepared base evaluator, never serialized. One
 * parameter-state cache bounds memory; every new state resamples the same fixed
 * absolute domain. Probe errors are estimates, not continuous guarantees. */
export function prepareTraceProgram(input:TraceProgram,bundle:Bundle,evaluate:BaseEvaluator,accesses:readonly DeepReadonly<ExecutionAccess>[]=[]):PreparedTraceProgram {
  const checked=inspect(input,bundle);if(checked.diagnostics.some(d=>d.severity==='error'))throw new OperationValidationError(checked.diagnostics);
  const entries=freezeSnapshot(checked.entries) as unknown as Entry[];
  const resolveParameters=prepareParameterResolver(bundle.expressions?.parameters??{});
  for(const entry of entries)for(const access of accesses)if([...access.reads,...access.writes].some(slot=>slot.node===entry.operation.target))
    fail('TRACE_DEPENDENCY','Trace target cannot participate in another execution step.',entry,[{message:'Conflicting step.',path:access.path,...(access.sourceSpan?{sourceSpan:structuredClone(access.sourceSpan)}:{})}]);
  let cacheKey:string|undefined,cached:Sampled[]|undefined;
  return Object.freeze({apply(frame:EvaluatedFrame,parameters?:Readonly<Record<string,ExpressionValue>>):TraceEvaluation {
    // Validate and snapshot even on cache hits. Preserve each finite parameter
    // value, including signed zero, in the bounded cache identity.
    const values=freezeSnapshot(resolveParameters(parameters)) as Readonly<Record<string,ExpressionValue>>,
      key=JSON.stringify(values,(_key,value)=>typeof value==='number'&&Object.is(value,-0)?{negativeZero:true}:value);
    if(!cached||key!==cacheKey){const next=entries.map(entry=>sample(entry,evaluate,values));cached=next;cacheKey=key;}
    const nodes=new Map(frame.nodes.map(n=>[n.id,n])),reports:Record<string,TraceReport>=Object.create(null);
    entries.forEach((entry,i)=>{
      const op=entry.operation,data=cached![i],geometry:PathGeometry={contours:[]},cutoff=op.reveal==='full'?op.domain[1]:Math.min(frame.time,op.domain[1]);
      let inverse;try{inverse=inverseMatrix(worldMatrix(op.target,nodes),`trace target ${op.target}`);}catch(error){
        fail('TRACE_SINGULAR_SPACE',error instanceof Error?error.message:String(error),entry);
      }
      let previous:Segment|undefined,segmentCount=0;
      for(const segment of data.segments){
        if(segment.a>cutoff)break;
        const local=(point:PathPoint):PathPoint=>{const p=transformPoint(inverse,point);if(!p.every(Number.isFinite))fail('TRACE_GEOMETRY','Trace target conversion produced nonfinite coordinates.',entry);return p;};
        let contour=geometry.contours.at(-1);
        if(!contour||previous?.b!==segment.a){contour={id:`trace-contour-${geometry.contours.length}`,start:local(segment.from),segments:[]};geometry.contours.push(contour);}
        if(cutoff>segment.a){
          const u=Math.min(1,(cutoff-segment.a)/(segment.b-segment.a)),point:PathPoint=u===1?segment.to:[blend(segment.from[0],segment.to[0],u),blend(segment.from[1],segment.to[1],u)];
          contour.segments.push({id:`trace-segment-${segmentCount++}`,kind:'line',to:local(point)});
        }
        previous=segment;if(segment.b>=cutoff)break;
      }
      const target=nodes.get(op.target) as PathNode;target.geometry=geometry;target.d=pathGeometryData(geometry);delete target.resolvedPath;
      reports[op.id]={...structuredClone(data.report),reveal:{mode:op.reveal,time:frame.time,end:Math.max(op.domain[0],cutoff),segmentCount,contourCount:geometry.contours.length}};
    });
    return freezeSnapshot(reports);
  }});
}
