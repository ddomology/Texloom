import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareGpuGeometry,gpuBufferSize,gpuWireBufferSize,validateGpuSize,validateGpuColor,validateGpuMatrix,validateGpuTransformBounds,validateGpuOrientation,GpuRenderError} from '../src/renderers/gpu/data.ts';
import {attachMeshAttributes} from '../src/ir/attributes.ts';
import {validateSpace3D} from '../src/ir/scene3d.ts';
import {createGpuRenderer} from '../src/renderers/gpu/index.ts';
import {snapshotMeshResource,type MeshResource} from '../src/ir/mesh.ts';

const triangle=(positions:number[]=[-1,-1,0,1,-1,0,0,1,0]):MeshResource=>({kind:'mesh',version:1,primitive:'triangles',coordinateSpace:'object',units:'unit',winding:'ccw',topologyRevision:'v1',
  positions:{version:1,componentType:'float64',components:3,count:3,byteOffset:0,byteStride:24,data:positions},
  indices:{version:1,componentType:'uint16',components:1,count:3,byteOffset:0,byteStride:2,data:[0,1,2]},
  bounds:{min:[0,1,2].map(k=>Math.min(...[0,1,2].map(i=>positions[i*3+k]))) as [number,number,number],
    max:[0,1,2].map(k=>Math.max(...[0,1,2].map(i=>positions[i*3+k]))) as [number,number,number]}});
const hasCode=(code:string)=>(e:unknown)=>e instanceof GpuRenderError&&e.code===code;

test('color upload respects explicit vertex, face and corner domains and preserves shared seams',()=>{
  const base=triangle([-1,-1,0,1,-1,0,0,1,0]);base.indices.data=[0,1,2,2,1,0];base.indices.count=6;
  const buffer=(data:number[])=>({version:1 as const,componentType:'float64' as const,components:3 as const,count:data.length/3,byteOffset:0,byteStride:24,data});
  const resource=attachMeshAttributes(base,{
    vertex:{domain:'vertex',valueType:'color',buffer:buffer([1,0,0,0,1,0,0,0,1])},
    face:{domain:'face',valueType:'color',buffer:buffer([1,0,0,0,0,1])},
    corner:{domain:'corner',valueType:'color',buffer:buffer([1,0,0,1,0,0,1,0,0,0,0,1,0,0,1,0,0,1])},
  }),before=JSON.stringify(resource);
  const vertex=prepareGpuGeometry(resource,'vertex'),face=prepareGpuGeometry(resource,'face'),corner=prepareGpuGeometry(resource,'corner');
  assert.equal(vertex.positions.length,9);assert.deepEqual([...vertex.indices],[0,1,2,2,1,0]);
  assert.deepEqual([...face.indices],[0,1,2,3,4,5]);assert.equal(face.positions.length,18);
  assert.deepEqual(face.colors,corner.colors);assert.deepEqual([...face.positions.slice(9)],[0,1,0,1,-1,0,-1,-1,0]);
  assert.deepEqual([...corner.colors!.slice(6,12)],[1,0,0,0,0,1]);
  for(const [name,data] of [['vertex',vertex],['face',face],['corner',corner]] as const){assert.equal(data.bytes,gpuBufferSize(resource,name));assert.equal(gpuWireBufferSize(resource,name),24);}
  corner.colors![0]=.5;corner.positions[0]=100;corner.indices[0]=5;assert.equal(JSON.stringify(resource),before);
  assert.equal(prepareGpuGeometry(resource,'corner').colors![0],1);
  assert.throws(()=>prepareGpuGeometry(resource,'missing'),hasCode('GPU_COLOR_ATTRIBUTE'));
});

test('mesh material selects an existing color attribute and rejects scalar names',()=>{
  const mesh=attachMeshAttributes(triangle(),{height:{domain:'vertex',valueType:'scalar',buffer:{version:1,componentType:'float64',components:1,count:3,byteOffset:0,byteStride:8,data:[0,0,1]}}});
  const space={version:1,units:'unit',handedness:'right',upAxis:'z',nodes:[{kind:'mesh',id:'m',resourceId:'mesh',material:{kind:'unlit',color:'#ffffff',colorAttribute:'height'}}]};
  for(const name of ['height','missing','']){space.nodes[0].material.colorAttribute=name;assert.ok(validateSpace3D(space,{mesh:mesh as MeshResource}).some(d=>d.code==='SPACE3D_COLOR_ATTRIBUTE'));}
});

test('GPU modules import without DOM and construction fails with a specific browser diagnostic',()=>{
  assert.throws(()=>createGpuRenderer(),hasCode('GPU_BROWSER'));
  assert.throws(()=>createGpuRenderer({antialias:'no'} as any),hasCode('GPU_OPTIONS'));
});
test('GPU upload copies preserve shared resources and expose exact bounded byte sizes',()=>{
  const resource=snapshotMeshResource(triangle()),before=JSON.stringify(resource),a=prepareGpuGeometry(resource),b=prepareGpuGeometry(resource);
  assert.ok(a.positions instanceof Float32Array);assert.ok(a.indices instanceof Uint16Array);assert.equal(a.bytes,42);
  a.positions[0]=50;a.indices[0]=2;assert.equal(b.positions[0],-1);assert.equal(b.indices[0],0);assert.equal(JSON.stringify(resource),before);
});
test('float64 overflow, underflow and conversion-induced triangle collapse are explicit GPU limitations',()=>{
  for(const positions of [[-1e100,-1,0,1e100,-1,0,0,1,0],[-1e-100,-1,0,1e-100,-1,0,0,1,0],
    [1e8,0,0,1e8+1,0,0,1e8,1,0]])assert.throws(()=>prepareGpuGeometry(snapshotMeshResource(triangle(positions))),hasCode('GPU_PRECISION'));
  const nativeDegenerate=triangle([0,0,0,0,0,0,0,1,0]);assert.doesNotThrow(()=>prepareGpuGeometry(snapshotMeshResource(nativeDegenerate)));
});
test('GPU dimensions, colors and matrix uploads reject invalid or implicit presentation values',()=>{
  for(const [w,h] of [[0,1],[1.5,2],[4097,3],[3,Infinity]])assert.throws(()=>validateGpuSize(w,h),hasCode('GPU_SIZE'));
  validateGpuSize(4096,4096);validateGpuColor('transparent',true);validateGpuColor('#ABCdef');
  for(const value of ['red','#fff','#12345678','rgba(0,0,0,.5)'])assert.throws(()=>validateGpuColor(value),hasCode('GPU_COLOR'));
  assert.throws(()=>validateGpuMatrix(Array(16).fill(1e100),'test'),hasCode('GPU_PRECISION'));
  assert.throws(()=>validateGpuMatrix([1,2],'test'),hasCode('GPU_MATRIX'));
  const identity=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],scaled=[...identity];scaled[0]=1e30;
  assert.throws(()=>validateGpuTransformBounds({min:[1e20,0,0],max:[2e20,1,0]},scaled,identity),hasCode('GPU_PRECISION'));
  assert.doesNotThrow(()=>validateGpuTransformBounds({min:[-1,-1,-2],max:[1,1,-2]},identity,identity));
  const nearlySingular=[...identity];nearlySingular[0]=1;nearlySingular[1]=1;nearlySingular[4]=1;nearlySingular[5]=1+1e-8;
  assert.throws(()=>validateGpuOrientation(nearlySingular,1),hasCode('GPU_PRECISION'));
});
