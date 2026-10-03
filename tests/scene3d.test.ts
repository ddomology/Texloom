import test from 'node:test';
import assert from 'node:assert/strict';
import {createEvaluator,prepareScene,prepareSceneAsync,validateBundle,validateSpace3D,prepareSpace3D,
  NUMERIC_3D_PROFILE,SVG_2D_PROFILE,CANVAS_2D_PROFILE,copyMeshBuffers,transformPoint3D,transformNormal3D,
  type Bundle,type MeshResource,type Space3D} from '../src/index.ts';
import {renderSvg} from '../src/render-svg.ts';
import {renderCanvas} from '../src/render-canvas.ts';
import {validateScenePackage} from '../src/resources/package.ts';

function cube():MeshResource{return {kind:'mesh',version:1,primitive:'triangles',units:'m',coordinateSpace:'object',winding:'ccw',topologyRevision:'cube-1',
  positions:{version:1,componentType:'float64',components:3,count:8,byteOffset:0,byteStride:24,data:[-1,-1,-1,1,-1,-1,1,1,-1,-1,1,-1,-1,-1,1,1,-1,1,1,1,1,-1,1,1]},
  indices:{version:1,componentType:'uint16',components:1,count:36,byteOffset:0,byteStride:2,data:[0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,3,7,6,3,6,2,0,4,7,0,7,3,1,2,6,1,6,5]},
  bounds:{min:[-1,-1,-1],max:[1,1,1]}};}
function bundle():Bundle{return {version:'0.3',title:'Spatial contract',duration:3,units:'bp',viewport:{width:100,height:50},
  camera:{x:0,y:0,zoom:1},nodes:[],tracks:[],relations:[],resources:{cube:cube()},
  space3d:{version:1,units:'m',handedness:'right',upAxis:'z',nodes:[
    {id:'a',kind:'mesh',parent:'root',resourceId:'cube',transform:{translation:[2,0,0],scale:[2,1,.5]}},
    {id:'b',kind:'mesh',parent:'root',resourceId:'cube',transform:{translation:[-3,0,1],scale:[-1,2,1]}},
    {id:'root',kind:'group',transform:{translation:[1,2,3]}}],
    camera:{id:'camera',parent:'root',transform:{translation:[0,-8,5]}}}};}
const errors=(b:Bundle)=>validateBundle(b).filter(d=>d.severity==='error');
test('shared cube evaluates analytic world/camera coordinates and reflection without changing source vertices',()=>{
  const input=bundle(),original=structuredClone(input),runtime=prepareScene(input),frame=runtime.sample(1),s=frame.space3d!;
  assert.equal(s.instances.length,2);assert.equal(s.instances[0].resourceId,s.instances[1].resourceId);
  assert.deepEqual(transformPoint3D(s.instances[0].worldMatrix,[1,1,1]),[5,3,3.5]);
  assert.deepEqual(transformPoint3D(s.instances[0].modelViewMatrix!,[1,1,1]),[4,9,-4.5]);
  assert.deepEqual(s.instances[0].worldBounds,{min:[1,1,2.5],max:[5,3,3.5]});
  assert.deepEqual(s.instances[1].worldBounds,{min:[-3,0,3],max:[-1,4,5]});
  assert.deepEqual(s.instances.map(i=>[i.orientation,i.worldWinding]),[[1,'ccw'],[-1,'cw']]);
  assert.deepEqual(s.instances[0].normalMatrix,[.5,0,0,0,1,0,0,0,2]);
  assert.deepEqual(transformPoint3D(s.camera!.viewMatrix,[1,-6,8]),[0,0,0]);
  assert.deepEqual(input,original);
});
test('prepared spatial state and resources are immutable snapshots; reverse/repeated samples are identical',()=>{
  const input=bundle(),run=createEvaluator(input),one=run(1),resource=one.resources.cube as MeshResource;
  (input.resources.cube as MeshResource).positions.data[0]=999;input.space3d!.nodes[2].transform={translation:[999,999,999]};
  assert.equal(resource.positions.data[0],-1);assert.strictEqual(run(3).space3d,one.space3d);
  assert.deepEqual(run(0).space3d,one.space3d);assert.ok(Object.isFrozen(one.space3d!.instances[0].worldMatrix));
  const a=copyMeshBuffers(resource),b=copyMeshBuffers(resource);a.positions[0]=123;a.indices[0]=7;
  assert.equal(b.positions[0],-1);assert.equal(b.indices[0],0);assert.equal(resource.positions.data[0],-1);
});
test('singular mesh transform is a valid forward map with explicit unavailable normals',()=>{
  const input=bundle();input.space3d!.nodes[0].transform={scale:[1,0,2]};
  const s=prepareScene(input).sample(0).space3d!;
  assert.equal(s.instances[0].normalMatrix,null);assert.equal(s.instances[0].worldWinding,null);
  assert.equal(s.instances[0].orientation,0);assert.equal(s.diagnostics[0].code,'SPACE3D_SINGULAR_NORMAL');
  assert.deepEqual(s.instances[0].worldBounds,{min:[0,2,1],max:[2,2,5]});
});
test('camera requires an invertible complete ancestor transform',()=>{
  const input=bundle();input.space3d!.nodes[2].transform={scale:[1,0,1]};
  assert.ok(errors(input).some(d=>d.code==='MATRIX4_SINGULAR'));assert.throws(()=>prepareScene(input),/MATRIX4_SINGULAR/);
});
test('empty mesh and absent camera preserve null bounds and model-view',()=>{
  const input=bundle(),m=input.resources.cube as MeshResource;m.positions.count=0;m.positions.data=[];m.indices.count=0;m.indices.data=[];m.bounds=null;
  delete input.space3d!.camera;const s=prepareScene(input).sample(0).space3d!;
  assert.equal(s.camera,null);assert.equal(s.instances[0].worldBounds,null);assert.equal(s.instances[0].modelViewMatrix,null);
});
test('units, invalid indices, unsupported fields and missing resources are rejected even for hidden meshes',()=>{
  for(const mutate of [
    (b:Bundle)=>{b.space3d!.units='cm';},
    (b:Bundle)=>{(b.resources.cube as MeshResource).indices.data[0]=8;},
    (b:Bundle)=>{Object.assign(b.space3d!,{projection:'perspective'});},
    (b:Bundle)=>{Object.assign(b.space3d!.nodes[0],{visible:false,resourceId:'absent'});},
    (b:Bundle)=>{b.version='0.2';},
  ]){const input=bundle();mutate(input);assert.ok(errors(input).length);assert.throws(()=>prepareScene(input));}
});
test('malformed resource IDs return diagnostics, never coerce arbitrary objects',()=>{
  const input=bundle();Object.assign(input.space3d!.nodes[0],{resourceId:{toString:0,valueOf:0}});
  assert.ok(validateSpace3D(input.space3d,input.resources).some(d=>d.code==='SPACE3D_RESOURCE'));
  const {resources,...scene}=input;
  assert.ok(validateScenePackage({contract:'texloom-package/1',scene,assets:{version:1,requiredFeatures:[],entries:[]}}).some(d=>d.code==='ASSET_REFERENCE'));
  const long=bundle(),id='r'.repeat(512);long.resources[id]=long.resources.cube;delete long.resources.cube;
  for(const node of long.space3d!.nodes)if(node.kind==='mesh')node.resourceId=id;
  assert.deepEqual(errors(long),[]);
});
test('parent IDs have their own 3D namespace and camera/mesh parents/cycles/duplicates fail',()=>{
  for(const mutate of [
    (s:Space3D)=>{s.nodes[2].parent='a';},
    (s:Space3D)=>{s.nodes[2].parent='root';},
    (s:Space3D)=>{s.nodes[0].parent='camera';},
    (s:Space3D)=>{s.camera!.id='a';},
    (s:Space3D)=>{s.nodes[0].parent='missing-2d';},
  ]){const b=bundle();mutate(b.space3d!);assert.ok(errors(b).length);}
  const b=bundle();b.nodes=[{id:'root',kind:'group',transform:{translate:[100,100]}}];
  assert.deepEqual(prepareScene(b).sample(0).space3d!.instances[0].worldBounds,{min:[1,1,2.5],max:[5,3,3.5]});
});
test('deep flat hierarchy evaluates iteratively without stack dependence',()=>{
  const b=bundle();delete b.space3d!.camera;b.space3d!.nodes=Array.from({length:700},(_,i)=>({kind:'group',id:`g${i}`,...(i?{parent:`g${i-1}`} : {}),transform:{translation:[1,0,0]}}));
  b.space3d!.nodes.push({kind:'mesh',id:'leaf',parent:'g699',resourceId:'cube'});
  assert.deepEqual(prepareScene(b).sample(0).space3d!.instances[0].worldBounds,{min:[699,-1,-1],max:[701,1,1]});
});
test('2D consumers reject 3D data explicitly; numeric preparation is opt-in',async()=>{
  const b=bundle(),runtime=prepareScene(b),frame=runtime.sample(0);
  runtime.require(NUMERIC_3D_PROFILE);assert.throws(()=>runtime.require(SVG_2D_PROFILE),/RENDER_CAPABILITY/);
  assert.throws(()=>runtime.require(CANVAS_2D_PROFILE),/RENDER_CAPABILITY/);
  assert.throws(()=>renderSvg(frame),/RENDER_CAPABILITY/);
  assert.throws(()=>renderCanvas(frame,{} as CanvasRenderingContext2D),/RENDER_CAPABILITY/);
  await assert.rejects(prepareSceneAsync(b),/RENDER_CAPABILITY/);
  const prepared=await prepareSceneAsync(b,{profile:NUMERIC_3D_PROFILE});assert.deepEqual(prepared.sample(0).space3d,frame.space3d);prepared.dispose();
  delete b.space3d;const bare=createEvaluator(b)(0);assert.throws(()=>renderSvg(bare),/RENDER_CAPABILITY/);
  assert.throws(()=>renderCanvas(bare,{} as CanvasRenderingContext2D),/RENDER_CAPABILITY/);
});
test('normal inverse transpose preserves perpendicularity under shear, rather than transforming like a position',()=>{
  const b=bundle();delete b.space3d!.camera;b.space3d!.nodes=[{id:'shear',kind:'mesh',resourceId:'cube',transform:{matrix:[2,0,0,0,1,3,0,0,0,1,4,0,5,6,7,1]}}];
  const s=prepareScene(b).sample(0).space3d!.instances[0],n=transformNormal3D(s.worldMatrix,[0,0,1]);
  assert.deepEqual(n,[0,0,1]);assert.ok(Math.abs(s.normalMatrix![0]-.5)<1e-12);
});
test('public spatial preparation refuses invalid resources and snapshots the result',()=>{
  const b=bundle();const s=prepareSpace3D(b.space3d!,b.resources);assert.ok(Object.isFrozen(s));
  (b.resources.cube as MeshResource).positions.data[0]=NaN;assert.throws(()=>prepareSpace3D(b.space3d!,b.resources));
});
