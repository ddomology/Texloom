import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {exportGltfAsset,GltfExportError} from '../src/resources/gltf-export.js';
import {identityMatrix4} from '../src/geometry/matrix4.js';
const validator=createRequire(import.meta.url)('gltf-validator');
type Obj=Record<string,any>;
function scene():Obj {
  const numeric=(data:number[],components:1|3,type:'float64'|'uint16')=>({version:1,componentType:type,components,count:data.length/components,byteOffset:0,byteStride:components*(type==='uint16'?2:8),data});
  return {duration:8,viewport:{width:640,height:360},resources:{triangle:{kind:'mesh',version:1,primitive:'triangles',units:'m',coordinateSpace:'object',winding:'ccw',topologyRevision:'triangle/1',positions:numeric([0,0,0,1,0,0,0,0,1],3,'float64'),indices:numeric([0,1,2],1,'uint16'),normals:numeric([0,-1,0,0,-1,0,0,-1,0],3,'float64'),bounds:{min:[0,0,0],max:[1,0,1]}}},space3d:{version:1,units:'m',handedness:'right',upAxis:'z',nodes:[{id:'parent',kind:'group',transform:{translation:[2,-3,4]}},{id:'first',kind:'mesh',parent:'parent',resourceId:'triangle',material:{kind:'unlit',color:'#336699'}},{id:'second',kind:'mesh',parent:'parent',resourceId:'triangle',transform:{scale:[-1,2,.5]},material:{kind:'unlit',color:'#336699'}}]}};
}
function data(output:ReturnType<typeof exportGltfAsset>,index:number):number[]{
  const a=output.asset.document.accessors[index],v=output.asset.document.bufferViews[a.bufferView];
  const bytes=Buffer.from(output.asset.buffers[v.buffer],'base64'),view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),size=a.type==='SCALAR'?1:a.type==='VEC3'?3:4;
  const count=a.count*size,offset=(v.byteOffset??0)+(a.byteOffset??0),width=a.componentType===5123?2:4;
  return Array.from({length:count},(_,i)=>a.componentType===5126?view.getFloat32(offset+i*width,true):a.componentType===5123?view.getUint16(offset+i*width,true):view.getUint32(offset+i*width,true));
}
async function validate(output:ReturnType<typeof exportGltfAsset>){
  const d=output.asset.document;
  const result=await validator.validateString(JSON.stringify(d),{maxIssues:100,externalResourceFunction:async(uri:string)=>new Uint8Array(Buffer.from(output.asset.buffers[d.buffers.findIndex((b:Obj)=>b.uri===uri)],'base64'))});
  assert.equal(result.issues.numErrors,0,JSON.stringify(result.issues));assert.equal(result.issues.numWarnings,0,JSON.stringify(result.issues));
}
test('export preserves shared geometry, hierarchy and reflected transform in valid glTF',async()=>{
  const source=scene(),before=JSON.stringify(source),out=exportGltfAsset(source),d=out.asset.document;
  assert.equal(JSON.stringify(source),before);assert.ok(Object.isFrozen(out.asset.document));
  assert.equal(d.meshes.length,1);assert.deepEqual(d.nodes[0].translation,[2,4,3]);
  assert.deepEqual(d.nodes[0].children,[1,2]);assert.deepEqual(d.nodes[2].scale,[-1,.5,2]);
  assert.deepEqual(data(out,d.meshes[0].primitives[0].attributes.POSITION),[0,0,0,1,0,0,0,1,0]);
  assert.deepEqual(data(out,d.meshes[0].primitives[0].indices),[0,1,2]);
  assert.deepEqual(data(out,d.meshes[0].primitives[0].attributes.NORMAL),[0,0,1,0,0,1,0,0,1]);
  await validate(out);
});
test('material variants share accessor data and unlit colors use linear RGB',async()=>{
  const source=scene();source.space3d.nodes[2].material={kind:'unlit',color:'#ffffff',side:'double'};
  const out=exportGltfAsset(source),d=out.asset.document;assert.equal(d.meshes.length,2);
  assert.equal(d.meshes[0].primitives[0].attributes.POSITION,d.meshes[1].primitives[0].attributes.POSITION);
  assert.equal(d.materials[1].doubleSided,true);assert.deepEqual(d.materials[1].pbrMetallicRoughness.baseColorFactor,[1,1,1,1]);
  assert.ok(Math.abs(d.materials[0].pbrMetallicRoughness.baseColorFactor[0]-.033104766570885055)<1e-15);await validate(out);
});
test('TRS STEP and LINEAR animation use exact converted axes and valid accessors',async()=>{
  const source=scene();source.space3d.tracks=[{target:'parent',property:'translation',interpolation:'linear',keys:[[0,[0,1,2]],[8,[3,4,5]]]},{target:'first',property:'scale',interpolation:'step',keys:[[0,[1,2,3]],[2,[4,5,6]]]},{target:'second',property:'rotation',interpolation:'linear',keys:[[0,[0,0,0,1]],[8,[0,0,1,0]]]}];
  const out=exportGltfAsset(source),animation=out.asset.document.animations[0];
  assert.deepEqual(animation.samplers.map((s:Obj)=>s.interpolation),['LINEAR','STEP','LINEAR']);
  assert.deepEqual(data(out,animation.samplers[0].output),[0,2,-1,3,5,-4]);
  assert.deepEqual(data(out,animation.samplers[1].output),[1,3,2,4,6,5]);
  assert.deepEqual(data(out,animation.samplers[2].output),[0,0,0,1,0,1,0,0]);await validate(out);
});
test('float32 rounding is reported and collapsed time, scale underflow and overflow are rejected',()=>{
  const source=scene();source.space3d.tracks=[{target:'parent',property:'translation',keys:[[0,[0,0,0]],[8,[.1,.2,.3]]]}];
  const out=exportGltfAsset(source);assert.ok(out.report.precision.roundedComponents>=3);assert.ok(out.report.precision.maxAbsoluteError>0);
  source.duration=1e8+1;source.space3d.tracks[0].keys=[[1e8,[0,0,0]],[1e8+.1,[1,1,1]]];assert.throws(()=>exportGltfAsset(source),/TIME_PRECISION/);
  source.space3d.tracks=[{target:'parent',property:'scale',keys:[[0,[1,1,1]],[8,[1e-50,1,1]]]}];assert.throws(()=>exportGltfAsset(source),/underflow/);
  source.space3d.tracks=[{target:'parent',property:'translation',keys:[[0,[0,0,0]],[8,[1e50,0,0]]]}];assert.throws(()=>exportGltfAsset(source),/FLOAT32/);
});
test('static camera optical axes use left basis conversion and declared fragment aspect',async()=>{
  const source=scene();delete source.viewport;source.requiredAspectRatio=16/9;
  source.space3d.camera={id:'eye',parent:'parent',transform:{matrix:[...identityMatrix4()]},projection:{kind:'orthographic',height:4,near:.1,far:100}};
  const out=exportGltfAsset(source),d=out.asset.document;
  assert.deepEqual(d.nodes.at(-1).matrix,[1,0,0,0,0,0,-1,0,0,1,0,0,0,0,0,1]);
  assert.equal(d.cameras[0].orthographic.xmag,32/9);assert.equal(d.cameras[0].orthographic.ymag,2);await validate(out);
  delete source.requiredAspectRatio;assert.throws(()=>exportGltfAsset(source),GltfExportError);
});
test('camera ancestors cannot be animated and matrix shear is rejected',()=>{
  const source=scene();source.space3d.camera={id:'eye',parent:'parent',projection:{kind:'perspective',fovY:1,near:.1,far:100}};
  source.space3d.tracks=[{target:'parent',property:'translation',keys:[[0,[0,0,0]],[8,[1,1,1]]]}];assert.throws(()=>exportGltfAsset(source),/CAMERA_ANIMATION/);
  delete source.space3d.tracks;delete source.space3d.camera;source.space3d.nodes[0].transform={matrix:[1,0,0,0,.2,1,0,0,0,0,1,0,0,0,0,1]};assert.throws(()=>exportGltfAsset(source),/SHEAR/);
});
test('native metadata and unused mesh bytes remain in the non-roundtrip sidecar',()=>{
  const source=scene();source.document={blocks:[{kind:'theorem',text:'A native theorem'}]};source.resources.unused=structuredClone(source.resources.triangle);source.provenance={sourceFile:'lesson.tex'};
  source.space3d.nodes[1].material.wireframe=true;const out=exportGltfAsset(source);
  assert.equal(out.sidecar.roundTrip,false);assert.deepEqual(out.sidecar.native.document,source.document);assert.deepEqual(out.sidecar.native.resources.unused,source.resources.unused);
  assert.equal(out.report.losses[0].code,'GLTF_EXPORT_WIREFRAME');assert.match(out.sidecar.boundary,/not a glTF extension/);
});
test('unsupported spatial computation, visibility and custom attributes fail explicitly',()=>{
  for(const key of ['bakes','sampledFields','surfaces','curves3d','meshAttributes','instances','fieldVisualization']){
    const source=scene();source[key]={unexpected:true};assert.throws(()=>exportGltfAsset(source),/UNEVALUATED/);
  }
  const hidden=scene();hidden.space3d.nodes[1].visible=false;assert.throws(()=>exportGltfAsset(hidden),/VISIBILITY/);
  const cycle=scene();cycle.space3d.nodes[0].parent='parent';assert.throws(()=>exportGltfAsset(cycle),/SPATIAL/);
  const malformed=scene();Object.defineProperty(malformed,'getter',{enumerable:true,get(){throw new Error('executed');}});assert.throws(()=>exportGltfAsset(malformed),/GLTF_EXPORT_JSON/);
});
test('valid object-property-like node and resource IDs have own mapping entries',()=>{
  for(const id of ['toString','constructor','__proto__']){
    const source=scene();source.resources=Object.fromEntries([[id,source.resources.triangle]]);
    source.space3d.nodes[1].id=id;source.space3d.nodes[1].resourceId=id;source.space3d.nodes[2].resourceId=id;
    const out=exportGltfAsset(source);
    assert.equal(Object.hasOwn(out.report.mappings.meshes,id),true);assert.deepEqual(out.report.mappings.meshes[id],[0]);
    assert.equal(Object.hasOwn(out.report.mappings.nodes,id),true);assert.equal(out.report.mappings.nodes[id],1);
    assert.equal(Object.hasOwn(out.sidecar.meshMetadata,id),true);
  }
});
test('camera global basis rejects direct and inherited affine scale or reflection',async()=>{
  for(const inherited of [false,true])for(const scale of [[2,1,1],[-1,1,1]]){
    const source=scene();source.space3d.camera={id:'eye',parent:'parent',projection:{kind:'perspective',fovY:1,near:.1,far:100}};
    if(inherited)source.space3d.nodes[0].transform.scale=scale;else source.space3d.camera.transform={scale};
    assert.throws(()=>exportGltfAsset(source),/CAMERA_RIGID/);
  }
  const source=scene();source.space3d.nodes[0].transform.scale=[2,1,1];source.space3d.camera={id:'eye',parent:'parent',transform:{scale:[.5,1,1]},projection:{kind:'perspective',fovY:1,near:.1,far:100}};
  await validate(exportGltfAsset(source));
});
