import {PathGeometryError,geometryLength,sampleGeometry,splitSegment,type PathGeometry,type PathPoint,type PathSegment} from '../path-geometry.js';
import {validatePathGeometry} from '../path-contract.js';
import type {DeepReadonly} from '../ir/operations.js';

export interface PathFrameOptions {
  tolerance?:number;corner?:'following'|'skip'|'error';cusp?:'skip'|'error';
}
export interface RegularPathFrameOptions extends PathFrameOptions {
  spacing?:number;phase?:number;origin?:number;startMargin?:number;endMargin?:number;maxSamples?:number;
}
export interface PathFrame {
  position:PathPoint;tangent:PathPoint;normal:PathPoint;distance:number;segmentId:string;localParameter:number;
}
export interface PathFrameSampler {
  readonly totalLength:number;readonly closed:boolean;readonly corners:readonly number[];
  /** All joins and interior stationary points; a closed seam occurs once, at zero. */
  readonly breakpoints:readonly number[];
  frameAt(distance:number):DeepReadonly<PathFrame>|undefined;
}
export interface RegularPathFrames {
  frames:(PathFrame&{id:string;index:number})[];skipped:number[];totalLength:number;closed:boolean;
}
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const same=(a:readonly number[],b:readonly number[])=>a[0]===b[0]&&a[1]===b[1];
const machineEqual=(a:number,b:number)=>a===b||Math.abs(a-b)<=8*Number.EPSILON*Math.max(Math.abs(a),Math.abs(b));
function nearby<T>(items:readonly T[],distance:number,coordinate:(item:T)=>number):T|undefined {
  let low=0,high=items.length;
  while(low<high){const mid=(low+high)>>>1;if(coordinate(items[mid])<distance)low=mid+1;else high=mid;}
  for(const index of [low-1,low])if(index>=0&&index<items.length&&machineEqual(coordinate(items[index]),distance))return items[index];
}
function fail(code:string,message:string):never {throw new PathGeometryError(code,message);}
function json(value:unknown,ancestors=new Set<object>(),depth=0):void {
  if(value===null||typeof value==='string'||typeof value==='boolean'||finite(value))return;
  if(depth>128||typeof value!=='object'||ancestors.has(value!))fail('PATH_FRAME_DATA','Expected finite acyclic JSON data.');
  const array=Array.isArray(value),prototype=Object.getPrototypeOf(value);
  if(array?prototype!==Array.prototype:prototype!==Object.prototype&&prototype!==null)fail('PATH_FRAME_DATA','Expected plain JSON data.');
  if(Object.getOwnPropertySymbols(value).length)fail('PATH_FRAME_DATA','Symbol properties are not JSON.');
  const descriptors=Object.getOwnPropertyDescriptors(value);ancestors.add(value);
  if(array)for(let i=0;i<value.length;i++)if(!Object.hasOwn(descriptors,String(i)))fail('PATH_FRAME_DATA','Sparse arrays are not JSON.');
  for(const [key,d] of Object.entries(descriptors)){
    if(array&&key==='length')continue;
    if(!Object.hasOwn(d,'value')||!d.enumerable||array&&!/^(0|[1-9]\d*)$/.test(key))fail('PATH_FRAME_DATA','Expected ordinary enumerable JSON values.');
    json(d.value,ancestors,depth+1);
  }ancestors.delete(value);
}
function keys(value:object,allowed:string[]):void {
  if(Object.keys(value).some(key=>!allowed.includes(key)))fail('PATH_FRAME_DATA','Unknown path-frame property.');
}
function freeze<T>(value:T):DeepReadonly<T> {
  const result=structuredClone(value),visit=(v:any):void=>{if(v&&typeof v==='object'){Object.values(v).forEach(visit);Object.freeze(v);}};
  visit(result);return result as DeepReadonly<T>;
}
const baseKeys=['tolerance','corner','cusp'];
const regularKeys=['spacing','phase','origin','startMargin','endMargin','maxSamples'];
function options(input:PathFrameOptions,extra:string[]=[]):Required<PathFrameOptions> {
  json(input);if(!object(input))fail('PATH_FRAME_OPTIONS','Expected path-frame options.');keys(input,[...baseKeys,...extra]);
  const o={tolerance:.05,corner:'following',cusp:'error',...input};
  if(!finite(o.tolerance)||o.tolerance<=0||!['following','skip','error'].includes(o.corner)||!['skip','error'].includes(o.cusp))
    fail('PATH_FRAME_OPTIONS','Expected positive tolerance and supported corner/cusp policies.');
  return o as Required<PathFrameOptions>;
}
const single=(start:PathPoint,segment:PathSegment):PathGeometry=>({contours:[{id:'frame',start,segments:[segment]}]});
interface Piece {from:number;to:number;start:PathPoint;segment:PathSegment;length:number;offset:number}
interface Entry {start:PathPoint;segment:PathSegment;geometry:PathGeometry;length:number;offset:number;end:number;stationary:number[];pieces:Piece[]}
interface Stationary {distance:number;entry:number;t:number}
function segmentPortion(entry:Entry,from:number,to:number):{start:PathPoint;segment:PathSegment} {
  const left=to===1?structuredClone(entry.segment):splitSegment(entry.start,entry.segment,to)[0];
  if(from===0)return {start:entry.start,segment:left};
  const [before,segment]=splitSegment(entry.start,left,from/to);return {start:before.to,segment};
}
function lengthTo(entry:Entry,t:number,budget:number):number {
  if(t===0)return 0;if(t===1)return entry.length;
  const piece=entry.pieces.find(p=>p.to>=t)!;
  if(t===piece.from)return piece.offset;if(t===piece.to)return piece.offset+piece.length;
  const left=splitSegment(piece.start,piece.segment,(t-piece.from)/(piece.to-piece.from))[0];
  return piece.offset+geometryLength(single(piece.start,left),budget/entry.pieces.length);
}

/** Candidate roots of the cubic derivative, verified with the shared tangent policy. */
function stationaryParameters(entry:Entry):number[] {
  const s=entry.segment;if(s.kind!=='cubic')return [];
  const deltas=[0,1].map(axis=>[s.c1[axis]-entry.start[axis],s.c2[axis]-s.c1[axis],s.to[axis]-s.c2[axis]]);
  const scale=Math.max(...deltas.flat().map(Math.abs));
  if(!Number.isFinite(scale))fail('PATH_FRAME_PRECISION','Cubic derivative cannot be represented.');
  if(scale===0)return [];
  const coefficients=deltas.map(row=>{const [d0,d1,d2]=row.map(v=>v/scale);return [d0-2*d1+d2,2*(d1-d0),d0];});
  const [a,b,c]=coefficients.sort((x,y)=>Math.max(...y.map(Math.abs))-Math.max(...x.map(Math.abs)))[0];
  let candidates:number[]=[];
  if(a===0){if(b!==0)candidates=[-c/b];}
  else {
    let discriminant=b*b-4*a*c;
    if(discriminant<0&&-discriminant<=16*Number.EPSILON*(b*b+Math.abs(4*a*c)))discriminant=0;
    if(discriminant>=0){const q=-.5*(b+(b>=0?1:-1)*Math.sqrt(discriminant));candidates=q===0?[-b/(2*a)]:[q/a,c/q];}
  }
  const result:number[]=[];
  for(const t of candidates.sort((x,y)=>x-y))if(finite(t)&&t>0&&t<1&&!result.some(v=>machineEqual(v,t))) {
    try {sampleGeometry(entry.geometry,t,'parameter');}
    catch(error){if(error instanceof PathGeometryError&&error.code==='UNDEFINED_TANGENT')result.push(t);else throw error;}
  }
  return result;
}

/** One frozen contour snapshot, cached segment lengths, and deterministic local-bp frames. */
export function preparePathFrames(input:DeepReadonly<PathGeometry>,configuration:PathFrameOptions={}):PathFrameSampler {
  const o=options(configuration);json(input);
  const errors=validatePathGeometry(input);if(errors.length)fail('INVALID_PATH_GEOMETRY',errors.map(e=>e.message).join('\n'));
  keys(input,['contours']);if(input.contours.length!==1)fail('PATH_FRAME_CONTOUR','Path frames require exactly one contour.');
  const contour=structuredClone(input.contours[0]) as PathGeometry['contours'][number];keys(contour,['id','start','segments','closed']);
  for(const segment of contour.segments)keys(segment,segment.kind==='line'?['id','kind','to']:['id','kind','c1','c2','to']);
  const raw:{start:PathPoint;segment:PathSegment}[]=[];let cursor=contour.start;
  for(const segment of contour.segments){
    if(!same(cursor,segment.to)||segment.kind==='cubic'&&(!same(cursor,segment.c1)||!same(cursor,segment.c2)))raw.push({start:cursor,segment});
    cursor=segment.to;
  }
  if(contour.closed&&!same(cursor,contour.start))raw.push({start:cursor,segment:{kind:'line',id:contour.id+':close',to:contour.start}});
  if(!raw.length)fail('PATH_FRAME_DEGENERATE','Path frames require positive arc length.');
  const budget=o.tolerance/(8*raw.length);if(budget===0)fail('PATH_FRAME_PRECISION','Length tolerance is below representable precision.');
  const entries:Entry[]=[];let totalLength=0;
  for(const source of raw){
    const geometry=single(source.start,source.segment),entry:Entry={...source,geometry,length:0,offset:totalLength,end:0,stationary:[],pieces:[]};
    entry.stationary=stationaryParameters(entry);const cuts=[0,...entry.stationary,1],pieceBudget=budget/(cuts.length-1);
    if(pieceBudget===0)fail('PATH_FRAME_PRECISION','Stationary subdivision tolerance is below representable precision.');
    for(let i=1;i<cuts.length;i++){
      const portion=segmentPortion(entry,cuts[i-1],cuts[i]),length=geometryLength(single(portion.start,portion.segment),pieceBudget);
      entry.pieces.push({...portion,from:cuts[i-1],to:cuts[i],length,offset:entry.length});entry.length+=length;
    }
    const length=entry.length,end=totalLength+length;
    if(!finite(end)||!(length>0)||end<=totalLength)fail('PATH_FRAME_PRECISION','Segment lengths cannot be represented by distinct cumulative distances.');
    entry.end=end;entries.push(entry);totalLength=end;
  }
  const closed=contour.closed===true,corners:number[]=[],breakpoints:number[]=[],stationary:Stationary[]=[];
  const joins=new Map<number,number>();
  for(let index=closed?0:1;index<entries.length;index++){
    const incoming=entries[(index+entries.length-1)%entries.length],outgoing=entries[index],distance=outgoing.offset;
    const a=sampleGeometry(incoming.geometry,1).tangent,b=sampleGeometry(outgoing.geometry,0).tangent;
    breakpoints.push(distance);joins.set(distance,index);
    if(Math.hypot(a[0]-b[0],a[1]-b[1])>64*Number.EPSILON)corners.push(distance);
  }
  for(const [index,entry] of entries.entries())for(const t of entry.stationary){
    const distance=entry.offset+lengthTo(entry,t,budget);
    if(!finite(distance)||distance<=entry.offset||distance>=entry.end)fail('PATH_FRAME_PRECISION','Interior stationary distance cannot be represented.');
    stationary.push({distance,entry:index,t});breakpoints.push(distance);
  }
  breakpoints.sort((a,b)=>a-b);corners.sort((a,b)=>a-b);
  const junctions=[...joins.entries()];
  function frameAt(requested:number):DeepReadonly<PathFrame>|undefined {
    if(!finite(requested)||requested<0||requested>totalLength)fail('PATH_FRAME_DISTANCE','Distance must be finite and within [0,totalLength].');
    let distance=closed&&requested===totalLength?0:requested;
    const corner=nearby(corners,distance,d=>d);
    if(corner!==undefined){
      if(o.corner==='skip')return;
      if(o.corner==='error')fail('PATH_FRAME_CORNER',`The tangent is discontinuous at distance ${corner}.`);
      distance=corner;
    }
    const cusp=nearby(stationary,distance,s=>s.distance);
    if(cusp){
      if(o.cusp==='skip')return;
      fail('UNDEFINED_TANGENT',`Segment ${entries[cusp.entry].segment.id} has an interior stationary point at distance ${cusp.distance}.`);
    }
    const junction=nearby(junctions,distance,entry=>entry[0]);
    let index:number,t:number;
    if(junction){distance=junction[0];index=junction[1];t=0;}
    else if(distance===totalLength){index=entries.length-1;t=1;}
    else {
      let low=0,high=entries.length;
      while(low<high){const mid=(low+high)>>>1;if(entries[mid].end<=distance)low=mid+1;else high=mid;}
      index=Math.min(entries.length-1,low);const entry=entries[index],remaining=distance-entry.offset;
      if(remaining===0)t=0;
      else if(entry.segment.kind==='line')t=remaining/entry.length;
      else {
        let lo=0,hi=1;t=NaN;
        for(let iteration=0;iteration<64;iteration++){
          const mid=(lo+hi)/2,length=lengthTo(entry,mid,budget);
          if(Math.abs(length-remaining)<=o.tolerance/4){t=mid;break;}
          if(length<remaining)lo=mid;else hi=mid;if(mid===(lo+hi)/2)break;
        }
        if(!finite(t))fail('ARC_LENGTH_TOLERANCE','Path-frame arc length cannot be inverted within tolerance.');
      }
    }
    const entry=entries[index];
    try {
      const sample=sampleGeometry(entry.geometry,t,'parameter',o.tolerance),[tx,ty]=sample.tangent;
      return freeze({position:sample.point,tangent:sample.tangent,normal:[-ty,tx] as PathPoint,distance,segmentId:entry.segment.id,localParameter:t});
    }catch(error){if(o.cusp==='skip'&&error instanceof PathGeometryError&&error.code==='UNDEFINED_TANGENT')return;throw error;}
  }
  return Object.freeze({totalLength,closed,corners:Object.freeze(corners),breakpoints:Object.freeze(breakpoints),frameAt});
}

/** Lattice index k is the stable ID; skipped distances count towards the work budget. */
export function regularPathFrames(input:DeepReadonly<PathGeometry>,configuration:RegularPathFrameOptions={}):DeepReadonly<RegularPathFrames> {
  const base=options(configuration,regularKeys),o={spacing:20,phase:0,origin:0,startMargin:0,endMargin:0,maxSamples:2048,...configuration};
  if(!finite(o.spacing)||o.spacing<=0||!finite(o.phase)||!finite(o.origin)||!finite(o.startMargin)||o.startMargin<0||!finite(o.endMargin)||o.endMargin<0||
    !Number.isSafeInteger(o.maxSamples)||o.maxSamples<1||o.maxSamples>131072)
    fail('PATH_FRAME_OPTIONS','Expected positive spacing, finite phase/origin, nonnegative margins and maxSamples in [1,131072].');
  const sampler=preparePathFrames(input,{tolerance:base.tolerance,corner:base.corner,cusp:base.cusp}),{totalLength,closed}=sampler;
  const frames:RegularPathFrames['frames']=[],skipped:number[]=[],lower=o.startMargin,upper=totalLength-o.endMargin;
  if(lower>upper)return freeze({frames,skipped,totalLength,closed});
  const offset=o.phase-o.origin,minimum=Math.ceil((lower-offset)/o.spacing),maximum=Math.floor((upper-offset)/o.spacing);
  if(!finite(offset)||!Number.isSafeInteger(minimum)||!Number.isSafeInteger(maximum))fail('PATH_FRAME_PRECISION','Lattice indices exceed the safe integer range.');
  let first=minimum,last=maximum;
  const at=(k:number)=>offset+k*o.spacing;
  const inside=(d:number)=>finite(d)&&d>=lower&&d<=upper&&(!closed||d<totalLength);
  // Division can round an integral quotient down even when the directly
  // evaluated lattice point lies on the boundary. Inspect the neighboring
  // integer once; never use the arc-length tolerance to move a mark.
  if(first<=last&&at(first)<lower)first++;
  if(Number.isSafeInteger(first-1)&&inside(at(first-1)))first--;
  if(first<=last&&!inside(at(last)))last--;
  if(Number.isSafeInteger(last+1)&&inside(at(last+1)))last++;
  const count=last-first+1;
  if(count>o.maxSamples)fail('PATH_FRAME_BUDGET',`Lattice has ${count} candidates, exceeding maxSamples ${o.maxSamples}.`);
  let previous=-Infinity;
  for(let k=first;k<=last;k++){
    const distance=at(k);
    if(!finite(distance)||distance<lower||distance>upper||closed&&distance>=totalLength||distance<=previous)
      fail('PATH_FRAME_PRECISION','Lattice distances cannot be represented consistently.');
    previous=distance;const frame=sampler.frameAt(distance);
    if(frame)frames.push({...structuredClone(frame) as PathFrame,id:`mark-${k===0?0:k}`,index:k===0?0:k});else skipped.push(distance);
  }
  return freeze({frames,skipped,totalLength,closed});
}
