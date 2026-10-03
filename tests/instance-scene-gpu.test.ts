import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareSpace3D,prepareSpace3DSampler,validateSpace3D,type Space3D} from '../src/ir/scene3d.ts';
import {snapshotMeshResource,type MeshResource} from '../src/ir/mesh.ts';
import type {InstanceSet3D} from '../src/ir/instances.ts';
import {prepareGpuInstanceRuns,GPU_INSTANCE_BYTES} from '../src/renderers/gpu/instances.ts';
import {identityMatrix4,multiplyMatrix4,transformPoint3D,type Matrix4} from '../src/geometry/matrix4.ts';

const mesh:MeshResource={kind:'mesh',version:1,primitive:'triangles',units:'unit',coordinateSpace:'object',winding:'ccw',topologyRevision:'triangle',
 positions:{version:1,componentType:'float64',components:3,count:3,byteOffset:0,byteStride:24,data:[0,0,0,1,0,0,0,1,0]},
 indices:{version:1,componentType:'uint16',components:1,count:3,byteOffset:0,byteStride:2,data:[0,1,2]},bounds:{min:[0,0,0],max:[1,1,0]}};
const resources={prototype:mesh},context={duration:2,viewport:{width:100,height:100}};
function set():InstanceSet3D{return {version:1,prototypeResourceId:'prototype',units:'unit',instances:[{id:'a',transform:{translation:[2,0,0]}},{id:'b',transform:{translation:[100,0,0]},selected:false},{id:'c',transform:{translation:[-2,0,0],scale:[-1,1,1]},color:[0,1,0]}]};}
function space():Space3D{return {version:1,units:'unit',handedness:'right',upAxis:'z',nodes:[{id:'root',kind:'group',transform:{translation:[1,2,0]}},{id:'batch',kind:'instances',parent:'root',instanceSetId:'set',transform:{translation:[0,0,-2]}}],camera:{id:'camera',transform:{scale:[2,.5,1]},projection:{kind:'orthographic',height:10,near:.1,far:10}}};}

test('instance hierarchy composes parent, batch and element transforms; unselected bounds stay excluded',()=>{
 const result=prepareSpace3D(space(),resources,context,{set:set()}).instanceBatches![0];
 assert.deepEqual(result.instances.map(i=>i.id),['a','b','c']);assert.deepEqual(result.instances.map(i=>i.selected),[true,false,true]);
 assert.deepEqual(result.instances.map(i=>i.orientation),[1,1,-1]);
 assert.deepEqual(transformPoint3D(result.instances[0].worldMatrix,[1,1,0]),[4,3,-2]);
 assert.deepEqual(transformPoint3D(result.instances[0].modelViewMatrix!,[1,1,0]),[2,6,-2]);
 assert.deepEqual(result.worldBounds,{min:[-2,2,-2],max:[4,3,-2]});
 assert.deepEqual(result.instances[0].color,[1,1,1]);assert.ok(Object.isFrozen(result.instances[0].worldMatrix));
});

test('sampler snapshots sets, validates identity contract, accepts changed selection and reverses deterministically',()=>{
 const initial=set(),sampler=prepareSpace3DSampler(space(),resources,context,[],{},{set:initial});
 initial.instances[0].id='mutated';assert.equal(sampler(0).instanceBatches![0].instances[0].id,'a');
 const changed=set();changed.instances.forEach(i=>{i.selected=false;});assert.equal(sampler(1,undefined,undefined,{set:changed}).instanceBatches![0].worldBounds,null);
 assert.deepEqual(sampler(0),sampler(2));
 for(const changed of [{}, {set:{...set(),prototypeResourceId:'other'}},{set:{...set(),units:'cm'}},{set:{...set(),instances:[{id:'a'},{id:'a'}]}}])assert.throws(()=>sampler(0,undefined,undefined,changed as any));
 let calls=0;const value={set:set()};Object.defineProperty(value.set.instances[0],'color',{get(){calls++;return [1,1,1];},enumerable:true});
 assert.throws(()=>sampler(0,undefined,undefined,value));assert.equal(calls,0);
});

test('expanded instance budgets include repeated set references and sampled replacements before allocation',()=>{
 const large=set();large.instances=Array.from({length:2049},(_,i)=>({id:String(i)}));const program=space();program.nodes.push({kind:'instances',id:'second',instanceSetId:'set'});
 assert.ok(validateSpace3D(program,resources,'$.space3d',context,{set:large}).some(d=>d.code==='SPACE3D_INSTANCE_BUDGET'));
 const sampler=prepareSpace3DSampler(program,resources,context,[],{},{set:set()});
 assert.throws(()=>sampler(0,undefined,undefined,{set:large}),/SPACE3D_INSTANCE_BUDGET/);
});

test('GPU runs preserve order, own buffers and correct reflection without changing affine camera coordinates',()=>{
 const frame=prepareSpace3D(space(),resources,context,{set:set()}),batch=frame.instanceBatches![0];
 const before=JSON.stringify(batch),runs=prepareGpuInstanceRuns(batch,snapshotMeshResource(mesh),frame.camera!.projectionMatrix!);
 assert.deepEqual(runs.map(r=>[r.reflected,r.count,r.sourceIds]),[[false,1,['a']],[true,1,['c']]]);
 const reflection=[...identityMatrix4()] as Matrix4;reflection[0]=-1;
 for(const [j,run] of runs.entries()){
  const actual=multiplyMatrix4(run.reflected?reflection:identityMatrix4(),[...run.matrices] as Matrix4);
  assert.deepEqual(actual.map(n=>Object.is(n,-0)?0:n),batch.instances[j===0?0:2].modelViewMatrix!.map(n=>Math.fround(n)));
  assert.equal(run.matrices.byteLength+run.colors.byteLength,run.count*GPU_INSTANCE_BYTES);
 }
 runs[0].matrices[0]=123;runs[0].colors[0]=0;assert.equal(JSON.stringify(batch),before);
});

test('GPU invalid records, precision loss and excessive instance counts fail before uploads',()=>{
 const frame=prepareSpace3D(space(),resources,context,{set:set()}),batch=frame.instanceBatches![0];
 for(const change of [(b:any)=>b.instances[0].color=[2,0,0],(b:any)=>b.instances[0].selected=1,(b:any)=>b.instances[0].modelViewMatrix[0]=1e100,(b:any)=>b.instances[1].id='a',(b:any)=>b.instances=Array(4097).fill(b.instances[0])]){
  const invalid=structuredClone(batch);change(invalid);assert.throws(()=>prepareGpuInstanceRuns(invalid,snapshotMeshResource(mesh),frame.camera!.projectionMatrix!));
 }
});
