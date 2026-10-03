import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareGpuGeometry,validateGpuSize,validateGpuColor,validateGpuMatrix,validateGpuTransformBounds,validateGpuOrientation,GpuRenderError} from '../src/renderers/gpu/data.ts';
import {createGpuRenderer} from '../src/renderers/gpu/index.ts';
import {snapshotMeshResource,type MeshResource} from '../src/ir/mesh.ts';

const triangle=(positions:number[]=[-1,-1,0,1,-1,0,0,1,0]):MeshResource=>({kind:'mesh',version:1,primitive:'triangles',coordinateSpace:'object',units:'unit',winding:'ccw',topologyRevision:'v1',
  positions:{version:1,componentType:'float64',components:3,count:3,byteOffset:0,byteStride:24,data:positions},
  indices:{version:1,componentType:'uint16',components:1,count:3,byteOffset:0,byteStride:2,data:[0,1,2]},
  bounds:{min:[0,1,2].map(k=>Math.min(...[0,1,2].map(i=>positions[i*3+k]))) as [number,number,number],
    max:[0,1,2].map(k=>Math.max(...[0,1,2].map(i=>positions[i*3+k]))) as [number,number,number]}});
const hasCode=(code:string)=>(e:unknown)=>e instanceof GpuRenderError&&e.code===code;

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
