import {PathGeometryError,evaluateSegment,type PathGeometry,type PathPoint,type PathSegment} from '../path-geometry.js';
import {validatePathGeometry} from '../path-contract.js';
import type {DeepReadonly} from '../ir/operations.js';

export type IntersectionMode='segment'|'line';
export interface IntersectionOptions {modeA?:IntersectionMode;modeB?:IntersectionMode;positionTolerance?:number;parameterTolerance?:number;maxPairs?:number;maxResults?:number}
export interface IntersectionSegmentRef {contourId:string;segmentId:string;contourIndex:number;segmentIndex:number;closing:boolean}
export type IntersectionContact='crossing'|'tangent'|'endpoint'|'degenerate';
export interface IntersectionIncident {a:IntersectionSegmentRef;b:IntersectionSegmentRef;parameterA:number;parameterB:number;contact:IntersectionContact}
export interface IntersectionPoint {point:PathPoint;incidents:IntersectionIncident[]}
export interface IntersectionOverlap {a:IntersectionSegmentRef;b:IntersectionSegmentRef;parameterA:[number|null,number|null];parameterB:[number|null,number|null];orientation:1|-1;points:[PathPoint|null,PathPoint|null]}
export interface IntersectionSet {version:1;points:IntersectionPoint[];overlaps:IntersectionOverlap[];options:Required<IntersectionOptions>;pairsTested:number}
type Entry={ref:IntersectionSegmentRef;start:PathPoint;segment:PathSegment;count:number;closed:boolean};
const EPS=Number.EPSILON;
function fail(code:string,message:string):never {throw new PathGeometryError(code,message);}
const finite=(x:unknown):x is number=>typeof x==='number'&&Number.isFinite(x);
const obj=(x:unknown):x is Record<string,any>=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const point=(x:unknown):x is PathPoint=>Array.isArray(x)&&x.length===2&&x.every(finite);
const same=(a:readonly number[],b:readonly number[])=>a.every((v,i)=>v===b[i]);
const sub=(a:PathPoint,b:PathPoint):PathPoint=>[a[0]-b[0],a[1]-b[1]];
const cross=(a:PathPoint,b:PathPoint)=>a[0]*b[1]-a[1]*b[0];
const dot=(a:PathPoint,b:PathPoint)=>a[0]*b[0]+a[1]*b[1];
const distance=(a:PathPoint,b:PathPoint)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
function keys(value:Record<string,any>,allowed:string[]):void {if(Object.keys(value).some(key=>!allowed.includes(key)))fail('INTERSECTION_DATA','Unknown intersection data property.');}
function json(value:unknown,ancestors=new Set<object>(),depth=0):void {
  if(depth>64)fail('INTERSECTION_DATA','JSON nesting exceeds the limit.');
  if(value===null||typeof value==='boolean'||typeof value==='string'||finite(value))return;
  if(typeof value!=='object'||ancestors.has(value!))fail('INTERSECTION_DATA','Expected finite acyclic JSON data.');
  const prototype=Object.getPrototypeOf(value);
  if(Array.isArray(value)?prototype!==Array.prototype:prototype!==Object.prototype&&prototype!==null)fail('INTERSECTION_DATA','Expected plain JSON data.');
  if(Object.getOwnPropertySymbols(value).length)fail('INTERSECTION_DATA','Symbols are not JSON.');
  ancestors.add(value);
  const descriptors=Object.getOwnPropertyDescriptors(value);
  if(Array.isArray(value))for(let i=0;i<value.length;i++)if(!Object.hasOwn(descriptors,String(i)))fail('INTERSECTION_DATA','Sparse arrays are not supported.');
  for(const [key,descriptor] of Object.entries(descriptors)){
    if(Array.isArray(value)&&key==='length')continue;
    if(!Object.hasOwn(descriptor,'value')||!descriptor.enumerable||Array.isArray(value)&&!/^(0|[1-9]\d*)$/.test(key))fail('INTERSECTION_DATA','Expected ordinary enumerable JSON values.');
    json(descriptor.value,ancestors,depth+1);
  }ancestors.delete(value);
}
function freeze<T>(value:T):DeepReadonly<T> {const visit=(x:any)=>{if(x&&typeof x==='object'){Object.values(x).forEach(visit);Object.freeze(x);}};visit(value);return value as DeepReadonly<T>;}
function options(value:IntersectionOptions={}):Required<IntersectionOptions> {
  json(value);if(!obj(value))fail('INTERSECTION_OPTIONS','Expected options object.');
  keys(value,['modeA','modeB','positionTolerance','parameterTolerance','maxPairs','maxResults']);
  const out={modeA:'segment' as IntersectionMode,modeB:'segment' as IntersectionMode,positionTolerance:1e-7,parameterTolerance:1e-9,maxPairs:65536,maxResults:16384,...value};
  if(!['segment','line'].includes(out.modeA)||!['segment','line'].includes(out.modeB))fail('INTERSECTION_MODE','Expected segment or line mode.');
  if(!finite(out.positionTolerance)||out.positionTolerance<=0||!finite(out.parameterTolerance)||out.parameterTolerance<32*EPS||out.parameterTolerance>=.5)fail('INTERSECTION_TOLERANCE','Require positive position tolerance and parameter tolerance in [32*Number.EPSILON,0.5).');
  if(!Number.isSafeInteger(out.maxPairs)||out.maxPairs<1||out.maxPairs>1048576||!Number.isSafeInteger(out.maxResults)||out.maxResults<1||out.maxResults>131072)fail('INTERSECTION_BUDGET','Invalid intersection work budget.');
  return out;
}
function geometry(value:DeepReadonly<PathGeometry>):PathGeometry {
  json(value);const errors=validatePathGeometry(value);if(errors.length)fail('INVALID_PATH_GEOMETRY',errors.map(e=>e.message).join('\n'));
  keys(value as any,['contours']);
  for(const c of value.contours){keys(c as any,['id','start','segments','closed']);for(const s of c.segments)keys(s as any,s.kind==='line'?['id','kind','to']:['id','kind','to','c1','c2']);}
  return structuredClone(value) as PathGeometry;
}
function inventory(g:PathGeometry):Entry[] {
  const entries:Entry[]=[];
  g.contours.forEach((c,contourIndex)=>{
    const last=c.segments.at(-1)?.to??c.start,closing=!!c.closed&&!same(last,c.start),count=c.segments.length+(closing?1:0);
    let start=c.start;
    c.segments.forEach((segment,segmentIndex)=>{entries.push({ref:{contourId:c.id,segmentId:segment.id,contourIndex,segmentIndex,closing:false},start,segment,count,closed:!!c.closed});start=segment.to;});
    if(closing)entries.push({ref:{contourId:c.id,segmentId:c.id+':close',contourIndex,segmentIndex:c.segments.length,closing:true},start:last,segment:{id:c.id+':close',kind:'line',to:c.start},count,closed:true});
  });return entries;
}
const controls=(e:Entry):PathPoint[]=>e.segment.kind==='line'?[e.start,e.segment.to]:[e.start,e.segment.c1,e.segment.c2,e.segment.to];
const constant=(e:Entry)=>controls(e).every(p=>same(p,e.start));
const powerScale=(magnitude:number)=>2**Math.max(-1074,Math.min(1023,Math.floor(Math.log2(magnitude))));
const at=(entry:Entry,t:number):PathPoint=>entry.segment.kind==='line'
  ?[entry.start[0]+t*(entry.segment.to[0]-entry.start[0]),entry.start[1]+t*(entry.segment.to[1]-entry.start[1])]
  :evaluateSegment(entry.start,entry.segment,t);
const polynomial=(values:number[]):number[]=>values.length===2?[values[0],values[1]-values[0]]:
  [values[0],3*(values[1]-values[0]),3*(values[2]-2*values[1]+values[0]),values[3]-3*values[2]+3*values[1]-values[0]];
const evaluate=(p:number[],t:number)=>p.reduceRight((v,c)=>v*t+c,0);
const derivative=(p:number[])=>p.slice(1).map((c,i)=>c*(i+1));
const unique=(values:number[],tolerance:number)=>values.sort((a,b)=>a-b).filter((v,i,a)=>i===0||v-a[i-1]>tolerance);

/** Isolate real roots on [0,1] using derivative partitions, not a flat polyline. */
function roots(coefficients:number[],parameterTolerance:number):number[] {
  const magnitude=Math.max(...coefficients.map(Math.abs));if(!magnitude)return [];
  const p=coefficients.map(c=>c/powerScale(magnitude));
  if(p.some((c,i)=>!finite(c)||c===0&&coefficients[i]!==0))fail('INTERSECTION_PRECISION','Polynomial normalization loses a coefficient.');
  while(p.length>1&&p.at(-1)===0)p.pop();
  if(p.length===1)return [];
  if(p.length===2){const t=p[0]===0?0:p[0]+p[1]===0?1:-p[0]/p[1];return finite(t)&&t>=0&&t<=1?[t]:[];}
  const critical=roots(derivative(p),Math.min(parameterTolerance/8,1e-13));
  const boundaries=unique([0,...critical.filter(t=>t>0&&t<1),1],Math.min(parameterTolerance/8,1e-14));
  const values=boundaries.map(t=>evaluate(p,t)),error=32*EPS*p.reduce((sum,c)=>sum+Math.abs(c),0),result:number[]=[];
  for(let i=0;i<boundaries.length;i++){
    if(values[i]===0)result.push(boundaries[i]);
    else if(i>0&&i+1<boundaries.length&&Math.abs(values[i])<=error)
      fail('INTERSECTION_PRECISION','A nearly tangent polynomial has unresolved root multiplicity.');
  }
  for(let i=0;i+1<boundaries.length;i++){
    if((values[i]<0)===(values[i+1]<0)||result.some(t=>t===boundaries[i]||t===boundaries[i+1]))continue;
    let lo=boundaries[i],hi=boundaries[i+1],flo=values[i];
    for(let iteration=0;iteration<80;iteration++){
      const mid=(lo+hi)/2;if(mid===lo||mid===hi)break;
      const f=evaluate(p,mid);if(f===0){lo=hi=mid;break;}
      if((f<0)===(flo<0)){lo=mid;flo=f;}else hi=mid;
      if(hi-lo<=Math.min(parameterTolerance/8,1e-14))break;
    }result.push((lo+hi)/2);
  }
  return unique(result,Math.min(parameterTolerance/8,32*EPS));
}
function clipped(t:number,mode:IntersectionMode,tolerance:number):number|undefined {
  if(!finite(t))fail('INTERSECTION_PRECISION','Nonfinite intersection parameter.');
  if(mode==='line')return t;
  if(t< -tolerance||t>1+tolerance)return;
  return t<=0?0:t>=1?1:t;
}
function topology(entry:Entry,t:number,tolerance:number,mode:IntersectionMode,positionTolerance:number):string {
  const nearStart=t<=tolerance&&distance(at(entry,t),entry.start)<=positionTolerance;
  const nearEnd=t>=1-tolerance&&distance(at(entry,t),entry.segment.to)<=positionTolerance;
  if(mode==='segment'&&(nearStart||nearEnd)){
    let vertex=entry.ref.segmentIndex+(nearEnd?1:0);if(entry.closed&&vertex===entry.count)vertex=0;
    return JSON.stringify([entry.ref.contourIndex,'vertex',vertex]);
  }return JSON.stringify([entry.ref.contourIndex,'segment',entry.ref.segmentIndex]);
}

export function intersectPathGeometries(inputA:DeepReadonly<PathGeometry>,inputB:DeepReadonly<PathGeometry>,configuration:IntersectionOptions={}):DeepReadonly<IntersectionSet> {
  const opts=options(configuration),a=inventory(geometry(inputA)),b=inventory(geometry(inputB));
  if(a.length*b.length>opts.maxPairs)fail('INTERSECTION_BUDGET','Segment-pair budget exceeded.');
  if(opts.modeA==='line'&&a.some(e=>e.segment.kind!=='line')||opts.modeB==='line'&&b.some(e=>e.segment.kind!=='line'))fail('INTERSECTION_MODE','Infinite-line mode requires only line segments.');
  if(opts.modeA==='line'&&a.some(constant)||opts.modeB==='line'&&b.some(constant))fail('INTERSECTION_DEGENERATE_LINE','An infinite line requires a nonzero direction.');
  const result:IntersectionSet={version:1,points:[],overlaps:[],options:opts,pairsTested:0};
  const identities:{a:string;b:string;ta:number;tb:number}[]=[];let records=0;
  const budget=()=>{if(++records>opts.maxResults)fail('INTERSECTION_BUDGET','Intersection result budget exceeded.');};
  const addPoint=(ea:Entry,eb:Entry,ta:number,tb:number,contact:IntersectionContact)=>{
    const ca=clipped(ta,opts.modeA,opts.parameterTolerance),cb=clipped(tb,opts.modeB,opts.parameterTolerance);if(ca===undefined||cb===undefined)return;
    const pa=at(ea,ca),pb=at(eb,cb);
    if(!point(pa)||!point(pb))fail('INTERSECTION_PRECISION','Nonfinite evaluated intersection.');
    if(distance(pa,pb)>opts.positionTolerance){
      if(ca!==ta||cb!==tb)return;
      fail('INTERSECTION_PRECISION','Position residual exceeds the requested tolerance.');
    }
    const position:PathPoint=[pa[0]/2+pb[0]/2,pa[1]/2+pb[1]/2];
    if(contact!=='degenerate'&&(opts.modeA==='segment'&&(ca===0||ca===1)||opts.modeB==='segment'&&(cb===0||cb===1)))contact='endpoint';
    const incident:IntersectionIncident={a:structuredClone(ea.ref),b:structuredClone(eb.ref),parameterA:ca,parameterB:cb,contact};
    const id={a:topology(ea,ca,opts.parameterTolerance,opts.modeA,opts.positionTolerance),b:topology(eb,cb,opts.parameterTolerance,opts.modeB,opts.positionTolerance),ta:ca,tb:cb};
    const existing=result.points.findIndex((p,i)=>identities[i].a===id.a&&identities[i].b===id.b&&distance(p.point,position)<=opts.positionTolerance&&
      (identities[i].a.includes('vertex')||Math.abs(identities[i].ta-ca)<=opts.parameterTolerance)&&
      (identities[i].b.includes('vertex')||Math.abs(identities[i].tb-cb)<=opts.parameterTolerance));
    if(existing>=0){const p=result.points[existing];if(!p.incidents.some(v=>JSON.stringify(v)===JSON.stringify(incident))){budget();p.incidents.push(incident);}}
    else {budget();result.points.push({point:position,incidents:[incident]});identities.push(id);}
  };
  const addOverlap=(ea:Entry,eb:Entry,ta0:number,ta1:number,tb0:number,tb1:number)=>{
    if(ta1<ta0){[ta0,ta1]=[ta1,ta0];[tb0,tb1]=[tb1,tb0];}
    if(ta0===ta1&&finite(ta0)&&finite(tb0)){addPoint(ea,eb,ta0,tb0,'endpoint');return;}
    budget();result.overlaps.push({a:structuredClone(ea.ref),b:structuredClone(eb.ref),parameterA:[finite(ta0)?ta0:null,finite(ta1)?ta1:null],
      parameterB:[Math.min(tb0,tb1),Math.max(tb0,tb1)].map(t=>finite(t)?t:null) as [number|null,number|null],orientation:tb1>=tb0?1:-1,
      points:[finite(ta0)?at(ea,ta0):null,finite(ta1)?at(ea,ta1):null]});
  };
  for(const ea of a)for(const eb of b){
    result.pairsTested++;
    if(ea.segment.kind==='cubic'&&eb.segment.kind==='cubic')fail('INTERSECTION_UNSUPPORTED','Cubic-cubic intersections are not supported in PR 11.');
    const all=[...controls(ea),...controls(eb)],origin=ea.start,shifted=all.map(p=>sub(p,origin));
    if(shifted.some(p=>!point(p)))fail('INTERSECTION_PRECISION','Coordinate differences overflowed.');
    const scale=powerScale(Math.max(...shifted.flat().map(Math.abs))||1);
    const normalized=(p:PathPoint):PathPoint=>[(p[0]-origin[0])/scale,(p[1]-origin[1])/scale];
    const a0=normalized(ea.start),a1=normalized(ea.segment.to),b0=normalized(eb.start),b1=normalized(eb.segment.to);
    const isAConstant=constant(ea),isBConstant=constant(eb);
    for(const entry of [ea,eb])if(!constant(entry)&&controls(entry).map(normalized).every(p=>same(p,normalized(entry.start))))
      fail('INTERSECTION_PRECISION','Coordinate normalization loses a nonconstant segment.');
    if(isAConstant||isBConstant){
      if(isAConstant&&isBConstant){if(distance(ea.start,eb.start)<=opts.positionTolerance)addPoint(ea,eb,0,0,'degenerate');continue;}
      const dotEntry=isAConstant?ea:eb,curve=isAConstant?eb:ea,mode=isAConstant?opts.modeB:opts.modeA;
      const p=normalized(dotEntry.start),cs=controls(curve).map(normalized);
      if(curve.segment.kind==='line'){
        const d=sub(cs[1],cs[0]),squared=dot(d,d);if(!finite(squared)||squared===0)fail('INTERSECTION_PRECISION','Line metric underflow or overflow.');
        const t=dot(sub(p,cs[0]),d)/squared,v=clipped(t,mode,opts.parameterTolerance);
        if(v!==undefined&&distance(at(curve,v),dotEntry.start)<=opts.positionTolerance)
          addPoint(ea,eb,isAConstant?0:v,isAConstant?v:0,'degenerate');
      }else{
        const px=polynomial(cs.map(q=>q[0]-p[0])),py=polynomial(cs.map(q=>q[1]-p[1]));
        const chosen=Math.max(...px.slice(1).map(Math.abs))>=Math.max(...py.slice(1).map(Math.abs))?px:py;
        for(const t of roots(chosen,opts.parameterTolerance))if(distance(evaluateSegment(curve.start,curve.segment,t),dotEntry.start)<=opts.positionTolerance)
          addPoint(ea,eb,isAConstant?0:t,isAConstant?t:0,'degenerate');
      }continue;
    }
    if(ea.segment.kind==='line'&&eb.segment.kind==='line'){
      const r=sub(a1,a0),s=sub(b1,b0),q=sub(b0,a0),denominator=cross(r,s);
      const uncertainty=32*EPS*(Math.abs(r[0]*s[1])+Math.abs(r[1]*s[0]));
      if(denominator!==0&&Math.abs(denominator)<=uncertainty)fail('INTERSECTION_PRECISION','Nearly parallel line directions are unresolved at Float64 precision.');
      if(denominator!==0){addPoint(ea,eb,cross(q,s)/denominator,cross(q,r)/denominator,'crossing');continue;}
      const collinearity=cross(q,r);
      if(collinearity!==0){if(Math.abs(collinearity)<=32*EPS*(Math.abs(q[0]*r[1])+Math.abs(q[1]*r[0])))fail('INTERSECTION_PRECISION','Line collinearity is numerically ambiguous.');continue;}
      const rr=dot(r,r);if(!finite(rr)||rr===0)fail('INTERSECTION_PRECISION','Line metric underflow or overflow.');
      const u=dot(q,r)/rr,v=dot(s,r)/rr;if(!finite(u)||!finite(v)||v===0)fail('INTERSECTION_PRECISION','Collinear parameter mapping is unresolved.');
      const domainA=opts.modeA==='line'?[-Infinity,Infinity]:[0,1],domainB=opts.modeB==='line'?[-Infinity,Infinity]:[u,u+v].sort((x,y)=>x-y);
      const lo=Math.max(domainA[0],domainB[0]),hi=Math.min(domainA[1],domainB[1]);
      if(lo<=hi)addOverlap(ea,eb,lo,hi,(lo-u)/v,(hi-u)/v);continue;
    }
    const swap=ea.segment.kind!=='line',line=swap?eb:ea,curve=swap?ea:eb,mode=swap?opts.modeB:opts.modeA;
    const lp=normalized(line.start),ld=sub(normalized(line.segment.to),lp),ll=dot(ld,ld),cs=controls(curve).map(normalized);
    if(!finite(ll)||ll===0)fail('INTERSECTION_PRECISION','Line metric underflow or overflow.');
    const distances=cs.map(p=>cross(ld,sub(p,lp))/Math.sqrt(ll)),equation=polynomial(distances);
    const projection=polynomial(cs.map(p=>dot(sub(p,lp),ld)/ll));
    const emit=(u:number,t:number,contact:IntersectionContact)=>addPoint(ea,eb,swap?t:u,swap?u:t,contact);
    const emitOverlap=(u0:number,u1:number,t0:number,t1:number)=>addOverlap(ea,eb,swap?t0:u0,swap?t1:u1,swap?u0:t0,swap?u1:t1);
    if(distances.every(v=>v===0)){
      const boundaries=unique([0,...roots(derivative(projection),opts.parameterTolerance),1],Math.min(opts.parameterTolerance/8,32*EPS));
      for(let i=0;i+1<boundaries.length;i++){
        const t0=boundaries[i],t1=boundaries[i+1],u0=evaluate(projection,t0),u1=evaluate(projection,t1);
        if(u0===u1){if(clipped(u0,mode,opts.parameterTolerance)!==undefined)emit(u0,t0,'degenerate');continue;}
        const lo=Math.max(Math.min(u0,u1),mode==='line'?-Infinity:0),hi=Math.min(Math.max(u0,u1),mode==='line'?Infinity:1);if(lo>hi)continue;
        const invert=(u:number)=>{
          if(u===u0)return t0;if(u===u1)return t1;
          let l=t0,h=t1;for(let j=0;j<80;j++){const m=(l+h)/2;if(m===l||m===h)break;if((evaluate(projection,m)<u)===(u1>u0))l=m;else h=m;}return(l+h)/2;
        };
        const first=u1>u0?lo:hi,last=u1>u0?hi:lo;
        emitOverlap(first,last,invert(first),invert(last));
      }continue;
    }
    if(Math.max(...distances.map(Math.abs))<64*EPS)fail('INTERSECTION_PRECISION','Line-cubic collinearity is numerically ambiguous.');
    for(const t of roots(equation,opts.parameterTolerance)){
      const u=evaluate(projection,t);if(clipped(u,mode,opts.parameterTolerance)===undefined)continue;
      const slope=derivative(equation),tangentThreshold=128*EPS*slope.reduce((sum,c)=>sum+Math.abs(c),0);
      emit(u,t,Math.abs(evaluate(slope,t))<=tangentThreshold?'tangent':'crossing');
    }
  }
  assertIntersectionSet(result);return freeze(result);
}

/** Validate portable result data without relying on its original geometry. */
export function assertIntersectionSet(value:unknown):asserts value is IntersectionSet {
  json(value);if(!obj(value))fail('INTERSECTION_DATA','Expected intersection result set.');
  keys(value,['version','points','overlaps','options','pairsTested']);
  if(value.version!==1||!Array.isArray(value.points)||!Array.isArray(value.overlaps))fail('INTERSECTION_DATA','Expected intersection result version 1.');
  if(!obj(value.options))fail('INTERSECTION_DATA','Result options must be fully resolved.');
  const resolved=options(value.options);if(Object.keys(value.options).length!==6)fail('INTERSECTION_DATA','Result options must be fully resolved.');
  if(!Number.isSafeInteger(value.pairsTested)||value.pairsTested<0||value.pairsTested>resolved.maxPairs)fail('INTERSECTION_DATA','Invalid tested-pair count.');
  const ref=(r:unknown)=>{
    if(!obj(r))fail('INTERSECTION_DATA','Invalid segment reference.');keys(r,['contourId','segmentId','contourIndex','segmentIndex','closing']);
    if(typeof r.contourId!=='string'||!r.contourId||typeof r.segmentId!=='string'||!r.segmentId||typeof r.closing!=='boolean'||
      !Number.isSafeInteger(r.contourIndex)||r.contourIndex<0||!Number.isSafeInteger(r.segmentIndex)||r.segmentIndex<0)fail('INTERSECTION_DATA','Invalid segment identity.');
  };
  const parameter=(t:unknown,mode:IntersectionMode)=>{if(!finite(t)||mode==='segment'&&(t<0||t>1))fail('INTERSECTION_DATA','Invalid result parameter.');};
  let count=value.overlaps.length;
  for(const p of value.points){
    if(!obj(p))fail('INTERSECTION_DATA','Invalid point record.');keys(p,['point','incidents']);
    if(!point(p.point)||!Array.isArray(p.incidents)||!p.incidents.length)fail('INTERSECTION_DATA','Point records need positions and incidents.');
    count+=p.incidents.length;
    for(const incident of p.incidents){
      if(!obj(incident))fail('INTERSECTION_DATA','Invalid incident.');keys(incident,['a','b','parameterA','parameterB','contact']);
      ref(incident.a);ref(incident.b);parameter(incident.parameterA,resolved.modeA);parameter(incident.parameterB,resolved.modeB);
      if(!['crossing','tangent','endpoint','degenerate'].includes(incident.contact))fail('INTERSECTION_DATA','Invalid contact kind.');
    }
  }
  for(const overlap of value.overlaps){
    if(!obj(overlap))fail('INTERSECTION_DATA','Invalid overlap.');keys(overlap,['a','b','parameterA','parameterB','orientation','points']);
    ref(overlap.a);ref(overlap.b);
    for(const [name,mode] of [['parameterA',resolved.modeA],['parameterB',resolved.modeB]] as const){
      const interval=overlap[name];if(!Array.isArray(interval)||interval.length!==2)fail('INTERSECTION_DATA','Invalid overlap interval.');
      for(const t of interval){if(t===null){if(mode!=='line')fail('INTERSECTION_DATA','Only infinite line intervals may be unbounded.');}else parameter(t,mode);}
      if(interval[0]!==null&&interval[1]!==null&&interval[0]>=interval[1])fail('INTERSECTION_DATA','Overlap intervals must have positive extent.');
    }
    if(overlap.orientation!==1&&overlap.orientation!==-1||!Array.isArray(overlap.points)||overlap.points.length!==2||overlap.points.some((p:unknown)=>p!==null&&!point(p)))fail('INTERSECTION_DATA','Invalid overlap orientation or endpoints.');
    if(overlap.points.some((p:unknown,i:number)=>(p===null)!==(overlap.parameterA[i]===null)))fail('INTERSECTION_DATA','Overlap endpoints must match unbounded A limits.');
  }
  if(count>resolved.maxResults)fail('INTERSECTION_BUDGET','Result record budget exceeded.');
}
