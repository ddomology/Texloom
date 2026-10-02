import {PathGeometryError,type PathGeometry,type PathContour,type PathPoint,type PathSegment} from '../path-geometry.js';
import {validatePathGeometry} from '../path-contract.js';
import type {DeepReadonly} from '../ir/operations.js';
import {preparePathFrames,regularPathFrames,type PathFrame,type RegularPathFrameOptions} from './path-frame.js';

export type DecorationKind='ticks'|'marks'|'symbols'|'snake';
export interface DecorationOptions extends RegularPathFrameOptions {
  kind?:DecorationKind;offset?:number;size?:number;orientation?:'tangent'|'fixed'|'reverse';
  symbolScale?:number;amplitude?:number;resolution?:number;
}
export interface DecorationReport {
  kind:DecorationKind;totalLength:number;candidateCount:number;emittedCount:number;
  skippedIds:string[];sampleIds:string[];representation:'exact'|'polyline';
}
export interface DecorationResult {geometry:PathGeometry;report:DecorationReport}
export interface BraceOptions {amplitude?:number;aspect?:number;offset?:number}
export const DECORATION_DEFAULTS:Readonly<Required<DecorationOptions>>=Object.freeze({
  kind:'ticks',spacing:20,phase:0,origin:0,startMargin:0,endMargin:0,tolerance:.05,maxSamples:2048,
  corner:'following',cusp:'error',offset:0,size:6,orientation:'tangent',symbolScale:1,amplitude:5,resolution:16,
});
const MAX_SAMPLES=2048,MAX_OUTPUT=131072;
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
function fail(code:string,message:string):never {throw new PathGeometryError(code,message);}
function json(value:unknown,ancestors=new Set<object>(),depth=0):void {
  if(value===null||typeof value==='string'||typeof value==='boolean'||finite(value))return;
  if(depth>128||typeof value!=='object'||ancestors.has(value!))fail('DECORATION_DATA','Expected finite acyclic JSON data.');
  const array=Array.isArray(value),prototype=Object.getPrototypeOf(value);
  if(array?prototype!==Array.prototype:prototype!==Object.prototype&&prototype!==null)fail('DECORATION_DATA','Expected plain JSON data.');
  if(Object.getOwnPropertySymbols(value).length)fail('DECORATION_DATA','Symbol properties are not JSON.');
  const descriptors=Object.getOwnPropertyDescriptors(value);ancestors.add(value);
  if(array)for(let i=0;i<value.length;i++)if(!Object.hasOwn(descriptors,String(i)))fail('DECORATION_DATA','Sparse arrays are not JSON.');
  for(const [key,d] of Object.entries(descriptors)){
    if(array&&key==='length')continue;
    if(!Object.hasOwn(d,'value')||!d.enumerable||array&&!/^(0|[1-9]\d*)$/.test(key))fail('DECORATION_DATA','Expected ordinary enumerable JSON values.');
    json(d.value,ancestors,depth+1);
  }ancestors.delete(value);
}
function keys(value:object,allowed:readonly string[]):void {
  if(Object.keys(value).some(key=>!allowed.includes(key)))fail('DECORATION_OPTIONS','Unknown decoration property.');
}
function frozen<T>(value:T):DeepReadonly<T> {
  const result=structuredClone(value),visit=(v:any):void=>{if(v&&typeof v==='object'){Object.values(v).forEach(visit);Object.freeze(v);}};
  visit(result);return result as DeepReadonly<T>;
}
function point(p:readonly number[]):PathPoint {
  if(!Array.isArray(p)||p.length!==2||!p.every(finite))fail('DECORATION_NONFINITE','Expected a finite point.');
  return [p[0],p[1]];
}
export function normalizeDecorationOptions(value:DecorationOptions={}):Required<DecorationOptions> {
  json(value);if(!object(value))fail('DECORATION_OPTIONS','Expected decoration options.');keys(value,Object.keys(DECORATION_DEFAULTS));
  const o={...DECORATION_DEFAULTS,...value};
  if(!['ticks','marks','symbols','snake'].includes(o.kind))fail('DECORATION_KIND','Unsupported decoration kind.');
  for(const name of ['spacing','tolerance','size','symbolScale'] as const)
    if(!finite(o[name])||o[name]<=0)fail('DECORATION_DIMENSION',`${name} must be positive and finite.`);
  for(const name of ['startMargin','endMargin'] as const)
    if(!finite(o[name])||o[name]<0)fail('DECORATION_DIMENSION',`${name} must be nonnegative and finite.`);
  for(const name of ['phase','origin','offset','amplitude'] as const)
    if(!finite(o[name]))fail('DECORATION_DIMENSION',`${name} must be finite.`);
  if(!Number.isSafeInteger(o.maxSamples)||o.maxSamples<1||o.maxSamples>MAX_SAMPLES)fail('DECORATION_BUDGET',`maxSamples must be an integer in [1,${MAX_SAMPLES}].`);
  if(!Number.isSafeInteger(o.resolution)||o.resolution<4||o.resolution>128)fail('DECORATION_RESOLUTION','resolution must be an integer in [4,128].');
  if(!['tangent','fixed','reverse'].includes(o.orientation)||!['following','skip','error'].includes(o.corner)||!['error','skip'].includes(o.cusp))
    fail('DECORATION_POLICY','Unsupported orientation, corner or cusp policy.');
  return o;
}
function localPoint(frame:DeepReadonly<PathFrame>,x:number,y:number,o:Required<DecorationOptions>):PathPoint {
  const tangent=o.orientation==='fixed'?[1,0]:frame.tangent,normal=o.orientation==='fixed'?[0,1]:frame.normal;
  const sign=o.orientation==='reverse'?-1:1;
  return point([frame.position[0]+o.offset*frame.normal[0]+sign*(x*tangent[0]+y*normal[0]),
    frame.position[1]+o.offset*frame.normal[1]+sign*(x*tangent[1]+y*normal[1])]);
}
function frameSettings(o:Required<DecorationOptions>) {return {tolerance:o.tolerance,corner:o.corner,cusp:o.cusp};}
function regularSettings(o:Required<DecorationOptions>) {return {...frameSettings(o),spacing:o.spacing,phase:o.phase,origin:o.origin,
  startMargin:o.startMargin,endMargin:o.endMargin,maxSamples:o.maxSamples};}
function latticeId(distance:number,o:Required<DecorationOptions>):string {
  const index=Math.round((distance-(o.phase-o.origin))/o.spacing);
  if(!Number.isSafeInteger(index))fail('DECORATION_PRECISION','Lattice index cannot be represented.');
  return `mark-${index===0?0:index}`;
}
function symbolGeometry(input:DeepReadonly<PathGeometry>):DeepReadonly<PathGeometry> {
  json(input);const errors=validatePathGeometry(input);if(errors.length)fail('INVALID_PATH_GEOMETRY',errors.map(e=>e.message).join('\n'));
  keys(input,['contours']);let work=input.contours.length;
  for(const c of input.contours){keys(c,['id','start','segments','closed']);work+=c.segments.length+(c.closed?1:0);
    for(const s of c.segments)keys(s,s.kind==='line'?['id','kind','to']:['id','kind','c1','c2','to']);}
  if(work>MAX_OUTPUT)fail('DECORATION_BUDGET','Symbol exceeds the output geometry budget.');
  return input;
}

/** Repeated rigid marks use stable global lattice IDs; all distances are local bp. */
export function createPathDecoration(input:DeepReadonly<PathGeometry>,configuration:DecorationOptions={},symbol?:DeepReadonly<PathGeometry>):DeepReadonly<DecorationResult> {
  const o=normalizeDecorationOptions(configuration);
  if(o.kind==='symbols'&&symbol===undefined)fail('DECORATION_SYMBOL','Symbols require an explicit editable symbol path.');
  if(o.kind!=='symbols'&&symbol!==undefined)fail('DECORATION_SYMBOL','Only symbol decorations accept a symbol path.');
  if(o.kind==='snake')return snake(input,o);
  const art=symbol===undefined?undefined:symbolGeometry(symbol),samples=regularPathFrames(input,regularSettings(o));
  const cost=art?art.contours.reduce((sum,c)=>sum+1+c.segments.length+(c.closed?1:0),0):o.kind==='ticks'?2:3;
  if(cost*samples.frames.length>MAX_OUTPUT)fail('DECORATION_BUDGET','Repeated geometry exceeds the output budget.');
  const contours:PathContour[]=[];
  for(const frame of samples.frames){
    if(art){
      const map=(p:readonly [number,number])=>localPoint(frame,p[0]*o.symbolScale,p[1]*o.symbolScale,o);
      art.contours.forEach((c,ci)=>contours.push({id:`${frame.id}:contour-${ci}`,start:map(c.start),...(c.closed===undefined?{}:{closed:c.closed}),
        segments:c.segments.map((s,si)=>s.kind==='line'?{id:`segment-${si}`,kind:'line',to:map(s.to)}:
          {id:`segment-${si}`,kind:'cubic',c1:map(s.c1),c2:map(s.c2),to:map(s.to)})}));
    }else {
      const points=o.kind==='ticks'?[[0,-o.size/2],[0,o.size/2]]:[[-o.size/2,-o.size/2],[0,0],[-o.size/2,o.size/2]];
      const mapped=points.map(([x,y])=>localPoint(frame,x,y,o));
      contours.push({id:frame.id,start:mapped[0],segments:mapped.slice(1).map((to,i)=>({id:`segment-${i}`,kind:'line',to}))});
    }
  }
  return frozen({geometry:{contours},report:{kind:o.kind,totalLength:samples.totalLength,candidateCount:samples.frames.length+samples.skipped.length,
    emittedCount:samples.frames.length,skippedIds:samples.skipped.map(d=>latticeId(d,o)),sampleIds:samples.frames.map(f=>f.id),representation:'exact'}});
}

/** A resolution-controlled normal-offset polyline. It is deliberately open at a closed seam. */
function snake(input:DeepReadonly<PathGeometry>,o:Required<DecorationOptions>):DeepReadonly<DecorationResult> {
  const sampler=preparePathFrames(input,frameSettings(o)),total=sampler.totalLength,start=o.startMargin,end=total-o.endMargin;
  const empty=():DeepReadonly<DecorationResult>=>frozen({geometry:{contours:[]},report:{kind:'snake',totalLength:total,candidateCount:0,emittedCount:0,skippedIds:[],sampleIds:[],representation:'polyline'}});
  if(start>end)return empty();
  const step=o.spacing/o.resolution,base=o.phase-o.origin;
  if(!finite(step)||step<=0||!finite(base))fail('DECORATION_PRECISION','Snake lattice is not representable.');
  let first=Math.ceil((start-base)/step),last=Math.floor((end-base)/step);
  if(!Number.isSafeInteger(first)||!Number.isSafeInteger(last))fail('DECORATION_PRECISION','Snake lattice indices are not representable.');
  const at=(k:number)=>base+k*step,inside=(d:number)=>finite(d)&&d>=start&&d<=end;
  // Check neighboring integer indices using the evaluated lattice point. A
  // rounded quotient must not rename a boundary sample to snake-start/end.
  if(first<=last&&at(first)<start)first++;
  if(Number.isSafeInteger(first-1)&&inside(at(first-1)))first--;
  if(first<=last&&!inside(at(last)))last--;
  if(Number.isSafeInteger(last+1)&&inside(at(last+1)))last++;
  const count=Math.max(0,last-first+1);
  if(!Number.isSafeInteger(count))fail('DECORATION_PRECISION','Snake lattice count is not representable.');
  if(count>o.maxSamples)fail('DECORATION_BUDGET','Snake exceeds its sample budget.');
  const candidates=new Map<number,string>();
  const add=(distance:number,id:string)=>{if(distance<start||distance>end)return;if(!candidates.has(distance))candidates.set(distance,id);
    if(candidates.size>o.maxSamples)fail('DECORATION_BUDGET','Snake endpoints and breakpoints exceed its sample budget.');};
  let previous=-Infinity;
  for(let k=first;k<=last;k++){const d=at(k);if(!inside(d)||d<=previous)fail('DECORATION_PRECISION','Distinct snake samples must have representable increasing distances.');previous=d;add(d,`snake-${k===0?0:k}`);}
  add(start,'snake-start');add(end,'snake-end');
  sampler.breakpoints.forEach((d,i)=>add(d,`snake-break-${i}`));
  const contours:PathContour[]=[],sampleIds:string[]=[],skippedIds:string[]=[];let current:PathContour|undefined;
  for(const [distance,id] of [...candidates].sort(([a],[b])=>a-b)){
    const frame=sampler.frameAt(distance);
    if(!frame){skippedIds.push(id);current=undefined;continue;}
    const cycles=(distance-base)/o.spacing;
    if(!finite(cycles))fail('DECORATION_NONFINITE','Snake phase is nonfinite.');
    const displacement=o.offset+o.amplitude*Math.sin(2*Math.PI*(cycles%1));
    const p=point([frame.position[0]+displacement*frame.normal[0],frame.position[1]+displacement*frame.normal[1]]);
    sampleIds.push(id);
    if(!current){current={id:`snake-part-${id}`,start:p,segments:[]};contours.push(current);}
    else current.segments.push({id:`to-${id}`,kind:'line',to:p});
  }
  if(sampleIds.length+contours.length>MAX_OUTPUT)fail('DECORATION_BUDGET','Snake exceeds the output geometry budget.');
  return frozen({geometry:{contours},report:{kind:'snake',totalLength:total,candidateCount:candidates.size,emittedCount:sampleIds.length,
    skippedIds,sampleIds,representation:'polyline'}});
}

/** Four cubic bends with optional straight shoulders, in the ordered endpoint frame. */
export function createBraceGeometry(from:readonly [number,number],to:readonly [number,number],configuration:BraceOptions={}):DeepReadonly<PathGeometry> {
  json(from);json(to);json(configuration);const a=point(from),b=point(to);
  if(!object(configuration))fail('BRACE_OPTIONS','Expected brace options.');keys(configuration,['amplitude','aspect','offset']);
  const {amplitude=12,aspect=.5,offset=0}=configuration;
  if(!finite(amplitude)||!finite(offset)||!finite(aspect)||aspect<=0||aspect>=1)fail('BRACE_OPTIONS','Brace amplitude/offset must be finite and aspect must be strictly between zero and one.');
  const dx=b[0]-a[0],dy=b[1]-a[1],width=Math.hypot(dx,dy);
  if(!finite(width)||width<=0)fail('BRACE_DEGENERATE','Brace endpoints need positive finite separation.');
  const ux=dx/width,uy=dy/width,cusp=aspect*width,bend=Math.min(Math.abs(amplitude),cusp/2,(width-cusp)/2);
  const map=(x:number,y:number)=>point([a[0]+ux*x-uy*(y+offset),a[1]+uy*x+ux*(y+offset)]);
  const middle=amplitude/2,segments:PathSegment[]=[];
  const cubic=(id:string,c1:PathPoint,c2:PathPoint,end:PathPoint)=>segments.push({id,kind:'cubic',c1:map(...c1),c2:map(...c2),to:map(...end)});
  cubic('start-bend',[0,middle/2],[bend/2,middle],[bend,middle]);
  if(cusp-bend>bend)segments.push({id:'left-shoulder',kind:'line',to:map(cusp-bend,middle)});
  cubic('left-cusp',[cusp-bend/2,middle],[cusp,middle+amplitude/4],[cusp,amplitude]);
  cubic('right-cusp',[cusp,middle+amplitude/4],[cusp+bend/2,middle],[cusp+bend,middle]);
  if(width-bend>cusp+bend)segments.push({id:'right-shoulder',kind:'line',to:map(width-bend,middle)});
  cubic('end-bend',[width-bend/2,middle],[width,middle/2],[width,0]);
  return frozen({contours:[{id:'brace',start:map(0,0),segments}]});
}
