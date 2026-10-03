import test from 'node:test';
import assert from 'node:assert/strict';
import {realizeMeshInstances,derivedInstanceTopologyRevision,type RealizeMeshOptions} from '../src/operations/realize-instances.ts';
import {exactInstanceSetBounds,type InstanceSet3D} from '../src/ir/instances.ts';
import {copyMeshBuffers,validateMeshResource,type MeshResource} from '../src/ir/mesh.ts';
import {attachMeshAttributes,copyMeshAttribute} from '../src/ir/attributes.ts';
import type {NumericBuffer} from '../src/resources/buffers.ts';

const buffer=(data:number[],components:1|2|3,componentType:NumericBuffer['componentType']='float64'):NumericBuffer=>({version:1,componentType,components,count:data.length/components,byteOffset:0,byteStride:components*(componentType==='float64'?8:4),data});
const mesh=():MeshResource=>({kind:'mesh',version:1,primitive:'triangles',units:'unit',coordinateSpace:'object',winding:'ccw',topologyRevision:'tri',positions:buffer([0,0,0,1,0,0,0,1,0],3),indices:buffer([0,1,2],1,'uint32'),normals:buffer([0,0,1,0,0,1,0,0,1],3),bounds:{min:[0,0,0],max:[1,1,0]}});
const set=():InstanceSet3D=>({version:1,prototypeResourceId:'prototype',units:'unit',instances:[{id:'a',transform:{translation:[2,1,0],scale:[2,3,1]},color:[.2,.4,.8]},{id:'b',transform:{translation:[-2,0,1],scale:[-1,2,1]},selected:false}]});
const options:RealizeMeshOptions={topologyRevision:'realized',normalPolicy:'transform',selection:'all'};
const code=(fn:()=>unknown,expected:string)=>assert.throws(fn,(error:any)=>error.diagnostics?.some((d:any)=>d.code===expected));

test('explicit realization reproduces exact transformed geometry and stable ranges without shared writable arrays',()=>{
  const prototype=mesh(),instances=set(),before=JSON.stringify([prototype,instances]);const output=realizeMeshInstances(instances,prototype,options),data=copyMeshBuffers(output.mesh);
  assert.deepEqual([...data.positions],[2,1,0,4,1,0,2,4,0,-2,0,1,-3,0,1,-2,2,1]);
  assert.deepEqual([...data.indices],[0,1,2,3,5,4]);assert.deepEqual(output.mesh.bounds,exactInstanceSetBounds(instances,prototype,{selection:'all'}));
  assert.deepEqual(output.ranges,[{id:'a',vertexStart:0,vertexCount:3,faceStart:0,faceCount:1,reflected:false,selected:true},{id:'b',vertexStart:3,vertexCount:3,faceStart:1,faceCount:1,reflected:true,selected:false}]);
  assert.equal(output.report.reflectedInstances,1);assert.equal(output.report.bufferBytes,6*3*8*2+6*4);
  assert.equal(JSON.stringify([prototype,instances]),before);assert.ok(Object.isFrozen(output.mesh.positions.data));assert.ok(Object.isFrozen(output.ranges));
  data.positions[0]=100;assert.equal(copyMeshBuffers(output.mesh).positions[0],2);
  assert.deepEqual(realizeMeshInstances(instances,prototype,options),output);
});

test('reflection permutes corner attributes together with indices and repeats other domains unchanged',()=>{
  const prototype=attachMeshAttributes(mesh(),{
    captured:{domain:'vertex',valueType:'vec3',buffer:buffer([0,0,0,1,0,0,0,1,0],3)},
    weight:{domain:'vertex',valueType:'scalar',buffer:buffer([10,20,30],1)},
    uv:{domain:'corner',valueType:'vec2',buffer:buffer([0,0,1,0,0,1],2)},
    faceColor:{domain:'face',valueType:'color',buffer:buffer([.1,.2,.3],3)},
  });
  const output=realizeMeshInstances(set(),prototype,{...options,instanceColorAttribute:'tint',instanceSelectionAttribute:'selection'});
  assert.deepEqual([...copyMeshAttribute(output.mesh,'uv')],[0,0,1,0,0,1,0,0,0,1,1,0]);
  assert.deepEqual([...copyMeshAttribute(output.mesh,'captured')],[0,0,0,1,0,0,0,1,0,0,0,0,1,0,0,0,1,0]);
  assert.deepEqual([...copyMeshAttribute(output.mesh,'weight')],[10,20,30,10,20,30]);
  assert.deepEqual([...copyMeshAttribute(output.mesh,'faceColor')],[.1,.2,.3,.1,.2,.3]);
  assert.deepEqual([...copyMeshAttribute(output.mesh,'tint')],[.2,.4,.8,.2,.4,.8,.2,.4,.8,1,1,1,1,1,1,1,1,1]);
  assert.deepEqual([...copyMeshAttribute(output.mesh,'selection')],[1,1,1,0,0,0]);
  assert.deepEqual(output.mesh.attributes!.topology.indices,[0,1,2,3,5,4]);assert.deepEqual(validateMeshResource(output.mesh),[]);
});

test('normal transformation is inverse transpose, while singular normal requests require an explicit drop',()=>{
  const prototype=mesh(),n=Math.SQRT1_2;prototype.normals=buffer([n,n,0,n,n,0,n,n,0],3);
  const instances=set();instances.instances=[{id:'scaled',transform:{scale:[2,1,1]}}];
  const result=realizeMeshInstances(instances,prototype,options),normal=copyMeshBuffers(result.mesh).normals!;
  assert.ok(Math.abs(normal[0]-1/Math.sqrt(5))<1e-15);assert.ok(Math.abs(normal[1]-2/Math.sqrt(5))<1e-15);
  instances.instances[0].transform={scale:[0,1,1]};code(()=>realizeMeshInstances(instances,prototype,options),'MATRIX4_SINGULAR');
  const dropped=realizeMeshInstances(instances,prototype,{...options,normalPolicy:'drop'});assert.equal(dropped.mesh.normals,undefined);
  assert.ok(validateMeshResource(dropped.mesh).some(d=>d.code==='MESH_DEGENERATE'&&d.severity==='warning'));
  delete prototype.normals;assert.doesNotThrow(()=>realizeMeshInstances(instances,prototype,options));
});

test('selection controls allocation and geometry without replacing stable records or synthesizing instances',()=>{
  const output=realizeMeshInstances(set(),mesh(),{topologyRevision:'selected',normalPolicy:'drop'});
  assert.equal(output.report.instances,1);assert.equal(output.ranges[0].id,'a');assert.equal(output.mesh.positions.count,3);
  const empty=set();empty.instances=[];const result=realizeMeshInstances(empty,mesh(),{...options,instanceColorAttribute:'color'});
  assert.equal(result.mesh.bounds,null);assert.equal(result.mesh.positions.count,0);assert.equal(result.mesh.attributes!.values.color.buffer.count,0);
  const blank=mesh();blank.positions=buffer([],3);blank.indices=buffer([],1,'uint32');blank.normals=buffer([],3);blank.bounds=null;
  const retained=realizeMeshInstances(set(),blank,options);assert.equal(retained.ranges.length,2);assert.equal(retained.report.bufferBytes,0);
});

test('attribute names and budgets are explicit, checked before expanded output allocations',()=>{
  const prototype=attachMeshAttributes(mesh(),{color:{domain:'vertex',valueType:'color',buffer:buffer(Array(9).fill(.5),3)}});
  code(()=>realizeMeshInstances(set(),prototype,{...options,instanceColorAttribute:'color'}),'INSTANCE_ATTRIBUTE_CONFLICT');
  code(()=>realizeMeshInstances(set(),mesh(),{...options,instanceColorAttribute:'same',instanceSelectionAttribute:'same'}),'INSTANCE_ATTRIBUTE_CONFLICT');
  code(()=>realizeMeshInstances(set(),mesh(),{...options,instanceColorAttribute:'constructor'}),'INSTANCE_ATTRIBUTE_NAME');
  code(()=>realizeMeshInstances(set(),mesh(),{...options,maxVertices:5}),'INSTANCE_BUDGET');
  code(()=>realizeMeshInstances(set(),mesh(),{...options,maxBytes:100}),'INSTANCE_BUDGET');
  code(()=>realizeMeshInstances(set(),mesh(),{...options,maxBytes:Infinity}),'ASSET_JSON_VALUE');
  code(()=>realizeMeshInstances(set(),mesh(),{...options,normalPolicy:'guess'} as any),'INSTANCE_NORMAL_POLICY');
  code(()=>realizeMeshInstances(set(),mesh(),null as any),'INSTANCE_OPTIONS');
  let reads=0;const evil:any={...options};Object.defineProperty(evil,'selection',{enumerable:true,get(){reads++;throw Error('invoked');}});
  code(()=>realizeMeshInstances(set(),mesh(),evil),'ASSET_JSON_VALUE');assert.equal(reads,0);
  const many=set();many.instances=Array.from({length:4096},(_,i)=>({id:String(i)}));
  const large=mesh();large.positions=buffer(Array.from({length:100*3},(_,i)=>i%3===0?i/3:0),3);large.bounds={min:[0,0,0],max:[99,0,0]};delete large.normals;
  code(()=>realizeMeshInstances(many,large,options),'INSTANCE_BUDGET');
});

test('derived topology identity is stable under deformation and color, but follows ordering, selection and reflection',()=>{
  const prototype=mesh(),instances=set(),original=derivedInstanceTopologyRevision(instances,prototype,'all');
  const deformed=mesh();deformed.positions.data=deformed.positions.data.map(v=>v*2);deformed.bounds={min:[0,0,0],max:[2,2,0]};
  const moved=set();moved.instances[0].color=[0,1,0];moved.instances[0].transform={translation:[10,20,30],scale:[3,4,5]};
  assert.equal(derivedInstanceTopologyRevision(moved,deformed,'all'),original);
  const reversed=set();reversed.instances.reverse();assert.notEqual(derivedInstanceTopologyRevision(reversed,prototype,'all'),original);
  const flipped=set();flipped.instances[0].transform={scale:[-1,1,1]};assert.notEqual(derivedInstanceTopologyRevision(flipped,prototype,'all'),original);
  assert.notEqual(derivedInstanceTopologyRevision(instances,prototype),original);
  const reindexed=mesh();reindexed.indices.data=[0,2,1];assert.notEqual(derivedInstanceTopologyRevision(instances,reindexed,'all'),original);
});
