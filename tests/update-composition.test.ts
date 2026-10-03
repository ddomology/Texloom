import test from 'node:test';
import assert from 'node:assert/strict';
import {createEvaluator,nodePosition,worldMatrix,type Bundle,type InputRef,type Operation,type PathNode,type SpaceRef} from '../src/index.ts';
import {prepareExecutionPlan} from '../src/operations/plan.ts';

const scene={kind:'scene'} as const;
const scalar=(value:number,unit:'1'|'bp'|'rad'='1'):InputRef=>({kind:'literal',value:{type:'scalar',unit,value}});
const point=(value:[number,number]):InputRef=>({kind:'literal',value:{type:'vec2',role:'point',space:scene,value}});
const vector=(value:[number,number]):InputRef=>({kind:'literal',value:{type:'vec2',role:'vector',space:scene,value}});
const output=(operation:string,socket:string):InputRef=>({kind:'output',ref:{operation,socket}});
const position=(node:string):InputRef=>({kind:'node',node,property:'position',space:scene});
const operation=(id:string,operator:string,inputs:Record<string,InputRef>,spaces:Record<string,SpaceRef>={space:scene}):Operation=>({id,operator,version:1,spaces,inputs});
const near=(a:number,b:number)=>assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`);
const nearPoint=(a:readonly number[],b:readonly number[])=>a.forEach((v,i)=>near(v,b[i]));
function fixture():Bundle {
  const parent:SpaceRef={kind:'parent',node:'heading'};
  return {version:'0.3',title:'Update composition',duration:2,units:'bp',viewport:{width:240,height:180},camera:{x:0,y:0,zoom:1},resources:{},tracks:[],relations:[],
    nodes:[{id:'parent',kind:'group',transform:{translate:[17,11],rotate:.3,scale:[1.8,.7]}},
      {id:'P',kind:'point',x:0,y:0,r:2},{id:'label',kind:'point',parent:'parent',x:0,y:0,r:1},
      {id:'heading',kind:'group',parent:'parent'},
      {id:'trail',kind:'path',d:'M0 0',geometry:{contours:[]},style:{fill:'none',stroke:'#fff'}}],
    expressions:{version:1,parameters:{radius:{type:'scalar',unit:'bp',default:20,min:1,max:40}},bindings:[
      {target:'parent',property:'transform.rotate',expression:'time/1s*0.4rad'}]},
    operationGraph:{version:1,operations:[
      operation('align','alignDirection',{direction:output('transport','vector'),fallbackAngle:scalar(0,'rad')},{space:parent}),
      operation('follow','followPoint',{point:position('P'),offset:vector([7,-9])}),
      operation('transport','transformVector',{vector:output('sample','tangent'),transform:{kind:'spaceTransform',from:scene,to:parent}},{from:scene,to:parent}),
      operation('sample','sampleShape',{shape:output('circle','shape'),parameter:{kind:'expression',expression:'time/2s',unit:'1'}}),
      operation('circle','circle',{center:point([80,90]),radius:{kind:'expression',expression:'radius',unit:'bp'}}),
    ],bindings:[{target:'heading',property:'transform.rotate',value:{operation:'align',socket:'angle'}},
      {target:'label',property:'position',value:{operation:'follow',socket:'position'}},
      {target:'P',property:'position',value:{operation:'sample',socket:'position'}}]},
    traces:{version:1,operations:[{id:'orbit-trace',target:'trail',source:{kind:'node',node:'P',property:'position',space:scene},
      domain:[0,2],step:.25,tolerance:.05,maxDepth:10,maxSamples:2048,seed:0,missing:'break',reveal:'progress'}]}};
}

test('updates compose after regeneration across animated affine parents and graph declaration order',()=>{
  const b=fixture(),before=structuredClone(b),sample=createEvaluator(b);
  for(const t of [0,.3,.9,1.4,2]) {
    const f=sample(t),nodes=new Map(f.nodes.map(n=>[n.id,n]));
    const theta=Math.PI*t,p=[80+20*Math.cos(theta),90+20*Math.sin(theta)];
    nearPoint(nodePosition('P',scene,nodes),p);
    nearPoint(nodePosition('label',scene,nodes),[p[0]+7,p[1]-9]);
    const m=worldMatrix('heading',nodes),length=Math.hypot(m[0],m[1]);
    nearPoint([m[0]/length,m[1]/length],[-Math.sin(theta),Math.cos(theta)]);
  }
  const reversed=structuredClone(b);reversed.operationGraph!.operations.reverse();reversed.operationGraph!.bindings.reverse();
  const other=createEvaluator(reversed);
  for(const t of [.9,0,2,.3])assert.deepEqual(other(t),sample(t));
  assert.deepEqual(b,before);
});

test('parameter overrides regenerate dependent points and fixed-domain traces independently of playback history',()=>{
  const b=fixture(),sample=createEvaluator(b),first=sample(1,{radius:30}),saved=structuredClone(first);
  const trail=first.nodes.find(n=>n.id==='trail') as PathNode;
  for(const c of trail.geometry!.contours)for(const p of [c.start,...c.segments.map(s=>s.to)])near(Math.hypot(p[0]-80,p[1]-90),30);
  assert.notDeepEqual((sample(1).nodes.find(n=>n.id==='trail') as PathNode).geometry,trail.geometry);
  trail.geometry!.contours[0].start[0]=999;
  for(let i=0;i<=60;i++)sample(i/30);
  sample(2,{radius:10});assert.deepEqual(sample(1,{radius:30}),saved);
  assert.throws(()=>sample(1,{radius:0}));
  assert.deepEqual(sample(1,{radius:30}),saved);
});

test('follow dependencies reject cycles and overlap with explicit position writers',()=>{
  const b=fixture();delete b.traces;
  b.operationGraph!.operations.find(o=>o.id==='follow')!.inputs.point=position('label');
  assert.throws(()=>createEvaluator(b),(e:any)=>e.diagnostics?.some((d:any)=>d.code==='OPERATION_PLAN_CYCLE'));
  const conflict=fixture();delete conflict.traces;
  conflict.tracks.push({target:'label',property:'x',keys:[[0,0],[2,10]]});
  assert.throws(()=>createEvaluator(conflict),(e:any)=>e.diagnostics?.some((d:any)=>d.code==='OPERATION_WRITER_CONFLICT'));
});

test('execution dependency manifest is detached and immutable for derived-data preparation',()=>{
  const b=fixture();delete b.traces;const plan=prepareExecutionPlan(b);
  const follow=plan.accesses.find(a=>a.id===JSON.stringify(['operation','follow']))!;
  assert.ok(follow.reads.some(r=>r.node==='P'&&r.property==='x'));
  assert.ok(Object.isFrozen(plan.accesses)&&Object.isFrozen(follow.reads)&&Object.isFrozen(follow.reads[0]));
  b.operationGraph!.operations.find(o=>o.id==='follow')!.inputs.point=position('label');
  assert.ok(follow.reads.some(r=>r.node==='P'&&r.property==='x'));
});

test('intersection existence drives visibility and leaves a real gap in absolute-time tracing',()=>{
  const b:Bundle={version:'0.3',title:'Missing crossing',duration:2,units:'bp',viewport:{width:10,height:10},camera:{x:0,y:0,zoom:1},resources:{},tracks:[],relations:[],nodes:[
    {id:'horizontal',kind:'path',d:'M0 0',geometry:{contours:[{id:'c',start:[0,0],segments:[{id:'s',kind:'line',to:[1,0]}]}]}},
    {id:'vertical',kind:'path',d:'M0 0',geometry:{contours:[{id:'c',start:[0,-1],segments:[{id:'s',kind:'line',to:[0,1]}]}]}},
    {id:'P',kind:'point',x:0,y:0,r:.1},{id:'trail',kind:'path',d:'M0 0',geometry:{contours:[]}}],
    expressions:{version:1,parameters:{},bindings:[{target:'vertical',property:'transform.translate',expression:'vec2(2bp*cos(time/1s*2),0bp)'}]},
    operationGraph:{version:1,operations:[
      operation('intersections','intersectPaths',{a:{kind:'path',node:'horizontal',space:scene},b:{kind:'path',node:'vertical',space:scene}}),
      operation('select','selectIntersection',{intersections:output('intersections','intersections'),along:scalar(0),missing:scalar(1),fallback:point([99,99])}),
      operation('show','thresholdOpacity',{value:output('select','found'),threshold:scalar(.5)},{}),
    ],bindings:[{target:'P',property:'position',value:{operation:'select',socket:'position'}},{target:'P',property:'style.opacity',value:{operation:'show',socket:'opacity'}}]},
    traces:{version:1,operations:[{id:'crossings',target:'trail',source:{kind:'node',node:'P',property:'position',space:scene},domain:[0,2],step:.1,tolerance:.002,maxDepth:10,maxSamples:4096,seed:0,missing:'break',reveal:'full'}]}};
  const sample=createEvaluator(b),hidden=sample(0),shown=sample(.6);
  assert.equal(hidden.nodes.find(n=>n.id==='P')!.style!.opacity,0);
  assert.equal(shown.nodes.find(n=>n.id==='P')!.style!.opacity,1);
  const trace=hidden.nodes.find(n=>n.id==='trail') as PathNode;
  assert.ok(trace.geometry!.contours.length>0);
  for(const c of trace.geometry!.contours)for(const [x,y] of [c.start,...c.segments.map(s=>s.to)]){
    assert.ok(x>=-1e-8&&x<=1+1e-8);near(y,0);
  }
  assert.deepEqual(sample(0),hidden);
});
