import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AssetError,RESOURCE_MEDIA_TYPE,validateScenePackage,type AssetEntry,type ScenePackage} from '../src/resources/package.ts';
import {createAssetStore,type AssetStore} from '../src/resources/store.ts';
import {attachMeshAttributes,copyMeshAttribute} from '../src/ir/attributes.ts';
import {copyMeshBuffers,type MeshResource} from '../src/ir/mesh.ts';
import {prepareScene,prepareSceneAsync} from '../src/runtime.ts';
import {NUMERIC_3D_PROFILE,SVG_2D_PROFILE,sceneFeatures} from '../src/capabilities.ts';
import type {Bundle} from '../src/schema.ts';
import type {DeepReadonly} from '../src/ir/operations.ts';
// @ts-expect-error Production JavaScript package CLI has no declaration file.
import {packageScene} from '../tools/package-scene.mjs';

const mesh=():MeshResource=>({kind:'mesh',version:1,primitive:'triangles',units:'unit',coordinateSpace:'object',winding:'ccw',topologyRevision:'attributes-v1',
  positions:{version:1,componentType:'float64',components:3,count:4,byteOffset:0,byteStride:24,data:[0,0,0,1,0,0,0,1,0,1,1,0]},
  indices:{version:1,componentType:'uint16',components:1,count:6,byteOffset:0,byteStride:2,data:[0,1,2,1,3,2]},bounds:{min:[0,0,0],max:[1,1,0]}});
const attributed=()=>attachMeshAttributes(mesh(),{
  height:{domain:'vertex',valueType:'scalar',buffer:{version:1,componentType:'float64',components:1,count:4,byteOffset:0,byteStride:8,data:[0,1,2,3]}},
  uv:{domain:'corner',valueType:'vec2',buffer:{version:1,componentType:'float32',components:2,count:6,byteOffset:0,byteStride:8,data:[0,0,1,0,0,1,0,0,1,1,0,1]}},
});
const bytes=(value:unknown)=>new TextEncoder().encode(JSON.stringify(value)+'\n');
const sha=(value:Uint8Array)=>createHash('sha256').update(value).digest('hex');
function entry(id='base',external=false,resource=attributed()):Extract<AssetEntry,{kind:'mesh'}>{const data=bytes(resource);return {id,kind:'mesh',mediaType:RESOURCE_MEDIA_TYPE,byteLength:data.length,sha256:sha(data),bounds:structuredClone(resource.bounds) as MeshResource['bounds'],source:external?{kind:'external',uri:`assets/${id}.json`}:{kind:'inline',data:new TextDecoder().decode(data)}};}
const bundle=():Bundle=>({version:'0.3',units:'bp',title:'Attributes package',duration:2,viewport:{width:100,height:60},camera:{x:0,y:0,zoom:1},nodes:[],tracks:[],relations:[],resources:{base:structuredClone(attributed()) as MeshResource},
  space3d:{version:1,units:'unit',handedness:'right',upAxis:'z',nodes:[{id:'source',kind:'mesh',resourceId:'base'}]}});
function generated():Bundle{
  const b=bundle();b.meshAttributes={version:1,operations:[
    {id:'capture',source:'base',resourceId:'captured',units:'unit',steps:[{kind:'capture',name:'originalPosition',domain:'vertex',valueType:'vec3',expression:['x','y','z']}]},
    {id:'mean',source:'captured',resourceId:'face-values',units:'unit',steps:[{kind:'transfer',source:'height',name:'meanHeight',domain:'face',method:'mean'}]},
  ]};b.space3d!.nodes.push({id:'result',kind:'mesh',resourceId:'face-values'});return b;
}
function packaged(external=false,full=bundle()):ScenePackage{const {resources,...scene}=full;return {contract:'texloom-package/1',scene,assets:{version:1,requiredFeatures:sceneFeatures(full),entries:Object.keys(resources).map(id=>entry(id,external,resources[id] as DeepReadonly<MeshResource>))}};}
const empty=(store:AssetStore)=>{for(const key of ['entries','waiters','leases','reservedBytes'] as const)assert.equal(store.stats()[key],0);};

test('attributed mesh payloads preserve exact topology and bytes through inline/external/packed packaging',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'texloom-attributed-assets-'));
  try{
    const authored=bundle();authored.resources.alias=structuredClone(authored.resources.base);const input=join(folder,'bundle.json');await writeFile(input,JSON.stringify(authored));
    let first:Buffer|undefined;
    for(const mode of ['external','inline','packed','external']){
      const out=join(folder,mode),report=await packageScene(input,out,{mode});assert.equal(report.entries,2);assert.equal(report.uniquePayloads,1);
      const contents=await readFile(join(out,'scene.json')),manifest=JSON.parse(contents.toString()) as ScenePackage;assert.deepEqual(validateScenePackage(manifest),[]);
      if(mode==='external'){if(first)assert.deepEqual(contents,first);else first=contents;}
      const resolver=async(e:DeepReadonly<AssetEntry>)=>{if(e.source.kind==='inline')return Buffer.from(e.source.data);const data=await readFile(join(out,e.source.uri)),range=e.source.byteRange;return range?data.subarray(range.offset,range.offset+range.length):data;};
      for(const e of manifest.assets.entries){const data=await resolver(e);assert.equal(sha(data),e.sha256);assert.equal(data.length,e.byteLength);assert.deepEqual(data,Buffer.from(bytes(attributed())));}
      const runtime=await prepareSceneAsync(manifest,{assetResolver:resolver,profile:NUMERIC_3D_PROFILE}),frame=runtime.sample(1);
      assert.strictEqual(frame.resources.base,frame.resources.alias);assert.deepEqual(frame.resources.base,attributed());
      const source=frame.resources.base as DeepReadonly<MeshResource>;assert.ok(Object.isFrozen(source.attributes!.topology.indices));
      const a=copyMeshBuffers(source),b=copyMeshBuffers(source);a.attributes!.height.values[0]=999;a.attributes!.uv.values[0]=.5;
      assert.equal(b.attributes!.height.values[0],0);assert.equal(b.attributes!.uv.values[0],0);runtime.dispose();assert.deepEqual(source,attributed());
    }
  }finally{await rm(folder,{recursive:true,force:true});}
});

test('ordered mesh attribute programs package without generated transport entries and hydrate deterministically',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'texloom-attribute-program-assets-'));
  try{
    const authored=generated(),input=join(folder,'bundle.json');await writeFile(input,JSON.stringify(authored));
    for(const mode of ['external','inline','packed']){
      const out=join(folder,mode),report=await packageScene(input,out,{mode});assert.equal(report.entries,1);
      const manifest=JSON.parse(await readFile(join(out,'scene.json'),'utf8')) as ScenePackage;assert.deepEqual(manifest.scene.meshAttributes,authored.meshAttributes);
      assert.deepEqual(manifest.assets.entries.map(e=>e.id),['base']);assert.deepEqual(validateScenePackage(manifest),[]);
      let calls=0;const resolver=async(e:DeepReadonly<AssetEntry>)=>{calls++;assert.equal(e.id,'base');if(e.source.kind==='inline')throw Error('Inline handled by store');const data=await readFile(join(out,e.source.uri)),r=e.source.byteRange;return r?data.subarray(r.offset,r.offset+r.length):data;};
      const runtime=await prepareSceneAsync(manifest,{profile:NUMERIC_3D_PROFILE,assetResolver:resolver}),sync=prepareScene(authored);
      for(const time of [1.5,0,2,1.5])assert.deepEqual(runtime.sample(time),sync.sample(time));
      const result=runtime.sample(0).resources['face-values'] as DeepReadonly<MeshResource>;
      assert.deepEqual([...copyMeshAttribute(result,'meanHeight')],[1,2]);assert.deepEqual(result.attributes!.topology,attributed().attributes!.topology);
      assert.equal(calls,mode==='inline'?0:1);runtime.dispose();
    }
  }finally{await rm(folder,{recursive:true,force:true});}
});

test('attribute generators may consume generated surfaces without introducing any transport asset',async()=>{
  const authored=generated();authored.resources={};authored.surfaces={version:1,operations:[{id:'plane',resourceId:'base',units:'unit',domain:{u:[0,1],v:[0,1]},segments:{u:2,v:2},position:['u','v','0'],normals:{kind:'finite-difference'}}]};
  authored.meshAttributes!.operations=[{id:'capture',source:'base',resourceId:'face-values',units:'unit',steps:[{kind:'capture',name:'position',domain:'vertex',valueType:'vec3',expression:['x','y','z']}]}];
  const data=packaged(false,authored);assert.deepEqual(validateScenePackage(data),[]);assert.equal(data.assets.entries.length,0);
  let calls=0;const runtime=await prepareSceneAsync(data,{profile:NUMERIC_3D_PROFILE,assetResolver:async()=>{calls++;throw Error('No assets');}});
  assert.equal(calls,0);assert.equal(runtime.sample(0).resources['face-values'].kind,'mesh');runtime.dispose();
});

test('colliding outputs and missing, forward, cyclic or wrong-kind sources fail before asset I/O',async()=>{
  const base=packaged(true,generated()),cases:[ScenePackage,string][]=[];
  const change=(fn:(x:ScenePackage)=>void,code:string)=>{const copy=structuredClone(base);fn(copy);cases.push([copy,code]);};
  change(x=>x.scene.meshAttributes!.operations[0].resourceId='base','ASSET_DUPLICATE');
  change(x=>x.scene.meshAttributes!.operations[1].resourceId='captured','ASSET_DUPLICATE');
  change(x=>x.scene.meshAttributes!.operations[0].source='face-values','ASSET_REFERENCE');
  change(x=>x.scene.meshAttributes!.operations[0].source='missing','ASSET_REFERENCE');
  change(x=>{x.scene.meshAttributes!.operations[0].source='face-values';x.scene.meshAttributes!.operations[1].source='captured';},'ASSET_REFERENCE');
  change(x=>{x.assets.entries[0]={...entry('base',true),kind:'vector',bounds:[0,0,1,1]};},'ASSET_KIND');
  change(x=>{x.scene.curves3d={version:1,operations:[{id:'curve',resourceId:'line',units:'unit',domain:[0,1],segments:4,position:['u','0','0'],frame:{seed:{kind:'up',up:[0,1,0]}}}],followers:[]};x.scene.meshAttributes!.operations[0].source='line';},'ASSET_KIND');
  change(x=>{x.scene.surfaces={version:1,operations:[{id:'surface',resourceId:'captured',units:'unit',domain:{u:[0,1],v:[0,1]},segments:{u:1,v:1},position:['u','v','0'],normals:{kind:'finite-difference'}}]};},'ASSET_DUPLICATE');
  change(x=>{(x.scene.meshAttributes!.operations[0] as any).source={toString:0,valueOf:0};},'ASSET_GENERATOR');
  let calls=0;const store=createAssetStore({resolver:async()=>{calls++;return bytes(attributed());}});
  for(const [input,code] of cases){assert.ok(validateScenePackage(input).some(d=>d.code===code),code);await assert.rejects(prepareSceneAsync(input,{profile:NUMERIC_3D_PROFILE,assetStore:store}));}
  assert.equal(calls,0);empty(store);store.dispose();
});

test('shared attributed resources retain exact captures across independent runtime disposal',async()=>{
  let calls=0;const store=createAssetStore({resolver:async()=>{calls++;return bytes(attributed());}});
  const [a,b]=await Promise.all([prepareSceneAsync(packaged(true),{profile:NUMERIC_3D_PROFILE,assetStore:store}),prepareSceneAsync(packaged(true),{profile:NUMERIC_3D_PROFILE,assetStore:store})]);
  assert.equal(calls,1);const one=a.sample(0).resources.base,two=b.sample(0).resources.base;assert.strictEqual(one,two);
  const mutable=copyMeshAttribute(one as DeepReadonly<MeshResource>,'height');mutable.fill(99);
  assert.deepEqual([...copyMeshAttribute(two as DeepReadonly<MeshResource>,'height')],[0,1,2,3]);a.dispose();assert.equal(store.stats().leases,1);
  b.sample(1);assert.equal(calls,1);b.dispose();empty(store);store.dispose();
});

test('valid-hash payload topology mismatch and incompatible profiles cannot publish cached attributed data',async()=>{
  const malformed=structuredClone(attributed()) as MeshResource;malformed.attributes!.topology.indices=[0,2,1,1,3,2];
  const store=createAssetStore({resolver:async()=>bytes(malformed)});await assert.rejects(store.acquire(entry('bad',true,malformed)),(e:any)=>e instanceof AssetError&&e.code==='ASSET_RESOURCE'&&e.diagnostics.some(d=>d.code==='ATTRIBUTE_TOPOLOGY'));
  empty(store);store.dispose();let calls=0;const untouched=createAssetStore({resolver:async()=>{calls++;return bytes(attributed());}});
  await assert.rejects(prepareSceneAsync(packaged(true,generated()),{profile:SVG_2D_PROFILE,assetStore:untouched}));assert.equal(calls,0);empty(untouched);untouched.dispose();
  const badRef=packaged();badRef.scene.nodes=[{id:'bad',kind:'tex',resourceId:{toString:0,valueOf:0}} as any];assert.doesNotThrow(()=>validateScenePackage(badRef));assert.ok(validateScenePackage(badRef).some(d=>d.code==='ASSET_REFERENCE'));
});
