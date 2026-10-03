import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {setImmediate as tick} from 'node:timers/promises';
import {AssetError,RESOURCE_MEDIA_TYPE,snapshotScenePackage,validateScenePackage,validateAssetEntry,validateAssetJson,
  type AssetEntry,type ScenePackage} from '../src/resources/package.ts';
import {createAssetStore,type AssetResolver,type AssetStore} from '../src/resources/store.ts';
import type {ScalarFieldResource,VectorResource} from '../src/schema.ts';

type LegacyAssetEntry=Extract<AssetEntry,{kind:'vector'|'scalar-field'}>;

const vector=():VectorResource=>({kind:'vector',items:[{kind:'path',d:'M0 0L12 4',style:{stroke:'#fff',fill:'none'}}],
  metrics:{width:12,height:4,depth:0},inkBounds:[0,0,12,4],sourceTex:'x + λ'});
const bytes=(resource:unknown)=>new TextEncoder().encode(JSON.stringify(resource)+'\n');
const hash=(value:Uint8Array)=>createHash('sha256').update(value).digest('hex');
function entry(payload:Uint8Array=bytes(vector()),id='formula'):LegacyAssetEntry {
  return {id,kind:'vector',mediaType:RESOURCE_MEDIA_TYPE,byteLength:payload.byteLength,sha256:hash(payload),
    bounds:[0,0,12,4],source:{kind:'external',uri:`assets/${id}.json`}};
}
const inline=(resource:VectorResource|ScalarFieldResource=vector(),id='formula'):LegacyAssetEntry=>{
  const payload=bytes(resource),out=entry(payload,id);out.kind=resource.kind;
  out.bounds=resource.kind==='vector'?[...resource.inkBounds]:[0,0,1,1];
  out.source={kind:'inline',data:new TextDecoder().decode(payload)};return out;
};
const scenePackage=():ScenePackage=>({contract:'texloom-package/1',scene:{version:'0.3',title:'Assets',duration:1,units:'bp',
  viewport:{width:100,height:50},camera:{x:0,y:0,zoom:1},nodes:[{kind:'tex',id:'formula',resourceId:'formula',x:3,y:5}],tracks:[],relations:[]},
  assets:{version:1,requiredFeatures:['path.2d'],entries:[inline()]}});
const deferred=<T>()=>{let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;
  const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const code=(expected:string)=>(error:unknown)=>error instanceof AssetError&&error.code===expected;
const empty=(store:AssetStore)=>{
  const stats=store.stats();assert.equal(stats.entries,0);assert.equal(stats.pending,0);assert.equal(stats.ready,0);
  assert.equal(stats.waiters,0);assert.equal(stats.leases,0);assert.equal(stats.reservedBytes,0);
};

test('portable package snapshots preserve exact payload strings and reject structural ambiguity',()=>{
  const authored=scenePackage(),frozen=snapshotScenePackage(authored);assert.deepEqual(validateScenePackage(authored),[]);
  assert.ok(authored.assets.entries[0].kind==='vector');assert.ok(frozen.assets.entries[0].kind==='vector');
  authored.scene.title='changed';authored.assets.entries[0].bounds[0]=9;
  assert.equal(frozen.scene.title,'Assets');assert.equal(frozen.assets.entries[0].bounds[0],0);
  assert.ok(Object.isFrozen(frozen.assets.entries[0].source));assert.equal(Object.isFrozen(authored),false);
  const variants:[(p:ScenePackage)=>void,string][]=[
    [p=>p.assets.entries.push(structuredClone(p.assets.entries[0])),'ASSET_DUPLICATE'],
    [p=>p.assets.requiredFeatures.push('path.2d'),'ASSET_FEATURES'],
    [p=>p.assets.entries=[],'ASSET_REFERENCE'],
    [p=>(p.scene as any).resources={},'ASSET_SCENE_RESOURCES'],
    [p=>p.assets.entries[0].source={kind:'external',uri:'blob:https://example.test/session'},'ASSET_URI'],
    [p=>(p.assets.entries[0] as any).gpuHandle=12,'ASSET_PROPERTY'],
    [p=>(p.assets as any).version=2,'ASSET_VERSION'],
    [p=>(p as any).contract='texloom-package/2','ASSET_CONTRACT'],
    [p=>p.scene.duration=Infinity,'ASSET_JSON_VALUE'],
  ];
  for(const [modify,expected] of variants){const p=scenePackage();modify(p);
    assert.ok(validateScenePackage(p).some(d=>d.code===expected),expected);assert.throws(()=>snapshotScenePackage(p),AssetError);}
});

test('JSON input limits and accessor rejection precede any observable property access',()=>{
  let calls=0;const p=scenePackage();Object.defineProperty(p,'assets',{enumerable:true,get:()=>{calls++;throw Error('getter');}});
  assert.equal(validateScenePackage(p)[0].code,'ASSET_JSON_VALUE');assert.throws(()=>snapshotScenePackage(p),AssetError);assert.equal(calls,0);
  const cycle:any={};cycle.self=cycle;assert.equal(validateAssetJson(cycle)[0].code,'ASSET_JSON_CYCLE');
  const deep:any={};let at=deep;for(let i=0;i<130;i++)at=at.next={};
  assert.equal(validateAssetJson(deep)[0].code,'ASSET_JSON_DEPTH');
  assert.equal(validateAssetJson(new Array(1_000_001))[0].code,'ASSET_JSON_LIMIT');
  assert.equal(validateAssetJson([,1])[0].code,'ASSET_JSON_VALUE');
  assert.equal(validateAssetJson({fn:()=>1})[0].code,'ASSET_JSON_VALUE');
  const tooMany=scenePackage();tooMany.assets.entries=Array(4097).fill(inline());
  assert.ok(validateScenePackage(tooMany).some(d=>d.code==='ASSET_ENTRIES'));
});

test('projected TeX overlays preflight manifest references before hydration',()=>{
  const p=scenePackage();
  p.scene.space3d={version:1,units:'m',handedness:'right',upAxis:'z',nodes:[],
    overlays:[{id:'label',resourceId:'formula',position:[0,0,0]}]};
  assert.deepEqual(validateScenePackage(p),[]);
  p.scene.space3d.overlays![0].resourceId='absent';
  assert.ok(validateScenePackage(p).some(d=>d.code==='ASSET_REFERENCE'&&d.path==='$.scene.space3d.overlays[0].resourceId'));
  p.scene.space3d.overlays![0].resourceId='formula';
  p.assets.entries[0].kind='scalar-field';p.assets.entries[0].bounds=[0,0,1,1];
  assert.ok(validateScenePackage(p).some(d=>d.code==='ASSET_KIND'&&d.path==='$.scene.space3d.overlays[0].resourceId'));
});

test('entry metadata validates ranges, finite bounds, hashes and scalar normalization',()=>{
  const e=entry();e.source={kind:'external',uri:'atlas.bin',byteRange:{offset:123,length:e.byteLength}};
  assert.deepEqual(validateAssetEntry(e),[]);
  for(const range of [{offset:-1,length:e.byteLength},{offset:0,length:e.byteLength+1},{offset:Number.MAX_SAFE_INTEGER,length:e.byteLength}]){
    e.source={kind:'external',uri:'atlas.bin',byteRange:range};assert.ok(validateAssetEntry(e).some(d=>d.code==='ASSET_RANGE'));
  }
  e.source={kind:'external',uri:'atlas.bin'};e.bounds=[0,0,-1,2];assert.ok(validateAssetEntry(e).some(d=>d.code==='ASSET_BOUNDS'));
  e.bounds=[0,0,12,4];e.sha256=e.sha256.toUpperCase();assert.ok(validateAssetEntry(e).some(d=>d.code==='ASSET_HASH'));
  e.sha256='a'.repeat(64);e.kind='scalar-field';assert.ok(validateAssetEntry(e).some(d=>d.code==='ASSET_BOUNDS'));
});

test('inline vector and scalar resources are fully validated, detached and recursively frozen',async()=>{
  const scalar:ScalarFieldResource={kind:'scalar-field',columns:2,rows:1,times:[0,1],samples:[[0,1],[1,2]],range:[0,2],interpolation:'linear'};
  const store=createAssetStore();const a=await store.acquire(inline()),b=await store.acquire(inline(scalar,'heat'));
  assert.deepEqual(a.resource,vector());assert.deepEqual(b.resource,scalar);
  assert.ok(Object.isFrozen(a.resource));assert.ok(Object.isFrozen((a.resource as VectorResource).items[0].style));
  assert.throws(()=>{(b.resource as any).samples[0][0]=9;},TypeError);
  assert.equal(store.stats().ready,2);a.release();b.release();empty(store);store.dispose();store.dispose();
});

test('content sharing spans aliases and transports, preserving one immutable resource identity',async()=>{
  const payload=bytes(vector()),gate=deferred<Uint8Array>();let calls=0;
  const store=createAssetStore({resolver:async()=>{calls++;return gate.promise;}});
  const first=store.acquire(entry(payload,'first'));
  const second=store.acquire(inline(vector(),'other-id'));
  assert.equal(calls,1);assert.equal(store.stats().pending,1);assert.equal(store.stats().waiters,2);
  gate.resolve(payload);const [a,b]=await Promise.all([first,second]);assert.equal(a.resource,b.resource);
  const c=await store.acquire(entry(payload,'third'));assert.equal(c.resource,a.resource);assert.equal(calls,1);
  a.release();a.release();assert.equal(store.stats().leases,2);b.release();c.release();empty(store);
  const d=await store.acquire(inline());assert.notEqual(d.resource,a.resource);d.release();empty(store);
});

test('canceling one pending acquisition does not cancel an overlapping consumer',async()=>{
  const gate=deferred<Uint8Array>(),payload=bytes(vector());let signal!:AbortSignal;
  const store=createAssetStore({resolver:async(_e,c)=>{signal=c.signal;return gate.promise;}});
  const cancel=new AbortController(),a=store.acquire(entry(payload,'a'),cancel.signal),b=store.acquire(entry(payload,'b'));
  const rejected=assert.rejects(a,code('ASSET_ABORTED'));cancel.abort();await rejected;
  assert.equal(signal.aborted,false);assert.equal(store.stats().waiters,1);
  gate.resolve(payload);const lease=await b;assert.equal(store.stats().leases,1);lease.release();empty(store);
});

test('last pending cancellation evicts immediately and ignored-abort late settlement cannot poison a retry',async()=>{
  const pending=[deferred<Uint8Array>(),deferred<Uint8Array>()],signals:AbortSignal[]=[];let calls=0;
  const store=createAssetStore({resolver:async(_e,c)=>{signals.push(c.signal);return pending[calls++].promise;}});
  const c=new AbortController(),old=store.acquire(entry(),c.signal),cancelled=assert.rejects(old,code('ASSET_ABORTED'));
  c.abort();await cancelled;empty(store);assert.equal(signals[0].aborted,true);
  const next=store.acquire(entry());assert.equal(calls,2);
  pending[0].resolve(new Uint8Array([1,2,3]));await tick();assert.equal(store.stats().waiters,1);
  pending[1].resolve(bytes(vector()));const lease=await next;assert.equal(store.stats().ready,1);lease.release();empty(store);
});

test('disposed stores settle all waiters, release ready entries and reject future work',async()=>{
  const gate=deferred<Uint8Array>();let signal!:AbortSignal;
  const store=createAssetStore({resolver:async(_e,c)=>{signal=c.signal;return gate.promise;}});
  const ready=await store.acquire(inline());const different=entry();different.sha256='a'.repeat(64);
  const pending=store.acquire(different),failure=assert.rejects(pending,code('ASSET_DISPOSED'));
  store.dispose();store.dispose();await failure;assert.equal(signal.aborted,true);empty(store);assert.equal(store.stats().disposed,true);
  assert.deepEqual(ready.resource,vector());ready.release();gate.reject(Error('late rejection'));await tick();empty(store);
  await assert.rejects(store.acquire(inline()),code('ASSET_DISPOSED'));
});

test('lease cancellation is isolated after readiness, and invalid signals allocate nothing',async()=>{
  const store=createAssetStore(),cancel=new AbortController();
  const a=await store.acquire(inline(),cancel.signal),b=await store.acquire(inline());
  cancel.abort();assert.equal(store.stats().leases,1);assert.deepEqual(b.resource,vector());a.release();b.release();empty(store);
  await assert.rejects(store.acquire(inline(),{} as AbortSignal),code('ASSET_SIGNAL'));empty(store);
  const pre=new AbortController();pre.abort();await assert.rejects(store.acquire(inline(),pre.signal),code('ASSET_ABORTED'));empty(store);
});

test('declared byte reservations bound pending and ready entries before resolver calls',async()=>{
  const payload=bytes(vector()),gate=deferred<Uint8Array>();let calls=0;
  const store=createAssetStore({maxAssetBytes:payload.length,maxTotalBytes:payload.length,
    resolver:async()=>{calls++;return gate.promise;}});
  const a=store.acquire(entry(payload)),other=entry(payload,'other');other.sha256='b'.repeat(64);
  await assert.rejects(store.acquire(other),code('ASSET_BUDGET'));assert.equal(calls,1);
  const alias=store.acquire(entry(payload,'alias'));assert.equal(store.stats().reservedBytes,payload.length);
  gate.resolve(payload);const [x,y]=await Promise.all([a,alias]);await assert.rejects(store.acquire(other),code('ASSET_BUDGET'));
  x.release();y.release();empty(store);
  const small=createAssetStore({maxAssetBytes:payload.length-1});await assert.rejects(small.acquire(inline()),code('ASSET_BUDGET'));empty(small);
  for(const config of [{maxAssetBytes:0},{maxTotalBytes:NaN},{maxAssetBytes:1.5}])assert.throws(()=>createAssetStore(config),code('ASSET_BUDGET'));
});

test('resolver absence, exceptions and wrong byte types produce contextual AssetErrors with no retention',async()=>{
  const absent=createAssetStore();await assert.rejects(absent.acquire(entry()),code('ASSET_RESOLVER'));empty(absent);
  for(const resolver of [async()=>{throw Error('offline');},async()=>[1,2],async()=>new DataView(new ArrayBuffer(2))]){
    const store=createAssetStore({resolver:resolver as unknown as AssetResolver});
    await assert.rejects(store.acquire(entry()),(error:unknown)=>{
      assert.ok(error instanceof AssetError);assert.equal(error.assetId,'formula');assert.equal(error.uri,'assets/formula.json');
      assert.ok(['ASSET_RESOLVE','ASSET_BYTES'].includes(error.code));assert.ok(Object.isFrozen(error.diagnostics));return true;
    });empty(store);
  }
});

test('exact selected-range payloads succeed, but a full packed response is never silently sliced',async()=>{
  const payload=bytes(vector()),packed=new Uint8Array(payload.length+12);packed.set(payload,7);
  const e=entry(payload);e.source={kind:'external',uri:'pack.bin',byteRange:{offset:7,length:payload.length}};
  let seen:unknown;const correct=createAssetStore({resolver:async(input)=>{seen=input.source;return packed.slice(7,7+payload.length).buffer;}});
  const lease=await correct.acquire(e);assert.deepEqual(seen,e.source);lease.release();empty(correct);
  const wrong=createAssetStore({resolver:async()=>packed});await assert.rejects(wrong.acquire(e),code('ASSET_SIZE'));empty(wrong);
});

test('payload corruption, metadata mismatch and invalid resource data fail before publication',async()=>{
  const payload=bytes(vector()),broken=new Uint8Array(payload);broken[0]=123^1;
  const cases:{payload:Uint8Array;entry:AssetEntry;code:string}[]=[
    {payload:broken,entry:entry(payload),code:'ASSET_HASH'},
    {payload,entry:{...entry(payload),bounds:[0,0,13,4]},code:'ASSET_BOUNDS'},
    {payload,entry:{...entry(payload),kind:'scalar-field',bounds:[0,0,1,1]},code:'ASSET_KIND'},
    ...[{kind:'vector',items:[]},null,{...vector(),metrics:{width:'x',height:1,depth:0}}].map(value=>{
      const data=bytes(value);return {payload:data,entry:entry(data),code:'ASSET_RESOURCE'};
    }),
  ];
  for(const c of cases){const store=createAssetStore({resolver:async()=>c.payload});
    await assert.rejects(store.acquire(c.entry),code(c.code));empty(store);}
});

test('UTF-8 and JSON parsing are strict even when the supplied digest is correct',async()=>{
  const invalidUtf8=new Uint8Array([0x7b,0x22,0xc3,0x28,0x22,0x7d]);
  const badJson=new TextEncoder().encode('{"kind":}');
  const bom=new Uint8Array([0xef,0xbb,0xbf,...bytes(vector())]);
  const nonfinite=new TextEncoder().encode(JSON.stringify(vector()).replace('"width":12','"width":1e999'));
  const cases:[Uint8Array,string][]=[[invalidUtf8,'ASSET_UTF8'],[badJson,'ASSET_JSON'],[bom,'ASSET_JSON'],[nonfinite,'ASSET_RESOURCE']];
  for(const [payload,expected] of cases){const store=createAssetStore({resolver:async()=>payload});
    await assert.rejects(store.acquire(entry(payload)),code(expected));empty(store);}
});

test('payload JSON budgets reject deep metadata before resource traversal',async()=>{
  const resource:any=vector();let at=resource;for(let i=0;i<130;i++)at=at.extra={};
  const payload=bytes(resource),store=createAssetStore({resolver:async()=>payload});
  await assert.rejects(store.acquire(entry(payload)),(error:unknown)=>{
    assert.ok(error instanceof AssetError);assert.equal(error.code,'ASSET_RESOURCE');
    assert.ok(error.diagnostics.some(d=>d.code==='ASSET_JSON_DEPTH'));return true;
  });empty(store);
});

test('same content with conflicting metadata is independently validated rather than borrowing a ready resource',async()=>{
  const payload=bytes(vector());let calls=0;const store=createAssetStore({resolver:async()=>{calls++;return payload;}});
  const original=await store.acquire(entry(payload)),wrong=entry(payload,'wrong');wrong.bounds[2]=99;
  await assert.rejects(store.acquire(wrong),code('ASSET_BOUNDS'));assert.equal(calls,2);assert.equal(store.stats().leases,1);
  assert.deepEqual(original.resource,vector());original.release();empty(store);
});

test('entry and resolver buffers are snapshotted before asynchronous verification',async()=>{
  const payload=bytes(vector()),gate=deferred<Uint8Array>();let received:any;
  const store=createAssetStore({resolver:async e=>{received=e;return gate.promise;}}),e=entry(payload);
  const pending=store.acquire(e);e.id='changed';e.bounds[2]=99;(e.source as any).uri='wrong.json';
  assert.equal(received.id,'formula');assert.equal(received.bounds[2],12);assert.ok(Object.isFrozen(received.source));
  gate.resolve(payload);const lease=await pending;payload.fill(0);
  assert.deepEqual(lease.resource,vector());assert.equal(Object.isFrozen(e),false);lease.release();empty(store);
});

test('crypto unavailability is a diagnosed host limitation and does not retain an entry',async()=>{
  const original=Object.getOwnPropertyDescriptor(globalThis,'crypto')!;
  Object.defineProperty(globalThis,'crypto',{configurable:true,value:undefined});
  try {const store=createAssetStore();await assert.rejects(store.acquire(inline()),code('ASSET_CRYPTO'));empty(store);}
  finally {Object.defineProperty(globalThis,'crypto',original);}
});
