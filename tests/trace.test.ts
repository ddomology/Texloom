import test from 'node:test';
import assert from 'node:assert/strict';
import {createEvaluator} from '../src/evaluate.js';
import {validateBundle,type Bundle,type PathNode,type PointNode,type GroupNode,type Diagnostic} from '../src/schema.js';
import {prepareTraceProgram,validateTraceProgram,type TraceOperation} from '../src/timeline/trace.js';
import {lowerTimeline} from '../src/timeline/compile.js';
import {worldMatrix,transformPoint} from '../src/geometry.js';
import type {PathPoint} from '../src/path-geometry.js';
const node=<T>(frame:{nodes:{id:string}[]},id:string)=>frame.nodes.find(n=>n.id===id) as T;
const near=(actual:readonly number[],expected:readonly number[],epsilon=1e-9)=>actual.forEach((v,i)=>assert.ok(Math.abs(v-expected[i])<=epsilon,`${actual} != ${expected}`));
function rejects(fn:()=>unknown,code:RegExp):void {assert.throws(fn,(error:any)=>error.name!=='TypeError'&&code.test(JSON.stringify(error.diagnostics??error.message)));}
const operation=():TraceOperation=>({id:'trail',target:'trace',source:{kind:'node',node:'P',property:'position',space:{kind:'scene'}},domain:[0,4],step:.5,tolerance:.01,maxDepth:12,maxSamples:4096,seed:0,missing:'break',reveal:'progress'});
function fixture():Bundle {
  return {version:'0.3',title:'Absolute-time trace',duration:5,units:'bp',viewport:{width:200,height:100},camera:{x:0,y:0,zoom:1},resources:{},relations:[],tracks:[],
    nodes:[{id:'P',kind:'point',x:0,y:0,r:1},{id:'trace',kind:'path',d:'M0 0',geometry:{contours:[]},style:{fill:'none',stroke:'#fff'}}],
    expressions:{version:1,parameters:{amplitude:{type:'scalar',unit:'1',default:1,min:.1,max:3}},bindings:[
      {target:'P',property:'x',expression:'time / 1s * 10bp'},
      {target:'P',property:'y',expression:'amplitude * (time / 1s) * (time / 1s) * 2bp'}]},traces:{version:1,operations:[operation()]}};
}
function points(frame:ReturnType<ReturnType<typeof createEvaluator>>):PathPoint[][] {
  const p=node<PathNode>(frame,'trace'),matrix=worldMatrix('trace',new Map(frame.nodes.map(n=>[n.id,n])));
  return p.geometry!.contours.map(c=>[c.start,...c.segments.map(s=>s.to)].map(p=>transformPoint(matrix,p)));
}
test('fixed-domain polynomial probes meet independently checked dense error and progressive absolute-time reveal',()=>{
  const input=fixture(),before=structuredClone(input),run=createEvaluator(input),full=run(4),path=points(full)[0];
  assert.deepEqual(input,before);assert.equal(full.traces!.trail.qualityMetric,'observed-probes');assert.ok(full.traces!.trail.maxAcceptedError<=.01);
  for(let i=0;i<=1000;i++){
    const t=4*i/1000,x=t*10,index=Math.max(0,path.findIndex(p=>p[0]>=x)-1),a=path[index],b=path[Math.min(index+1,path.length-1)];
    const y=b[0]===a[0]?a[1]:a[1]+(b[1]-a[1])*(x-a[0])/(b[0]-a[0]);assert.ok(Math.abs(y-2*t*t)<=.010000001);
  }
  near(points(run(1.25))[0].at(-1)!,[12.5,3.125]);
  assert.equal(run(1).traces!.trail.sampleCount,full.traces!.trail.sampleCount,'The full sampling grid is independent of display time');
  assert.equal(run(0).traces!.trail.reveal.segmentCount,0);
});
test('30/60 fps common frames and reverse seeks are identical and frame mutations cannot leak into cached samples',()=>{
  const run=createEvaluator(fixture()),samples=new Map<number,unknown>();
  for(let i=0;i<=120;i++)samples.set(i,node<PathNode>(run(i/30),'trace').geometry);
  for(let i=240;i>=0;i-=2)assert.deepEqual(node<PathNode>(run(i/60),'trace').geometry,samples.get(i/2));
  const frame=run(2),expected=structuredClone(frame);node<PathNode>(frame,'trace').geometry!.contours[0].start[0]=999;
  run(5);run(0);assert.deepEqual(run(2),expected);
});
test('parameter changes resample pure source scenes, retain a bounded current state and validate cached calls',()=>{
  const bundle=fixture(),run=createEvaluator(bundle),one=run(2,{amplitude:1}),three=run(2,{amplitude:3});
  near(points(one)[0].at(-1)!,[20,8]);near(points(three)[0].at(-1)!,[20,24]);
  assert.deepEqual(run(2,{amplitude:1}),one);
  rejects(()=>run(2,{amplitude:0}),/EXPRESSION_PARAMETER_VALUE/);rejects(()=>run(2,{unknown:1}),/EXPRESSION_PARAMETER_UNKNOWN/);
  bundle.expressions!.parameters.amplitude.default=2;node<PointNode>(bundle,'P').x=999;assert.deepEqual(run(2,{amplitude:1}),one);
});
test('sampled hidden intervals and ancestor opacity create separate contours with explicit boundary gaps',()=>{
  const input=fixture();input.nodes.push({id:'visibility',kind:'group'});node<PointNode>(input,'P').parent='visibility';
  input.expressions!.bindings.push({target:'visibility',property:'style.opacity',expression:'time >= 1.25s && time < 2.75s ? 0 : 1'});
  const frame=createEvaluator(input)(4),contours=points(frame),report=frame.traces!.trail;
  assert.equal(contours.length,2);assert.ok(contours[0].at(-1)![0]<12.5);assert.ok(contours[1][0][0]>=27.5);
  assert.ok(report.gaps.some(g=>g.reason==='hidden'));assert.ok(report.gaps.some(g=>g.reason==='visibility-boundary'));
  assert.ok(report.maskedIntervals>0);assert.ok(report.sampleCount<=4096);
});
test('scene trajectory survives source transforms and current moving target ancestors without camera contamination',()=>{
  const input=fixture();input.nodes.push({id:'source-parent',kind:'group',transform:{translate:[4,7],scale:[2,3]}},{id:'target-parent',kind:'group',transform:{translate:[20,30],rotate:.2,scale:[2,3]}});
  node<PointNode>(input,'P').parent='source-parent';node<PathNode>(input,'trace').parent='target-parent';
  input.tracks=[{target:'target-parent',property:'transform.translate',keys:[[0,[20,30]],[4,[90,-50]]]},{target:'$camera',property:'zoom',keys:[[0,1],[4,4]]}];
  const run=createEvaluator(input);near(points(run(2))[0].at(-1)!,[44,31]);
  const start=points(run(3))[0][0];near(start,[4,7]);assert.equal(run(3).camera.zoom,3.25);
});
test('full reveal is fixed before the source domain and progressive reveal is empty until the domain starts',()=>{
  const input=fixture();input.traces!.operations[0].domain=[1,4];const progressive=createEvaluator(input);
  assert.deepEqual(points(progressive(0)),[]);near(points(progressive(1))[0][0],[10,2]);
  input.traces!.operations[0].reveal='full';const full=createEvaluator(input);assert.deepEqual(points(full(0)),points(full(5)));near(points(full(0))[0].at(-1)!,[40,32]);
});
test('sampling budgets, finite unresolved curvature and unrepresentable clocks diagnose rather than truncate',()=>{
  const initial=fixture();initial.traces!.operations[0].maxSamples=5;rejects(()=>createEvaluator(initial),/TRACE_BUDGET/);
  const unresolved=fixture();unresolved.traces!.operations[0].maxDepth=0;rejects(()=>createEvaluator(unresolved)(4),/TRACE_RESOLUTION/);
  const exhausted=fixture();Object.assign(exhausted.traces!.operations[0],{step:4,maxSamples:5,tolerance:1e-8});rejects(()=>createEvaluator(exhausted)(4),/TRACE_BUDGET/);
  const clock=fixture();clock.duration=1e16+2;Object.assign(clock.traces!.operations[0],{domain:[1e16,1e16+2],step:2});clock.expressions!.bindings=[];
  rejects(()=>createEvaluator(clock)(1e16),/TRACE_PRECISION/);
});
test('invalid shapes, policies, singular target spaces and arrow placeholders have structured diagnostics',()=>{
  assert.ok(validateTraceProgram({version:1,operations:[]},null as unknown as Bundle).some(d=>d.code==='TRACE_CONTEXT'));
  for(const patch of [{seed:1},{missing:'connect'},{reveal:'past'},{domain:[2,1]},{domain:[0,6]},{step:0},{maxSamples:Infinity},{maxDepth:-1},{tolerance:0}]){
    const input=fixture();Object.assign(input.traces!.operations[0],patch);assert.ok(validateBundle(input).some(d=>d.severity==='error'));
  }
  const singular=fixture();node<PathNode>(singular,'trace').transform={scale:[0,1]};rejects(()=>createEvaluator(singular)(0),/TRACE_SINGULAR_SPACE/);
  for(const patch of [{arrows:{end:1}},{arrowStart:false},{resolvedArrows:{}}]){const input=fixture();Object.assign(node<PathNode>(input,'trace'),patch);assert.ok(validateBundle(input).length>0);}
  const source=fixture();source.traces!.operations[0].source.node='missing';rejects(()=>createEvaluator(source),/TRACE_SOURCE/);
});
test('trace targets cannot feed relations, derived morph ownership, writers or parent cycles',()=>{
  const input=fixture();input.expressions!.bindings=[];input.relations=[{type:'pointOnPath',target:'P',source:'trace'}];rejects(()=>createEvaluator(input),/TRACE_DEPENDENCY/);
  const writer=fixture();writer.tracks=[{target:'trace',property:'style.opacity',keys:[[0,1]]}];rejects(()=>createEvaluator(writer),/TRACE_DEPENDENCY/);
  const child=fixture();node<PointNode>(child,'P').parent='trace';rejects(()=>createEvaluator(child),/PARENT_KIND/);
  const cycle=fixture();cycle.nodes.push({id:'A',kind:'group',parent:'B'},{id:'B',kind:'group',parent:'A'});rejects(()=>createEvaluator(cycle),/CYCLE/);
  const morph=fixture();delete morph.traces;const geometry={contours:[{id:'c',start:[0,0] as PathPoint,segments:[{id:'s',kind:'line' as const,to:[10,0] as PathPoint}]}]};
  node<PathNode>(morph,'trace').geometry=geometry;morph.nodes.push({id:'other',kind:'path',d:'M0 0L10 0',geometry});
  const lowered=lowerTimeline({version:1,root:{kind:'morph',id:'M',source:'trace',destination:'other',duration:2,correspondence:{approved:true,contours:[{source:'c',target:'c',segments:[{source:'s',target:'s'}]}]}}},morph);
  lowered.traces={version:1,operations:[{...operation(),target:'M:shape'}]};assert.ok(validateTraceProgram(lowered.traces,lowered).some(d=>d.code==='TRACE_DEPENDENCY'));
});
test('public prepared application validates overrides even after cache hits and preserves real source errors',()=>{
  const input=fixture(),{traces,...base}=input,run=createEvaluator(base),prepared=prepareTraceProgram(traces!,input,run);
  const frame=run(1);prepared.apply(frame,{amplitude:1});rejects(()=>prepared.apply(frame,{amplitude:NaN}),/NON_JSON_VALUE/);
  rejects(()=>prepared.apply(frame,{unknown:1}),/EXPRESSION_PARAMETER_UNKNOWN/);
  const broken=fixture();broken.expressions!.bindings[1].expression='1bp / ((time / 1s) - 2)';
  rejects(()=>createEvaluator(broken)(0),/EXPRESSION|DOMAIN|NONFINITE/);
});
test('the public prepared cache preserves signed-zero parameter identity and passes detached frozen values',()=>{
  const input=fixture();input.expressions={version:1,parameters:{signed:{type:'scalar',unit:'1',default:0}},bindings:[]};
  const {traces,...base}=input,run=createEvaluator(base);let calls=0;
  const prepared=prepareTraceProgram(traces!,input,(time,parameters)=>{
    calls++;assert.ok(Object.isFrozen(parameters));const frame=run(time,parameters);
    node<PointNode>(frame,'P').x=Object.is(parameters!.signed,-0)?-1:1;return frame;
  });
  const plus=run(2);prepared.apply(plus,{signed:0});near(points(plus)[0][0],[1,0]);const first=calls;
  const minus=run(2);prepared.apply(minus,{signed:-0});near(points(minus)[0][0],[-1,0]);assert.ok(calls>first);
  const cached=calls;prepared.apply(run(2),{signed:-0});assert.equal(calls,cached);
});
test('existing nonfatal bundle diagnostics do not suppress trace preparation or change evaluated frames',()=>{
  const input=fixture(),expected=createEvaluator(input)(2);input.diagnostics=[{severity:'warning',code:'NOTE',message:'Author supplied note.'}];
  const diagnostics=validateTraceProgram(input.traces!,input);assert.ok(diagnostics.some(d=>d.severity==='warning'&&d.code==='NOTE'));
  assert.ok(!diagnostics.some(d=>d.severity==='error'));assert.deepEqual(createEvaluator(input)(2),expected);
});
