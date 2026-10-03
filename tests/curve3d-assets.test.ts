import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setImmediate as tick} from 'node:timers/promises';
import {createAssetStore,type AssetStore} from '../src/resources/store.ts';
import {AssetError,RESOURCE_MEDIA_TYPE,validateScenePackage,validateAssetEntry,type AssetEntry,type ScenePackage} from '../src/resources/package.ts';
import {copyCurve3DBuffers,type Curve3DResource} from '../src/ir/curve3d.ts';
import {prepareScene,prepareSceneAsync} from '../src/runtime.ts';
import {NUMERIC_3D_PROFILE,SVG_2D_PROFILE,sceneFeatures} from '../src/capabilities.ts';
import type {Bundle} from '../src/schema.ts';
import type {DeepReadonly} from '../src/ir/operations.ts';
// @ts-expect-error Production JavaScript CLI exports no declaration file.
import {packageScene} from '../tools/package-scene.mjs';

const curve=():Curve3DResource=>({kind:'curve3d',version:1,primitive:'line-strip',units:'unit',coordinateSpace:'object',closed:false,topologyRevision:'line-v1',
  positions:{version:1,componentType:'float64',components:3,count:3,byteOffset:0,byteStride:24,data:[-1,0,0,0,1,0,1,0,0]},bounds:{min:[-1,0,0],max:[1,1,0]}});
const bytes=(value:unknown)=>new TextEncoder().encode(JSON.stringify(value)+'\n');
const sha=(data:Uint8Array)=>createHash('sha256').update(data).digest('hex');
function entry(id='path',external=false,resource=curve()):Extract<AssetEntry,{kind:'curve3d'}>{const data=bytes(resource);return {id,kind:'curve3d',mediaType:RESOURCE_MEDIA_TYPE,
  byteLength:data.length,sha256:sha(data),bounds:structuredClone(resource.bounds),source:external?{kind:'external',uri:`assets/${id}.json`}:{kind:'inline',data:new TextDecoder().decode(data)}};}
const bundle=():Bundle=>({version:'0.3',units:'bp',title:'Curve package',duration:2,viewport:{width:100,height:60},camera:{x:0,y:0,zoom:1},nodes:[],tracks:[],relations:[],resources:{path:curve()},
  space3d:{version:1,units:'unit',handedness:'right',upAxis:'z',nodes:[{id:'static-curve',kind:'curve',resourceId:'path'}]}});
function generated():Bundle{const b=bundle();b.curves3d={version:1,operations:[{id:'moving',resourceId:'generated-path',units:'unit',domain:[0,1],segments:8,
  position:['u','u*u*(1+time/1s)','0'],frame:{seed:{kind:'up',up:[0,0,1]}}}],followers:[]};b.space3d!.nodes.push({id:'dynamic-curve',kind:'curve',resourceId:'generated-path'});return b;}
function packaged(external=false):ScenePackage{const full=bundle(),{resources,...scene}=full;return {contract:'texloom-package/1',scene,assets:{version:1,requiredFeatures:sceneFeatures(full),entries:[entry('path',external)]}};}
const errorCode=(code:string)=>(e:unknown)=>e instanceof AssetError&&e.code===code;
const empty=(store:AssetStore)=>{for(const key of ['entries','waiters','leases','reservedBytes'] as const)assert.equal(store.stats()[key],0);};
const deferred=<T>()=>{let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};};

test('static and generated curves package in external, inline and packed modes with exact bytes and zero generated payloads',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'texloom-curve-assets-'));
  try{
    const authored=generated();authored.resources.alias=structuredClone(authored.resources.path);
    const input=join(folder,'bundle.json');await writeFile(input,JSON.stringify(authored));let firstManifest:Buffer|undefined;
    for(const mode of ['external','inline','packed','external']){
      const out=join(folder,mode),report=await packageScene(input,out,{mode});assert.equal(report.entries,2);assert.equal(report.uniquePayloads,1);
      const manifestBytes=await readFile(join(out,'scene.json')),manifest=JSON.parse(manifestBytes.toString()) as ScenePackage;
      assert.deepEqual(validateScenePackage(manifest),[]);assert.deepEqual(manifest.scene.curves3d,authored.curves3d);
      assert.ok(manifest.assets.requiredFeatures.includes('curve.polyline.3d'));assert.ok(!manifest.assets.entries.some(e=>e.id==='generated-path'));
      if(mode==='external'){if(firstManifest)assert.deepEqual(manifestBytes,firstManifest);else firstManifest=manifestBytes;}
      const resolver=async(asset:DeepReadonly<AssetEntry>)=>{if(asset.source.kind==='inline')return Buffer.from(asset.source.data);
        const all=await readFile(join(out,asset.source.uri)),range=asset.source.byteRange;return range?all.subarray(range.offset,range.offset+range.length):all;};
      for(const asset of manifest.assets.entries){const payload=await resolver(asset);assert.equal(sha(payload),asset.sha256);assert.equal(payload.length,asset.byteLength);assert.deepEqual(payload,Buffer.from(bytes(curve())));assert.deepEqual(asset.bounds,curve().bounds);}
      const runtime=await prepareSceneAsync(manifest,{profile:NUMERIC_3D_PROFILE,assetResolver:resolver}),sync=prepareScene(authored),first=runtime.sample(.5);
      assert.strictEqual(first.resources.path,first.resources.alias);assert.equal(first.resources['generated-path'].kind,'curve3d');
      for(const t of [2,0,1,.5])assert.deepEqual(runtime.sample(t),sync.sample(t));runtime.dispose();assert.deepEqual(first,sync.sample(.5));
    }
  }finally{await rm(folder,{recursive:true,force:true});}
});

test('generated curve IDs cannot collide with assets/surfaces and never satisfy vector or mesh references',()=>{
  const full=generated(),{resources,...scene}=full,base:ScenePackage={contract:'texloom-package/1',scene,assets:{version:1,requiredFeatures:sceneFeatures(full),entries:[entry()]}};
  const assetCollision=structuredClone(base);assetCollision.scene.curves3d!.operations[0].resourceId='path';assert.ok(validateScenePackage(assetCollision).some(d=>d.code==='ASSET_DUPLICATE'));
  const generatedCollision=structuredClone(base);generatedCollision.scene.surfaces={version:1,operations:[{id:'plane',resourceId:'generated-path',units:'unit',domain:{u:[0,1],v:[0,1]},segments:{u:1,v:1},position:['u','v','0'],normals:{kind:'finite-difference'}}]};
  assert.ok(validateScenePackage(generatedCollision).some(d=>d.code==='ASSET_DUPLICATE'));
  const label=structuredClone(base);label.scene.space3d!.overlays=[{id:'bad-label',resourceId:'generated-path',position:[0,0,0]}];assert.ok(validateScenePackage(label).some(d=>d.code==='ASSET_REFERENCE'));
  const mesh=structuredClone(base);mesh.scene.space3d!.nodes[1]={id:'wrong',kind:'mesh',resourceId:'generated-path'};assert.ok(validateScenePackage(mesh).some(d=>d.code==='ASSET_KIND'));
});

test('curve leases share immutable resources while typed buffers and runtime lifetimes remain independent',async()=>{
  let calls=0;const store=createAssetStore({resolver:async()=>{calls++;return bytes(curve());}}),input=packaged(true);
  const [a,b]=await Promise.all([prepareSceneAsync(input,{assetStore:store,profile:NUMERIC_3D_PROFILE}),prepareSceneAsync(input,{assetStore:store,profile:NUMERIC_3D_PROFILE})]);
  assert.equal(calls,1);assert.equal(store.stats().leases,2);const one=a.sample(0).resources.path,two=b.sample(0).resources.path;assert.strictEqual(one,two);
  const left=copyCurve3DBuffers(one),right=copyCurve3DBuffers(two);left.positions[0]=999;assert.equal(right.positions[0],-1);assert.ok(Object.isFrozen(one));
  for(const t of [2,0,1])a.sample(t);assert.equal(calls,1);a.dispose();assert.equal(store.stats().leases,1);assert.equal(b.state,'ready');b.dispose();empty(store);store.dispose();
});

test('pending curve cancellation aborts only the final waiter and ignores late transport completion',async()=>{
  const gates=[deferred<Uint8Array>(),deferred<Uint8Array>()],signals:AbortSignal[]=[];let calls=0;
  const store=createAssetStore({resolver:async(_entry,{signal})=>{signals.push(signal);return gates[calls++].promise;}}),a=new AbortController(),b=new AbortController();
  const first=store.acquire(entry('a',true),a.signal),second=store.acquire(entry('b',true),b.signal);
  const rejectFirst=assert.rejects(first,errorCode('ASSET_ABORTED'));a.abort();await rejectFirst;assert.equal(signals[0].aborted,false);
  const rejectSecond=assert.rejects(second,errorCode('ASSET_ABORTED'));b.abort();await rejectSecond;assert.equal(signals[0].aborted,true);empty(store);
  const retry=store.acquire(entry('retry',true));gates[0].resolve(new Uint8Array([0]));await tick();assert.equal(store.stats().waiters,1);
  gates[1].resolve(bytes(curve()));const lease=await retry;assert.deepEqual(lease.resource,curve());store.dispose();empty(store);lease.release();
});

test('curve asset kinds, exact bounds and corrupt payloads fail independently without retained cache entries',async()=>{
  const source=bytes(curve()),corrupt=new Uint8Array(source);corrupt[0]^=1;
  const invalid=curve();invalid.positions.data.splice(3,3,...invalid.positions.data.slice(0,3));
  const cases:[AssetEntry,Uint8Array,string][]=[
    [entry('hash',true),corrupt,'ASSET_HASH'],[{...entry('bounds',true),bounds:{min:[-1,0,0],max:[1,2,0]}},source,'ASSET_BOUNDS'],
    [{...entry('kind',true),kind:'vector',bounds:[0,0,1,1]},source,'ASSET_KIND'],[entry('resource',true,invalid),bytes(invalid),'ASSET_RESOURCE']];
  for(const [asset,payload,code] of cases){const store=createAssetStore({resolver:async()=>payload});await assert.rejects(store.acquire(asset),errorCode(code));empty(store);store.dispose();}
  assert.ok(validateAssetEntry({...entry(),bounds:[0,0,1,1]}).some(d=>d.code==='ASSET_BOUNDS'));
});

test('2D profiles and missing/wrong 3D resource references reject before any transport',async()=>{
  let calls=0;const store=createAssetStore({resolver:async()=>{calls++;return bytes(curve());}});
  await assert.rejects(prepareSceneAsync(packaged(true),{assetStore:store,profile:SVG_2D_PROFILE}));assert.equal(calls,0);
  const missing=packaged(true);missing.assets.entries=[];
  const wrong=packaged(true);wrong.assets.entries[0]={...entry('path',true),kind:'vector',bounds:[0,0,1,1]};
  for(const value of [missing,wrong])await assert.rejects(prepareSceneAsync(value,{assetStore:store,profile:NUMERIC_3D_PROFILE}));
  assert.equal(calls,0);empty(store);store.dispose();
});
