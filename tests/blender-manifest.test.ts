import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {blenderConfigSha256,validateBlenderManifest,lowerBlenderManifest,mergeBlenderManifests,snapshotBlenderManifest,
  type BlenderManifest,type BlenderObjectReport,BlenderManifestError} from '../src/resources/blender-manifest.ts';
import {prepareScene} from '../src/runtime.ts';
import type {Bundle} from '../src/schema.ts';
import type {MeshResource} from '../src/ir/mesh.ts';
import type {BakeManifest} from '../src/resources/bake.ts';
import {copyMeshBuffers} from '../src/ir/mesh.ts';
import type {Matrix4} from '../src/geometry/matrix4.ts';

const reflectedShear:Matrix4=[-1,0,0,0, .25,1,0,0, 0,0,1,0, 2,0,0,1];
function mesh():MeshResource{return {kind:'mesh',version:1,units:'m',primitive:'triangles',coordinateSpace:'object',winding:'ccw',topologyRevision:'tri',
  positions:{version:1,componentType:'float64',components:3,count:3,byteOffset:0,byteStride:24,data:[0,0,0,1,0,0,0,1,0]},
  normals:{version:1,componentType:'float64',components:3,count:3,byteOffset:0,byteStride:24,data:[0,0,1,0,0,1,0,0,1]},
  indices:{version:1,componentType:'uint32',components:1,count:3,byteOffset:0,byteStride:4,data:[0,1,2]},bounds:{min:[0,0,0],max:[1,1,0]}};}
function bake():BakeManifest{
  const values=[0,0,0,1,0,0,0,1,0,0,0,0,1,0,1,0,1,0],bytes=Buffer.alloc(values.length*8);values.forEach((v,i)=>bytes.writeDoubleLE(v,i*8));
  return {version:1,units:'m',timeUnit:'s',topology:{revision:'tri',vertexCount:3,indices:[0,1,2]},sampleTimes:[0,1],interpolation:'linear',outside:'clamp',seed:3801,
    solver:{name:'Blender evaluated dependency graph',version:'4.5.9',parameters:{sourceBlendSha256:'2'.repeat(64),normalPolicy:'recomputed-triangle',topologyPolicy:'fixed-exact-corner-incidence'}},channels:[{id:'position',kind:'position',componentType:'float64',unit:'m'}],
    chunks:[{id:'positions',startSample:0,sampleCount:2,byteLength:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),source:{kind:'inline',data:bytes.toString('base64')}}]};
}
function objectRow(key:string,nodeId:string|null,extra:Partial<BlenderObjectReport>={}):BlenderObjectReport{return {key,sourceObject:key,sourceData:'Triangle',isInstance:false,parent:null,persistentId:[],resourceId:'triangle',nodeId,setId:null,instanceId:null,
  originalVertices:3,evaluatedVertices:3,outputVertices:3,modifiers:[],geometry:'converted',transform:'preserved-matrix',normalPolicy:'preserved-corner',material:'#4488cc',...extra};}
function manifest():BlenderManifest{
  const config:BlenderManifest['report']['config']={materialPolicy:'error',normalPolicy:'corner-static-triangle-recomputed-bake',triangulation:'evaluated-loop-triangles',interpolation:'linear',chunkFrames:8,seed:3801,blenderBuildHash:'abcdef123456'};
  return {version:1,profile:'blender-evaluated/1',producer:{name:'Blender',version:'4.5.9',script:{path:'tools/blender/export_evaluated.py',sha256:'1'.repeat(64)}},
    source:{blend:{path:'fixture.blend',sha256:'2'.repeat(64)},scene:'Scene'},coordinates:{units:'m',handedness:'right',upAxis:'z',metersPerBlenderUnit:.01},time:{unit:'s',duration:1,sampleTimes:[0,1],fps:24,frameStart:1},
    resources:{triangle:mesh()},instanceSets:{shared:{version:1,prototypeResourceId:'triangle',units:'m',instances:[{id:'first',transform:{translation:[0,2,0]}},{id:'second',transform:{matrix:reflectedShear},selected:false}]}},
    bakes:{deformation:bake()},sampledFields:{version:1,operations:[{id:'sample',source:'triangle',resourceId:'deformed',bake:'deformation',units:'m',attributes:[],position:{channel:'position',normalPolicy:'recompute',degenerateNormalPolicy:'error'}}]},
    space3d:{version:1,units:'m',handedness:'right',upAxis:'z',nodes:[
      {id:'solid',kind:'mesh',resourceId:'triangle',transform:{matrix:reflectedShear},material:{kind:'unlit',color:'#4488cc'}},
      {id:'batch',kind:'instances',instanceSetId:'shared',transform:{translation:[0,0,2]},material:{kind:'unlit',color:'#4488cc'}},
      {id:'animated',kind:'mesh',resourceId:'deformed',transform:{translation:[0,0,0]},material:{kind:'unlit',color:'#4488cc'}}],
      tracks:[{target:'animated',property:'translation',keys:[[0,[0,0,0]],[1,[2,0,0]]],interpolation:'linear'}]},
    report:{config,configSha256:blenderConfigSha256(config),counts:{objects:4,resources:1,instanceSets:1,instances:2,bakes:1,vertices:3,triangles:1,bakeBytes:144},
      objects:[objectRow('solid','solid'),objectRow('first',null,{isInstance:true,setId:'shared',instanceId:'first'}),objectRow('second',null,{isInstance:true,setId:'shared',instanceId:'second'}),
        objectRow('animated','animated',{resourceId:'deformed',geometry:'baked',transform:'baked-trs',normalPolicy:'recomputed-triangle'})],
      preserved:['Shared prototype geometry and affine matrices'],converted:['Metres and triangle normals'],baked:['Position samples and TRS'],unsupported:[]}};
}
const bundle=():Bundle=>({version:'0.3',title:'Imported',duration:1,units:'bp',viewport:{width:320,height:200},camera:{x:0,y:0,zoom:1},nodes:[],tracks:[],relations:[],resources:{},
  space3d:{version:1,units:'m',handedness:'right',upAxis:'z',nodes:[{kind:'group',id:'model',transform:{translation:[10,0,0]}}]}});
const rejects=(value:unknown,code?:string)=>{const errors=validateBlenderManifest(value);assert.ok(errors.length);if(code)assert.ok(errors.some(d=>d.code===code),JSON.stringify(errors));};

test('Blender results lower into native IR, retaining affine reflection/shear and shared geometry',()=>{
  const m=manifest();assert.deepEqual(validateBlenderManifest(m),[]);
  const lowered=lowerBlenderManifest(m,{scope:'model'});
  assert.equal(lowered.rootId,'model');assert.equal(Object.keys(lowered.resources).length,1);
  assert.deepEqual(lowered.space3d.nodes.find(n=>n.id==='model:node:solid')!.transform,{matrix:reflectedShear});
  assert.ok(lowered.space3d.nodes.every(n=>n.kind!=='instances'));
  assert.equal(lowered.report.mappings.instances.length,2);
  const {bundle:scene}=mergeBlenderManifests(bundle(),[{id:'model',manifest:m}]);
  const player=prepareScene(structuredClone(scene) as Bundle),frame=player.sample(.5),solid=frame.space3d!.instances.find(i=>i.id==='model:node:solid')!;
  assert.equal(solid.orientation,-1);assert.equal(solid.worldWinding,'cw');assert.equal(solid.worldMatrix[12],12);assert.equal(solid.worldMatrix[4],.25);
  const instances=frame.space3d!.instances.filter(i=>i.id.includes(':instance:'));
  assert.equal(instances.length,2);assert.ok(instances.every(i=>i.resourceId==='model:mesh:triangle'));
  assert.equal(instances.find(i=>i.id.endsWith(':second'))!.visible,false);
  assert.deepEqual([...copyMeshBuffers(frame.resources['model:mesh:deformed']).positions],[0,0,0,1,0,.5,0,1,0]);
  assert.equal(frame.space3d!.instances.find(i=>i.id==='model:node:animated')!.worldMatrix[12],11);
  player.sample(1);player.sample(0);assert.deepEqual(player.sample(.5),frame);
});

test('lowering and merging snapshots are detached, frozen and do not freeze caller objects',()=>{
  const m=manifest(),b=bundle(),before=JSON.stringify({m,b}),lowered=lowerBlenderManifest(m,{scope:'model'}),result=mergeBlenderManifests(b,[{id:'model',manifest:m}]);
  assert.equal(JSON.stringify({m,b}),before);assert.ok(!Object.isFrozen(m));
  assert.ok(Object.isFrozen(lowered.resources['model:mesh:triangle'].positions.data));
  assert.ok(Object.isFrozen(result.bundle.provenance!.blenderImports));
  m.resources.triangle.positions.data[0]=100;b.space3d!.nodes=[];
  assert.equal(lowered.resources['model:mesh:triangle'].positions.data[0],0);
  assert.equal(result.bundle.space3d!.nodes[0].id,'model');
  assert.throws(()=>{(lowered.resources['model:mesh:triangle'].positions.data as number[])[0]=12;},TypeError);
  assert.ok(Object.isFrozen(snapshotBlenderManifest(manifest()).report.objects));
});

test('manifest validation rejects non-JSON descriptors without invoking getters',()=>{
  let called=false;const bad={};Object.defineProperty(bad,'profile',{enumerable:true,get(){called=true;return 'blender-evaluated/1';}});
  rejects(bad,'ASSET_JSON_VALUE');assert.equal(called,false);
  const m:any=manifest();m.report.loop=m;rejects(m,'ASSET_JSON_CYCLE');
  for(const change of [(m:any)=>m.instanceSets.shared.instances[0]=null,(m:any)=>m.instanceSets.shared.instances[0].color='red',
    (m:any)=>m.report.objects[0].material={toString:0,valueOf:0},(m:any)=>m.report.objects[0]=null]){const value=manifest();change(value);assert.doesNotThrow(()=>rejects(value));}
});

test('pinned Blender profile, relative source identities and config hash are mandatory',()=>{
  for(const change of [(m:any)=>m.producer.version='4.6.0',(m:any)=>m.source.blend.path='../secret.blend',
    (m:any)=>m.producer.script.sha256='INVALID',(m:any)=>m.coordinates.metersPerBlenderUnit=0,
    (m:any)=>m.report.config.blenderBuildHash='changed',(m:any)=>m.extra=true]){
    const m=manifest();change(m);rejects(m);
  }
});

test('source object report is a checked mapping, including material and conversion decisions',()=>{
  for(const change of [(m:any)=>m.report.counts.vertices=4,(m:any)=>m.report.objects[0].resourceId='missing',
    (m:any)=>m.report.objects[0].material='#ffffff',(m:any)=>m.report.objects[3].geometry='converted',
    (m:any)=>m.report.objects.pop(),(m:any)=>m.report.objects[1].instanceId='missing',
    (m:any)=>m.report.objects[0].transform='baked-trs']){const m=manifest();change(m);rejects(m,'BLENDER_REPORT');}
});

test('instance dependencies, tint preservation and local ID scoping are explicit',()=>{
  const m:any=manifest();m.instanceSets.shared.prototypeResourceId='absent';rejects(m,'BLENDER_DEPENDENCY');
  const colored=manifest();colored.instanceSets.shared.instances[0].color=[1,.5,1];rejects(colored,'BLENDER_INSTANCE_COLOR');
  for(const invalid of ['constructor','a:b','../a','a'.repeat(65)])assert.throws(()=>lowerBlenderManifest(manifest(),{scope:invalid}),BlenderManifestError);
  const duplicate=manifest();duplicate.space3d.nodes[1].id='solid';rejects(duplicate);
  const explicit=manifest();explicit.report.objects[1].nodeId='batch';explicit.report.objects[2].nodeId='batch';assert.deepEqual(validateBlenderManifest(explicit),[]);
  explicit.report.objects[1].nodeId='solid';rejects(explicit,'BLENDER_REPORT');
});

test('bake hashes, exact topology, shared times and position-only units are checked before publication',()=>{
  for(const change of [(m:any)=>m.bakes.deformation.chunks[0].sha256='0'.repeat(64),
    (m:any)=>m.bakes.deformation.topology.indices=[0,2,1],(m:any)=>m.bakes.deformation.sampleTimes=[0,.9],
    (m:any)=>m.bakes.deformation.channels[0].unit='cm',
    (m:any)=>m.bakes.deformation.solver.parameters.sourceBlendSha256='0'.repeat(64),
    (m:any)=>m.bakes.deformation.chunks[0].source={kind:'external',uri:'chunk.bin'},
    (m:any)=>m.sampledFields.operations[0].source='not-declared']){const m=manifest();change(m);rejects(m);}
});

test('unsupported material fallback is only legal under an explicit policy and remains reported',()=>{
  const m=manifest();m.report.unsupported=[{code:'MATERIAL_UNSUPPORTED',subject:'Glass',message:'First material diffuse color used.'}];rejects(m,'BLENDER_REPORT');
  m.report.config.materialPolicy='fallback';m.report.configSha256=blenderConfigSha256(m.report.config);
  assert.deepEqual(validateBlenderManifest(m),[]);
  const result=lowerBlenderManifest(m,{scope:'a'});assert.equal(result.report.conversion.unsupported[0].subject,'Glass');
});

test('native track validation rejects matrix-animation ambiguity and malformed time keys',()=>{
  const m=manifest();m.space3d.tracks![0].target='solid';rejects(m,'SPACE3D_TRACK_MATRIX');
  const other=manifest();other.space3d.tracks![0].keys=[[0,[0,0,0]],[0,[1,0,0]]];rejects(other,'SPACE3D_TRACK_TIME');
  const clock=manifest();clock.space3d.tracks![0].keys[1][0]=.9;rejects(clock,'BLENDER_TRACK_TIME');
});

test('merge rejects resource, bake, operation, namespace, duration and unit collisions atomically',()=>{
  const original=bundle();
  const cases=[(b:Bundle)=>{b.resources['model:mesh:triangle']=mesh();},
    (b:Bundle)=>{b.bakes={'model:bake:deformation':bake()};},
    (b:Bundle)=>{b.duration=.5;},(b:Bundle)=>{b.space3d!.units='cm';},
    (b:Bundle)=>{b.space3d!.nodes[0]={kind:'mesh',id:'model',resourceId:'anything'};},
    (b:Bundle)=>{b.space3d!.nodes.push({kind:'group',id:'model:node:solid'});}];
  for(const change of cases){const b=structuredClone(original);change(b);const before=JSON.stringify(b);assert.throws(()=>mergeBlenderManifests(b,[{id:'model',manifest:manifest()}]),BlenderManifestError);assert.equal(JSON.stringify(b),before);}
  assert.throws(()=>mergeBlenderManifests(original,[{id:'model',manifest:manifest()},{id:'model',manifest:manifest()}]),BlenderManifestError);
});

test('separate namespaces reuse geometry within each import and add author-controlled roots',()=>{
  const result=mergeBlenderManifests(bundle(),[{id:'model',manifest:manifest()},{id:'other',manifest:manifest()}]);
  assert.equal(result.reports.length,2);assert.equal(Object.keys(result.bundle.resources).length,2);
  assert.ok(result.bundle.space3d!.nodes.some(n=>n.id==='other'&&n.kind==='group'));
  assert.deepEqual(result.bundle.space3d!.nodes.find(n=>n.id==='model')!.transform,{translation:[10,0,0]});
  assert.equal(prepareScene(structuredClone(result.bundle) as Bundle).sample(.5).space3d!.instances.length,8);
});

test('a Blender-only declaration promotes a legacy scene and creates its placement space',()=>{
  const legacy=bundle();legacy.version='0.1';delete legacy.space3d;
  const result=mergeBlenderManifests(legacy,[{id:'imported',manifest:manifest()}]);
  assert.equal(result.bundle.version,'0.3');assert.equal(legacy.version,'0.1');assert.equal(legacy.space3d,undefined);
  assert.equal(result.bundle.space3d!.units,'m');assert.deepEqual(result.bundle.space3d!.nodes[0],{id:'imported',kind:'group'});
  assert.equal(prepareScene(structuredClone(result.bundle) as Bundle).sample(.5).space3d!.instances.length,4);
});

test('author wireframe presentation overrides only imported draw materials after producer validation',()=>{
  const m=manifest(),b=bundle(),entry={id:'model',manifest:m,presentation:{wireframe:true}};
  b.resources.authored=mesh();b.space3d!.nodes.push({id:'authored',kind:'mesh',resourceId:'authored',material:{kind:'unlit',color:'#112233',wireframe:false}});
  const authoredBefore=JSON.stringify({b,entry}),result=mergeBlenderManifests(b,[entry]);
  const imported=result.bundle.space3d!.nodes.filter(n=>n.kind==='mesh'&&n.id!=='authored');
  assert.equal(imported.length,4);
  for(const node of imported){assert.equal(node.kind==='mesh'&&node.material?.wireframe,true);assert.equal(node.kind==='mesh'&&node.material?.color,'#4488cc');}
  const authored=result.bundle.space3d!.nodes.find(n=>n.id==='authored')!;
  assert.deepEqual(authored.kind==='mesh'&&authored.material,{kind:'unlit',color:'#112233',wireframe:false});
  assert.deepEqual(result.reports[0].presentation,{wireframe:true});assert.deepEqual(result.reports[0].conversion,m.report);
  assert.deepEqual(result.reports[0].producer,m.producer);assert.deepEqual(result.reports[0].source,m.source);
  assert.deepEqual(result.bundle.resources['model:mesh:triangle'],m.resources.triangle);
  assert.equal(JSON.stringify({b,entry}),authoredBefore);
  entry.presentation.wireframe=false;assert.equal(result.reports[0].presentation!.wireframe,true);assert.ok(Object.isFrozen(result.reports[0].presentation));
  const noOverride=mergeBlenderManifests(bundle(),[{id:'model',manifest:m}]);
  assert.equal(noOverride.reports[0].presentation,undefined);
  assert.ok(noOverride.bundle.space3d!.nodes.filter(n=>n.kind==='mesh').every(n=>n.material?.wireframe===undefined));
  const off=mergeBlenderManifests(bundle(),[{id:'model',manifest:m,presentation:{wireframe:false}}]);
  assert.ok(off.bundle.space3d!.nodes.filter(n=>n.kind==='mesh').every(n=>n.material?.wireframe===false));
  const invalid=manifest(),solid=invalid.space3d.nodes[0];assert.equal(solid.kind,'mesh');if(solid.kind==='mesh')solid.material!.color='#ffffff';
  assert.throws(()=>mergeBlenderManifests(bundle(),[{id:'model',manifest:invalid,presentation:{wireframe:true}}]),BlenderManifestError);
});

test('malformed display overrides reject before publishing and cannot extend the rendering profile',()=>{
  for(const presentation of [null,[],{},true,{wireframe:1},{wireframe:'true'},{wireframe:true,color:'#ffffff'}]){
    const b=bundle(),before=JSON.stringify(b);
    assert.throws(()=>mergeBlenderManifests(b,[{id:'model',manifest:manifest(),presentation} as any]),BlenderManifestError);
    assert.equal(JSON.stringify(b),before);
  }
});

test('a static zero-duration manifest needs neither bakes nor sampled programs',()=>{
  const m=manifest();delete m.bakes;delete m.sampledFields;delete m.space3d.tracks;
  m.time.duration=0;m.time.sampleTimes=[0];m.space3d.nodes.pop();m.report.objects.pop();
  Object.assign(m.report.counts,{objects:3,bakes:0,bakeBytes:0});m.report.baked=[];
  assert.deepEqual(validateBlenderManifest(m),[]);
  const result=mergeBlenderManifests(bundle(),[{id:'model',manifest:m}]);
  assert.equal(result.bundle.bakes,undefined);assert.equal(result.bundle.sampledFields,undefined);
  assert.equal(prepareScene(structuredClone(result.bundle) as Bundle).sample(0).space3d!.instances.length,3);
});

test('Node lowering CLI produces the same native bundle as the public API',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'texloom-blender-'));
  try{const input=join(folder,'request.json'),output=join(folder,'response.json'),b=bundle(),m=manifest();
    await writeFile(input,JSON.stringify({bundle:b,imports:[{id:'model',manifest:m,presentation:{wireframe:true}}]}));
    execFileSync(process.execPath,['tools/lower-blender.mjs',input,output],{cwd:process.cwd(),stdio:'pipe'});
    assert.deepEqual(JSON.parse(await readFile(output,'utf8')),mergeBlenderManifests(b,[{id:'model',manifest:m,presentation:{wireframe:true}}]));
  }finally{await rm(folder,{recursive:true,force:true});}
});
