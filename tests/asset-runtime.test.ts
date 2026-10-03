import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {beginPrepareScene,prepareSceneAsync,prepareScene} from '../src/runtime.ts';
import {createAssetStore} from '../src/resources/store.ts';
import {SVG_2D_PROFILE,sceneFeatures} from '../src/capabilities.ts';
import type {Bundle,Resource,VectorResource} from '../src/schema.ts';

const vector=(color='#123456'):VectorResource=>({kind:'vector',metrics:{width:8,height:9,depth:1},inkBounds:[0,-9,8,10],
  items:[{kind:'path',d:'M0 0L8 0L4 -9Z',style:{fill:color}}]});
const fixture=():Bundle=>({version:'0.3',title:'Asset lifecycle',duration:2,units:'bp',viewport:{width:100,height:60},camera:{x:0,y:0,zoom:1},
  resources:{glyph:vector()},nodes:[{id:'label',kind:'tex',resourceId:'glyph',x:10,y:20}],tracks:[{target:'label',property:'x',keys:[[0,10],[2,30]]}],relations:[]});
function packaged(bundle=fixture(),external=false):any {
  const {resources,...scene}=structuredClone(bundle);
  return {contract:'texloom-package/1',scene,assets:{version:1,requiredFeatures:sceneFeatures(bundle),entries:Object.entries(resources).map(([id,resource])=>{
    const data=JSON.stringify(resource),bytes=new TextEncoder().encode(data);
    return {id,kind:resource.kind,mediaType:'application/vnd.texloom.resource+json',byteLength:bytes.length,
      sha256:createHash('sha256').update(bytes).digest('hex'),bounds:resource.kind==='vector'?resource.inkBounds:[0,0,1,1],
      source:external?{kind:'external',uri:`./assets/${id}.json`}:{kind:'inline',data}};
  })}};
}
const bytes=(resource:Resource)=>new TextEncoder().encode(JSON.stringify(resource));
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));
function deferred<T>() {let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
async function until(predicate:()=>boolean) {const deadline=Date.now()+3000;while(Date.now()<deadline){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,1));}assert.ok(predicate(),'Expected async preparation milestone');}
const diagnostic=(pattern:RegExp)=>(error:any)=>error?.name!=='TypeError'&&pattern.test(JSON.stringify(error?.diagnostics??error?.message??error));
function emptyStore(store:ReturnType<typeof createAssetStore>) {const stats=store.stats();assert.equal(stats.entries,0);assert.equal(stats.pending,0);assert.equal(stats.ready,0);assert.equal(stats.leases,0);assert.equal(stats.waiters,0);assert.equal(stats.reservedBytes,0);}

test('legacy synchronous preparation is unchanged; async bundle runtime snapshots input and guards disposal',async()=>{
  const bundle=fixture(),sync=prepareScene(bundle),handle=beginPrepareScene(bundle);
  bundle.title='mutated';(bundle.nodes[0] as any).x=999;(bundle.resources.glyph as VectorResource).items[0].d='M999 999';
  const runtime=await handle.ready,frame=runtime.sample(1);
  assert.equal(handle.state,'ready');assert.equal(runtime.state,'ready');assert.equal(runtime.manifest.title,'Asset lifecycle');
  assert.deepEqual(frame,sync.sample(1));assert.equal('dispose' in sync,false);assert.ok(Object.isFrozen(frame.resources.glyph));
  runtime.dispose();runtime.dispose();handle.dispose();assert.equal(runtime.state,'disposed');assert.equal(handle.state,'disposed');
  assert.throws(()=>runtime.sample(1),diagnostic(/DISPOSED/));assert.throws(()=>runtime.require(SVG_2D_PROFILE),diagnostic(/DISPOSED/));
  assert.deepEqual(frame,sync.sample(1),'An already returned frame survives runtime disposal');
});

test('inline package needs no resolver and manifest contains detached metadata without payload transport',async()=>{
  const input=packaged(),before=structuredClone(input),runtime=await prepareSceneAsync(input),asset=(runtime.manifest as any).assets[0];
  assert.deepEqual(input,before);assert.equal(asset.id,'glyph');assert.equal(asset.sha256,input.assets.entries[0].sha256);
  assert.equal('source' in asset,false);assert.ok(Object.isFrozen(asset));assert.ok(Object.isFrozen(asset.bounds));
  assert.deepEqual(runtime.sample(.7),prepareScene(fixture()).sample(.7));runtime.dispose();
  const external=beginPrepareScene(packaged(fixture(),true));await assert.rejects(external.ready,diagnostic(/ASSET_RESOLVER/));assert.equal(external.state,'failed');external.dispose();
});

test('package and capability profile are deeply snapshotted before the first resolver await',async()=>{
  const input=packaged(fixture(),true),gate=deferred<Uint8Array>(),seen:any[]=[],profile={...SVG_2D_PROFILE,features:[...SVG_2D_PROFILE.features]};
  const handle=beginPrepareScene(input,{profile,assetResolver:async(entry:any)=>{seen.push(entry);return gate.promise;}});
  input.scene.title='changed';input.scene.nodes[0].x=900;input.assets.entries[0].source.uri='./wrong.json';input.assets.entries[0].bounds[0]=90;profile.features.length=0;
  await until(()=>seen.length===1);assert.equal(seen[0].source.uri,'./assets/glyph.json');assert.deepEqual(seen[0].bounds,[0,-9,8,10]);assert.ok(Object.isFrozen(seen[0]));
  gate.resolve(bytes(vector()));const runtime=await handle.ready;assert.equal(runtime.manifest.title,'Asset lifecycle');assert.equal((runtime.sample(0).nodes[0] as any).x,10);runtime.dispose();
});

test('declared unsupported capabilities fail before I/O; undeclared hydrated features fail and roll back leases',async()=>{
  let calls=0;const resolver=async()=>{calls++;return bytes(vector());},store=createAssetStore({resolver});
  const unsupported=packaged(fixture(),true);unsupported.assets.requiredFeatures.push('mesh.3d');
  const preflight=beginPrepareScene(unsupported,{assetStore:store,profile:SVG_2D_PROFILE});await assert.rejects(preflight.ready,diagnostic(/FEATURE|CAPABILITY/));assert.equal(calls,0);emptyStore(store);
  const underdeclared=packaged(fixture(),true);underdeclared.assets.requiredFeatures=[];
  const hydration=beginPrepareScene(underdeclared,{assetStore:store});await assert.rejects(hydration.ready,diagnostic(/ASSET_FEATURES/));assert.equal(hydration.state,'failed');assert.equal(calls,1);emptyStore(store);store.dispose();
});

test('pre-aborted signal and immediate disposal reject readiness without resolver work',async()=>{
  let calls=0;const controller=new AbortController();controller.abort();
  const cancelled=beginPrepareScene(packaged(fixture(),true),{signal:controller.signal,assetResolver:async()=>{calls++;return bytes(vector());}});
  await assert.rejects(cancelled.ready,diagnostic(/ABORT|CANCEL|DISPOSED/));assert.equal(cancelled.state,'disposed');assert.equal(calls,0);
  const disposed=beginPrepareScene(packaged(fixture(),true),{assetResolver:async()=>{calls++;return bytes(vector());}});disposed.dispose();disposed.dispose();
  await assert.rejects(disposed.ready,diagnostic(/ABORT|CANCEL|DISPOSED/));assert.equal(disposed.state,'disposed');assert.equal(calls,0);
});

test('disposal during a resolver that ignores abort cannot resurrect readiness or retain assets',async()=>{
  const gate=deferred<Uint8Array>();let resolverSignal:AbortSignal|undefined;const store=createAssetStore({resolver:async(_entry,{signal})=>{resolverSignal=signal;return gate.promise;}});
  const handle=beginPrepareScene(packaged(fixture(),true),{assetStore:store});await until(()=>!!resolverSignal);assert.equal(handle.state,'preparing');
  handle.dispose();await assert.rejects(handle.ready,diagnostic(/ABORT|CANCEL|DISPOSED/));assert.equal(resolverSignal!.aborted,true);emptyStore(store);
  gate.resolve(bytes(vector()));await turn();await turn();assert.equal(handle.state,'disposed');emptyStore(store);store.dispose();
});

test('external signal abort during preparation and after readiness releases the scene lease',async()=>{
  const gate=deferred<Uint8Array>(),controller=new AbortController();let called=false;
  const store=createAssetStore({resolver:async()=>{called=true;return gate.promise;}}),handle=beginPrepareScene(packaged(fixture(),true),{assetStore:store,signal:controller.signal});
  await until(()=>called);controller.abort();await assert.rejects(handle.ready,diagnostic(/ABORT|CANCEL|DISPOSED/));assert.equal(handle.state,'disposed');emptyStore(store);gate.resolve(bytes(vector()));await turn();
  const readySignal=new AbortController(),runtime=await prepareSceneAsync(packaged(),{assetStore:store,signal:readySignal.signal});assert.equal(store.stats().leases,1);
  readySignal.abort();assert.equal(runtime.state,'disposed');assert.throws(()=>runtime.sample(0),diagnostic(/DISPOSED/));emptyStore(store);store.dispose();
});

test('two ready scenes share one immutable asset with independent frames and lease lifetimes',async()=>{
  let calls=0;const store=createAssetStore({resolver:async()=>{calls++;return bytes(vector());}}),input=packaged(fixture(),true);
  const [left,right]=await Promise.all([prepareSceneAsync(input,{assetStore:store}),prepareSceneAsync(input,{assetStore:store})]);
  assert.equal(calls,1);assert.equal(store.stats().leases,2);const a=left.sample(1),b=right.sample(1);assert.strictEqual(a.resources.glyph,b.resources.glyph);assert.ok(Object.isFrozen(a.resources.glyph));
  (a.nodes[0] as any).x=-500;assert.equal((right.sample(1).nodes[0] as any).x,20);left.dispose();assert.equal(store.stats().leases,1);assert.equal(right.state,'ready');assert.equal((right.sample(1).nodes[0] as any).x,20);
  for(const time of [2,0,.3,1.7,1])right.sample(time);assert.equal(calls,1,'Sampling cannot perform asset I/O');right.dispose();emptyStore(store);store.dispose();
});

test('one cancelled shared pending consumer leaves the other preparation alive',async()=>{
  const gate=deferred<Uint8Array>();let calls=0,resolverSignal:AbortSignal|undefined;
  const store=createAssetStore({resolver:async(_entry,{signal})=>{calls++;resolverSignal=signal;return gate.promise;}}),input=packaged(fixture(),true),a=beginPrepareScene(input,{assetStore:store}),b=beginPrepareScene(input,{assetStore:store});
  await until(()=>store.stats().waiters===2);a.dispose();await assert.rejects(a.ready,diagnostic(/ABORT|CANCEL|DISPOSED/));assert.equal(resolverSignal!.aborted,false);assert.equal(calls,1);
  gate.resolve(bytes(vector()));const runtime=await b.ready;assert.equal(b.state,'ready');assert.equal(store.stats().leases,1);runtime.dispose();emptyStore(store);store.dispose();
});

test('missing bytes, corrupted bytes, and missing referenced resources never produce partial ready runtimes',async()=>{
  for(const mode of ['missing','corrupt','reference'] as const){
    const input=packaged(fixture(),true);if(mode==='reference')input.scene.nodes[0].resourceId='not-in-manifest';
    const store=createAssetStore({resolver:async()=>{if(mode==='missing')throw new Error('fixture resource absent');const data=bytes(vector());if(mode==='corrupt')data[2]^=1;return data;}}),handle=beginPrepareScene(input,{assetStore:store});
    await assert.rejects(handle.ready);assert.equal(handle.state,'failed');emptyStore(store);handle.dispose();assert.equal(handle.state,'disposed');store.dispose();
  }
});

test('failure of a second asset releases any first acquired lease and keeps caller input untouched',async()=>{
  const inputBundle=fixture();inputBundle.resources.other=vector('#abcdef');inputBundle.nodes.push({id:'other-label',kind:'tex',resourceId:'other',x:40,y:20});
  const input=packaged(inputBundle,true),before=structuredClone(input),second=deferred<Uint8Array>();let secondCalled=false;
  const store=createAssetStore({resolver:async entry=>{if(entry.id==='glyph')return bytes(vector());secondCalled=true;return second.promise;}}),handle=beginPrepareScene(input,{assetStore:store});
  await until(()=>secondCalled);assert.equal(handle.state,'preparing');const data=bytes(vector('#abcdef'));data[3]^=1;second.resolve(data);
  await assert.rejects(handle.ready,diagnostic(/HASH|INTEGRITY/));assert.equal(handle.state,'failed');emptyStore(store);assert.deepEqual(input,before);store.dispose();
});

test('invalid input and accessor data reject through the handle without reading getters',async()=>{
  let reads=0;const input:any=fixture();Object.defineProperty(input,'title',{enumerable:true,get(){reads++;return 'unsafe';}});
  for(const value of [null,{},input]){let handle:ReturnType<typeof beginPrepareScene>|undefined;assert.doesNotThrow(()=>{handle=beginPrepareScene(value as any);});await assert.rejects(handle!.ready);assert.equal(handle!.state,'failed');}
  assert.equal(reads,0);
  const handle=beginPrepareScene(fixture(),{profile:{id:'bad',contract:'wrong',features:[]} as any});await assert.rejects(handle.ready,diagnostic(/CAPABILITY|CONTRACT|RENDER/));assert.equal(handle.state,'failed');
});

test('unobserved rejected readiness is internally handled but still rejects when subsequently awaited',async()=>{
  const unhandled:unknown[]=[];const observe=(reason:unknown)=>unhandled.push(reason);process.on('unhandledRejection',observe);
  try {const handle=beginPrepareScene(packaged(fixture(),true));await turn();await turn();assert.equal(handle.state,'failed');assert.deepEqual(unhandled,[]);await assert.rejects(handle.ready,diagnostic(/ASSET_RESOLVER/));}
  finally {process.removeListener('unhandledRejection',observe);}
});

test('a custom store cannot publish a shallow-frozen resource and its lease is rolled back',async()=>{
  let released=0,disposed=0;const resource=Object.freeze(vector());
  const store={acquire:async()=>({resource,release(){released++;}}),dispose(){disposed++;}} as any;
  const handle=beginPrepareScene(packaged(),{assetStore:store});await assert.rejects(handle.ready,diagnostic(/ASSET_OWNERSHIP/));
  assert.equal(handle.state,'failed');assert.equal(released,1);assert.equal(disposed,0,'The host owns the supplied store');
  handle.dispose();assert.equal(released,1);
});
