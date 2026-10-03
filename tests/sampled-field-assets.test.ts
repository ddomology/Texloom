import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RESOURCE_MEDIA_TYPE,validateScenePackage,type ScenePackage,type AssetEntry} from '../src/resources/package.ts';
import {prepareScene,prepareSceneAsync} from '../src/runtime.ts';
import {NUMERIC_3D_PROFILE,SVG_2D_PROFILE,sceneFeatures} from '../src/capabilities.ts';
import type {Bundle} from '../src/schema.ts';
import type {MeshResource} from '../src/ir/mesh.ts';
import type {BakeManifest} from '../src/resources/bake.ts';
// @ts-expect-error JavaScript CLI does not publish declarations.
import {packageScene} from '../tools/package-scene.mjs';

const mesh:MeshResource={kind:'mesh',version:1,primitive:'triangles',units:'unit',coordinateSpace:'object',winding:'ccw',topologyRevision:'sample-triangle',
 positions:{version:1,componentType:'float64',components:3,count:3,byteOffset:0,byteStride:24,data:[0,0,0,1,0,0,0,1,0]},
 normals:{version:1,componentType:'float64',components:3,count:3,byteOffset:0,byteStride:24,data:[0,0,1,0,0,1,0,0,1]},
 indices:{version:1,componentType:'uint16',components:1,count:3,byteOffset:0,byteStride:2,data:[0,1,2]},bounds:{min:[0,0,0],max:[1,1,0]}};
function baked():BakeManifest{
 const times=[0,.75,2],channels:BakeManifest['channels']=[
  {id:'temperature',kind:'scalar',componentType:'float64',unit:'K'},
  {id:'flow',kind:'vector',componentType:'float64',unit:'unit/s'},
  {id:'absolute',kind:'position',componentType:'float64',unit:'unit'}];
 return {version:1,units:'unit',timeUnit:'s',topology:{revision:'sample-triangle',vertexCount:3,indices:[0,1,2]},sampleTimes:times,interpolation:'linear',outside:'clamp',seed:36,
  solver:{name:'independent-linear-fixture',version:'1',parameters:{reference:'analytic affine samples'}},channels,
  chunks:[[0,1],[1,2]].map(([startSample,sampleCount],index)=>{
   const values=times.slice(startSample,startSample+sampleCount).flatMap(t=>[t,t+1,t+2,...Array.from({length:3},()=>[1+t,0,0]).flat(),0,0,t,1,0,t,0,1,t]);
   const bytes=Buffer.alloc(values.length*8);values.forEach((value,i)=>bytes.writeDoubleLE(value,i*8));
   return {id:`chunk-${index}`,startSample,sampleCount,byteLength:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),source:{kind:'inline' as const,data:bytes.toString('base64')}};
  })};
}
function bundle():Bundle{return {version:'0.3',title:'Temporal transport',units:'bp',duration:2,viewport:{width:100,height:60},camera:{x:0,y:0,zoom:1},nodes:[],tracks:[],relations:[],resources:{source:structuredClone(mesh)},
 bakes:{motion:baked()},sampledFields:{version:1,operations:[{id:'samples',source:'source',resourceId:'state',bake:'motion',units:'unit',attributes:[{channel:'temperature',name:'temperature'},{channel:'flow',name:'flow'}],position:{channel:'absolute',normalPolicy:'recompute',degenerateNormalPolicy:'error'}}]},
 fieldVisualization:{version:1,operations:[{id:'color',source:'state',resourceId:'display',units:'unit',scalar:{attribute:'temperature'},vector:{attribute:'flow'},invalidPolicy:'error',
  color:{attribute:'fieldColor',stops:[{position:0,color:[0,0,1]},{position:1,color:[1,0,0]}],range:{mode:'fixed',min:0,max:4},outOfRange:'clamp',invalidColor:[.2,.2,.2]}}]},
 space3d:{version:1,units:'unit',handedness:'right',upAxis:'z',nodes:[{id:'surface',kind:'mesh',resourceId:'display',material:{kind:'unlit',color:'#ffffff',colorAttribute:'fieldColor'}}]}};}
function packaged(full=bundle()):ScenePackage{
 const {resources,...scene}=structuredClone(full);
 return {contract:'texloom-package/1',scene,assets:{version:1,requiredFeatures:sceneFeatures(full),entries:Object.entries(resources).map(([id,value])=>{
  const bytes=Buffer.from(JSON.stringify(value));return {id,kind:'mesh',mediaType:RESOURCE_MEDIA_TYPE,byteLength:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),bounds:(value as MeshResource).bounds,source:{kind:'external',uri:`assets/${id}.json`}} as AssetEntry;
 })}};
}

test('temporal channels retain frame semantics through all resource packaging modes',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'texloom-sample-assets-'));
 try {const full=bundle(),input=join(folder,'bundle.json');await writeFile(input,JSON.stringify(full));
  const reference=prepareScene(full);
  for(const mode of ['inline','external','packed']){
   const directory=join(folder,mode);await packageScene(input,directory,{mode});const manifest=JSON.parse(await readFile(join(directory,'scene.json'),'utf8')) as ScenePackage;
   assert.deepEqual(manifest.assets.entries.map(e=>e.id),['source']);assert.deepEqual(validateScenePackage(manifest),[]);
   let chunkReads=0;
   const runtime=await prepareSceneAsync(manifest,{profile:NUMERIC_3D_PROFILE,assetResolver:async entry=>{
    assert.equal(entry.source.kind,'external');if(entry.source.kind!=='external')throw Error();
    const raw=await readFile(join(directory,entry.source.uri)),r=entry.source.byteRange;return r?raw.subarray(r.offset,r.offset+r.length):raw;
   },bakeResolver:async chunk=>{
    chunkReads++;assert.equal(chunk.source.kind,'external');if(chunk.source.kind!=='external')throw Error();
    const raw=await readFile(join(directory,chunk.source.uri)),r=chunk.source.byteRange;return r?raw.subarray(r.offset,r.offset+r.length):raw;
   }});
   assert.equal(chunkReads,mode==='inline'?0:2);
   if(mode==='packed')assert.ok(manifest.scene.bakes!.motion.chunks.every(c=>c.source.kind==='external'&&c.source.byteRange));
   for(const time of [0,.375,.75,1,2,1,.375])assert.deepEqual(runtime.sample(time),reference.sample(time));
   assert.deepEqual(runtime.sample(1).fieldVisualization!.color.scalar,[1,2,3]);runtime.dispose();
  }
 }finally{await rm(folder,{recursive:true,force:true});}
});

test('external bake chunks hydrate atomically alongside external mesh assets',async()=>{
 const full=bundle(),manifest=packaged(full),payloads=new Map<string,Buffer>();
 for(const chunk of manifest.scene.bakes!.motion.chunks){assert.equal(chunk.source.kind,'inline');if(chunk.source.kind!=='inline')throw Error();payloads.set(chunk.id,Buffer.from(chunk.source.data,'base64'));chunk.source={kind:'external',uri:`bakes/${chunk.id}.bin`};}
 let assets=0,chunks=0;const runtime=await prepareSceneAsync(manifest,{profile:NUMERIC_3D_PROFILE,
  assetResolver:async()=>{assets++;return Buffer.from(JSON.stringify(mesh));},
  bakeResolver:async chunk=>{chunks++;return payloads.get(chunk.id)!;}});
 assert.equal(assets,1);assert.equal(chunks,2);
 for(const time of [0,.75,.5,2,1])assert.deepEqual(runtime.sample(time),prepareScene(full).sample(time));
 runtime.dispose();
});

test('missing bake, cyclic source, wrong resource and collisions fail package preflight before any I/O',async()=>{
 const cases:[ScenePackage,string][]=[];
 const add=(change:(p:ScenePackage)=>void,code:string)=>{const p=packaged();change(p);cases.push([p,code]);};
 add(p=>{p.scene.sampledFields!.operations[0].bake='missing';},'ASSET_REFERENCE');
 add(p=>{p.scene.sampledFields!.operations[0].source='state';},'ASSET_REFERENCE');
 add(p=>{p.scene.sampledFields!.operations[0].resourceId='source';},'ASSET_DUPLICATE');
 add(p=>{p.scene.sampledFields!.operations.push({...p.scene.sampledFields!.operations[0],resourceId:'second'});},'ASSET_DUPLICATE');
 add(p=>{p.assets.entries[0]={...p.assets.entries[0],kind:'vector',bounds:[0,0,1,1]};},'ASSET_KIND');
 let reads=0;for(const [p,code] of cases){assert.ok(validateScenePackage(p).some(d=>d.code===code),code);
  await assert.rejects(prepareSceneAsync(p,{profile:NUMERIC_3D_PROFILE,assetResolver:async()=>{reads++;return Buffer.from(JSON.stringify(mesh));},bakeResolver:async()=>{reads++;return new Uint8Array();}}));}
 assert.equal(reads,0);
});

test('a non-temporal consumer refuses baked data before touching assets or chunks',async()=>{
 const p=packaged();let calls=0;
 await assert.rejects(prepareSceneAsync(p,{profile:SVG_2D_PROFILE,assetResolver:async()=>{calls++;return new Uint8Array();},bakeResolver:async()=>{calls++;return new Uint8Array();}}));
 assert.equal(calls,0);
});

test('omitting scene-declared bake requirements cannot bypass transport preflight',async()=>{
 const required=['bake.temporal.3d','field.sampled.3d','mesh.triangles.3d','attribute.mesh.3d'];let reads=0;
 for(const omitted of required){const p=packaged();p.assets.requiredFeatures=p.assets.requiredFeatures.filter(f=>f!==omitted);
  assert.ok(validateScenePackage(p).some(d=>d.code==='ASSET_FEATURES'));
  await assert.rejects(prepareSceneAsync(p,{profile:SVG_2D_PROFILE,assetResolver:async()=>{reads++;return new Uint8Array();},bakeResolver:async()=>{reads++;return new Uint8Array();}}));
 }
 assert.equal(reads,0);
});

test('corrupt temporal chunks cannot publish a ready scene',async()=>{
 const p=packaged();for(const chunk of p.scene.bakes!.motion.chunks)chunk.source={kind:'external',uri:`${chunk.id}.bin`};
 await assert.rejects(prepareSceneAsync(p,{profile:NUMERIC_3D_PROFILE,assetResolver:async()=>Buffer.from(JSON.stringify(mesh)),bakeResolver:async chunk=>new Uint8Array(chunk.byteLength)}));
});
