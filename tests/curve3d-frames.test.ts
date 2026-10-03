import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareCurve3D,sampleCurve3DAt,validateCurve3DOptions,Curve3DError} from '../src/geometry/curve3d.ts';
import {prepareTransportFrames3D,sampleTransportFrame3D,validateTransportFrameOptions3D,type CurveFrameSample3D} from '../src/geometry/frames3d.ts';
import {composeTransform3D,transformDirection3D,type Vec3} from '../src/geometry/matrix4.ts';
import type {DeepReadonly} from '../src/ir/operations.ts';

const close=(a:number,b:number,epsilon=1e-10)=>assert.ok(Math.abs(a-b)<=epsilon,`${a} != ${b} (±${epsilon})`);
const vector=(a:readonly number[],b:readonly number[],epsilon=1e-10)=>a.forEach((n,i)=>close(n,b[i],epsilon));
const dot=(a:readonly number[],b:readonly number[])=>a.reduce((sum,n,i)=>sum+n*b[i],0);
const cross=(a:readonly number[],b:readonly number[])=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const code=(name:string)=>(error:unknown)=>error instanceof Curve3DError&&error.code===name;
const verify=(frame:DeepReadonly<CurveFrameSample3D>)=>{
  for(const axis of [frame.tangent,frame.normal,frame.binormal])close(Math.hypot(...axis),1);
  close(dot(frame.tangent,frame.normal),0);close(dot(frame.tangent,frame.binormal),0);close(dot(frame.normal,frame.binormal),0);
  vector(cross(frame.tangent,frame.normal),frame.binormal);close(Math.hypot(...frame.quaternion),1);
  const matrix=composeTransform3D({rotation:frame.quaternion});
  vector(transformDirection3D(matrix,[1,0,0]),frame.tangent);vector(transformDirection3D(matrix,[0,1,0]),frame.normal);
  vector(transformDirection3D(matrix,[0,0,1]),frame.binormal);
};
const up={seed:{kind:'up' as const,up:[0,0,1] as Vec3}};

test('straight curve length and explicit up/rotation seeds have exact constant frames and independent arc sampling',()=>{
  const source=prepareCurve3D({domain:[.3,.9],segments:6},u=>[u,0,0]);close(source.totalLength,.6);
  const prepared=prepareTransportFrames3D(source,{seed:{kind:'up',up:[0,1,0]}});
  for(const p of [0,.17,.5,.91,1]){
    const f=sampleTransportFrame3D(prepared,p);verify(f);vector(f.position,[.3+.6*p,0,0]);vector(f.tangent,[1,0,0]);
    vector(f.normal,[0,1,0]);vector(f.binormal,[0,0,1]);close(f.parameter,.3+.6*p);close(f.length,.6*p);
  }
  assert.equal(source.parameters.at(-1),.9);assert.equal(sampleTransportFrame3D(prepared,1).position[0],.9);
  const rotated=prepareTransportFrames3D(source,{seed:{kind:'quaternion',rotation:[Math.SQRT1_2,0,0,Math.SQRT1_2]}});
  vector(rotated.frames[0].normal,[0,0,1]);vector(rotated.frames[0].binormal,[0,-1,0]);
  assert.throws(()=>prepareTransportFrames3D(source,{seed:{kind:'quaternion',rotation:[0,0,Math.SQRT1_2,Math.SQRT1_2]}}),code('FRAME3D_SEED_ALIGNMENT'));
  assert.throws(()=>prepareTransportFrames3D(source,{seed:{kind:'up',up:[2,0,0]}}),code('FRAME3D_SEED_PARALLEL'));
});

test('circle length is the polygon chord sum and planar parallel transport keeps the explicit normal',()=>{
  const count=128,radius=2,curve=prepareCurve3D({domain:[0,2*Math.PI],segments:count,closed:true},u=>[radius*Math.cos(u),radius*Math.sin(u),0]);
  close(curve.totalLength,2*count*radius*Math.sin(Math.PI/count));assert.ok(curve.totalLength<2*Math.PI*radius);
  const prepared=prepareTransportFrames3D(curve,{...up,closedSeam:'distribute'});
  for(let i=0;i<=count;i++){
    const u=curve.parameters[i],f=prepared.frames[i];verify(f);vector(f.tangent,[-Math.sin(u),Math.cos(u),0],1e-12);vector(f.normal,[0,0,1]);
  }
  vector(prepared.frames[0].position,prepared.frames.at(-1)!.position,0);
  close(Math.abs(dot(prepared.frames[0].quaternion,prepared.frames.at(-1)!.quaternion)),1);
  for(let i=1;i<prepared.frames.length;i++)assert.ok(dot(prepared.frames[i-1].quaternion,prepared.frames[i].quaternion)>=0);
  assert.equal(curve.report.lengthPolicy,'chord-sum');assert.equal(curve.report.tangentPolicy,'unit-chord-bisectors');
});

test('helix frames are finite orthonormal and approximate analytic tangents without a Frenet curvature rule',()=>{
  const turns=4*Math.PI,pitch=.3,n=256,curve=prepareCurve3D({domain:[0,turns],segments:n},u=>[Math.cos(u),Math.sin(u),pitch*u]);
  close(curve.totalLength,n*Math.hypot(2*Math.sin(turns/n/2),pitch*turns/n));
  const prepared=prepareTransportFrames3D(curve,up);
  for(let i=0;i<=n;i+=8){verify(prepared.frames[i]);const u=curve.parameters[i],analytic=[-Math.sin(u),Math.cos(u),pitch].map(v=>v/Math.hypot(1,pitch));
    if(i>0&&i<n)vector(prepared.frames[i].tangent,analytic,2e-4);}
  for(const p of [.123,.357,.731,.999])verify(sampleTransportFrame3D(prepared,p));
  assert.equal(prepared.report.algorithm,'discrete-parallel-transport');
});

test('inflection and zero curvature preserve a planar seed without normal flips',()=>{
  const curve=prepareCurve3D({domain:[-2,2],segments:128},u=>[u,u*u*u,0]),prepared=prepareTransportFrames3D(curve,up);
  for(const f of prepared.frames){verify(f);vector(f.normal,[0,0,1]);}
  const center=sampleTransportFrame3D(prepared,.5);close(center.position[0],0);close(center.position[1],0);
});

test('closed nonplanar seam distribution cancels holonomy before explicit authored twist',()=>{
  const curve=prepareCurve3D({domain:[0,2*Math.PI],segments:384,closed:true},u=>[(2+.5*Math.cos(3*u))*Math.cos(2*u),(2+.5*Math.cos(3*u))*Math.sin(2*u),.5*Math.sin(3*u)]);
  const preserved=prepareTransportFrames3D(curve,up),closed=prepareTransportFrames3D(curve,{...up,closedSeam:'distribute'});
  assert.ok(Math.abs(preserved.report.baseSeamAngle!)>.01);close(preserved.report.finalSeamAngle!,preserved.report.baseSeamAngle!);
  close(closed.report.finalSeamAngle!,0);close(Math.abs(dot(closed.frames[0].quaternion,closed.frames.at(-1)!.quaternion)),1);
  const twisted=prepareTransportFrames3D(curve,{...up,closedSeam:'distribute',twist:Math.PI/2});close(twisted.report.finalSeamAngle!,-Math.PI/2);
  for(const f of twisted.frames)verify(f);
});

test('twist is distributed by chord length and underresolved turns fail rather than alias',()=>{
  const curve=prepareCurve3D({domain:[0,1],segments:16},u=>[u,0,0]);
  const frames=prepareTransportFrames3D(curve,{seed:{kind:'up',up:[0,1,0]},twist:2*Math.PI});
  for(const p of [0,.125,.25,.375,.5,.75,1]){
    const f=sampleTransportFrame3D(frames,p);vector(f.normal,[0,Math.cos(2*Math.PI*p),Math.sin(2*Math.PI*p)]);verify(f);
  }
  assert.throws(()=>prepareTransportFrames3D(curve,{seed:{kind:'up',up:[0,1,0]},twist:16*Math.PI}),code('FRAME3D_TWIST_RESOLUTION'));
  assert.throws(()=>prepareTransportFrames3D(curve,{...up,closedSeam:'distribute'}),code('FRAME3D_SEAM'));
});

test('reversed parameter orientation flips tangents while retaining independent stable seeds',()=>{
  const forward=prepareCurve3D({domain:[0,1],segments:32},u=>[u,u*u,0]),reverse=prepareCurve3D({domain:[0,1],segments:32},u=>[1-u,(1-u)**2,0]);
  const a=prepareTransportFrames3D(forward,up),b=prepareTransportFrames3D(reverse,up);close(forward.totalLength,reverse.totalLength);
  for(const p of [0,.1,.35,.7,1]){
    const x=sampleTransportFrame3D(a,p),y=sampleTransportFrame3D(b,1-p);vector(x.position,y.position);vector(x.tangent,y.tangent.map(n=>-n));vector(x.normal,y.normal);verify(y);
  }
});

test('absolute random/reverse seeks and 30/60 shared progress preserve frames and immutable input snapshots',()=>{
  const options={domain:[0,6] as [number,number],segments:96},curve=prepareCurve3D(options,u=>[Math.cos(u),Math.sin(u),u*.2]),frames=prepareTransportFrames3D(curve,up);
  const before=JSON.stringify(frames),sampled=new Map<number,string>();for(let i=0;i<=30;i++)sampled.set(i,JSON.stringify(sampleTransportFrame3D(frames,i/30)));
  for(const i of [30,0,19,2,17,5,30,9])assert.equal(JSON.stringify(sampleTransportFrame3D(frames,i/30)),sampled.get(i));
  for(let i=0;i<=60;i+=2)assert.equal(JSON.stringify(sampleTransportFrame3D(frames,i/60)),sampled.get(i/2));
  assert.equal(JSON.stringify(frames),before);options.domain[1]=1;assert.equal(curve.domain[1],6);
  assert.ok(Object.isFrozen(frames.frames[0].quaternion));assert.ok(Object.isFrozen(curve.positions[0]));
  const at=sampleTransportFrame3D(frames,.133);assert.ok(at.chordTangent.some((n,i)=>Math.abs(n-at.tangent[i])>1e-5));
});

test('sampling validates budgets and grid precision before calling author code and preserves callback diagnostics',()=>{
  let calls=0;assert.throws(()=>prepareCurve3D({domain:[0,1],segments:8193},()=>{calls++;return [0,0,0];}),code('CURVE3D_BUDGET'));assert.equal(calls,0);
  assert.ok(validateCurve3DOptions({domain:[2**53,2**53+4],segments:3}).some(d=>d.code==='CURVE3D_PRECISION'));
  const input={domain:[0,1],segments:4};Object.defineProperty(input,'closed',{enumerable:true,get(){calls++;return false;}});assert.ok(validateCurve3DOptions(input).length);assert.equal(calls,0);
  const error=new Error('author expression path');assert.throws(()=>prepareCurve3D({domain:[0,1],segments:3},()=>{throw error;}),e=>e===error);
  assert.throws(()=>prepareCurve3D({domain:[0,1],segments:3},()=>[NaN,0,0]),code('CURVE3D_NONFINITE'));
  assert.throws(()=>prepareCurve3D({domain:[0,1],segments:3},()=>[0,0,0]),code('CURVE3D_SEGMENT'));
  assert.throws(()=>prepareCurve3D({domain:[-1,1],segments:2},u=>[u*u,0,0]),code('CURVE3D_CUSP'));
  assert.throws(()=>prepareCurve3D({domain:[0,1],segments:3,closed:true},u=>[u,0,0]),code('CURVE3D_CLOSURE'));
  assert.ok(validateTransportFrameOptions3D({seed:{kind:'up',up:[0,0,0]}}).length);
  assert.ok(validateTransportFrameOptions3D({seed:{kind:'up',up:[0,0,1]},closedSeam:null}).length);
});

test('positions and active chord directions use the sampled polyline without hidden analytic reevaluation',()=>{
  let calls=0;const curve=prepareCurve3D({domain:[0,1],segments:2},u=>{calls++;return [u,u*u,0];});
  const initial=calls,f=sampleCurve3DAt(curve,.25);assert.equal(calls,initial);
  const a=curve.positions[f.segmentIndex],b=curve.positions[f.segmentIndex+1];vector(f.position,a.map((n,i)=>n+(b[i]-n)*f.localFraction));
  const difference=b.map((n,i)=>n-a[i]),length=Math.hypot(...difference);vector(f.chordTangent,difference.map(n=>n/length));
  for(const progress of [-.01,1.01,Infinity,NaN])assert.throws(()=>sampleCurve3DAt(curve,progress),code('CURVE3D_PROGRESS'));
});
