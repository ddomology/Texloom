import {PathGeometryError} from '../path-geometry.js';
import type {DeepReadonly} from '../ir/operations.js';

export type CubicPoint=readonly [number,number];
export type CubicControls=readonly [CubicPoint,CubicPoint,CubicPoint,CubicPoint];
export interface CubicIntersectionOptions {
  positionTolerance:number;
  parameterTolerance:number;
  maxWork:number;
  maxDepth:number;
}
export interface CubicIntersectionPoint {
  parameterA:number;
  parameterB:number;
  contact:'crossing'|'tangent'|'endpoint'|'degenerate';
}
export interface CubicIntersectionOverlap {
  parameterA:[number,number];
  parameterB:[number,number];
  orientation:1|-1;
}
export interface CubicIntersectionResult {
  points:CubicIntersectionPoint[];
  overlaps:CubicIntersectionOverlap[];
  work:number;
  maxDepthReached:number;
}

const EPS=Number.EPSILON;
function fail(code:string,message:string):never {throw new PathGeometryError(code,message);}
const finite=(x:unknown):x is number=>typeof x==='number'&&Number.isFinite(x);
function validateControls(value:unknown):asserts value is CubicControls {
  const array=(v:unknown,length:number):v is unknown[]=>{
    if(!Array.isArray(v)||Object.getPrototypeOf(v)!==Array.prototype||v.length!==length||Object.getOwnPropertySymbols(v).length)return false;
    const descriptors=Object.getOwnPropertyDescriptors(v);
    if(Object.keys(descriptors).some(k=>k!=='length'&&!Array.from({length},(_,i)=>String(i)).includes(k)))return false;
    for(let i=0;i<length;i++){const d=descriptors[String(i)];if(!d||!Object.hasOwn(d,'value')||!d.enumerable)return false;}
    return true;
  };
  if(!array(value,4))fail('INTERSECTION_DATA','Expected four ordinary finite cubic control points.');
  for(let i=0;i<4;i++){
    const p=value[i];
    if(!array(p,2)||!finite(p[0])||!finite(p[1]))fail('INTERSECTION_DATA','Expected four ordinary finite cubic control points.');
  }
}
function validateOptions(value:CubicIntersectionOptions):void {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['positionTolerance','parameterTolerance','maxWork','maxDepth'].includes(k)))
    fail('INTERSECTION_OPTIONS','Invalid cubic intersection options.');
  const prototype=Object.getPrototypeOf(value);
  if(prototype!==Object.prototype&&prototype!==null||Object.getOwnPropertySymbols(value).length||
    Object.values(Object.getOwnPropertyDescriptors(value)).some(d=>!Object.hasOwn(d,'value')||!d.enumerable))
    fail('INTERSECTION_OPTIONS','Expected ordinary cubic intersection option values.');
  if(!finite(value.positionTolerance)||value.positionTolerance<=0||!finite(value.parameterTolerance)||value.parameterTolerance<32*EPS||value.parameterTolerance>=.5)
    fail('INTERSECTION_TOLERANCE','Require positive position tolerance and parameter tolerance in [32*Number.EPSILON,0.5).');
  if(!Number.isSafeInteger(value.maxWork)||value.maxWork<1||value.maxWork>1048576||!Number.isSafeInteger(value.maxDepth)||value.maxDepth<1||value.maxDepth>52)
    fail('INTERSECTION_BUDGET','Require maxWork in [1,1048576] and maxDepth in [1,52].');
}
const same=(a:CubicPoint,b:CubicPoint)=>a[0]===b[0]&&a[1]===b[1];
function snapshot(result:CubicIntersectionResult):DeepReadonly<CubicIntersectionResult> {
  const freeze=(v:any):void=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}};
  freeze(result);return result;
}

/** Finite cubic-pair intersections. No partial result is returned on unresolved work. */
export function intersectCubicSegments(a:CubicControls,b:CubicControls,options:CubicIntersectionOptions):DeepReadonly<CubicIntersectionResult> {
  validateControls(a);validateControls(b);validateOptions(options);
  if(a.every(p=>same(p,a[0]))&&b.every(p=>same(p,b[0])))
    return snapshot({points:same(a[0],b[0])?[{parameterA:0,parameterB:0,contact:'degenerate'}]:[],overlaps:[],work:1,maxDepthReached:0});
  if(a.every((p,i)=>same(p,b[i]))||a.every((p,i)=>same(p,b[3-i]))) {
    const orientation=a.every((p,i)=>same(p,b[i]))?1:-1;
    return snapshot({points:[],overlaps:[{parameterA:[0,1],parameterB:[0,1],orientation}],work:1,maxDepthReached:0});
  }
  return solvePair(a,b,options);
}

type Point=[number,number];
type Curve=[Point,Point,Point,Point];
type Range=[number,number];
type Box={a:Curve;b:Curve;ta:Range;tb:Range;da:number;db:number};
type Candidate={a:number;b:number;ta:Range;tb:Range;regular:boolean};
const sub=(a:CubicPoint,b:CubicPoint):Point=>[a[0]-b[0],a[1]-b[1]];
const dot=(a:CubicPoint,b:CubicPoint)=>a[0]*b[0]+a[1]*b[1];
const cross=(a:CubicPoint,b:CubicPoint)=>a[0]*b[1]-a[1]*b[0];
const norm=(a:CubicPoint)=>Math.hypot(a[0],a[1]);
const mix=(a:CubicPoint,b:CubicPoint,t:number):Point=>[(1-t)*a[0]+t*b[0],(1-t)*a[1]+t*b[1]];
function at(c:CubicControls,t:number):Point {
  const a=mix(c[0],c[1],t),b=mix(c[1],c[2],t),d=mix(c[2],c[3],t);
  return mix(mix(a,b,t),mix(b,d,t),t);
}
function derivative(c:CubicControls,t:number):Point {
  const a=sub(c[1],c[0]),b=sub(c[2],c[1]),d=sub(c[3],c[2]);
  const v=mix(mix(a,b,t),mix(b,d,t),t);return [3*v[0],3*v[1]];
}
function split(c:Curve):[Curve,Curve] {
  const a=mix(c[0],c[1],.5),b=mix(c[1],c[2],.5),d=mix(c[2],c[3],.5),e=mix(a,b,.5),f=mix(b,d,.5),g=mix(e,f,.5);
  return [[c[0],a,e,g],[g,f,d,c[3]]];
}
function extent(c:Curve):number {
  return Math.max(Math.max(...c.map(p=>p[0]))-Math.min(...c.map(p=>p[0])),Math.max(...c.map(p=>p[1]))-Math.min(...c.map(p=>p[1])));
}
/** Separating projections of control hulls are conservative for the curves. */
function separated(a:Curve,b:Curve):boolean {
  const axes:Point[]=[[1,0],[0,1]];
  for(const c of [a,b])for(let i=0;i<4;i++)for(let j=i+1;j<4;j++){
    const d=sub(c[j],c[i]),m=norm(d);if(m)axes.push([-d[1]/m,d[0]/m]);
  }
  for(const axis of axes){
    const av=a.map(p=>dot(p,axis)),bv=b.map(p=>dot(p,axis));
    const roundoff=16*EPS*Math.max(1,...av.map(Math.abs),...bv.map(Math.abs));
    if(Math.max(...av)<Math.min(...bv)-roundoff||Math.max(...bv)<Math.min(...av)-roundoff)return true;
  }return false;
}
function refine(a:CubicControls,b:CubicControls,ta:number,tb:number,rangeA:Range=[0,1],rangeB:Range=[0,1]):{a:number;b:number;regular:boolean;residual:number} {
  let regular=false;
  for(let i=0;i<30;i++){
    const difference=sub(at(a,ta),at(b,tb)),da=derivative(a,ta),db=derivative(b,tb),det=cross(da,db);
    regular=Math.abs(det)>128*EPS*norm(da)*norm(db);
    if(!regular)break;
    const dt=-cross(difference,db)/det,du=-cross(difference,da)/det;
    if(!finite(dt)||!finite(du))break;
    const nextA=ta+dt,nextB=tb+du;
    if(nextA<rangeA[0]||nextA>rangeA[1]||nextB<rangeB[0]||nextB>rangeB[1])break;
    if(nextA===ta&&nextB===tb)break;
    ta=nextA;tb=nextB;
  }
  return {a:ta,b:tb,regular,residual:norm(sub(at(a,ta),at(b,tb)))};
}
function subcurve(c:Curve,lo:number,hi:number):Curve {
  const cut=(input:Curve,t:number):[Curve,Curve]=>{
    const a=mix(input[0],input[1],t),b=mix(input[1],input[2],t),d=mix(input[2],input[3],t),e=mix(a,b,t),f=mix(b,d,t),g=mix(e,f,t);
    return [[input[0],a,e,g],[g,f,d,input[3]]];
  };
  const left=hi===1?c:cut(c,hi)[0];return lo===0?left:cut(left,lo/hi)[1];
}
/** A Krawczyk enclosure gives an early unique-root certificate for regular boxes. */
function uniqueRoot(a:Curve,b:Curve):{a:number;b:number}|undefined {
  const da=derivative(a,.5),db=derivative(b,.5),det=cross(da,db);
  if(!finite(det)||Math.abs(det)<=256*EPS*norm(da)*norm(db))return;
  // Inverse of [A',-B'] at the midpoint.
  const inverse=[[db[1]/det,-db[0]/det],[da[1]/det,-da[0]/det]];
  const delta=sub(at(a,.5),at(b,.5));
  const center=inverse.map(row=>.5-dot(row as Point,delta));
  const ja=a.slice(1).map((p,i)=>sub(p,a[i]).map(v=>3*v) as Point);
  const jb=b.slice(1).map((p,i)=>sub(b[i],p).map(v=>3*v) as Point);
  let interior=true,contraction=true;
  for(let r=0;r<2;r++){
    let radius=0;
    for(let c=0;c<2;c++){
      const entries=(c===0?ja:jb).map(v=>(r===c?1:0)-dot(inverse[r] as Point,v));
      radius+=.5*Math.max(...entries.map(Math.abs));
    }
    contraction=contraction&&radius<.45;
    radius+=256*EPS*(1+Math.abs(center[r])+Math.abs(inverse[r][0])+Math.abs(inverse[r][1]));
    interior=interior&&center[r]-radius>0&&center[r]+radius<1;
  }
  if(!interior){
    if(contraction)for(const ta of [0,1])for(const tb of [0,1])if(same(a[ta*3],b[tb*3]))return {a:ta,b:tb};
    return;
  }
  const root=refine(a,b,center[0],center[1]);
  return root.regular&&root.residual<=2048*EPS?{a:root.a,b:root.b}:undefined;
}

const polynomial=(v:number[])=>[v[0],3*(v[1]-v[0]),3*(v[2]-2*v[1]+v[0]),v[3]-3*v[2]+3*v[1]-v[0]];
const evaluatePolynomial=(p:number[],t:number)=>p.reduceRight((v,c)=>v*t+c,0);
const differentiate=(p:number[])=>p.slice(1).map((v,i)=>v*(i+1));
/** Derivative partitions retain double roots rather than relying on sign changes alone. */
function scalarRoots(input:number[]):number[]{
  const magnitude=Math.max(...input.map(Math.abs));if(!magnitude)return [];
  const scale=2**Math.max(-1074,Math.min(1023,Math.floor(Math.log2(magnitude))));
  const p=input.map(v=>v/scale);while(p.length>1&&p.at(-1)===0)p.pop();
  if(p.some((v,i)=>!finite(v)||v===0&&input[i]!==0))fail('INTERSECTION_PRECISION','Cubic coefficient normalization loses data.');
  if(p.length<=1)return [];
  if(p.length===2){const t=p[0]===0?0:p[0]+p[1]===0?1:-p[0]/p[1];return t>=0&&t<=1?[t]:[];}
  const boundaries=[0,...scalarRoots(differentiate(p)).filter(t=>t>0&&t<1),1].sort((a,b)=>a-b);
  const values=boundaries.map(t=>evaluatePolynomial(p,t)),result:number[]=[],roundoff=64*EPS*p.reduce((s,v)=>s+Math.abs(v),0);
  for(let i=0;i<boundaries.length;i++){
    if(values[i]===0)result.push(boundaries[i]);
    else if(i>0&&i+1<boundaries.length&&Math.abs(values[i])<=roundoff)
      fail('INTERSECTION_AMBIGUOUS','Nearly tangent cubic scalar residual has unresolved multiplicity.');
  }
  for(let i=0;i+1<boundaries.length;i++){
    if(values[i]===0||values[i+1]===0||(values[i]<0)===(values[i+1]<0))continue;
    let lo=boundaries[i],hi=boundaries[i+1],flo=values[i];
    for(let k=0;k<80;k++){
      const mid=(lo+hi)/2;if(mid===lo||mid===hi)break;
      const f=evaluatePolynomial(p,mid);if(f===0){lo=hi=mid;break;}
      if((f<0)===(flo<0)){lo=mid;flo=f;}else hi=mid;
    }result.push((lo+hi)/2);
  }
  return result.sort((a,b)=>a-b).filter((t,i,all)=>i===0||t-all[i-1]>32*EPS);
}

/** An identical strictly monotone coordinate implies matching parameters exactly. */
function commonCoordinate(a:Curve,b:Curve,spatial:number):CubicIntersectionPoint[]|undefined {
  for(const reversed of [false,true])for(const axis of [0,1]){
    const aligned=(reversed?[...b].reverse():b) as Curve;
    if(!a.every((p,i)=>p[axis]===aligned[i][axis]))continue;
    const coordinates=a.map(p=>p[axis]),d=coordinates.slice(1).map((v,i)=>v-coordinates[i]);
    if(!(d.every(v=>v>=0)&&d.some(v=>v>0)||d.every(v=>v<=0)&&d.some(v=>v<0)))continue;
    const equation=polynomial(a.map((p,i)=>p[1-axis]-aligned[i][1-axis]));
    if(equation.every(v=>v===0))fail('INTERSECTION_AMBIGUOUS','Coincident cubic parameterization could not be resolved as a full overlap.');
    return scalarRoots(equation).map(t=>{
      const u=reversed?1-t:t,da=derivative(a,t),db=derivative(b,u);
      if(norm(sub(at(a,t),at(b,u)))>spatial)fail('INTERSECTION_PRECISION','Analytic cubic root residual exceeds position tolerance.');
      return {parameterA:t,parameterB:u,contact:t===0||t===1?'endpoint':norm(da)===0||norm(db)===0?'degenerate':
        Math.abs(evaluatePolynomial(differentiate(equation),t))<=128*EPS*equation.reduce((s,v)=>s+Math.abs(v),0)?'tangent':'crossing'};
    });
  }
}

/** If both hulls meet only on a coordinate support line, only endpoints can touch it. */
function supportContact(a:Curve,b:Curve):CubicIntersectionPoint[]|undefined {
  for(const axis of [0,1]){
    const amin=Math.min(...a.map(p=>p[axis])),amax=Math.max(...a.map(p=>p[axis]));
    const bmin=Math.min(...b.map(p=>p[axis])),bmax=Math.max(...b.map(p=>p[axis]));
    if(amin===amax||bmin===bmax||amax!==bmin&&bmax!==amin)continue;
    const points:CubicIntersectionPoint[]=[];
    for(const ta of [0,1])for(const tb of [0,1])if(same(a[ta*3],b[tb*3]))points.push({parameterA:ta,parameterB:tb,contact:'endpoint'});
    return points;
  }
}

function pointCurve(a:Curve,b:Curve,spatial:number):CubicIntersectionPoint[]|undefined {
  const ca=a.every(p=>same(p,a[0])),cb=b.every(p=>same(p,b[0]));
  if(!ca&&!cb)return;
  const p=(ca?a:b)[0],curve=ca?b:a;
  const ranges=[0,1].map(axis=>Math.max(...curve.map(v=>v[axis]))-Math.min(...curve.map(v=>v[axis]))),axis=ranges[0]>=ranges[1]?0:1;
  const equation=polynomial(curve.map(v=>v[axis]-p[axis]));
  const points:CubicIntersectionPoint[]=[];
  for(const t of scalarRoots(equation)){
    const value=at(curve,t),residual=norm(sub(value,p));
    if(residual===0)points.push({parameterA:ca?0:t,parameterB:ca?t:0,contact:'degenerate'});
    else if(residual<=Math.min(spatial,256*EPS))fail('INTERSECTION_AMBIGUOUS','A point-like cubic is too close to certify a curve contact.');
  }return points;
}

function solvePair(inputA:CubicControls,inputB:CubicControls,options:CubicIntersectionOptions):DeepReadonly<CubicIntersectionResult> {
  const origin=inputA[0],shifted=[inputA,inputB].map(c=>c.map(p=>sub(p,origin)) as Curve);
  const magnitude=Math.max(...shifted.flat(2).map(Math.abs));
  if(!finite(magnitude))fail('INTERSECTION_PRECISION','Cubic coordinate subtraction overflowed.');
  const scale=magnitude?2**Math.max(-1074,Math.min(1023,Math.floor(Math.log2(magnitude)))):1;
  const [a,b]=shifted.map(c=>c.map(p=>p.map(v=>v/scale) as Point) as Curve);
  for(let side=0;side<2;side++)for(let i=0;i<4;i++)for(let j=0;j<2;j++)
    if(!finite([a,b][side][i][j])||shifted[side][i][j]!==0&&[a,b][side][i][j]===0)
      fail('INTERSECTION_PRECISION','Cubic normalization loses a nonzero coordinate.');
  const original=[...inputA,...inputB],normalized=[...a,...b];
  for(let i=0;i<8;i++)for(let j=i+1;j<8;j++)for(let axis=0;axis<2;axis++)
    if(normalized[i][axis]===normalized[j][axis]&&original[i][axis]!==original[j][axis])
      fail('INTERSECTION_PRECISION','Cubic normalization merges distinct authored coordinates.');
  const spatial=options.positionTolerance/scale;
  if(!finite(spatial)||spatial<=0)fail('INTERSECTION_PRECISION','Position tolerance is outside the normalized numeric range.');
  const degenerate=pointCurve(a,b,spatial);
  if(degenerate)return snapshot({points:degenerate,overlaps:[],work:1,maxDepthReached:0});
  const endpointOnly=supportContact(a,b);
  if(endpointOnly)return snapshot({points:endpointOnly,overlaps:[],work:1,maxDepthReached:0});
  const analytic=commonCoordinate(a,b,spatial);
  if(analytic)return snapshot({points:analytic,overlaps:[],work:1,maxDepthReached:0});
  const target=Math.max(64*EPS,Math.min(options.parameterTolerance/8,1e-10));
  const stack:Box[]=[{a,b,ta:[0,1],tb:[0,1],da:0,db:0}],candidates:Candidate[]=[];
  let work=0,maxDepthReached=0;
  const consumeWork=()=>{
    if(++work>options.maxWork)fail('INTERSECTION_BUDGET','Cubic subdivision or candidate merging exhausted maxWork; no partial result is returned.');
  };
  while(stack.length){
    const box=stack.pop()!;
    consumeWork();
    maxDepthReached=Math.max(maxDepthReached,box.da,box.db);
    if(separated(box.a,box.b))continue;
    const certified=uniqueRoot(box.a,box.b);
    if(certified){
      candidates.push({a:box.ta[0]+certified.a*(box.ta[1]-box.ta[0]),b:box.tb[0]+certified.b*(box.tb[1]-box.tb[0]),ta:box.ta,tb:box.tb,regular:true});continue;
    }
    const wa=box.ta[1]-box.ta[0],wb=box.tb[1]-box.tb[0];
    // A root on a dyadic subdivision boundary needs an enclosure straddling that boundary.
    // This enlarged certificate contains the entire original box, so it cannot swallow
    // an additional root from that box or accept proximity without existence.
    if(Math.min(box.da,box.db)>=2){
      const guess=refine(a,b,(box.ta[0]+box.ta[1])/2,(box.tb[0]+box.tb[1])/2);
      if(guess.regular&&guess.a>=box.ta[0]-wa&&guess.a<=box.ta[1]+wa&&guess.b>=box.tb[0]-wb&&guess.b<=box.tb[1]+wb){
        const ra:Range=[Math.max(0,Math.min(box.ta[0],guess.a-wa)),Math.min(1,Math.max(box.ta[1],guess.a+wa))];
        const rb:Range=[Math.max(0,Math.min(box.tb[0],guess.b-wb)),Math.min(1,Math.max(box.tb[1],guess.b+wb))];
        const expanded=uniqueRoot(subcurve(a,...ra),subcurve(b,...rb));
        if(expanded){candidates.push({a:ra[0]+expanded.a*(ra[1]-ra[0]),b:rb[0]+expanded.b*(rb[1]-rb[0]),ta:ra,tb:rb,regular:true});continue;}
      }
    }
    if(wa<=target&&wb<=target){
      fail('INTERSECTION_AMBIGUOUS','Cubic boxes remain close without a unique-root certificate; a small residual alone is insufficient.');
    }
    const divideA=wa>target&&(wb<=target||extent(box.a)>=extent(box.b));
    if((divideA?box.da:box.db)>=options.maxDepth)
      fail('INTERSECTION_BUDGET','Cubic subdivision exhausted maxDepth; no partial result is returned.');
    if(divideA){const [left,right]=split(box.a),mid=(box.ta[0]+box.ta[1])/2;
      stack.push({...box,a:right,ta:[mid,box.ta[1]],da:box.da+1},{...box,a:left,ta:[box.ta[0],mid],da:box.da+1});
    }else{const [left,right]=split(box.b),mid=(box.tb[0]+box.tb[1])/2;
      stack.push({...box,b:right,tb:[mid,box.tb[1]],db:box.db+1},{...box,b:left,tb:[box.tb[0],mid],db:box.db+1});
    }
  }
  const points:CubicIntersectionPoint[]=[],accepted:Candidate[]=[];
  for(const candidate of candidates.sort((x,y)=>x.a-y.a||x.b-y.b)){
    const root=refine(a,b,candidate.a,candidate.b,candidate.ta,candidate.tb),da=derivative(a,root.a),db=derivative(b,root.b);
    if(norm(sub(at(a,root.a),at(b,root.b)))>spatial)fail('INTERSECTION_PRECISION','Cubic root residual exceeds position tolerance.');
    let duplicate=false;
    for(let i=0;i<accepted.length;i++){
      consumeWork();
      const previous=accepted[i];
      // The same representable parameter pair is a single visit, including an
      // exact dyadic endpoint shared by otherwise disjoint certified boxes.
      if(points[i].parameterA===root.a&&points[i].parameterB===root.b){duplicate=true;break;}
      if(Math.max(previous.ta[0],candidate.ta[0])>Math.min(previous.ta[1],candidate.ta[1])||
        Math.max(previous.tb[0],candidate.tb[0])>Math.min(previous.tb[1],candidate.tb[1]))continue;
      const ra:Range=[Math.min(previous.ta[0],candidate.ta[0]),Math.max(previous.ta[1],candidate.ta[1])];
      const rb:Range=[Math.min(previous.tb[0],candidate.tb[0]),Math.max(previous.tb[1],candidate.tb[1])];
      if(uniqueRoot(subcurve(a,...ra),subcurve(b,...rb))){duplicate=true;break;}
    }
    if(duplicate)continue;
    const endpoint=(t:number)=>t===0||t===1;
    points.push({parameterA:root.a,parameterB:root.b,contact:endpoint(root.a)||endpoint(root.b)?'endpoint':
      norm(da)===0||norm(db)===0?'degenerate':Math.abs(cross(da,db))<=256*EPS*norm(da)*norm(db)?'tangent':'crossing'});
    accepted.push(candidate);
  }
  return snapshot({points,overlaps:[],work,maxDepthReached});
}
