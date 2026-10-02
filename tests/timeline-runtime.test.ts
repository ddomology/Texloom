import test from 'node:test';
import assert from 'node:assert/strict';
import {compileTimeline,lowerTimeline} from '../src/timeline/compile.js';
import {createEvaluator} from '../src/evaluate.js';
import {prepareScene,bindSceneClip} from '../src/runtime.js';
import {validateBundle,type Bundle,type Track,type PointNode,type PathNode,type Diagnostic} from '../src/schema.js';
import {validateOperationGraph} from '../src/operations/validate.js';
const scene={kind:'scene'} as const;
const local=(node:string)=>({kind:'local',node} as const);
const program=(root:any)=>({version:1 as const,root});
const tween=(target:string,property:string,duration:number,to:number|number[],extra:Record<string,unknown>={})=>({kind:'tween',target,property,duration,to,...extra});
const sequence=(...children:any[])=>({kind:'sequence',children});
function fixture():Bundle {
  return {version:'0.3',title:'Timeline runtime',duration:8,units:'bp',viewport:{width:300,height:200},camera:{x:0,y:0,zoom:1},resources:{},tracks:[],relations:[],
    nodes:[{id:'G',kind:'group'},{id:'P',kind:'point',parent:'G',x:7,y:0,r:2,progress:.5},
      {id:'Q',kind:'point',x:0,y:0,r:2},{id:'curve',kind:'path',d:'M 0 0 L 100 0',reveal:0,
        geometry:{contours:[{id:'main',start:[0,0],segments:[{id:'end',kind:'line',to:[100,0]}]}]}}]};
}
const node=<T>(frame:{nodes:{id:string}[]},id:string)=>frame.nodes.find(n=>n.id===id) as T;
const near=(a:number,b:number)=>assert.ok(Math.abs(a-b)<1e-9,`${a} != ${b}`);
const codes=(input:unknown)=>validateBundle(input).filter(d=>d.severity==='error').map(d=>d.code);
function rejects(fn:()=>unknown,pattern:RegExp):void {
  assert.throws(fn,(e:unknown)=>e instanceof Error&&e.name!=='TypeError'&&pattern.test(JSON.stringify((e as {diagnostics?:Diagnostic[]}).diagnostics??e.message)));
}

test('numeric tracks interpolate to left limits, select exact right values and respect each segment easing',()=>{
  const b=fixture();b.tracks=[{target:'P',property:'x',keys:[[0,0],[1,100],[2,200],[3,400]],
    interpolation:'step',segmentEasings:['linear','smooth','step'],leftValues:[null,10,200,300]}];
  const run=createEvaluator(b);
  for(const [time,x] of [[0,0],[.5,5],[1,100],[1.25,115.625],[1.5,150],[2,200],[2.9999,200],[3,400],[7,400]])near(node<PointNode>(run(time),'P').x,x);
  const legacy=fixture();legacy.tracks=[{target:'P',property:'x',keys:[[0,0],[1,10],[2,20]],interpolation:'step'}];
  const old=createEvaluator(legacy);near(node<PointNode>(old(.999),'P').x,0);near(node<PointNode>(old(1),'P').x,10);near(node<PointNode>(old(2),'P').x,20);
  const large=fixture();large.tracks=[{target:'P',property:'x',keys:[[0,-1e308],[2,1e308]]}];near(node<PointNode>(createEvaluator(large)(1),'P').x,0);
});

test('track extension validation rejects malformed easing, left-value shapes, first left limits and invalid ranges',()=>{
  const good:Track={target:'P',property:'transform.translate',keys:[[0,[0,0]],[2,[1,2]]],segmentEasings:['linear'],leftValues:[null,[1,2]]};
  for(const patch of [{segmentEasings:[]},{segmentEasings:['bounce']},{leftValues:[null]},
    {leftValues:[[0,0],[1,2]]},{leftValues:[null,1]},{leftValues:[null,[1,2,3]]}]){
    const b=fixture();b.tracks=[{...good,...patch} as Track];assert.ok(codes(b).length>0);
  }
  const opacity=fixture();opacity.tracks=[{target:'P',property:'style.opacity',keys:[[0,0],[2,1]],leftValues:[null,2]}];assert.ok(codes(opacity).length>0);
  const valid=fixture();valid.tracks=[good];assert.deepEqual(codes(valid),[]);
});

test('parallel vector, camera, opacity, reveal and geometry-control tracks use the shared numeric evaluator',()=>{
  const ast=program({kind:'parallel',children:[tween('G','transform.translate',2,[20,40]),tween('G','transform.scale',2,[2,3]),
    tween('$camera','x',2,100),tween('$camera','zoom',2,2),tween('P','style.opacity',2,0),
    tween('curve','reveal',2,1),tween('curve','geometry.main.end.to',2,[150,50])]});
  const b=fixture(),snapshot=structuredClone(b),result=lowerTimeline(ast,b),run=createEvaluator(result),f=run(1);
  assert.deepEqual(node<any>(f,'G').transform.translate,[10,20]);assert.deepEqual(node<any>(f,'G').transform.scale,[1.5,2]);
  near(f.camera.x,50);near(f.camera.zoom,1.5);near(node<any>(f,'P').style.opacity,.5);
  near(node<PathNode>(f,'curve').reveal!,.5);assert.deepEqual(node<PathNode>(f,'curve').geometry!.contours[0].segments[0].to,[125,25]);
  assert.match(node<PathNode>(f,'curve').d,/62\.5/);assert.deepEqual(b,snapshot);
  const serialized=JSON.stringify(result);(ast.root.children[0].to as number[])[0]=999;
  assert.equal(JSON.stringify(result),serialized);assert.deepEqual(node<any>(run(1),'G').transform.translate,[10,20]);
});

test('distinct ancestor and child channels compose before a world-space consumer reads their result',()=>{
  const b=fixture();
  b.operationGraph={version:1,operations:[{id:'observe',operator:'pointValue',version:1,spaces:{space:scene},inputs:{value:{kind:'node',node:'P',property:'position',space:scene}}}],
    bindings:[{target:'Q',property:'position',value:{operation:'observe',socket:'value'}}]};
  const ast=program({kind:'parallel',children:[tween('G','transform.translate',2,[20,40]),tween('P','x',2,17)]});
  const f=createEvaluator(lowerTimeline(ast,b))(1);near(node<PointNode>(f,'P').x,12);near(node<PointNode>(f,'Q').x,22);near(node<PointNode>(f,'Q').y,20);
});

test('external tracks, expression aliases, whole transforms and legacy writers retain lifetime ownership',()=>{
  const ast=program(sequence({kind:'wait',duration:4},tween('P','x',1,20)));
  const tracked=fixture();tracked.tracks=[{target:'P',property:'x',keys:[[0,0],[1,1]]}];rejects(()=>lowerTimeline(ast,tracked),/CONFLICT|WRITER/);
  const expression=fixture();expression.expressions={version:1,parameters:{},bindings:[{target:'P',property:'position',expression:'vec2(2bp,3bp)'}]};rejects(()=>lowerTimeline(ast,expression),/CONFLICT|WRITER/);
  const legacy=fixture();legacy.relations=[{type:'pointOnPath',target:'P',source:'curve'}];rejects(()=>lowerTimeline(ast,legacy),/CONFLICT|WRITER/);
  const whole=fixture();whole.operationGraph={version:1,operations:[{id:'pose',operator:'transformValue',version:1,spaces:{from:local('G'),to:scene},inputs:{value:{kind:'literal',value:{type:'transform2d',from:local('G'),to:scene,value:[1,0,0,1,0,0]}}}}],bindings:[{target:'G',property:'transform',value:{operation:'pose',socket:'value'}}]};
  rejects(()=>lowerTimeline(program(tween('G','transform.translate',1,[10,20])),whole),/CONFLICT|WRITER/);
});

function inverseFixture(site:'legacy'|'input'|'binding'):Bundle {
  const b=fixture();b.nodes[0].transform={scale:[1,1]};
  if(site==='legacy')b.relations=[{type:'pointOnPath',target:'P',source:'curve'}];
  if(site==='input')b.operationGraph={version:1,operations:[{id:'read',operator:'pointValue',version:1,spaces:{space:local('G')},inputs:{value:{kind:'node',node:'Q',property:'position',space:local('G')}}}],bindings:[]};
  if(site==='binding')b.operationGraph={version:1,operations:[{id:'value',operator:'pointValue',version:1,spaces:{space:scene},inputs:{value:{kind:'literal',value:{type:'vec2',role:'point',space:scene,value:[2,3]}}}}],bindings:[{target:'P',property:'position',value:{operation:'value',socket:'value'}}]};
  return b;
}

test('all three inverse-space validation paths distinguish instantaneous scale flips from continuous zero crossings',()=>{
  for(const site of ['legacy','input','binding'] as const){
    const b=inverseFixture(site),jump=program(sequence({kind:'wait',duration:1},{kind:'set',target:'G',property:'transform.scale',value:[-1,1]}));
    const safe=lowerTimeline(jump,b),run=createEvaluator(safe);assert.deepEqual(codes(safe),[]);
    for(const t of [.5,1,2])assert.ok(run(t).nodes.every(n=>!('x' in n)||Number.isFinite(n.x)));
    rejects(()=>lowerTimeline(program(tween('G','transform.scale',2,[-1,1])),b),/SINGULAR/);
    const hiddenCrossing=inverseFixture(site);hiddenCrossing.tracks=[{target:'G',property:'transform.scale',keys:[[0,[1,1]],[1,[1,1]]],leftValues:[null,[-1,1]],segmentEasings:['linear']}];
    assert.ok(codes(hiddenCrossing).some(c=>/SINGULAR/.test(c)),site+' must inspect the incoming left limit');
    const step=inverseFixture(site);step.tracks=[{target:'G',property:'transform.scale',keys:[[0,[1,1]],[1,[-1,1]]],leftValues:[null,[0,1]],segmentEasings:['step']}];
    assert.deepEqual(codes(step),[],site+' must ignore an unused left value on a step segment');
    if(site!=='legacy')assert.ok(validateOperationGraph(hiddenCrossing.operationGraph,hiddenCrossing).some(d=>/SINGULAR/.test(d.code)));
  }
});

test('AST accessors are rejected without invocation and compiled data cannot be mutated through source references',()=>{
  let reads=0;
  const root={kind:'wait',get duration(){reads++;return 1;}};
  rejects(()=>compileTimeline(program(root),fixture()),/JSON|TIMELINE/);assert.equal(reads,0);
  const ast=program(sequence(tween('G','transform.translate',1,[10,20]),{kind:'cue',name:'end'})),compiled=compileTimeline(ast,fixture());
  assert.ok(Object.isFrozen(compiled));assert.ok(Object.isFrozen(compiled.tracks[0].keys[1][1]));assert.ok(Object.isFrozen(compiled.cues));
  (ast.root.children[0].to as number[])[0]=999;assert.deepEqual(compiled.tracks[0].keys.at(-1)?.[1],[10,20]);
});

test('malformed timeline metadata cannot bypass the bundle interchange validator',()=>{
  const valid=lowerTimeline(program(sequence(tween('P','x',1,10),{kind:'cue',name:'end'})),fixture());
  for(const patch of [{version:99},{origin:-1},{duration:Infinity},{end:-1},{cues:[{name:'late',time:50}]},{clips:[{id:'bad',kind:'tween',target:'P',property:'x',start:2,end:1}]}]){
    const candidate=structuredClone(valid);candidate.timeline={...candidate.timeline!,...patch} as any;assert.ok(codes(candidate).length>0,JSON.stringify(patch));
  }
});


test('host clips map inclusive cue endpoints once while active playback remains half-open',()=>{
  const ast=program(sequence({kind:'cue',name:'outside'},{kind:'wait',duration:1},{kind:'cue',name:'start'},
    tween('P','x',2,27),{kind:'cue',name:'end'},{kind:'wait',duration:1},{kind:'cue',name:'after'}));
  const lowered=lowerTimeline(ast,fixture()),runtime=prepareScene(lowered),clip=bindSceneClip(runtime,{start:10,sourceStart:1,rate:2,duration:1,after:'hidden'});
  assert.deepEqual(clip.cues.map(c=>[c.name,c.sourceTime,c.hostTime]),[['start',1,10],['end',3,11]]);
  assert.equal(clip.sample(10).phase,'active');assert.equal(clip.sample(11).phase,'after');assert.equal(clip.sample(11).visible,false);
  near(node<PointNode>(clip.sample(10.5).frame!,'P').x,17);
  assert.ok(Object.isFrozen(runtime.manifest.timeline));assert.ok(Object.isFrozen(clip.cues[0]));
  lowered.timeline!.cues[1].name='changed';assert.equal(runtime.manifest.timeline!.cues[1].name,'start');
  const expected=clip.sample(10.5);clip.sample(50);clip.sample(-1);assert.deepEqual(clip.sample(10.5),expected);
  const empty=bindSceneClip(runtime,{start:20,sourceStart:3,duration:0});
  assert.deepEqual(empty.cues.map(c=>[c.name,c.sourceTime,c.hostTime]),[['end',3,20]]);assert.equal(empty.sample(20).phase,'after');
});


test('canonical timeline end need not round-trip through origin plus descriptive duration',()=>{
  const b=fixture();b.duration=.9;
  b.timeline={version:1,origin:.3,duration:.9-.3,end:.9,cues:[{name:'end',time:.9}],clips:[]};
  assert.notEqual(b.timeline.origin+b.timeline.duration,b.timeline.end);
  assert.deepEqual(codes(b),[]);assert.equal(prepareScene(b).manifest.timeline!.end,.9);
});

test('positive host and source clip clocks must make representable forward progress',()=>{
  const runtime=prepareScene(fixture());
  for(const timing of [{start:1e16,duration:.1},{start:Number.MAX_VALUE,duration:1e308,rate:1e-308},
    {start:0,sourceStart:4,duration:Number.MIN_VALUE,rate:1}])assert.throws(()=>bindSceneClip(runtime,timing),/CLIP_TIMING/);
});
