import test from 'node:test';
import assert from 'node:assert/strict';
import {adaptiveSampleCurve,areaBetweenCurves,sampledDataPlot,type AdaptiveSamplingOptions,type SampledPlot} from '../src/geometry/adaptive-sampling.js';
import {createCartesianMapping} from '../src/geometry/data-space.js';
import type {PathPoint} from '../src/path-geometry.js';
import type {DeepReadonly} from '../src/ir/operations.js';
const error=(fn:()=>unknown,code:string):void=>assert.throws(fn,(e:unknown)=>e instanceof Error&&'code' in e&&e.code===code);
const vertices=(result:DeepReadonly<SampledPlot>):(readonly PathPoint[])[]=>result.geometry.contours.map(c=>[c.start,...c.segments.map(s=>s.to)]) as PathPoint[][];
function denseGraphError(result:DeepReadonly<SampledPlot>,fn:(x:number)=>number):number {
  let maximum=0;
  for(const points of vertices(result))for(let i=1;i<points.length;i++){
    const a=points[i-1],b=points[i];
    for(let j=1;j<80;j++){const t=j/80,x=(1-t)*a[0]+t*b[0],y=(1-t)*a[1]+t*b[1];maximum=Math.max(maximum,Math.abs(fn(x)-y));}
  }
  return maximum;
}

test('adaptive mapped polynomial matches a dense independent graph oracle and retains endpoints',()=>{
  const y=(x:number)=>.003*x*x-.000003*x*x*x;
  const result=adaptiveSampleCurve(x=>[x,y(x)],{domains:[[-200,250]],tolerance:.25,initialSegments:4});
  assert.equal(result.geometry.contours.length,1);assert.deepEqual(result.geometry.contours[0].start,[-200,y(-200)]);
  assert.deepEqual(result.geometry.contours[0].segments.at(-1)?.to,[250,y(250)]);
  assert.ok(denseGraphError(result,y)<.253);assert.ok(result.report.maxAcceptedError<=.25);
  assert.ok(result.report.maxObservedError>.25);assert.equal(result.report.qualityMetric,'observed-probes');
});

test('nonuniform probes avoid the midpoint and quarter-point alias of a high frequency sine',()=>{
  const y=(x:number)=>40*Math.sin(2*Math.PI*32*x),options:AdaptiveSamplingOptions={domains:[[0,1]],tolerance:.12,initialSegments:8};
  const result=adaptiveSampleCurve(x=>[x,y(x)],options);
  assert.ok(result.report.segmentCount>500);assert.ok(denseGraphError(result,y)<.125);
  assert.deepEqual(result,adaptiveSampleCurve(x=>[x,y(x)],options));
});

test('data-to-scene scale and pixel density determine geometric refinement, not the renderer',()=>{
  const config={origin:[0,0] as PathPoint,width:120,height:80,xMin:-1,xMax:1,yMin:0,yMax:1};
  const small=createCartesianMapping(config),large=createCartesianMapping({...config,width:480,height:320});
  const opts={domains:[[-1,1]] as [number,number][],initialSegments:2,tolerance:.4};
  const first=adaptiveSampleCurve(x=>small.dataToScene(x,x*x),opts),second=adaptiveSampleCurve(x=>large.dataToScene(x,x*x),opts),dense=adaptiveSampleCurve(x=>small.dataToScene(x,x*x),{...opts,pixelsPerBp:4});
  assert.ok(second.report.segmentCount>first.report.segmentCount);assert.equal(second.report.segmentCount,dense.report.segmentCount);
  assert.equal(dense.report.tolerance,.4);assert.equal(dense.report.pixelsPerBp,4);
});

test('a parametric loop remains ordered and resolves a closed geometric trace without a false chord',()=>{
  const result=adaptiveSampleCurve(t=>[100*Math.cos(t),100*Math.sin(t)],{domains:[[0,2*Math.PI]],initialSegments:1,tolerance:.25});
  assert.equal(result.geometry.contours.length,1);assert.ok(result.report.segmentCount>32);
  for(const points of vertices(result))for(let i=1;i<points.length;i++){
    const a=points[i-1],b=points[i];assert.ok(100-Math.hypot((a[0]+b[0])/2,(a[1]+b[1])/2)<.251);
  }
});

test('explicit intervals and finite-width masks keep reciprocal branches disconnected',()=>{
  const evaluate=(x:number):PathPoint=>[100*x,30/x];
  const result=adaptiveSampleCurve(evaluate,{domains:[[-2,-.08],[.08,2]],tolerance:.3});
  assert.equal(result.geometry.contours.length,2);
  for(const points of vertices(result))assert.ok(points.every(p=>Math.sign(p[0])===Math.sign(points[0][0])));
  const masked=adaptiveSampleCurve(x=>Math.abs(x)<.08?null:evaluate(x),{domains:[[-2,2]],breaks:[0],tolerance:.3});
  assert.equal(masked.geometry.contours.length,2);assert.ok(masked.report.maskedIntervals>0);
  assert.ok(masked.report.gaps.some(g=>g.reason==='break'&&g.domain[0]===0));
  for(const points of vertices(masked))assert.ok(points.every(p=>Math.sign(p[0])===Math.sign(points[0][0])));
});

test('declared break excludes its parameter and never joins finite step branches',()=>{
  let calledAtBreak=false;
  const result=adaptiveSampleCurve(x=>{if(x===0)calledAtBreak=true;return [x,x<0?0:50];},{domains:[[-1,1]],breaks:[0],initialSegments:2,maxDepth:8});
  assert.equal(calledAtBreak,false);assert.equal(result.geometry.contours.length,2);
  for(const points of vertices(result))assert.ok(points.every(p=>p[1]===points[0][1]));
  assert.equal(result.report.maxDepthReached,8);
});

test('sampled domain holes and all-null cells are reported rather than joined',()=>{
  const result=adaptiveSampleCurve(x=>x>=.3&&x<=.6?null:[x,10*x*x],{domains:[[0,1]],initialSegments:4,maxDepth:10});
  assert.equal(result.geometry.contours.length,2);assert.ok(result.report.gaps.some(g=>g.reason==='masked'&&g.domain[0]<=.3&&g.domain[1]>=.6));
  const empty=adaptiveSampleCurve(()=>null,{domains:[[0,1]],initialSegments:4});
  assert.deepEqual(empty.geometry,{contours:[]});assert.equal(empty.report.maskedIntervals,1);
  assert.deepEqual(empty.report.gaps,[{domain:[0,1],reason:'masked'}]);
});

test('joint area sampling closes each common valid interval and retains both curved boundaries',()=>{
  const top=(x:number):PathPoint|null=>x>.4&&x<.6?null:[100*x,40+20*x*x];
  const bottom=(x:number):PathPoint|null=>x>.45&&x<.65?null:[100*x,10+5*x*x];
  const result=areaBetweenCurves(top,bottom,{domains:[[0,1]],initialSegments:4,tolerance:.1,maxDepth:12});
  assert.equal(result.geometry.contours.length,2);assert.ok(result.geometry.contours.every(c=>c.closed));
  assert.equal(result.report.segmentCount,result.geometry.contours.reduce((n,c)=>n+c.segments.length+1,0));
  for(const points of vertices(result))assert.ok(points.every(p=>p[0]<=40||p[0]>=65));
  assert.ok(result.report.gaps.some(g=>g.reason==='masked'&&g.domain[0]<=.4&&g.domain[1]>=.65));
});

test('sampled data polylines preserve null and jump gaps, order and isolated points',()=>{
  const input:(PathPoint|null)[]=[[0,0],[1,2],null,[4,5],[5,6],[100,100]];
  const result=sampledDataPlot(input,{maxJump:10});
  assert.equal(result.geometry.contours.length,3);assert.equal(result.report.segmentCount,2);assert.equal(result.report.sampleCount,6);
  assert.deepEqual(vertices(result),[[[0,0],[1,2]],[[4,5],[5,6]],[[100,100]]]);
  input[0]![0]=999;assert.deepEqual(result.geometry.contours[0].start,[0,0]);
  assert.deepEqual(sampledDataPlot([]).geometry,{contours:[]});
});

test('bounded quality rejects unresolved finite curvature and never calls beyond a sample budget',()=>{
  error(()=>adaptiveSampleCurve(x=>[x,100*x*x],{domains:[[0,1]],initialSegments:1,maxDepth:0,tolerance:.001}),'PLOT_RESOLUTION');
  let calls=0;
  error(()=>adaptiveSampleCurve(x=>{calls++;return [x,x*x];},{domains:[[0,1]],initialSegments:1,maxSamples:5}),'PLOT_BUDGET');assert.equal(calls,5);
  error(()=>adaptiveSampleCurve(x=>[x,x],{domains:[[0,1]],initialSegments:3,maxSegments:2}),'PLOT_BUDGET');
  error(()=>areaBetweenCurves(x=>[x,1],x=>[x,0],{domains:[[0,1]],initialSegments:1,maxSegments:3}),'PLOT_BUDGET');
  error(()=>sampledDataPlot([[0,0],[1,1],[2,2]],{maxSegments:1}),'PLOT_BUDGET');
  error(()=>sampledDataPlot([[0,0],[1,1]],{maxSamples:1}),'PLOT_BUDGET');
  error(()=>sampledDataPlot([[-1e308,0],[1e308,0]]),'PLOT_RESOLUTION');
  error(()=>adaptiveSampleCurve(x=>[x,20*x],{domains:[[0,1]],initialSegments:1,maxDepth:0,maxJump:.1}),'PLOT_RESOLUTION');
});

test('invalid domains, precision collapse, nonfinite samples and hostile options fail explicitly',()=>{
  const evaluate=(x:number):PathPoint=>[x,x];
  for(const domains of [[],[[0,0]],[[1,0]],[[0,2],[1,3]],[[2,3],[0,1]],[[0,Infinity]]])
    error(()=>adaptiveSampleCurve(evaluate,{domains:domains as [number,number][]}),'PLOT_DOMAIN');
  error(()=>adaptiveSampleCurve(evaluate,{domains:[[0,1]],breaks:[2]}),'PLOT_DOMAIN');
  error(()=>adaptiveSampleCurve(evaluate,{domains:[[0,1]],breaks:[.5,.5]}),'PLOT_DOMAIN');
  error(()=>adaptiveSampleCurve(evaluate,{domains:[[1,1+Number.EPSILON]],initialSegments:1}),'PLOT_RESOLUTION');
  error(()=>adaptiveSampleCurve(()=>[0,Infinity],{domains:[[0,1]]}),'PLOT_SAMPLE');
  error(()=>adaptiveSampleCurve(()=>{throw new Error('domain');},{domains:[[0,1]]}),'PLOT_SAMPLE');
  error(()=>adaptiveSampleCurve(evaluate,{domains:[[0,1]],tolerance:0}),'PLOT_OPTIONS');
  error(()=>adaptiveSampleCurve(evaluate,{domains:[[0,1]],maxDepth:100}),'PLOT_BUDGET');
  error(()=>adaptiveSampleCurve(evaluate,{domains:[[0,1]],pixelsPerBp:1e308,tolerance:1e-308}),'PLOT_OPTIONS');
  error(()=>adaptiveSampleCurve(evaluate,{domains:[[0,1]],get tolerance():number{throw new Error('must not run');}}),'PLOT_OPTIONS');
  const sparse=Array(2) as PathPoint[];error(()=>sampledDataPlot(sparse),'PLOT_OPTIONS');
});

test('geometry, metadata and retained callback values are detached and deeply immutable',()=>{
  const shared:PathPoint=[0,0];
  const result=adaptiveSampleCurve(x=>{shared[0]=x;shared[1]=x;return shared;},{domains:[[0,1]],initialSegments:1});
  shared[0]=100;
  assert.deepEqual(result.geometry.contours[0].start,[0,0]);assert.deepEqual(result.geometry.contours[0].segments.at(-1)?.to,[1,1]);
  assert.ok(Object.isFrozen(result));assert.ok(Object.isFrozen(result.geometry.contours[0].segments[0].to));assert.ok(Object.isFrozen(result.report.gaps));
  assert.throws(()=>{(result.report as {sampleCount:number}).sampleCount=100;},TypeError);
});
