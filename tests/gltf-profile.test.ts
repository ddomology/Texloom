import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {importGltfAsset,mergeGltfAssets} from '../src/resources/gltf-profile.js';
import {copyMeshBuffers} from '../src/ir/mesh.js';
import {prepareScene} from '../src/runtime.js';
import type {Bundle} from '../src/schema.js';

type Obj=Record<string,any>;
const fixture=new URL('../examples/data/gltf-profile/',import.meta.url);
function asset():{document:Obj;buffers:string[]}{
  return {document:JSON.parse(readFileSync(new URL('scene.gltf',fixture),'utf8')),buffers:[readFileSync(new URL('scene.bin',fixture)).toString('base64')]};
}
function bundle():Bundle{return {version:'0.3',title:'glTF integration',duration:8,units:'bp',viewport:{width:640,height:360},nodes:[],tracks:[],relations:[],camera:{x:0,y:0,zoom:1},resources:{},space3d:{version:1,units:'m',handedness:'right',upAxis:'z',nodes:[]}};}
function read(a:ReturnType<typeof asset>,index:number):number[]{
  const accessor=a.document.accessors[index],view=a.document.bufferViews[accessor.bufferView],bytes=Buffer.from(a.buffers[view.buffer],'base64'),data=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  const components=({SCALAR:1,VEC3:3,VEC4:4} as Obj)[accessor.type],size=accessor.componentType===5126?4:accessor.componentType===5123?2:1;
  const offset=(view.byteOffset??0)+(accessor.byteOffset??0),stride=view.byteStride??components*size;
  return Array.from({length:accessor.count*components},(_,i)=>{const p=offset+Math.floor(i/components)*stride+i%components*size;return accessor.componentType===5126?data.getFloat32(p,true):size===2?data.getUint16(p,true):data.getUint8(p);});
}
function modifyFloat(a:ReturnType<typeof asset>,accessorIndex:number,element:number,value:number):void{
  const acc=a.document.accessors[accessorIndex],view=a.document.bufferViews[acc.bufferView],bytes=Buffer.from(a.buffers[view.buffer],'base64');
  bytes.writeFloatLE(value,(view.byteOffset??0)+(acc.byteOffset??0)+element*4);a.buffers[view.buffer]=bytes.toString('base64');
}
function rejected(change:(a:ReturnType<typeof asset>)=>void,options?:Obj):void{
  const a=asset();change(a);assert.throws(()=>importGltfAsset(a,'model',options),error=>error instanceof Error&&error.message.length>0);
}
const converted=(v:number[])=>[v[0],-v[2],v[1]].map(n=>n===0?0:n);
const near=(a:number[],b:number[],tolerance=1e-7)=>{assert.equal(a.length,b.length);a.forEach((n,i)=>assert.ok(Math.abs(n-b[i])<=tolerance,`${i}: ${n} != ${b[i]}`));};

test('glTF import preserves triangle ordering and shared resources in the explicit Z-up chart',()=>{
  const a=asset(),fragment=importGltfAsset(a,'model'),meshes=fragment.space3d.nodes.filter((n:any)=>n.kind==='mesh');
  assert.equal(Object.keys(fragment.resources).length,3);assert.equal(meshes.length,9);assert.equal(fragment.duration,8);
  const sourcePositions=read(a,0),sourceNormals=read(a,1);
  for(let primitive=0;primitive<3;primitive++){
    const id=`model:mesh:0:${primitive}`,resource=copyMeshBuffers(fragment.resources[id]);
    assert.equal(meshes.filter((n:any)=>n.resourceId===id).length,3);
    const p:number[]=[],normals:number[]=[];for(let i=0;i<sourcePositions.length;i+=3){p.push(...converted(sourcePositions.slice(i,i+3)));normals.push(...converted(sourceNormals.slice(i,i+3)));}
    near([...resource.positions],p,0);near([...resource.normals!],normals,0);
    assert.deepEqual([...resource.indices],read(a,a.document.meshes[0].primitives[primitive].indices));
  }
  assert.equal(fragment.space3d.camera,undefined);
});

test('import and merge are detached immutable snapshots without freezing caller input',()=>{
  const a=asset(),b=bundle(),before=JSON.stringify({a,b}),f=importGltfAsset(a,'model'),merged=mergeGltfAssets(b,[{id:'model',asset:a}]);
  assert.equal(JSON.stringify({a,b}),before);assert.ok(!Object.isFrozen(a.document));assert.ok(Object.isFrozen(f.resources));assert.ok(Object.isFrozen(merged.bundle));
  a.document.nodes[0].translation[0]=900;b.duration=1;
  assert.equal(f.duration,8);assert.equal(merged.bundle.duration,8);
  assert.ok(Object.isFrozen(f.resources['model:mesh:0:0'].positions.data));
});

test('native STEP and LINEAR tracks keep source knots and deterministic arbitrary-time sampling',()=>{
  const a=asset(),result=mergeGltfAssets(bundle(),[{id:'model',asset:a}]),scene=structuredClone(result.bundle) as Bundle;
  const tracks=scene.space3d!.tracks!,step=tracks.find(t=>t.property==='scale')!,translation=tracks.find(t=>t.property==='translation')!,rotation=tracks.find(t=>t.property==='rotation')!;
  assert.equal(step.interpolation,'step');assert.equal(translation.interpolation,'linear');assert.equal(rotation.interpolation,'linear');
  const samplers=a.document.animations[0].samplers;
  for(const [path,track] of [['translation',translation],['rotation',rotation],['scale',step]] as const){
    const channel=a.document.animations[0].channels.find((c:any)=>c.target.path===path),sampler=samplers[channel.sampler];
    assert.deepEqual(track.keys.map(k=>k[0]),read(a,sampler.input));
  }
  const player=prepareScene(scene),first=player.sample(1.125);player.sample(8);player.sample(0);assert.deepEqual(player.sample(1.125),first);
  const boundary=step.keys[1][0],before=player.sample(boundary-1e-5),at=player.sample(boundary);
  const get=(frame:ReturnType<typeof player.sample>)=>frame.space3d!.groups.find(g=>g.id===step.target)!.worldMatrix;
  assert.notDeepEqual(get(before),get(at));
});

test('multiple clips require an explicit selected animation',()=>{
  const a=asset();a.document.animations.push(structuredClone(a.document.animations[0]));
  assert.throws(()=>importGltfAsset(a,'model'));assert.equal(importGltfAsset(a,'model',{animation:1}).duration,8);
  assert.throws(()=>importGltfAsset(a,'model',{animation:2}));assert.throws(()=>importGltfAsset(a,'model',{animation:-1}));
});

test('selected camera preserves optical basis and enforces its authored aspect',()=>{
  const a=asset(),f=importGltfAsset(a,'model',{camera:0});assert.ok(f.space3d.camera);
  const out=mergeGltfAssets(bundle(),[{id:'model',asset:a,options:{camera:0}}]),frame=prepareScene(structuredClone(out.bundle) as Bundle).sample(0);
  const pose=frame.space3d!.camera!.worldMatrix,source=a.document.nodes.find((n:any)=>n.camera===0);
  near([pose[12],pose[13],pose[14]],converted(source.translation),1e-14);
  const wrong=bundle();wrong.viewport={width:100,height:100};assert.throws(()=>mergeGltfAssets(wrong,[{id:'model',asset:a,options:{camera:0}}]));
  rejected(a=>{a.document.cameras[0].perspective.zfar=undefined;delete a.document.cameras[0].perspective.zfar;},{camera:0});
  assert.throws(()=>importGltfAsset(a,'model',{camera:10}));
});

test('atomic merge rejects collisions, insufficient duration and incompatible spatial units',()=>{
  const a=asset(),b=bundle();b.space3d!.nodes.push({id:'model',kind:'group',transform:{translation:[3,0,0]}});
  const merged=mergeGltfAssets(b,[{id:'model',asset:a}]);assert.deepEqual(merged.bundle.space3d!.nodes.find(n=>n.id==='model')!.transform,{translation:[3,0,0]});
  const before=JSON.stringify(b);assert.throws(()=>mergeGltfAssets(b,[{id:'model',asset:a},{id:'model',asset:a}]));assert.equal(JSON.stringify(b),before);
  b.duration=1;assert.throws(()=>mergeGltfAssets(b,[{id:'model',asset:a}]));b.duration=8;b.space3d!.units='cm';assert.throws(()=>mergeGltfAssets(b,[{id:'model',asset:a}]));
  const clash=bundle();clash.space3d!.nodes.push({id:'model:node:0',kind:'group'});assert.throws(()=>mergeGltfAssets(clash,[{id:'model',asset:a}]));
});

test('unknown extensions and unsupported morph, skin and cubic animation are explicit errors',()=>{
  for(const change of [
    (a:ReturnType<typeof asset>)=>{a.document.extensionsUsed.push('EXT_future_geometry');a.document.extensionsRequired=['EXT_future_geometry'];},
    (a:ReturnType<typeof asset>)=>{a.document.nodes[1].extensions={EXT_future_geometry:{}};},
    (a:ReturnType<typeof asset>)=>{a.document.meshes[0].primitives[0].targets=[{POSITION:0}];a.document.meshes[0].weights=[0];},
    (a:ReturnType<typeof asset>)=>{a.document.nodes[1].weights=[NaN];},
    (a:ReturnType<typeof asset>)=>{a.document.nodes[1].skin=0;a.document.skins=[{joints:[0]}];},
    (a:ReturnType<typeof asset>)=>{a.document.animations[0].samplers[0].interpolation='CUBICSPLINE';},
    (a:ReturnType<typeof asset>)=>{a.document.animations[0].channels[0].target.path='weights';},
  ])rejected(change);
});

test('all buffers are explicit bounded canonical base64 with matching byte lengths',()=>{
  rejected(a=>{a.buffers=[];});rejected(a=>{a.buffers[0]='@@not-base64';});
  rejected(a=>{a.buffers[0]=Buffer.from([1,2,3]).toString('base64');});
  rejected(a=>{a.document.buffers[0].byteLength-=1;});
  rejected(a=>{a.document.buffers[0].byteLength=Number.MAX_SAFE_INTEGER;});
  rejected(a=>{a.buffers.push(a.buffers[0]);});
});

test('a valid padded buffer below the byte budget does not overflow the base64 validator stack',()=>{
  const a=asset(),bytes=Buffer.alloc(7_500_000);Buffer.from(a.buffers[0],'base64').copy(bytes);
  a.document.buffers[0].byteLength=bytes.length;a.buffers[0]=bytes.toString('base64');
  assert.equal(importGltfAsset(a,'model').space3d.nodes.filter((n:any)=>n.kind==='mesh').length,9);
});

test('accessor offsets, strides, normalization, count and min/max are checked against actual bytes',()=>{
  for(const change of [
    (a:ReturnType<typeof asset>)=>{a.document.accessors[0].byteOffset=1;},
    (a:ReturnType<typeof asset>)=>{a.document.accessors[0].count+=1000;},
    (a:ReturnType<typeof asset>)=>{a.document.accessors[0].min[0]+=1;},
    (a:ReturnType<typeof asset>)=>{a.document.accessors[0].max[1]-=1;},
    (a:ReturnType<typeof asset>)=>{delete a.document.accessors[0].min;delete a.document.accessors[0].max;},
    (a:ReturnType<typeof asset>)=>{a.document.accessors[0].normalized=true;},
    (a:ReturnType<typeof asset>)=>{a.document.bufferViews[0].byteStride=8;},
    (a:ReturnType<typeof asset>)=>{a.document.bufferViews[0].byteStride=13;},
    (a:ReturnType<typeof asset>)=>{a.document.accessors[0].sparse={count:1,indices:{bufferView:0,componentType:5123},values:{bufferView:0}};},
    (a:ReturnType<typeof asset>)=>{modifyFloat(a,0,0,Infinity);},
  ])rejected(change);
});

test('invalid indices, non-unit normals, duplicate animation writers and quaternion data fail',()=>{
  rejected(a=>{const acc=a.document.accessors[2],v=a.document.bufferViews[acc.bufferView],b=Buffer.from(a.buffers[v.buffer],'base64');delete acc.min;delete acc.max;b.writeUInt16LE(65535,(v.byteOffset??0)+(acc.byteOffset??0));a.buffers[v.buffer]=b.toString('base64');});
  rejected(a=>{delete a.document.accessors[1].min;delete a.document.accessors[1].max;modifyFloat(a,1,0,9);});
  rejected(a=>{a.document.animations[0].channels.push(structuredClone(a.document.animations[0].channels[0]));});
  rejected(a=>{const c=a.document.animations[0].channels.find((c:any)=>c.target.path==='rotation'),i=a.document.animations[0].samplers[c.sampler].output;for(let j=0;j<4;j++)modifyFloat(a,i,j,0);});
});

test('scene graph cycles, repeated children, multi-parent nodes and invalid references fail',()=>{
  rejected(a=>{a.document.nodes[1].children=[0];});
  rejected(a=>{a.document.nodes[0].children.push(1);});
  rejected(a=>{a.document.nodes[4].children=[1];});
  rejected(a=>{a.document.nodes[1].mesh=100;});
  rejected(a=>{a.document.scenes[0].nodes.push(1);});
});

test('PBR approximation requires opt-in and reports material loss; explicit wireframe is presentation',()=>{
  const a=asset();delete a.document.materials[0].extensions;
  assert.throws(()=>importGltfAsset(a,'model'));
  const f=importGltfAsset(a,'model',{materialPolicy:'fallback',wireframe:true});
  assert.ok(f.report.losses.length>0);assert.ok(f.space3d.nodes.filter((n:any)=>n.kind==='mesh').every((n:any)=>n.material.wireframe===true));
});

test('non-JSON caller descriptors never execute getters',()=>{
  let invoked=false;const a:any={buffers:[]};Object.defineProperty(a,'document',{enumerable:true,get(){invoked=true;return {};}});
  assert.throws(()=>importGltfAsset(a,'model'));assert.equal(invoked,false);
  const cyclic=asset();cyclic.document.self=cyclic.document;assert.throws(()=>importGltfAsset(cyclic,'model'));
});

test('unindexed triangles keep authored vertex order and receive sequential indices',()=>{
  const a=asset();a.document.meshes[0].primitives=[a.document.meshes[0].primitives[0]];delete a.document.meshes[0].primitives[0].indices;
  const result=importGltfAsset(a,'model'),mesh=copyMeshBuffers(result.resources['model:mesh:0:0']);
  assert.deepEqual([...mesh.indices],Array.from({length:36},(_,i)=>i));
  const expected=read(a,0).flatMap((_,i,data)=>i%3===0?converted(data.slice(i,i+3)):[]);near([...mesh.positions],expected,0);
});

test('uint8 indices and correctly aligned interleaved POSITION data are accepted',()=>{
  const a=asset(),d=a.document,positions=read(a,0),position=d.accessors[0];
  const extra=Buffer.alloc(position.count*16+12);
  for(let i=0;i<position.count;i++){for(let axis=0;axis<3;axis++)extra.writeFloatLE(positions[i*3+axis],i*16+axis*4);extra.writeFloatLE(123,i*16+12);}
  const indexOffset=position.count*16;[0,1,2,3,4,5,6,7,8,9,10,11].forEach((n,i)=>extra[indexOffset+i]=n);
  const buffer=d.buffers.length;d.buffers.push({byteLength:extra.length,uri:'interleaved.bin'});a.buffers.push(extra.toString('base64'));
  const pv=d.bufferViews.length;d.bufferViews.push({buffer,byteOffset:0,byteLength:indexOffset,byteStride:16,target:34962});position.bufferView=pv;
  const iv=d.bufferViews.length;d.bufferViews.push({buffer,byteOffset:indexOffset,byteLength:12,target:34963});
  const ix=d.accessors.length;d.accessors.push({bufferView:iv,componentType:5121,count:12,type:'SCALAR',min:[0],max:[11]});
  d.meshes[0].primitives[0].indices=ix;
  const result=importGltfAsset(a,'model'),mesh=copyMeshBuffers(result.resources['model:mesh:0:0']);
  assert.deepEqual([...mesh.indices],Array.from({length:12},(_,i)=>i));
  near([...mesh.positions],positions.flatMap((_,i,data)=>i%3===0?converted(data.slice(i,i+3)):[]),0);
});

test('selected cameras reject ambiguous instances, global scaling and authored-camera conflicts',()=>{
  rejected(a=>{a.document.nodes.push({...structuredClone(a.document.nodes[4]),name:'Another camera'});a.document.scenes[0].nodes.push(5);},{camera:0});
  rejected(a=>{a.document.nodes[4].scale=[1,2,1];},{camera:0});
  const b=bundle();b.space3d!.camera={id:'authored',projection:{kind:'perspective',fovY:1,near:.1,far:100}};
  assert.throws(()=>mergeGltfAssets(b,[{id:'model',asset:asset(),options:{camera:0}}]));
});

test('matrix/TRS exclusivity and unit quaternion source constraints are enforced',()=>{
  rejected(a=>{a.document.nodes[0].matrix=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];});
  rejected(a=>{a.document.nodes[1].rotation=[0,0,0,2];});
  rejected(a=>{const n=a.document.nodes[1];delete n.translation;delete n.rotation;delete n.scale;n.matrix=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];});
});

test('native v0.1 bundles promote atomically and report exact source identities',()=>{
  const a=asset(),b=bundle();b.version='0.1';delete b.space3d;
  const result=mergeGltfAssets(b,[{id:'model',asset:a}]);assert.equal(result.bundle.version,'0.3');assert.equal(b.version,'0.1');
  assert.equal(result.reports.length,1);assert.equal(result.reports[0].scope,'model');
  assert.match(result.reports[0].source.documentSha256,/^[0-9a-f]{64}$/);
  assert.equal(result.reports[0].source.bufferSha256.length,1);assert.equal(result.reports[0].source.bufferSha256[0],createHash('sha256').update(Buffer.from(a.buffers[0],'base64')).digest('hex'));
  assert.deepEqual(result.bundle.provenance!.gltfImports,result.reports);
});

test('malformed animation time/value ranges are rejected before runtime sampling',()=>{
  rejected(a=>{const sampler=a.document.animations[0].samplers[0];modifyFloat(a,sampler.input,1,0);});
  rejected(a=>{const sampler=a.document.animations[0].samplers[0];modifyFloat(a,sampler.input,0,-1);a.document.accessors[sampler.input].min=[-1];});
  rejected(a=>{const sampler=a.document.animations[0].samplers[0],output=a.document.accessors[sampler.output];output.count-=1;delete output.min;delete output.max;});
  rejected(a=>{a.document.animations[0].channels[0].target.node=99;});
});

test('generated primitive nodes are budgeted before resource expansion',()=>{
  const a=asset(),d=a.document;delete d.animations;
  d.meshes[0].primitives=Array.from({length:256},()=>structuredClone(d.meshes[0].primitives[0]));
  for(let i=0;i<99;i++){d.scenes[0].nodes.push(d.nodes.length);d.nodes.push({mesh:0,name:`Repeated ${i}`});}
  assert.throws(()=>importGltfAsset(a,'model'),(error:unknown)=>{
    assert.ok(error instanceof Error);assert.match(String((error as {code?:string}).code),/BUDGET/);return true;
  });
});

test('omitting a bufferView target cannot mix vertex and index usage',()=>{
  const a=asset(),d=a.document,indices=d.accessors[2],oldView=d.bufferViews[indices.bufferView];
  indices.bufferView=0;indices.byteOffset=oldView.byteOffset;
  d.bufferViews[0].byteLength=oldView.byteOffset+oldView.byteLength;delete d.bufferViews[0].target;
  // The bytes and addressed values are unchanged. The glTF usage conflict is
  // nevertheless invalid (Khronos BUFFER_VIEW_TARGET_OVERRIDE), even without target.
  assert.throws(()=>importGltfAsset(a,'model'));
});
