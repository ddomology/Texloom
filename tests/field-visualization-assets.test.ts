import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RESOURCE_MEDIA_TYPE,validateScenePackage,type ScenePackage,type AssetEntry} from '../src/resources/package.ts';
import {createAssetStore} from '../src/resources/store.ts';
import {prepareScene,prepareSceneAsync} from '../src/runtime.ts';
import {NUMERIC_3D_PROFILE,SVG_2D_PROFILE,sceneFeatures} from '../src/capabilities.ts';
import type {Bundle} from '../src/schema.ts';
import type {MeshResource} from '../src/ir/mesh.ts';
// @ts-expect-error JavaScript packaging CLI has no declaration.
import {packageScene} from '../tools/package-scene.mjs';

const mesh:MeshResource={kind:'mesh',version:1,primitive:'triangles',units:'unit',coordinateSpace:'object',winding:'ccw',topologyRevision:'source-triangle',
 positions:{version:1,componentType:'float64',components:3,count:3,byteOffset:0,byteStride:24,data:[0,0,0,1,0,0,0,1,0]},
 normals:{version:1,componentType:'float64',components:3,count:3,byteOffset:0,byteStride:24,data:[0,0,1,0,0,1,0,0,1]},
 indices:{version:1,componentType:'uint16',components:1,count:3,byteOffset:0,byteStride:2,data:[0,1,2]},bounds:{min:[0,0,0],max:[1,1,0]}};
const bytes=(x:unknown)=>Buffer.from(JSON.stringify(x)+'\n');
function bundle():Bundle{return {version:'0.3',title:'Portable visual fields',units:'bp',duration:2,viewport:{width:100,height:60},camera:{x:0,y:0,zoom:1},nodes:[],tracks:[],relations:[],resources:{source:structuredClone(mesh)},
 expressions:{version:1,parameters:{gain:{type:'scalar',unit:'1',default:.5,min:0,max:1}},bindings:[]},
 fieldVisualization:{version:1,operations:[{id:'field',source:'source',resourceId:'display',units:'unit',scalar:'x + time / 2s',vector:['1','0','0'],invalidPolicy:'error',
  color:{attribute:'fieldColor',stops:[{position:0,color:[0,0,1]},{position:1,color:[1,0,0]}],range:{mode:'fixed',min:0,max:2},outOfRange:'clamp',invalidColor:[.2,.2,.2]},
  displacement:{amplitude:'gain',normalPolicy:'drop',degenerateNormalPolicy:'error'},
  arrows:{instanceSetId:'arrows',prototype:'source',up:[0,0,1],lengthScale:'0.1',zeroPolicy:'hide'}}]},
 space3d:{version:1,units:'unit',handedness:'right',upAxis:'z',nodes:[{id:'display',kind:'mesh',resourceId:'display',material:{kind:'unlit',color:'#ffffff',colorAttribute:'fieldColor'}},{id:'arrows',kind:'instances',instanceSetId:'arrows'}]}};}
function packaged(external=false,full=bundle()):ScenePackage{const {resources,...scene}=full;return {contract:'texloom-package/1',scene,assets:{version:1,requiredFeatures:sceneFeatures(full),entries:Object.entries(resources).map(([id,value])=>{
 const payload=bytes(value);return {id,kind:'mesh',mediaType:RESOURCE_MEDIA_TYPE,byteLength:payload.length,sha256:createHash('sha256').update(payload).digest('hex'),bounds:(value as MeshResource).bounds,
  source:external?{kind:'external',uri:`assets/${id}.json`}:{kind:'inline',data:payload.toString()}} as AssetEntry;})}};}

test('field values, meshes and arrow sets round-trip through inline, external and packed transport',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'texloom-field-assets-'));
 try{const full=bundle(),input=join(folder,'bundle.json');await writeFile(input,JSON.stringify(full));
  for(const mode of ['inline','external','packed']){
   const out=join(folder,mode);await packageScene(input,out,{mode});const manifest=JSON.parse(await readFile(join(out,'scene.json'),'utf8')) as ScenePackage;
   assert.deepEqual(manifest.assets.entries.map(e=>e.id),['source']);assert.deepEqual(validateScenePackage(manifest),[]);
   let calls=0;const runtime=await prepareSceneAsync(manifest,{profile:NUMERIC_3D_PROFILE,assetResolver:async e=>{
    calls++;if(e.source.kind!=='external')throw Error('Expected transport input');const raw=await readFile(join(out,e.source.uri)),range=e.source.byteRange;return range?raw.subarray(range.offset,range.offset+range.length):raw;
   }}),sync=prepareScene(full);
   for(const t of [0,2,.5,0])assert.deepEqual(runtime.sample(t,{gain:.25}),sync.sample(t,{gain:.25}));
   assert.deepEqual(runtime.sample(1).fieldVisualization!.field.range,{min:0,max:2});
   assert.equal(runtime.sample(1).instanceSets!.arrows.instances.length,3);assert.equal(calls,mode==='inline'?0:1);runtime.dispose();
  }
 }finally{await rm(folder,{recursive:true,force:true});}
});

test('field outputs can feed later fields and ordinary instances without becoming transport assets',async()=>{
 const full=bundle();full.fieldVisualization!.operations.push({id:'second',source:'display',resourceId:'display-two',units:'unit',scalar:'z',invalidPolicy:'error'});
 full.instances={version:1,operations:[{id:'generic',prototype:'display-two',units:'unit',seed:35,source:{kind:'mesh',resourceId:'display',domain:'vertex'}}]};
 full.space3d!.nodes.push({id:'second',kind:'mesh',resourceId:'display-two'},{id:'generic',kind:'instances',instanceSetId:'generic'});
 const manifest=packaged(false,full);assert.deepEqual(validateScenePackage(manifest),[]);
 const runtime=await prepareSceneAsync(manifest,{profile:NUMERIC_3D_PROFILE}),frame=runtime.sample(0);
 assert.deepEqual(Object.keys(frame.instanceSets!).sort(),['arrows','generic']);assert.deepEqual(frame.fieldVisualization!.second.scalar,[0,.5,0]);runtime.dispose();
});

test('field dependencies reject missing, wrong-kind, forward, cyclic and colliding references before I/O',async()=>{
 const original=packaged(true),cases:[ScenePackage,string][]=[];
 const add=(change:(x:ScenePackage)=>void,code:string)=>{const value=structuredClone(original);change(value);cases.push([value,code]);};
 add(x=>x.scene.fieldVisualization!.operations[0].source='missing','ASSET_REFERENCE');
 add(x=>x.scene.fieldVisualization!.operations[0].source='display','ASSET_REFERENCE');
 add(x=>x.scene.fieldVisualization!.operations[0].arrows!.prototype='display','ASSET_REFERENCE');
 add(x=>x.scene.fieldVisualization!.operations[0].resourceId='source','ASSET_DUPLICATE');
 add(x=>x.scene.fieldVisualization!.operations.push({...structuredClone(x.scene.fieldVisualization!.operations[0]),resourceId:'later'}),'ASSET_DUPLICATE');
 add(x=>{x.scene.fieldVisualization!.operations[0].source='later';x.scene.fieldVisualization!.operations.push({id:'later',source:'source',resourceId:'later',units:'unit',scalar:'x',invalidPolicy:'error'});},'ASSET_REFERENCE');
 add(x=>{x.assets.entries[0]={...x.assets.entries[0],kind:'vector',bounds:[0,0,1,1]};},'ASSET_KIND');
 add(x=>{x.scene.instances={version:1,operations:[{id:'arrows',prototype:'source',units:'unit',seed:0,source:{kind:'points',points:[]}}]};},'ASSET_DUPLICATE');
 add(x=>{(x.scene.fieldVisualization!.operations[0] as any).source={toString:0};},'ASSET_GENERATOR');
 let calls=0;const store=createAssetStore({resolver:async()=>{calls++;return bytes(mesh);}});
 try{for(const [value,code] of cases){assert.ok(validateScenePackage(value).some(d=>d.code===code),code);await assert.rejects(prepareSceneAsync(value,{assetStore:store,profile:NUMERIC_3D_PROFILE}));}assert.equal(calls,0);assert.equal(store.stats().leases,0);}finally{store.dispose();}
});

test('a 2D consumer rejects visualization capabilities before fetching source geometry',async()=>{
 let calls=0;const store=createAssetStore({resolver:async()=>{calls++;return bytes(mesh);}});
 try{await assert.rejects(prepareSceneAsync(packaged(true),{assetStore:store,profile:SVG_2D_PROFILE}));assert.equal(calls,0);assert.equal(store.stats().reservedBytes,0);}finally{store.dispose();}
});
