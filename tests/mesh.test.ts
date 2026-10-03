import test from 'node:test';
import assert from 'node:assert/strict';
import {copyMeshBuffers,snapshotMeshResource,validateMeshResource,MeshError,type MeshResource} from '../src/ir/mesh.ts';
import type {NumericBuffer} from '../src/resources/buffers.ts';

const numeric=(data:number[],components:1|3,componentType:NumericBuffer['componentType']='float64'):NumericBuffer=>({
  version:1,componentType,components,count:data.length/components,byteOffset:0,
  byteStride:components*(componentType==='float64'?8:componentType==='uint16'?2:4),data});
const mesh=():MeshResource=>({kind:'mesh',version:1,primitive:'triangles',units:'m',coordinateSpace:'object',winding:'ccw',topologyRevision:'quad-v1',
  positions:numeric([-1,0,0,1,0,0,1,2,0,-1,2,0],3),indices:numeric([0,1,2,0,2,3],1,'uint16'),
  normals:numeric([0,0,1,0,0,1,0,0,1,0,0,1],3),bounds:{min:[-1,0,0],max:[1,2,0]}});
const code=(input:unknown,expected:string)=>assert.ok(validateMeshResource(input).some(d=>d.code===expected),JSON.stringify(validateMeshResource(input)));

test('mesh resource snapshots stay portable and each consumer owns its compact typed arrays',()=>{
  const source=mesh(),json=JSON.stringify(source),frozen=snapshotMeshResource(source);
  assert.deepEqual(validateMeshResource(source),[]);assert.equal(JSON.stringify(frozen),json);
  assert.ok(Object.isFrozen(frozen.positions.data));assert.ok(Object.isFrozen(frozen.bounds!.min));
  const a=copyMeshBuffers(frozen),b=copyMeshBuffers(frozen);
  assert.equal(a.triangleCount,2);assert.deepEqual(a.degenerateTriangles,[]);
  a.positions[0]=99;a.indices[0]=3;a.normals![2]=-1;
  assert.equal(b.positions[0],-1);assert.equal(b.indices[0],0);assert.equal(b.normals![2],1);
  assert.equal(JSON.stringify(frozen),json);assert.equal(JSON.stringify(source),json);
  source.positions.data[0]=-9;assert.equal(frozen.positions.data[0],-1);
});

test('bounds use all converted positions, including unreferenced vertices and float32 rounding',()=>{
  const source=mesh();source.positions=numeric([.1,0,0,1,0,0,0,1,0,5,5,5],3,'float32');
  source.indices=numeric([0,1,2],1,'uint32');delete source.normals;
  source.bounds={min:[0,0,0],max:[5,5,5]};assert.deepEqual(validateMeshResource(source),[]);
  source.positions=numeric([.1,0,0,1,0,0,.1,1,0],3,'float32');source.bounds={min:[.1,0,0],max:[1,1,0]};
  code(source,'MESH_BOUNDS');source.bounds.min[0]=Math.fround(.1);
  assert.deepEqual(validateMeshResource(source),[]);assert.equal(copyMeshBuffers(source).positions[0],Math.fround(.1));
  source.bounds.max[0]=2;code(source,'MESH_BOUNDS');
});

test('padded/interleaved attributes and full uint32 indices preserve object-space data',()=>{
  const source=mesh(),plain=source.positions.data;
  source.positions={version:1,componentType:'float64',components:3,count:4,byteOffset:8,byteStride:32,
    data:[777,...plain.slice(0,3),888,...plain.slice(3,6),888,...plain.slice(6,9),888,...plain.slice(9)]};
  source.indices=numeric([0,1,2,0,2,3],1,'uint32');
  assert.deepEqual(validateMeshResource(source),[]);assert.deepEqual([...copyMeshBuffers(source).positions],plain);
  assert.ok(copyMeshBuffers(source).indices instanceof Uint32Array);
});

test('empty meshes have null bounds and no hidden point-only triangle interpretation',()=>{
  const source=mesh();source.positions=numeric([],3);source.indices=numeric([],1,'uint16');source.normals=numeric([],3);source.bounds=null;
  assert.deepEqual(validateMeshResource(source),[]);assert.equal(copyMeshBuffers(source).triangleCount,0);
  assert.equal(copyMeshBuffers(source).bounds,null);
  source.bounds={min:[0,0,0],max:[0,0,0]};code(source,'MESH_BOUNDS');
  const pointOnly=mesh();pointOnly.indices=numeric([],1,'uint16');code(pointOnly,'MESH_EMPTY');
});

test('degenerate triangles survive with explicit warnings instead of changing authored topology',()=>{
  const source=mesh();source.indices=numeric([0,0,1,0,1,2],1,'uint16');
  const warnings=validateMeshResource(source);assert.equal(warnings.length,1);assert.equal(warnings[0].severity,'warning');
  assert.equal(warnings[0].code,'MESH_DEGENERATE');assert.doesNotThrow(()=>snapshotMeshResource(source));
  const result=copyMeshBuffers(source);assert.deepEqual(result.degenerateTriangles,[0]);assert.deepEqual([...result.indices],[0,0,1,0,1,2]);
  source.positions=numeric([0,0,0,1,0,0,2,0,0],3);source.indices=numeric([0,1,2],1,'uint16');
  delete source.normals;source.bounds={min:[0,0,0],max:[2,0,0]};
  assert.deepEqual(copyMeshBuffers(source).degenerateTriangles,[0]);
});

test('CCW is a front-face convention, not a false claim of global outward or manifold orientation',()=>{
  const source=mesh();source.indices=numeric([2,1,0,3,2,0,0,2,1],1,'uint16');
  // Reversed and nonmanifold artist topology, with intentionally independently authored unit normals.
  assert.deepEqual(validateMeshResource(source),[]);assert.equal(copyMeshBuffers(source).triangleCount,3);
  source.winding='cw' as any;code(source,'MESH_WINDING');
});

test('finite float64 geometry avoids a GPU precision requirement and cross-product overflow',()=>{
  const source=mesh();source.positions=numeric([-1e300,0,0,1e300,0,0,0,1e300,0],3);
  source.indices=numeric([0,1,2],1,'uint16');delete source.normals;
  source.bounds={min:[-1e300,0,0],max:[1e300,1e300,0]};
  assert.deepEqual(validateMeshResource(source),[]);assert.deepEqual(copyMeshBuffers(source).degenerateTriangles,[]);
  assert.equal(copyMeshBuffers(source).positions[0],-1e300);
  source.positions=numeric([0,0,1e308,1,0,1e308,0,1,1e308],3);
  source.bounds={min:[0,0,1e308],max:[1,1,1e308]};
  assert.deepEqual(validateMeshResource(source),[]);assert.deepEqual(copyMeshBuffers(source).degenerateTriangles,[]);
  source.positions=numeric([-1e308,0,0,1e308,0,0,0,1,0],3);
  source.bounds={min:[-1e308,0,0],max:[1e308,1,0]};
  assert.deepEqual(validateMeshResource(source),[]);assert.deepEqual(copyMeshBuffers(source).degenerateTriangles,[]);
});

test('invalid mesh shape, indices, normal contracts and bounds produce contextual diagnostics',()=>{
  const variants:[(s:any)=>void,string][]=[
    [s=>s.version=2,'MESH_VERSION'],[s=>s.coordinateSpace='world','MESH_SPACE'],[s=>s.units='bp','MESH_UNIT'],
    [s=>s.topologyRevision='','MESH_REVISION'],[s=>s.primitive='lines','MESH_PRIMITIVE'],
    [s=>s.indices.data[0]=4,'MESH_INDEX_RANGE'],[s=>s.indices.data[0]=-.1,'BUFFER_VALUE'],
    [s=>s.indices=numeric([0,1],1,'uint16'),'MESH_INDICES'],[s=>s.indices=numeric([0,1,2],1),'MESH_INDICES'],
    [s=>s.positions=numeric([0,1,2,3],1),'MESH_ATTRIBUTE'],[s=>s.normals=numeric([0,0,1],3),'MESH_NORMAL_COUNT'],
    [s=>s.normals.data[2]=0,'MESH_NORMAL'],[s=>s.normals.data[2]=1.0002,'MESH_NORMAL'],
    [s=>s.bounds=null,'MESH_BOUNDS'],[s=>s.bounds.max[1]=-5,'MESH_BOUNDS'],[s=>s.gpuHandle=1,'MESH_PROPERTY'],
  ];
  for(const [change,expected] of variants){const value=mesh();change(value);code(value,expected);
    assert.throws(()=>copyMeshBuffers(value),(e:unknown)=>e instanceof MeshError&&e.diagnostics.some(d=>d.code===expected&&d.path?.startsWith('$.mesh')));}
  let calls=0;const value=mesh();Object.defineProperty(value,'positions',{enumerable:true,get(){calls++;throw Error('getter');}});
  code(value,'ASSET_JSON_VALUE');assert.equal(calls,0);
});
