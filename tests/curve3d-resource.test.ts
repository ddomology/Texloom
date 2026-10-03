import test from 'node:test';
import assert from 'node:assert/strict';
import {copyCurve3DBuffers,snapshotCurve3DResource,validateCurve3DResource,CurveResource3DError,type Curve3DResource} from '../src/ir/curve3d.ts';
import {prepareGpuCurveGeometry,gpuCurveBufferSize} from '../src/renderers/gpu/curve-data.ts';
import {GpuRenderError} from '../src/renderers/gpu/data.ts';

const curve=(data=[-1,0,0,1,2,0,3,1,0],closed=false):Curve3DResource=>({kind:'curve3d',version:1,primitive:'line-strip',units:'m',coordinateSpace:'object',closed,
  topologyRevision:'line-v1',positions:{version:1,componentType:'float64',components:3,count:data.length/3,byteOffset:0,byteStride:24,data},
  bounds:data.length?{min:[0,1,2].map(k=>Math.min(...data.filter((_,i)=>i%3===k))) as [number,number,number],max:[0,1,2].map(k=>Math.max(...data.filter((_,i)=>i%3===k))) as [number,number,number]}:null});
const code=(resource:unknown,expected:string)=>assert.ok(validateCurve3DResource(resource).some(d=>d.code===expected),JSON.stringify(validateCurve3DResource(resource)));
const gpuCode=(error:unknown)=>error instanceof GpuRenderError&&error.code==='GPU_PRECISION';

test('curve resources are frozen portable JSON and typed copies are owned by each consumer',()=>{
  const source=curve(),before=JSON.stringify(source),snapshot=snapshotCurve3DResource(source),a=copyCurve3DBuffers(snapshot),b=copyCurve3DBuffers(snapshot);
  assert.deepEqual(validateCurve3DResource(source),[]);assert.equal(a.segmentCount,2);assert.equal(a.closed,false);
  assert.ok(Object.isFrozen(snapshot.positions.data));assert.ok(Object.isFrozen(snapshot.bounds!.min));
  a.positions[0]=100;assert.equal(b.positions[0],-1);assert.equal(snapshot.positions.data[0],-1);assert.equal(JSON.stringify(source),before);
  source.positions.data[0]=-99;assert.equal(snapshot.positions.data[0],-1);
});

test('position strides, float32 conversion and exact converted bounds remain distinct from GPU storage',()=>{
  const source=curve();source.positions={version:1,componentType:'float64',components:3,count:3,byteOffset:8,byteStride:32,data:[77,-1,0,0,88,1,2,0,99,3,1,0]};
  assert.deepEqual([...copyCurve3DBuffers(source).positions],curve().positions.data);
  const f32=curve([.1,0,0,.2,1,0]);f32.positions.componentType='float32';f32.positions.byteStride=12;
  code(f32,'CURVE3D_BOUNDS');f32.bounds!.min[0]=Math.fround(.1);f32.bounds!.max[0]=Math.fround(.2);
  assert.equal(copyCurve3DBuffers(f32).positions[0],Math.fround(.1));assert.ok(copyCurve3DBuffers(f32).positions instanceof Float32Array);
});

test('closed line strips use explicit repeated endpoints and empty curves keep null bounds',()=>{
  const closed=curve([0,0,0,1,0,0,0,1,0,0,0,0],true),owned=copyCurve3DBuffers(closed);
  assert.equal(owned.segmentCount,3);assert.equal(owned.closed,true);assert.deepEqual(validateCurve3DResource(closed),[]);
  closed.positions.data[9]=.01;code(closed,'CURVE3D_CLOSED');
  for(const flag of [false,true]){const empty=curve([],flag);assert.deepEqual(validateCurve3DResource(empty),[]);assert.equal(copyCurve3DBuffers(empty).segmentCount,0);assert.equal(copyCurve3DBuffers(empty).bounds,null);}
  const wrong=curve([]);wrong.bounds={min:[0,0,0],max:[0,0,0]};code(wrong,'CURVE3D_BOUNDS');
});

test('curve resource failures are diagnostic and never invoke accessor properties',()=>{
  const cases:[(v:any)=>void,string][]=[
    [v=>v.kind='mesh','CURVE3D_RESOURCE'],[v=>v.version=2,'CURVE3D_RESOURCE'],[v=>v.primitive='points','CURVE3D_RESOURCE'],
    [v=>v.units='bp','CURVE3D_UNITS'],[v=>v.coordinateSpace='world','CURVE3D_UNITS'],[v=>v.closed=null,'CURVE3D_CLOSED'],
    [v=>v.topologyRevision='','CURVE3D_REVISION'],[v=>v.bounds=null,'CURVE3D_BOUNDS'],[v=>v.bounds.max[0]=10,'CURVE3D_BOUNDS'],
    [v=>v.positions.data[3]=10,'CURVE3D_BOUNDS'],[v=>v.positions.count=1,'CURVE3D_COUNT'],
    [v=>v.rendererHandle=1,'CURVE3D_PROPERTY'],[v=>v.positions.data[0]=Infinity,'ASSET_JSON_VALUE'],
  ];
  for(const [edit,expected] of cases){const source=curve();edit(source);code(source,expected);assert.throws(()=>copyCurve3DBuffers(source),e=>e instanceof CurveResource3DError);}
  code(curve([0,0,0,0,0,0]),'CURVE3D_DEGENERATE');
  let calls=0;const accessor=curve();Object.defineProperty(accessor,'positions',{enumerable:true,get(){calls++;return {};}});
  assert.ok(validateCurve3DResource(accessor).length);assert.equal(calls,0);
});

test('GPU curve uploads are detached and reject float32 overflow, underflow and collapsed chords',()=>{
  const source=snapshotCurve3DResource(curve()),before=JSON.stringify(source),a=prepareGpuCurveGeometry(source),b=prepareGpuCurveGeometry(source);
  assert.ok(a.positions instanceof Float32Array);assert.equal(gpuCurveBufferSize(source),36);assert.equal(a.bytes,36);
  a.positions[0]=100;assert.equal(b.positions[0],-1);assert.equal(JSON.stringify(source),before);
  for(const data of [[0,0,0,1e100,1,0],[0,0,0,1e-100,1,0],[1e8,0,0,1e8+1,0,0]])assert.throws(()=>prepareGpuCurveGeometry(snapshotCurve3DResource(curve(data))),gpuCode);
  assert.equal(prepareGpuCurveGeometry(snapshotCurve3DResource(curve([]))).positions.length,0);
  const closed=snapshotCurve3DResource(curve([0,0,0,1,0,0,0,1,0,0,0,0],true));assert.deepEqual([...prepareGpuCurveGeometry(closed).positions],closed.positions.data);
});
