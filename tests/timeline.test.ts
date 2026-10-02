import test from 'node:test';
import assert from 'node:assert/strict';
import {compileTimeline,lowerTimeline} from '../src/timeline/compile.js';
import {createEvaluator} from '../src/evaluate.js';
import type {Bundle,PointNode,Diagnostic,SourceSpan} from '../src/schema.js';

const program=(root:any,origin=0)=>({version:1 as const,origin,root});
const sequence=(...children:any[])=>({kind:'sequence',children});
const tween=(id:string,target:string,property:string,duration:number,to:number|number[],extra:Record<string,unknown>={})=>({kind:'tween',id,target,property,duration,to,...extra});
const span=(line:number):SourceSpan=>({file:'lesson.tex',start:{line,column:1},end:{line,column:22}});
function fixture():Bundle {
  return {version:'0.3',title:'Timeline contract',duration:10,units:'bp',viewport:{width:400,height:240},camera:{x:0,y:0,zoom:1},resources:{},tracks:[],relations:[],
    nodes:[{id:'P',kind:'point',x:7,y:0,r:2},{id:'Q',kind:'point',x:0,y:0,r:2},{id:'R',kind:'point',x:0,y:0,r:2}]};
}
const at=(frame:{nodes:{id:string}[]},id='P')=>frame.nodes.find(n=>n.id===id) as PointNode;
const near=(actual:number,expected:number)=>assert.ok(Math.abs(actual-expected)<1e-9,`${actual} != ${expected}`);
function failure(fn:()=>unknown,pattern:RegExp):{diagnostics?:Diagnostic[];code?:string;message:string} {
  let caught:unknown;try{fn();}catch(e){caught=e;}
  assert.ok(caught instanceof Error,'Expected a diagnosed rejection');assert.notEqual(caught.name,'TypeError');
  const e=caught as Error&{diagnostics?:Diagnostic[];code?:string};assert.match(JSON.stringify(e.diagnostics??e.code??e.message),pattern);return e;
}

test('nested sequence, parallel and stagger lower to analytically determined absolute clip times',()=>{
  const ast=program(sequence({kind:'wait',duration:.5},{kind:'parallel',children:[
    tween('horizontal','P','x',2,100),sequence({kind:'wait',duration:.25},tween('vertical','P','y',1.25,50))]},
    {kind:'stagger',lag:.25,children:[tween('first','Q','x',.5,20),tween('second','R','x',1,30)]},
    {kind:'cue',name:'settled',sourceSpan:span(19)}),1.25);
  const result=compileTimeline(ast,fixture());
  assert.equal(result.origin,1.25);assert.equal(result.duration,3.75);
  assert.deepEqual(result.clips.map(c=>[c.id,c.start,c.end]),[['horizontal',1.75,3.75],['vertical',2,3.25],['first',3.75,4.25],['second',4,5]]);
  assert.deepEqual(result.cues,[{name:'settled',time:5,sourceSpan:span(19)}]);
  const run=createEvaluator(lowerTimeline(ast,fixture()));
  near(at(run(2.75)).x,53.5);near(at(run(2.75)).y,30);near(at(run(4.5),'Q').x,20);near(at(run(4.5),'R').x,15);
  assert.equal(run(0).time,0);
});

test('a delayed explicit from resets exactly at its start and preserves the authored value beforehand',()=>{
  const lowered=lowerTimeline(program(sequence({kind:'wait',duration:1},tween('reset','P','x',2,70,{from:50})),1),fixture());
  const run=createEvaluator(lowered);
  for(const t of [0,.5,1,1.999999])near(at(run(t)).x,7);
  near(at(run(2)).x,50);near(at(run(3)).x,60);near(at(run(4)).x,70);near(at(run(9)).x,70);
  const track=lowered.tracks.find(t=>t.target==='P'&&t.property==='x')!;
  assert.equal(track.keys.filter(k=>k[0]===2).length,1);
  assert.ok(track.keys.every((k,i)=>i===0||k[0]>track.keys[i-1][0]));
  assert.equal(track.leftValues?.[track.keys.findIndex(k=>k[0]===2)],7);
});

test('sequential endpoints, holds, independent easing and hard resets have exact right-continuous semantics',()=>{
  const b=fixture();(b.nodes[0] as PointNode).x=0;
  const ast=program(sequence(tween('linear','P','x',1,10),{kind:'wait',duration:1},
    tween('smooth','P','x',2,30,{easing:'smooth'}),{kind:'set',target:'P',property:'x',value:5},
    {kind:'wait',duration:1},tween('step','P','x',1,9,{easing:'step'})));
  const run=createEvaluator(lowerTimeline(ast,b));
  for(const [time,x] of [[0,0],[.5,5],[1,10],[1.5,10],[2,10],[2.5,13.125],[3,20],[3.999999,30],[4,5],[4.5,5],[5,5],[5.999999,5],[6,9],[9,9]])
    assert.ok(Math.abs(at(run(time)).x-x)<1e-8,`${time}: ${at(run(time)).x} != ${x}`);
  const adjacent=createEvaluator(lowerTimeline(program(sequence(tween('a','P','x',1,10,{from:0}),tween('b','P','x',1,200,{from:100}))),b));
  near(at(adjacent(1-1e-8)).x,10-1e-7);near(at(adjacent(1)).x,100);near(at(adjacent(1+1e-8)).x,100+1e-6);
});

test('zero-duration actions are ordered in a sequence without epsilon keys or elapsed time',()=>{
  const ast=program(sequence({kind:'set',id:'a',target:'P',property:'x',value:3},
    {kind:'set',id:'b',target:'P',property:'x',value:7},tween('zero','P','x',0,11,{from:100}),
    {kind:'cue',name:'instant'}, {kind:'wait',duration:1},tween('later','P','x',1,21)));
  const compiled=compileTimeline(ast,fixture());assert.equal(compiled.duration,2);assert.equal(compiled.cues[0].time,0);
  const run=createEvaluator(lowerTimeline(ast,fixture()));near(at(run(0)).x,11);near(at(run(.5)).x,11);near(at(run(1)).x,11);near(at(run(1.5)).x,16);
  assert.ok(compiled.tracks.every(t=>t.keys.every(k=>Number.isInteger(k[0]))));
});

test('half-open adjacency is legal while positive overlap and ambiguous simultaneous parallel writes are diagnosed with sources',()=>{
  const a=tween('one','P','x',2,10,{sourceSpan:span(17)}),b=tween('two','P','x',2,20,{sourceSpan:span(23)});
  const error=failure(()=>compileTimeline(program({kind:'parallel',children:[a,sequence({kind:'wait',duration:1},b)]}),fixture()),/TIMELINE_CONFLICT/);
  const diagnostics=error.diagnostics??[];assert.ok(diagnostics.length>0);
  const locations=diagnostics.flatMap(d=>[d.sourceSpan,...(d.related??[]).map(r=>r.sourceSpan)]).filter(Boolean);
  assert.ok(locations.some(s=>s!.start.line===17));assert.ok(locations.some(s=>s!.start.line===23));
  const ownership=diagnostics.map(d=>d.message).join(' ');assert.match(ownership,/\[0,\s*2\)/);assert.match(ownership,/\[1,\s*3\)/);
  failure(()=>compileTimeline(program({kind:'parallel',children:[{kind:'set',target:'P',property:'x',value:1},{kind:'set',target:'P',property:'x',value:2}]}),fixture()),/TIMELINE_CONFLICT/);
  failure(()=>compileTimeline(program({kind:'parallel',children:[{kind:'set',target:'P',property:'x',value:1},tween('begin','P','x',1,2)]}),fixture()),/TIMELINE_CONFLICT/);
  const valid=compileTimeline(program({kind:'parallel',children:[tween('ends','P','x',1,10),sequence({kind:'wait',duration:1},tween('starts','P','x',1,20))]}),fixture());
  assert.deepEqual(valid.clips.map(c=>[c.start,c.end]),[[0,1],[1,2]]);
});

test('cue metadata is pure, uniquely named, detached and does not become a renderer side effect',()=>{
  const source=span(8),ast=program(sequence({kind:'wait',duration:.25},{kind:'cue',name:'speak',sourceSpan:source},{kind:'wait',duration:.5},{kind:'cue',name:'done'}),1);
  const bundle=fixture(),before=structuredClone(bundle),compiled=compileTimeline(ast,bundle),lowered=lowerTimeline(ast,bundle);
  assert.equal(compiled.duration,.75);assert.deepEqual(compiled.cues.map(c=>[c.name,c.time]),[['speak',1.25],['done',1.75]]);
  assert.deepEqual(compiled.tracks,[]);assert.deepEqual(bundle,before);source.start.line=99;
  assert.equal(compiled.cues[0].sourceSpan?.start.line,8);assert.ok(Object.isFrozen(compiled.cues[0]));
  assert.ok(lowered.timeline);assert.equal('root' in lowered.timeline!,false);assert.equal('program' in lowered.timeline!,false);
  const run=createEvaluator(lowered);assert.deepEqual(run(1.25),run(1.25));assert.deepEqual(run(1.25).nodes,bundle.nodes);
  failure(()=>compileTimeline(program(sequence({kind:'cue',name:'same'},{kind:'cue',name:'same'})),fixture()),/TIMELINE_CUE/);
});

test('30 and 60 fps schedules agree at shared absolute times and reverse seeks require no playback history',()=>{
  const ast=program(sequence(tween('move','P','x',2,107,{easing:'smooth'}),{kind:'wait',duration:.5},
    {kind:'set',target:'P',property:'x',value:-20},tween('return','P','x',1.5,40)));
  const bundle=lowerTimeline(ast,fixture()),before=structuredClone(bundle),a=createEvaluator(bundle),b=createEvaluator(bundle);
  const frames=new Map<number,ReturnType<typeof a>>();
  for(let i=0;i<=240;i++){const t=i/60,frame=b(t);if(i%2===0)frames.set(i/2,frame);}
  for(let i=0;i<=120;i++)assert.deepEqual(a(i/30),frames.get(i));
  for(let i=120;i>=0;i--)assert.deepEqual(a(i/30),frames.get(i));
  assert.deepEqual(bundle,before);a(2).nodes[0].style={opacity:.1};assert.deepEqual(a(2),frames.get(60));
});

test('time precision, nonfinite arithmetic, depth, node count and unsupported fields have bounded failures',()=>{
  const huge=fixture();huge.duration=1e18;
  failure(()=>compileTimeline(program(sequence({kind:'wait',duration:1e16},tween('tiny','P','x',1,10))),huge),/TIMELINE_(PRECISION|TIME)/);
  const overflow=fixture();overflow.duration=Number.MAX_VALUE;
  failure(()=>compileTimeline(program(sequence({kind:'wait',duration:Number.MAX_VALUE},{kind:'wait',duration:Number.MAX_VALUE})),overflow),/TIMELINE_(PRECISION|TIME)/);
  failure(()=>compileTimeline(program(tween('long','P','x',11,10)),fixture()),/TIMELINE_TIME/);
  failure(()=>compileTimeline(program({kind:'wait',duration:-1}),fixture()),/TIMELINE_TIME/);
  failure(()=>compileTimeline(program({kind:'stagger',lag:-.1,children:[]}),fixture()),/TIMELINE_TIME/);
  let nested:any={kind:'wait',duration:0};for(let i=0;i<35;i++)nested=sequence(nested);
  failure(()=>compileTimeline(program(nested),fixture()),/TIMELINE_LIMIT/);
  failure(()=>compileTimeline(program(sequence(...Array.from({length:4097},()=>({kind:'wait',duration:0})))),fixture()),/TIMELINE_(LIMIT|NODE)/);
  failure(()=>compileTimeline(program({kind:'wait',duration:1,repeat:3}),fixture()),/TIMELINE_/);
  failure(()=>compileTimeline(program(tween('missing','absent','x',1,10)),fixture()),/TIMELINE_TARGET/);
  failure(()=>compileTimeline(program(tween('unsupported','P','visible',1,1)),fixture()),/TIMELINE_PROPERTY/);
  failure(()=>compileTimeline(program(tween('range','P','r',1,-1)),fixture()),/TIMELINE_VALUE/);
  failure(()=>compileTimeline(program({kind:'cue',name:'',sourceSpan:span(3)}),fixture()),/TIMELINE_CUE/);
});


test('nested decimal clocks preserve exact shared boundaries instead of recomputing rounded durations',()=>{
  const b=fixture(),ast=program(sequence({kind:'wait',duration:.2},sequence({kind:'wait',duration:.3},{kind:'cue',name:'nested-end'}),
    tween('after','P','x',.2,30,{from:20})),.1);
  const compiled=compileTimeline(ast,b),boundary=(.1+.2)+.3;
  assert.equal(compiled.cues[0].time,boundary);assert.equal(compiled.clips[0].start,boundary);assert.equal(compiled.end,boundary+.2);
  assert.equal(compiled.duration,compiled.end-compiled.origin);
  const run=createEvaluator(lowerTimeline(ast,b));near(at(run(boundary-Number.EPSILON)).x,7);near(at(run(boundary)).x,20);
  b.duration=12;
  const stagger=compileTimeline(program(sequence({kind:'stagger',lag:.45,children:[tween('p','P','x',.8,1),tween('q','Q','x',.8,1),tween('r','R','x',.8,1)]},tween('next','R','x',.4,2)),8.5),b);
  const previous=stagger.clips.find(c=>c.id==='r')!,next=stagger.clips.find(c=>c.id==='next')!;
  assert.equal(previous.end,next.start);assert.equal(previous.end,(8.5+2*.45)+.8);
});
