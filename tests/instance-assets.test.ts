import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RESOURCE_MEDIA_TYPE,validateScenePackage,type ScenePackage,type AssetEntry} from '../src/resources/package.ts';
import {createAssetStore,type AssetStore} from '../src/resources/store.ts';
import {prepareScene,prepareSceneAsync} from '../src/runtime.ts';
import {NUMERIC_3D_PROFILE,SVG_2D_PROFILE,sceneFeatures} from '../src/capabilities.ts';
import {attachMeshAttributes,copyMeshAttribute} from '../src/ir/attributes.ts';
import {copyMeshBuffers,type MeshResource} from '../src/ir/mesh.ts';
import type {Bundle} from '../src/schema.ts';
import type {DeepReadonly} from '../src/ir/operations.ts';
// @ts-expect-error Production JavaScript CLI has no separate declaration.
import {packageScene} from '../tools/package-scene.mjs';

const prototype=()=>attachMeshAttributes({kind:'mesh',version:1,primitive:'triangles',units:'unit',coordinateSpace:'object',winding:'ccw',topologyRevision:'arrow',
  positions:{version:1,componentType:'float64',components:3,count:3,byteOffset:0,byteStride:24,data:[0,0,0,1,0,0,0,1,0]},indices:{version:1,componentType:'uint16',components:1,count:3,byteOffset:0,byteStride:2,data:[0,1,2]},bounds:{min:[0,0,0],max:[1,1,0]}},
  {height:{domain:'vertex',valueType:'scalar',buffer:{version:1,componentType:'float64',components:1,count:3,byteOffset:0,byteStride:8,data:[0,1,2]}}});
const bytes=(x:unknown)=>Buffer.from(JSON.stringify(x)+'\n');
const sha=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
function entry(id:string,external=false,resource=prototype()):AssetEntry{const payload=bytes(resource);return {id,kind:'mesh',mediaType:RESOURCE_MEDIA_TYPE,byteLength:payload.length,sha256:sha(payload),bounds:structuredClone(resource.bounds) as MeshResource['bounds'],source:external?{kind:'external',uri:`assets/${id}.json`}:{kind:'inline',data:payload.toString()}};}
function bundle():Bundle{return {version:'0.3',units:'bp',title:'Instances package',duration:2,viewport:{width:100,height:60},camera:{x:0,y:0,zoom:1},nodes:[],tracks:[],relations:[],resources:{prototype:structuredClone(prototype()) as MeshResource},
  instances:{version:1,operations:[{id:'arrows',prototype:'prototype',units:'unit',seed:34,source:{kind:'mesh',resourceId:'prototype',domain:'vertex'},color:['rand','rand1','rand2'],realize:{resourceId:'baked',normalPolicy:'drop',instanceColorAttribute:'instanceColor'}}]},
  space3d:{version:1,units:'unit',handedness:'right',upAxis:'z',nodes:[{id:'batch',kind:'instances',instanceSetId:'arrows'},{id:'expanded',kind:'mesh',resourceId:'baked'}]}};}
function packaged(external=false,full=bundle()):ScenePackage{const {resources,...scene}=full;return {contract:'texloom-package/1',scene,assets:{version:1,requiredFeatures:sceneFeatures(full),entries:Object.keys(resources).map(id=>entry(id,external,resources[id] as DeepReadonly<MeshResource>))}};}
function empty(store:AssetStore){for(const key of ['entries','waiters','leases','reservedBytes'] as const)assert.equal(store.stats()[key],0);}

test('instance programs preserve shared prototypes and generated realizations in all three package delivery modes',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'texloom-instance-assets-'));
  try{
    const authored=bundle(),input=join(folder,'bundle.json');await writeFile(input,JSON.stringify(authored));
    for(const mode of ['external','inline','packed']){
      const out=join(folder,mode),report=await packageScene(input,out,{mode});assert.equal(report.entries,1);
      const manifest=JSON.parse(await readFile(join(out,'scene.json'),'utf8')) as ScenePackage;
      assert.deepEqual(manifest.assets.entries.map(e=>e.id),['prototype']);assert.deepEqual(validateScenePackage(manifest),[]);
      let calls=0;const resolver=async(e:DeepReadonly<AssetEntry>)=>{calls++;assert.equal(e.id,'prototype');assert.equal(e.source.kind,'external');if(e.source.kind!=='external')throw Error('inline');const all=await readFile(join(out,e.source.uri)),range=e.source.byteRange;const payload=range?all.subarray(range.offset,range.offset+range.length):all;assert.equal(sha(payload),e.sha256);return payload;};
      const asyncRuntime=await prepareSceneAsync(manifest,{profile:NUMERIC_3D_PROFILE,assetResolver:resolver}),sync=prepareScene(authored);
      for(const time of [0,2,.5,0])assert.deepEqual(asyncRuntime.sample(time),sync.sample(time));
      const frame=asyncRuntime.sample(1),set=frame.instanceSets!.arrows;assert.equal(set.prototypeResourceId,'prototype');assert.equal(set.instances.length,3);assert.ok(Object.isFrozen(set.instances[0].color));
      const realized=frame.resources.baked as DeepReadonly<MeshResource>;assert.equal(realized.positions.count,9);assert.deepEqual([...copyMeshAttribute(realized,'height')],[0,1,2,0,1,2,0,1,2]);
      const local=copyMeshBuffers(realized);local.positions.fill(77);assert.notEqual(copyMeshBuffers(realized).positions[0],77);
      assert.equal(calls,mode==='inline'?0:1);asyncRuntime.dispose();
    }
  }finally{await rm(folder,{recursive:true,force:true});}
});

test('generated surfaces and captured meshes may supply instance positions without generated transport payloads',async()=>{
  const authored=bundle();authored.surfaces={version:1,operations:[{id:'surface',resourceId:'grid',units:'unit',domain:{u:[0,1],v:[0,1]},segments:{u:1,v:1},position:['u','v','0'],normals:{kind:'finite-difference'}}]};
  authored.meshAttributes={version:1,operations:[{id:'capture',source:'grid',resourceId:'captured',units:'unit',steps:[{kind:'capture',name:'height',domain:'vertex',valueType:'scalar',expression:'z'}]}]};
  authored.instances!.operations[0].source={kind:'mesh',resourceId:'captured',domain:'vertex'};
  const manifest=packaged(false,authored);assert.deepEqual(validateScenePackage(manifest),[]);
  const runtime=await prepareSceneAsync(manifest,{profile:NUMERIC_3D_PROFILE});assert.equal(runtime.sample(0).instanceSets!.arrows.instances.length,4);runtime.dispose();
});

test('earlier realized meshes are valid later prototypes and sampled sources, never phantom manifest entries',async()=>{
  const authored=bundle();authored.instances!.operations.push({id:'later',prototype:'baked',units:'unit',seed:5,source:{kind:'mesh',resourceId:'baked',domain:'face'},realize:{resourceId:'baked-again',normalPolicy:'drop'}});
  authored.space3d!.nodes.push({id:'later-batch',kind:'instances',instanceSetId:'later'},{id:'later-expanded',kind:'mesh',resourceId:'baked-again'});
  const manifest=packaged(false,authored);assert.deepEqual(validateScenePackage(manifest),[]);assert.equal(manifest.assets.entries.length,1);
  const runtime=await prepareSceneAsync(manifest,{profile:NUMERIC_3D_PROFILE}),frame=runtime.sample(0);
  assert.equal(frame.instanceSets!.later.instances.length,3);assert.equal((frame.resources['baked-again'] as MeshResource).positions.count,27);runtime.dispose();
});

test('package instance references reject missing, wrong-kind, forward and colliding dependencies before I/O',async()=>{
  const original=packaged(true),cases:[ScenePackage,string][]=[];
  const add=(change:(x:ScenePackage)=>void,code:string)=>{const x=structuredClone(original);change(x);cases.push([x,code]);};
  add(x=>x.scene.instances!.operations[0].prototype='unknown','ASSET_REFERENCE');
  add(x=>x.scene.instances!.operations[0].source={kind:'mesh',resourceId:'baked',domain:'vertex'},'ASSET_REFERENCE');
  add(x=>x.scene.instances!.operations[0].prototype='baked','ASSET_REFERENCE');
  add(x=>x.scene.instances!.operations[0].realize!.resourceId='prototype','ASSET_DUPLICATE');
  add(x=>x.scene.instances!.operations.push({...structuredClone(x.scene.instances!.operations[0]),id:'other'}),'ASSET_DUPLICATE');
  add(x=>x.scene.instances!.operations.push({...structuredClone(x.scene.instances!.operations[0]),realize:undefined} as any),'ASSET_JSON_VALUE');
  add(x=>{const next=structuredClone(x.scene.instances!.operations[0]);delete next.realize;x.scene.instances!.operations.push(next);},'ASSET_DUPLICATE');
  add(x=>{x.assets.entries[0]={...x.assets.entries[0],kind:'vector',bounds:[0,0,1,1]};},'ASSET_KIND');
  add(x=>{(x.scene.space3d!.nodes[0] as any).instanceSetId={toString:0,valueOf:0};},'ASSET_REFERENCE');
  add(x=>{(x.scene.instances!.operations[0] as any).prototype={toString:0,valueOf:0};},'ASSET_GENERATOR');
  add(x=>{x.scene.instances!.operations[0].source={kind:'mesh',resourceId:'future',domain:'vertex'};x.scene.instances!.operations.push({...structuredClone(x.scene.instances!.operations[0]),id:'future-set',source:{kind:'points',points:[]},realize:{resourceId:'future',normalPolicy:'drop'}});},'ASSET_REFERENCE');
  let calls=0;const store=createAssetStore({resolver:async()=>{calls++;return bytes(prototype());}});
  for(const [input,expected] of cases){assert.ok(validateScenePackage(input).some(d=>d.code===expected),expected);await assert.rejects(prepareSceneAsync(input,{assetStore:store,profile:NUMERIC_3D_PROFILE}));}
  assert.equal(calls,0);empty(store);store.dispose();
});

test('shared prototype leases survive one preparation cancellation and independent disposal',async()=>{
  let finish!:(b:Uint8Array)=>void,calls=0;const pending=new Promise<Uint8Array>(resolve=>finish=resolve),store=createAssetStore({resolver:async()=>{calls++;return pending;}}),controller=new AbortController();
  const first=prepareSceneAsync(packaged(true),{assetStore:store,profile:NUMERIC_3D_PROFILE,signal:controller.signal});
  const second=prepareSceneAsync(packaged(true),{assetStore:store,profile:NUMERIC_3D_PROFILE});
  await new Promise(resolve=>setTimeout(resolve,0));controller.abort();await assert.rejects(first);finish(bytes(prototype()));
  const live=await second;assert.equal(calls,1);const frame=live.sample(0);assert.equal(store.stats().leases,1);assert.ok(Object.isFrozen(frame.resources.prototype));
  const third=await prepareSceneAsync(packaged(true),{assetStore:store,profile:NUMERIC_3D_PROFILE});assert.strictEqual(third.sample(0).resources.prototype,frame.resources.prototype);
  live.dispose();assert.equal(store.stats().leases,1);third.sample(1);assert.equal(calls,1);third.dispose();empty(store);store.dispose();
});

test('unsupported 2D profiles reject instance features before fetching a prototype',async()=>{
  const manifest=packaged(true);assert.ok(manifest.assets.requiredFeatures.includes('instance.mesh.3d'));assert.ok(manifest.assets.requiredFeatures.includes('instance.realize.3d'));
  let calls=0;const store=createAssetStore({resolver:async()=>{calls++;return bytes(prototype());}});
  await assert.rejects(prepareSceneAsync(manifest,{assetStore:store,profile:SVG_2D_PROFILE}));assert.equal(calls,0);empty(store);store.dispose();
});
