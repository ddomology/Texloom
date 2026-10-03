import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setImmediate as tick} from 'node:timers/promises';
import {AssetError,RESOURCE_MEDIA_TYPE,snapshotScenePackage,validateAssetEntry,validateScenePackage,
  type AssetEntry,type ScenePackage} from '../src/resources/package.ts';
import {createAssetStore,type AssetStore} from '../src/resources/store.ts';
import {copyMeshBuffers,validateMeshResource,type MeshResource} from '../src/ir/mesh.ts';
import {prepareScene,prepareSceneAsync} from '../src/runtime.ts';
import {NUMERIC_3D_PROFILE,SVG_2D_PROFILE,sceneFeatures} from '../src/capabilities.ts';
import type {Bundle} from '../src/schema.ts';
import type {DeepReadonly} from '../src/ir/operations.ts';
// The production package CLI is an ES module with a deliberately JavaScript API.
// @ts-expect-error JavaScript CLI has no declaration file.
import {packageScene} from '../tools/package-scene.mjs';

type MeshEntry=Extract<AssetEntry,{kind:'mesh'}>;
const mesh=():MeshResource=>({kind:'mesh',version:1,primitive:'triangles',units:'unit',coordinateSpace:'object',
  winding:'ccw',topologyRevision:'triangle-v1',
  positions:{version:1,componentType:'float64',components:3,count:3,byteOffset:0,byteStride:24,data:[-1,0,2,3,0,2,-1,4,2]},
  indices:{version:1,componentType:'uint16',components:1,count:3,byteOffset:0,byteStride:2,data:[0,1,2]},
  normals:{version:1,componentType:'float32',components:3,count:3,byteOffset:0,byteStride:12,data:[0,0,1,0,0,1,0,0,1]},
  bounds:{min:[-1,0,2],max:[3,4,2]}});
const bytes=(resource:unknown)=>new TextEncoder().encode(JSON.stringify(resource)+'\n');
const hash=(data:Uint8Array)=>createHash('sha256').update(data).digest('hex');
function entry(resource:MeshResource=mesh(),id='triangle',external=false):MeshEntry {
  const payload=bytes(resource);
  return {id,kind:'mesh',mediaType:RESOURCE_MEDIA_TYPE,byteLength:payload.length,sha256:hash(payload),
    bounds:structuredClone(resource.bounds),source:external?{kind:'external',uri:`assets/${id}.json`}:
      {kind:'inline',data:new TextDecoder().decode(payload)}};
}
const bundle=():Bundle=>({version:'0.3',title:'Portable 3D mesh',units:'bp',duration:2,
  viewport:{width:100,height:60},camera:{x:0,y:0,zoom:1},nodes:[],tracks:[],relations:[],resources:{triangle:mesh()},
  space3d:{version:1,units:'unit',handedness:'right',upAxis:'z',nodes:[
    {id:'assembly',kind:'group'},{id:'surface',kind:'mesh',resourceId:'triangle',parent:'assembly',visible:false}]}});
function surfaceBundle():Bundle {
  const full=bundle();full.resources={};
  full.surfaces={version:1,operations:[{id:'plane',resourceId:'triangle',units:'unit',
    domain:{u:[0,1],v:[0,1]},segments:{u:3,v:2},position:['u*(1+time/1s)','v','0'],normals:{kind:'finite-difference'}}]};
  return full;
}
function packaged(external=false):ScenePackage {
  const full=bundle(),{resources:_resources,...scene}=full;
  return {contract:'texloom-package/1',scene,assets:{version:1,requiredFeatures:sceneFeatures(full),entries:[entry(mesh(),'triangle',external)]}};
}
const code=(expected:string)=>(error:unknown)=>error instanceof AssetError&&error.code===expected;
function empty(store:AssetStore){const stats=store.stats();assert.equal(stats.entries,0);assert.equal(stats.waiters,0);
  assert.equal(stats.leases,0);assert.equal(stats.reservedBytes,0);}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes;});return {promise,resolve};}

test('generated surfaces package as programs without fabricated assets and hydrate deterministically',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'texloom-surface-package-'));
  try {
    const authored=surfaceBundle(),input=join(folder,'bundle.json');await writeFile(input,JSON.stringify(authored));
    for(const mode of ['external','inline','packed']){
      const out=join(folder,mode),report=await packageScene(input,out,{mode});assert.equal(report.entries,0);
      const packaged=JSON.parse(await readFile(join(out,'scene.json'),'utf8')) as ScenePackage;
      assert.deepEqual(packaged.scene.surfaces,authored.surfaces);assert.deepEqual(packaged.assets.entries,[]);
      assert.deepEqual(validateScenePackage(packaged),[]);let calls=0;
      const store=createAssetStore({resolver:async()=>{calls++;throw Error('Generated mesh cannot perform asset I/O');}});
      const runtime=await prepareSceneAsync(packaged,{assetStore:store,profile:NUMERIC_3D_PROFILE});
      const sync=prepareScene(authored),baseline=runtime.sample(.5);
      assert.equal(baseline.resources.triangle.kind,'mesh');assert.ok(Object.isFrozen(baseline.resources.triangle));
      for(const t of [2,0,1,.5])assert.deepEqual(runtime.sample(t),sync.sample(t));
      assert.equal(calls,0);runtime.dispose();assert.deepEqual(baseline,sync.sample(.5));empty(store);store.dispose();
    }
  }finally{await rm(folder,{recursive:true,force:true});}
});

test('generated mesh IDs cannot shadow manifest assets or each other and do not satisfy vector references',()=>{
  const {resources,...scene}=surfaceBundle(),input:ScenePackage={contract:'texloom-package/1',scene,assets:{version:1,requiredFeatures:[],entries:[]}};
  input.assets.entries=[entry()];assert.ok(validateScenePackage(input).some(d=>d.code==='ASSET_DUPLICATE'));
  input.assets.entries=[];scene.surfaces!.operations.push({...scene.surfaces!.operations[0],id:'duplicate'});
  assert.ok(validateScenePackage(input).some(d=>d.code==='ASSET_DUPLICATE'));scene.surfaces!.operations.pop();
  scene.space3d!.overlays=[{id:'invalid-label',resourceId:'triangle',position:[0,0,0]}];
  assert.ok(validateScenePackage(input).some(d=>d.code==='ASSET_REFERENCE'));
});

test('mesh metadata bounds are discriminated, finite ordered triples or an explicit empty null',()=>{
  assert.deepEqual(validateAssetEntry(entry()),[]);
  for(const bounds of [[0,0,1,1],{},undefined,{min:[0,0],max:[1,1,1]},
    {min:[0,0,3],max:[1,1,2]},{min:[0,0,0],max:[1,Infinity,1]},{min:[0,0,0],max:[1,1,1],radius:3}]){
    assert.ok(validateAssetEntry({...entry(),bounds}).length>0,JSON.stringify(bounds));
  }
  assert.deepEqual(validateAssetEntry({...entry(),bounds:null}),[]);
  for(const kind of ['vector','scalar-field'])assert.ok(validateAssetEntry({...entry(),kind}).some(d=>d.code==='ASSET_BOUNDS'));
  const authored=packaged(),frozen=snapshotScenePackage(authored),item=authored.assets.entries[0];
  assert.equal(item.kind,'mesh');if(item.kind!=='mesh')throw Error('fixture');item.bounds!.min[0]=-99;
  const immutable=frozen.assets.entries[0];assert.equal(immutable.kind,'mesh');if(immutable.kind!=='mesh')throw Error('fixture');
  assert.equal(immutable.bounds!.min[0],-1);assert.ok(Object.isFrozen(immutable.bounds!.min));
});

test('3D mesh resource references, including hidden nodes, are checked before resolver I/O',async()=>{
  let calls=0;const store=createAssetStore({resolver:async()=>{calls++;return bytes(mesh());}});
  const missing=packaged(true);missing.assets.entries=[];
  assert.ok(validateScenePackage(missing).some(d=>d.code==='ASSET_REFERENCE'&&d.path==='$.scene.space3d.nodes[1].resourceId'));
  const wrong=packaged(true);wrong.assets.entries[0]={...entry(),kind:'vector',bounds:[0,0,1,1]};
  assert.ok(validateScenePackage(wrong).some(d=>d.code==='ASSET_KIND'));
  for(const input of [missing,wrong])await assert.rejects(prepareSceneAsync(input,{assetStore:store,profile:NUMERIC_3D_PROFILE}));
  assert.equal(calls,0);empty(store);store.dispose();
});

test('mesh leases share immutable JSON while caller-owned numeric views remain detached',async()=>{
  const gate=deferred<Uint8Array>(),payload=bytes(mesh());let calls=0;
  const store=createAssetStore({resolver:async()=>{calls++;return gate.promise;}}),first=entry(mesh(),'first',true);
  const alias=entry(mesh(),'alias');alias.bounds={max:[3,4,2],min:[-1,0,2]};
  const pendingA=store.acquire(first),pendingB=store.acquire(alias);
  first.bounds!.min[0]=-50;assert.equal(calls,1);assert.equal(store.stats().waiters,2);
  gate.resolve(payload);const [a,b]=await Promise.all([pendingA,pendingB]);payload.fill(0);
  assert.strictEqual(a.resource,b.resource);assert.deepEqual(a.resource,mesh());assert.equal(a.resource.kind,'mesh');
  if(a.resource.kind!=='mesh')throw Error('fixture');const resource=a.resource;assert.ok(Object.isFrozen(resource.positions.data));
  assert.throws(()=>{(resource.positions.data as number[])[0]=999;},TypeError);
  const left=copyMeshBuffers(a.resource),right=copyMeshBuffers(b.resource);left.positions[0]=999;left.indices[0]=2;
  assert.equal(right.positions[0],-1);assert.equal(right.indices[0],0);assert.equal(a.resource.positions.data[0],-1);
  a.release();assert.equal(store.stats().leases,1);assert.equal(calls,1);b.release();empty(store);store.dispose();
});

test('mesh pending cancellation, late resolution and disposal retain existing ownership semantics',async()=>{
  const gates=[deferred<Uint8Array>(),deferred<Uint8Array>()],signals:AbortSignal[]=[];let calls=0;
  const store=createAssetStore({resolver:async(_entry,{signal})=>{signals.push(signal);return gates[calls++].promise;}});
  const one=new AbortController(),two=new AbortController();
  const a=store.acquire(entry(mesh(),'a',true),one.signal),b=store.acquire(entry(mesh(),'b',true),two.signal);
  const rejectedA=assert.rejects(a,code('ASSET_ABORTED'));one.abort();await rejectedA;assert.equal(signals[0].aborted,false);
  const rejectedB=assert.rejects(b,code('ASSET_ABORTED'));two.abort();await rejectedB;assert.equal(signals[0].aborted,true);empty(store);
  const next=store.acquire(entry(mesh(),'retry',true));gates[0].resolve(new Uint8Array([0]));await tick();assert.equal(store.stats().waiters,1);
  gates[1].resolve(bytes(mesh()));const lease=await next;assert.deepEqual(lease.resource,mesh());assert.equal(calls,2);
  store.dispose();store.dispose();empty(store);assert.deepEqual(lease.resource,mesh());lease.release();
  await assert.rejects(store.acquire(entry()),code('ASSET_DISPOSED'));
});

test('mesh hashes, payload kinds, resource validity and declared bounds fail independently',async()=>{
  const correct=bytes(mesh()),corrupt=new Uint8Array(correct);corrupt[0]^=1;
  const malformed=mesh();malformed.indices.data[2]=99;
  const invalidTyped=mesh();(invalidTyped.positions as any).data=new Float64Array(invalidTyped.positions.data);
  assert.ok(validateMeshResource(invalidTyped).some(d=>d.code==='ASSET_JSON_OBJECT'));
  const cases:{payload:Uint8Array;entry:AssetEntry;code:string}[]=[
    {payload:corrupt,entry:entry(mesh(),'corrupt',true),code:'ASSET_HASH'},
    {payload:correct,entry:{...entry(mesh(),'bounds',true),bounds:{min:[-1,0,2],max:[3,5,2]}},code:'ASSET_BOUNDS'},
    {payload:correct,entry:{...entry(mesh(),'empty',true),bounds:null},code:'ASSET_BOUNDS'},
    {payload:correct,entry:{...entry(mesh(),'kind',true),kind:'vector',bounds:[0,0,1,1]},code:'ASSET_KIND'},
    {payload:bytes(malformed),entry:entry(malformed,'invalid',true),code:'ASSET_RESOURCE'},
  ];
  for(const item of cases){const store=createAssetStore({resolver:async()=>item.payload});
    await assert.rejects(store.acquire(item.entry),code(item.code));empty(store);store.dispose();}
  let calls=0;const shared=createAssetStore({resolver:async()=>{calls++;return correct;}});
  const good=await shared.acquire(entry(mesh(),'good',true));
  await assert.rejects(shared.acquire(cases[1].entry),code('ASSET_BOUNDS'));assert.equal(calls,2);assert.equal(shared.stats().leases,1);
  good.release();empty(shared);shared.dispose();
});

test('empty meshes and warning-only degenerate triangles hydrate without fabricated 2D bounds',async()=>{
  const none=mesh();none.positions={...none.positions,count:0,data:[]};none.indices={...none.indices,count:0,data:[]};
  delete none.normals;none.bounds=null;
  const degenerate=mesh();degenerate.indices.data=[0,0,1];
  assert.ok(validateMeshResource(degenerate).some(d=>d.code==='MESH_DEGENERATE'&&d.severity==='warning'));
  const store=createAssetStore(),a=await store.acquire(entry(none)),b=await store.acquire(entry(degenerate));
  assert.equal(a.resource.kind,'mesh');if(a.resource.kind!=='mesh')throw Error('fixture');assert.equal(a.resource.bounds,null);
  assert.equal(copyMeshBuffers(a.resource).positions.length,0);assert.deepEqual(copyMeshBuffers(b.resource).degenerateTriangles,[0]);
  a.release();b.release();empty(store);store.dispose();
});

test('numeric 3D preparation shares mesh resources and rejects a 2D consumer before transport',async()=>{
  let calls=0;const store=createAssetStore({resolver:async()=>{calls++;return bytes(mesh());}}),input=packaged(true);
  await assert.rejects(prepareSceneAsync(input,{assetStore:store,profile:SVG_2D_PROFILE}));assert.equal(calls,0);empty(store);
  const [a,b]=await Promise.all([prepareSceneAsync(input,{assetStore:store,profile:NUMERIC_3D_PROFILE}),
    prepareSceneAsync(input,{assetStore:store,profile:NUMERIC_3D_PROFILE})]);
  assert.equal(calls,1);assert.equal(store.stats().leases,2);assert.strictEqual(a.sample(0).resources.triangle,b.sample(0).resources.triangle);
  for(const t of [2,0,1,.5])assert.deepEqual(a.sample(t),prepareScene(bundle()).sample(t));
  a.dispose();assert.equal(store.stats().leases,1);assert.equal(b.state,'ready');b.dispose();empty(store);store.dispose();
});

test('package builder preserves deterministic mesh bytes and bounds in external, inline and packed delivery',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'texloom-mesh-assets-'));
  try {
    const authored=bundle();authored.resources.alias=structuredClone(authored.resources.triangle);
    const none=mesh();none.positions={...none.positions,count:0,data:[]};none.indices={...none.indices,count:0,data:[]};
    delete none.normals;none.bounds=null;authored.resources.empty=none;
    const input=join(folder,'bundle.json');await writeFile(input,JSON.stringify(authored));let firstManifest:Buffer|undefined;
    for(const mode of ['external','inline','packed','external']){
      const out=join(folder,mode),report=await packageScene(input,out,{mode});
      assert.equal(report.entries,3);assert.equal(report.uniquePayloads,2);
      const serialized=await readFile(join(out,'scene.json')),manifest=JSON.parse(serialized.toString('utf8')) as ScenePackage;
      assert.deepEqual(validateScenePackage(manifest),[]);assert.ok(manifest.assets.requiredFeatures.includes('mesh.triangles.3d'));
      if(mode==='external'){if(firstManifest)assert.deepEqual(serialized,firstManifest);else firstManifest=serialized;}
      const resolvePayload=async(asset:DeepReadonly<AssetEntry>)=>{
        if(asset.source.kind==='inline')return Buffer.from(asset.source.data,'utf8');
        const data=await readFile(join(out,asset.source.uri)),range=asset.source.byteRange;
        return range?data.subarray(range.offset,range.offset+range.length):data;
      };
      for(const asset of manifest.assets.entries){const data=await resolvePayload(asset);
        assert.equal(hash(data),asset.sha256);assert.equal(data.length,asset.byteLength);
        assert.deepEqual(data,Buffer.from(bytes(authored.resources[asset.id])));
        assert.deepEqual(asset.bounds,(authored.resources[asset.id] as MeshResource).bounds);
      }
      const runtime=await prepareSceneAsync(manifest,{profile:NUMERIC_3D_PROFILE,assetResolver:resolvePayload});
      assert.strictEqual(runtime.sample(0).resources.triangle,runtime.sample(0).resources.alias);
      assert.deepEqual(runtime.sample(1),prepareScene(authored).sample(1));runtime.dispose();
    }
  }finally{await rm(folder,{recursive:true,force:true});}
});
