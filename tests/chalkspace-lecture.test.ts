import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {prepareChalkspaceLecture} from '../adapters/chalkspace-lecture.ts';
import {createChalkspaceCanvasLayer} from '../adapters/chalkspace-canvas.ts';
import {prepareScene} from '../src/runtime.ts';
import {sceneFeatures} from '../src/capabilities.ts';
import type {Bundle, VectorResource} from '../src/schema.ts';

const bundle = (): Bundle => ({version:'0.3',title:'Lecture source',duration:8,units:'bp',
  viewport:{width:100,height:50},camera:{x:3,y:4,zoom:1.25},resources:{},relations:[],
  nodes:[{id:'point',kind:'point',x:0,y:20,r:2}],
  tracks:[{target:'point',property:'x',keys:[[0,0],[8,80]]}]});
const lesson = ():any => ({contract:'texloom-lecture/1',scenes:{shared:bundle()},clips:[
  {id:'first',scene:'shared',timing:{start:10,sourceStart:2,rate:2,duration:3,after:'hidden'},placement:{x:-3,y:1,width:6}},
  {id:'second',scene:'shared',timing:{start:11,sourceStart:1,rate:.5,duration:8,before:'hidden',after:'hold'},placement:{x:3,y:4,width:6}},
]});
const diagnostic=(pattern:RegExp)=>(error:any)=>error?.name!=='TypeError'&&pattern.test(JSON.stringify(error?.diagnostics??error?.message??error));
const x=(sample:any)=>sample.frame.nodes.find((node:any)=>node.id==='point').x;
function packaged(source:Bundle):any {
  const {resources,...scene}=structuredClone(source);
  return {contract:'texloom-package/1',scene,assets:{version:1,requiredFeatures:sceneFeatures(source),entries:Object.entries(resources).map(([id,resource])=>{
    const data=JSON.stringify(resource),bytes=new TextEncoder().encode(data);
    return {id,kind:resource.kind,mediaType:'application/vnd.texloom.resource+json',byteLength:bytes.length,
      sha256:createHash('sha256').update(bytes).digest('hex'),bounds:resource.kind==='vector'?resource.inkBounds:[0,0,1,1],source:{kind:'inline',data}};
  })}};
}
const label:VectorResource={kind:'vector',metrics:{width:8,height:9,depth:1},inkBounds:[0,-9,8,10],
  items:[{kind:'path',d:'M0 0L8 0L4 -9Z',style:{fill:'#ffffff'}}]};

test('lecture independently converts the same host clock once for two clips of one source',async()=>{
  const runtime=await prepareChalkspaceLecture(lesson());
  const samples=runtime.sample(11.5);
  assert.deepEqual(samples.map(s=>[s.id,s.scene,s.hostTime,s.sourceTime,s.phase,s.visible]),[
    ['first','shared',11.5,5,'active',true],['second','shared',11.5,1.25,'active',true],
  ]);
  assert.equal(x(samples[0]),50);assert.equal(x(samples[1]),12.5);
  assert.deepEqual(samples[0].frame,prepareScene(bundle()).sample(5));
  assert.deepEqual(samples[1].frame,prepareScene(bundle()).sample(1.25));
  runtime.dispose();
});

test('lecture preserves exact half-open clip boundaries and explicit hold policy',async()=>{
  const runtime=await prepareChalkspaceLecture(lesson());
  assert.ok(runtime.sample(9).every(s=>!s.visible&&s.frame===null));
  const start=runtime.sample(10);assert.equal(start[0].phase,'active');assert.equal(x(start[0]),20);assert.equal(start[1].visible,false);
  const end=runtime.sample(13);assert.equal(end[0].phase,'after');assert.equal(end[0].sourceTime,8);assert.equal(end[0].frame,null);
  const held=runtime.sample(19);assert.equal(held[1].phase,'after');assert.equal(held[1].sourceTime,5);assert.equal(x(held[1]),50);
  assert.deepEqual(runtime.sample(100)[1].frame,held[1].frame);
  runtime.dispose();
});

test('lecture snapshots nested data before any asynchronous preparation',async()=>{
  const input=lesson(),pending=prepareChalkspaceLecture(input);
  input.scenes.shared.title='MUTATED';input.scenes.shared.tracks[0].keys[1][1]=999;
  input.clips[0].timing.start=900;input.clips[0].placement.width=100;input.clips.reverse();
  const runtime=await pending;
  assert.equal(runtime.manifest.scenes.shared.title,'Lecture source');assert.equal(runtime.manifest.clips[0].id,'first');
  assert.equal(runtime.manifest.clips[0].timing.start,10);assert.equal(runtime.manifest.clips[0].placement.width,6);
  assert.equal(x(runtime.sample(11.5)[0]),50);
  assert.ok(Object.isFrozen(runtime.manifest));assert.ok(Object.isFrozen(runtime.manifest.scenes));
  assert.ok(Object.isFrozen(runtime.manifest.clips));assert.ok(Object.isFrozen(runtime.manifest.clips[0].timing));
  assert.ok(Object.isFrozen(runtime.manifest.clips[0].placement));runtime.dispose();
});

test('reverse seeking and returned frame mutation cannot affect later lecture frames',async()=>{
  const runtime=await prepareChalkspaceLecture(lesson()),reference=runtime.sample(11.75);
  for(const time of [19,10,12.8,11,500,0,11.75])runtime.sample(time);
  assert.deepEqual(runtime.sample(11.75),reference);
  (reference[0].frame!.nodes[0] as any).x=-100;
  assert.equal(x(runtime.sample(11.75)[0]),55);
  assert.equal(x(runtime.sample(11.75)[1]),13.75);
  runtime.dispose();
});

test('frame keys identify exact active time and remain stable for held endpoints',async()=>{
  const runtime=await prepareChalkspaceLecture(lesson());
  assert.equal(typeof runtime.frameKey(10),'string');assert.equal(typeof runtime.frameKey(10.5),'string');
  assert.notEqual(runtime.frameKey(10),runtime.frameKey(10.5));assert.notEqual(runtime.frameKey(10.5),runtime.frameKey(18.999));
  assert.equal(typeof runtime.frameKey(9),'string');assert.equal(runtime.frameKey(9),runtime.frameKey(0));
  assert.equal(typeof runtime.frameKey(19),'string');assert.equal(runtime.frameKey(19),runtime.frameKey(100));
  assert.notEqual(runtime.frameKey(9),runtime.frameKey(19));runtime.dispose();
});

test('zero-duration clip is immediately after its start with source endpoint policy',async()=>{
  const input=lesson();input.clips=[{id:'instant',scene:'shared',timing:{start:4,sourceStart:3,duration:0},placement:{x:0,y:1,width:8}}];
  const runtime=await prepareChalkspaceLecture(input);
  assert.equal(runtime.sample(3.99)[0].visible,false);
  const sample=runtime.sample(4)[0];assert.equal(sample.phase,'after');assert.equal(sample.sourceTime,3);assert.equal(x(sample),30);
  assert.equal(typeof runtime.frameKey(4),'string');runtime.dispose();
});

test('lecture diagnostics reject invalid timing, references, placement and nonfinite host time',async()=>{
  const mutations=[
    (v:any)=>{v.clips[0].scene='missing';},
    (v:any)=>{v.clips[1].id='first';},
    (v:any)=>{v.clips[0].timing.rate=0;},
    (v:any)=>{v.clips[0].timing.duration=7;},
    (v:any)=>{v.clips[0].placement.width=0;},
    (v:any)=>{v.clips[0].placement.y=Infinity;},
  ];
  for(const mutate of mutations){const input=lesson();mutate(input);await assert.rejects(prepareChalkspaceLecture(input),diagnostic(/LECTURE|CLIP|BOARD|JSON|finite|placement/i));}
  for(const input of [null,[],{contract:'wrong'}, {...lesson(),clips:null}])await assert.rejects(prepareChalkspaceLecture(input as any),diagnostic(/LECTURE|JSON|contract|clips/i));
  await assert.rejects(prepareChalkspaceLecture(lesson(),null as any),diagnostic(/LECTURE|options/i));
  const runtime=await prepareChalkspaceLecture(lesson());
  for(const time of [NaN,Infinity,-Infinity]) {assert.throws(()=>runtime.sample(time),diagnostic(/TIME|finite/i));assert.throws(()=>runtime.frameKey(time),diagnostic(/TIME|finite/i));}
  runtime.dispose();
});

test('inline resource package prepares fully and matches canonical source frames',async()=>{
  const source=bundle();source.resources.label=structuredClone(label);source.nodes.push({id:'label',kind:'tex',resourceId:'label',x:30,y:25});
  const input=lesson();input.scenes.shared=packaged(source);
  const runtime=await prepareChalkspaceLecture(input),sample=runtime.sample(11.5)[0];
  assert.deepEqual(sample.frame,prepareScene(source).sample(5));
  assert.ok(Object.isFrozen(sample.frame!.resources.label));runtime.dispose();
});

test('external resources and corrupt or missing scene assets reject atomic preparation',async()=>{
  const source=bundle();source.resources.label=structuredClone(label);source.nodes.push({id:'label',kind:'tex',resourceId:'label',x:30,y:25});
  const external=lesson();external.scenes.shared=packaged(source);external.scenes.shared.assets.entries[0].source={kind:'external',uri:'assets/label.json'};
  await assert.rejects(prepareChalkspaceLecture(external),diagnostic(/INLINE|EXTERNAL|external|inline|LECTURE/));
  const corrupt=lesson();corrupt.scenes.shared=packaged(source);corrupt.scenes.shared.assets.entries[0].sha256='0'.repeat(64);
  await assert.rejects(prepareChalkspaceLecture(corrupt),diagnostic(/HASH|INTEGRITY|SHA|DIGEST/));
  const missing=lesson();missing.scenes.bad=source;delete missing.scenes.bad.resources.label;
  await assert.rejects(prepareChalkspaceLecture(missing),diagnostic(/RESOURCE|resource/));
});

test('lecture signal cancels pending preparation and disposes a ready runtime idempotently',async()=>{
  const before=new AbortController();before.abort();
  await assert.rejects(prepareChalkspaceLecture(lesson(),{signal:before.signal}),diagnostic(/ABORT|DISPOS|CANCEL/));
  const pendingController=new AbortController(),pending=prepareChalkspaceLecture(lesson(),{signal:pendingController.signal});pendingController.abort();
  await assert.rejects(pending,diagnostic(/ABORT|DISPOS|CANCEL/));
  const controller=new AbortController(),runtime=await prepareChalkspaceLecture(lesson(),{signal:controller.signal});
  assert.equal(runtime.state,'ready');const existing=runtime.sample(11.5);controller.abort();assert.equal(runtime.state,'disposed');
  assert.throws(()=>runtime.describe(11.5),diagnostic(/DISPOS/));
  assert.throws(()=>runtime.sample(11.5),diagnostic(/DISPOS/));assert.throws(()=>runtime.frameKey(11.5),diagnostic(/DISPOS/));
  assert.throws(()=>runtime.draw({} as CanvasRenderingContext2D,11.5,{frameWidth:16,frameHeight:9,cameraY:4.5}),diagnostic(/DISPOS/));
  runtime.dispose();runtime.dispose();assert.equal(x(existing[0]),50);
});

test('lecture descriptions share sample clock metadata and are detached from future descriptions',async()=>{
  const runtime=await prepareChalkspaceLecture(lesson());
  for(const time of [0,10,11.5,13,19,100]) {
    const description=runtime.describe(time);
    assert.deepEqual(description,runtime.sample(time).map(({frame:_frame,...clock})=>clock));
    assert.ok(description.every(clock=>!('frame' in clock)));
  }
  const first=runtime.describe(11.5);first[0].sourceTime=999;
  assert.equal(runtime.describe(11.5)[0].sourceTime,5);runtime.dispose();
});

test('revision fingerprints geometry and placement rather than only scene metadata',async()=>{
  const first=lesson(),geometry=lesson(),placement=lesson(),timing=lesson();
  geometry.scenes.shared.nodes[0].r=3;placement.clips[0].placement.x+=.1;timing.clips[0].timing.start+=.1;
  const layers=await Promise.all([first,structuredClone(first),geometry,placement,timing].map(value=>prepareChalkspaceLecture(value)));
  try {
    assert.match(layers[0].revision,/^[0-9a-f]{64}$/);assert.equal(layers[0].revision,layers[0].manifest.revision);
    assert.equal(layers[0].revision,layers[1].revision);assert.equal(layers[0].frameKey(11),layers[1].frameKey(11));
    assert.equal(new Set(layers.map(layer=>layer.revision)).size,4);
    assert.equal(new Set(layers.map(layer=>layer.frameKey(11))).size,4);
    assert.ok(Object.isFrozen(layers[0]));assert.ok(Object.isFrozen(layers[0].manifest));
  } finally {layers.forEach(layer=>layer.dispose());}
});

test('revision is independent of object insertion order and preserves signed numeric input',async()=>{
  const reorder=(value:any):any=>Array.isArray(value)?value.map(reorder):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).reverse().map(key=>[key,reorder(value[key])])):value;
  const original=lesson(),negative=lesson();negative.scenes.shared.nodes[0].x=-0;
  const [a,b,c]=await Promise.all([original,reorder(original),negative].map(value=>prepareChalkspaceLecture(value)));
  try {assert.equal(a.revision,b.revision);assert.notEqual(a.revision,c.revision);}finally {a.dispose();b.dispose();c.dispose();}
});

test('resource paint changes invalidate keys for both bundled and inline-package lectures',async()=>{
  const source=bundle();source.resources.label=structuredClone(label);source.nodes.push({id:'label',kind:'tex',resourceId:'label',x:30,y:25});
  const changed=structuredClone(source);(changed.resources.label as VectorResource).items[0].style!.fill='#00ff00';
  for(const transform of [(value:Bundle)=>value,packaged]) {
    const a=lesson(),b=lesson();a.scenes.shared=transform(source);b.scenes.shared=transform(changed);
    const [first,second]=await Promise.all([prepareChalkspaceLecture(a),prepareChalkspaceLecture(b)]);
    try {assert.notEqual(first.revision,second.revision);assert.notEqual(first.frameKey(11),second.frameKey(11));}finally {first.dispose();second.dispose();}
  }
});

test('frame keys preserve adjacent representable times, quality and deterministic reverse lookup',async()=>{
  const runtime=await prepareChalkspaceLecture(lesson()),time=11.5,next=time+Number.EPSILON*8;
  assert.notEqual(time,next);assert.notEqual(runtime.frameKey(time),runtime.frameKey(next));
  const key=runtime.frameKey(time,'1920x1080:30');
  assert.notEqual(key,runtime.frameKey(time,'854x480:15'));assert.equal(runtime.frameKey(time),runtime.frameKey(time,''));
  for(const t of [19,0,12,500,10.5,next])runtime.frameKey(t,'1920x1080:30');
  assert.equal(runtime.frameKey(time,'1920x1080:30'),key);
  assert.throws(()=>runtime.frameKey(time,{} as any),diagnostic(/quality|LECTURE_INPUT/));runtime.dispose();
});

test('accessor-backed lecture data is rejected without invoking the accessor',async()=>{
  let reads=0;const input=lesson();Object.defineProperty(input.clips[0].timing,'start',{enumerable:true,get(){reads++;return 10;}});
  await assert.rejects(prepareChalkspaceLecture(input),diagnostic(/JSON|LECTURE_INPUT|accessor|descriptor/i));assert.equal(reads,0);
});

test('board aspect accepts rounded video pixels and rejects stretching before surface allocation',()=>{
  const original=Object.getOwnPropertyDescriptor(globalThis,'document'),allocation=new Error('Surface allocation reached');let calls=0;
  Object.defineProperty(globalThis,'document',{configurable:true,value:{createElement(){calls++;throw allocation;}}});
  try {
    const frame=prepareScene(bundle()).sample(0),view={frameWidth:16,frameHeight:9,cameraY:4.5};
    for(const [width,height] of [[854,480],[1280,720],[1920,1080]]) {
      const layer=createChalkspaceCanvasLayer({x:0,y:1,width:8});
      assert.throws(()=>layer.draw(frame,{canvas:{width,height}} as CanvasRenderingContext2D,view),error=>error===allocation);
      layer.dispose();
    }
    assert.equal(calls,3);
    const layer=createChalkspaceCanvasLayer({x:0,y:1,width:8});
    assert.throws(()=>layer.draw(frame,{canvas:{width:854,height:500}} as CanvasRenderingContext2D,view),/BOARD_ASPECT/);
    assert.equal(calls,3);layer.dispose();
    assert.throws(()=>layer.draw(frame,{} as CanvasRenderingContext2D,view),/DISPOS/);
  } finally {
    if(original)Object.defineProperty(globalThis,'document',original);else Reflect.deleteProperty(globalThis,'document');
  }
});
