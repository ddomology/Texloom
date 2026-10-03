import test from 'node:test';
import assert from 'node:assert/strict';
import {mapScalarColors,orientFieldVector,displaceMeshAlongNormals,MAX_FIELD_VISUALIZATION_SAMPLES,type ScalarColorOptions,type NormalDisplacementOptions} from '../src/operations/field-visualization-data.ts';
import {composeTransform3D,transformPoint3D,type Vec3} from '../src/geometry/matrix4.ts';
import {copyMeshBuffers,validateMeshResource,type MeshResource} from '../src/ir/mesh.ts';
import {attachMeshAttributes} from '../src/ir/attributes.ts';
import type {NumericBuffer} from '../src/resources/buffers.ts';

const close=(actual:readonly number[],expected:readonly number[],tolerance=2e-14)=>{
  assert.equal(actual.length,expected.length);for(let i=0;i<actual.length;i++)assert.ok(Math.abs(actual[i]-expected[i])<=tolerance,`${actual[i]} != ${expected[i]} at ${i}`);
};
const code=(fn:()=>unknown,expected:string)=>assert.throws(fn,(error:any)=>error.diagnostics?.some((d:any)=>d.code===expected));
const colors=():ScalarColorOptions=>({stops:[{position:0,color:[0,0,1]},{position:.5,color:[0,1,0]},{position:1,color:[1,0,0]}],range:{mode:'fixed',min:-1,max:1},outOfRange:'clamp',invalidColor:[.2,.3,.4]});
const buffer=(data:number[],components:1|3,componentType:NumericBuffer['componentType']='float64'):NumericBuffer=>({version:1,componentType,components,count:data.length/components,byteOffset:0,byteStride:components*(componentType==='float64'?8:4),data});
const mesh=():MeshResource=>({kind:'mesh',version:1,primitive:'triangles',units:'unit',coordinateSpace:'object',winding:'ccw',topologyRevision:'source',positions:buffer([0,0,0,1,0,0,0,1,0],3),indices:buffer([0,1,2],1,'uint32'),normals:buffer([0,0,1,0,0,1,0,0,1],3),bounds:{min:[0,0,0],max:[1,1,0]}});
const displacement:NormalDisplacementOptions={amplitude:1,normalPolicy:'recompute',degenerateNormalPolicy:'error'};

test('scalar colormap interpolates explicit linear colors and preserves raw values separately from validity',()=>{
  const source=[-1,-.5,0,.5,1,null],options=colors(),before=JSON.stringify([source,options]);
  const result=mapScalarColors(source,options);
  assert.deepEqual(result.raw,source);assert.deepEqual(result.validity,[true,true,true,true,true,false]);assert.deepEqual(result.mappedValidity,result.validity);
  assert.deepEqual(result.normalized,[0,.25,.5,.75,1,null]);
  assert.deepEqual(result.colors,[[0,0,1],[0,.5,.5],[0,1,0],[.5,.5,0],[1,0,0],[.2,.3,.4]]);
  assert.equal(JSON.stringify([source,options]),before);assert.ok(Object.isFrozen(result.colors[0]));assert.ok(Object.isFrozen(result.raw));
  source[0]=100;options.stops[0].color[0]=1;assert.equal(result.raw[0],-1);assert.equal(result.colors[0][0],0);
});

test('range policies clamp, mask and reject without changing raw sample validity',()=>{
  const source=[-2,null,2],options=colors();
  assert.deepEqual(mapScalarColors(source,options).normalized,[0,null,1]);
  const masked=mapScalarColors(source,{...options,outOfRange:'mask'});
  assert.deepEqual(masked.raw,source);assert.deepEqual(masked.validity,[true,false,true]);assert.deepEqual(masked.mappedValidity,[false,false,false]);
  assert.deepEqual(masked.normalized,[null,null,null]);assert.deepEqual(masked.colors,[[.2,.3,.4],[.2,.3,.4],[.2,.3,.4]]);
  code(()=>mapScalarColors(source,{...options,outOfRange:'error'}),'FIELD_COLOR_OUT_OF_RANGE');
});

test('autoscale has no history, constant fields map to midpoint and all-invalid fields have no invented range',()=>{
  const options:ScalarColorOptions={...colors(),range:{mode:'auto'}};
  const first=mapScalarColors([10,20,30,null],options);assert.deepEqual(first.range,{min:10,max:30});assert.deepEqual(first.normalized,[0,.5,1,null]);
  assert.deepEqual(mapScalarColors([500,500,null],options).normalized,[.5,.5,null]);
  const empty=mapScalarColors([null,null],options);assert.equal(empty.range,null);assert.deepEqual(empty.validity,[false,false]);
  assert.deepEqual(mapScalarColors([],options),{raw:[],validity:[],mappedValidity:[],colors:[],normalized:[],range:null});
  assert.deepEqual(mapScalarColors([10,20,30,null],options),first);
  assert.deepEqual(mapScalarColors([0],colors()).range,{min:-1,max:1});
});

test('normalization covers both finite floating-point extremes without overflowing the interval width',()=>{
  const options={...colors(),range:{mode:'fixed' as const,min:-Number.MAX_VALUE,max:Number.MAX_VALUE}};
  close(mapScalarColors([-Number.MAX_VALUE,-Number.MAX_VALUE/2,0,Number.MAX_VALUE/2,Number.MAX_VALUE],options).normalized as number[],[0,.25,.5,.75,1]);
  assert.deepEqual(mapScalarColors([Number.MIN_VALUE],{...colors(),range:{mode:'fixed',min:0,max:Number.MIN_VALUE}}).normalized,[1]);
});

test('colormap structure, encoded RGB mistakes, undeclared range behavior and scalar budgets are rejected',()=>{
  const options=colors();
  code(()=>mapScalarColors([1],{...options,stops:[{position:0,color:[0,0,0]}]}),'FIELD_COLOR_STOPS');
  code(()=>mapScalarColors([1],{...options,stops:[{position:.1,color:[0,0,0]},{position:1,color:[1,1,1]}]}),'FIELD_COLOR_STOPS');
  code(()=>mapScalarColors([1],{...options,stops:[{position:0,color:[0,0,0]},{position:0,color:[1,1,1]}]}),'FIELD_COLOR_STOPS');
  code(()=>mapScalarColors([1],{...options,invalidColor:[255,0,0]}),'FIELD_COLOR');
  code(()=>mapScalarColors([1],{...options,range:{mode:'fixed',min:1,max:1}}),'FIELD_COLOR_RANGE');
  code(()=>mapScalarColors([1],{...options,range:{mode:'auto',min:0} as any}),'FIELD_COLOR_RANGE');
  code(()=>mapScalarColors([1],{...options,outOfRange:'wrap' as any}),'FIELD_COLOR_RANGE');
  code(()=>mapScalarColors(Array(MAX_FIELD_VISUALIZATION_SAMPLES+1).fill(null),options),'FIELD_SAMPLE_BUDGET');
  code(()=>mapScalarColors([NaN],options),'ASSET_JSON_VALUE');
  code(()=>mapScalarColors([Infinity],options),'ASSET_JSON_VALUE');
  code(()=>mapScalarColors([undefined] as any,options),'ASSET_JSON_VALUE');
});

test('leaf numeric boundaries reject accessors without invoking them',()=>{
  let calls=0;const raw=[1];Object.defineProperty(raw,0,{get(){calls++;return 1;},enumerable:true});
  assert.throws(()=>mapScalarColors(raw,colors()));
  const options=colors();Object.defineProperty(options,'invalidColor',{get(){calls++;return [0,0,0];},enumerable:true});
  assert.throws(()=>mapScalarColors([1],options));
  const v=[1,2,3];Object.defineProperty(v,1,{get(){calls++;return 2;},enumerable:true});
  assert.throws(()=>orientFieldVector(v as Vec3,{up:[0,0,1],lengthScale:1,zeroPolicy:'hide'}));assert.equal(calls,0);
});

test('vector orientation sends canonical +X to the direction and projects declared up onto local +Z',()=>{
  for(const vector of [[1,0,0],[0,1,0],[0,0,1],[-1,0,0],[1,2,3],[-3,1,-2]] as Vec3[]){
    const result=orientFieldVector(vector,{up:[0,0,1],lengthScale:2,zeroPolicy:'hide'}),matrix=composeTransform3D({rotation:[...result.rotation]});
    close(transformPoint3D(matrix,[1,0,0]),vector.map(v=>v/Math.hypot(...vector)));
    close([Math.hypot(...result.rotation)],[1]);assert.equal(result.magnitude,Math.hypot(...vector));assert.equal(result.displayLength,2*result.magnitude);assert.equal(result.visible,true);
    assert.ok(result.rotation[3]>=0);assert.ok(Object.isFrozen(result.rotation));
  }
  const result=orientFieldVector([1,0,0],{up:[0,1,1],lengthScale:1,zeroPolicy:'hide'});
  close(transformPoint3D(composeTransform3D({rotation:[...result.rotation]}),[0,0,1]),[0,Math.SQRT1_2,Math.SQRT1_2]);
});

test('parallel up has deterministic roll and tiny finite vectors keep their direction',()=>{
  const a=orientFieldVector([0,0,4],{up:[0,0,10],lengthScale:.25,zeroPolicy:'hide'});
  assert.deepEqual(a,orientFieldVector([0,0,4],{up:[0,0,10],lengthScale:.25,zeroPolicy:'hide'}));
  close(transformPoint3D(composeTransform3D({rotation:[...a.rotation]}),[0,0,1]),[1,0,0]);
  const b=orientFieldVector([0,Number.MIN_VALUE,0],{up:[0,0,1],lengthScale:1,zeroPolicy:'hide'});
  close(transformPoint3D(composeTransform3D({rotation:[...b.rotation]}),[1,0,0]),[0,1,0]);
  assert.equal(b.magnitude,Number.MIN_VALUE);
});

test('zero vectors use explicit presentation policy while invalid options and overflow fail',()=>{
  assert.deepEqual(orientFieldVector([0,0,0],{up:[0,0,1],lengthScale:3,zeroPolicy:'hide'}),{rotation:[0,0,0,1],magnitude:0,displayLength:0,visible:false});
  assert.equal(orientFieldVector([0,0,0],{up:[0,0,1],lengthScale:3,zeroPolicy:'identity'}).visible,true);
  code(()=>orientFieldVector([1,0,0],{up:[0,0,0],lengthScale:1,zeroPolicy:'hide'}),'FIELD_VECTOR_UP');
  code(()=>orientFieldVector([1,0,0],{up:[0,0,1],lengthScale:-1,zeroPolicy:'hide'}),'FIELD_VECTOR_SCALE');
  code(()=>orientFieldVector([Number.MAX_VALUE,Number.MAX_VALUE,0],{up:[0,0,1],lengthScale:0,zeroPolicy:'hide'}),'FIELD_VECTOR_RANGE');
  code(()=>orientFieldVector([Number.MAX_VALUE,0,0],{up:[0,0,1],lengthScale:2,zeroPolicy:'hide'}),'FIELD_VECTOR_RANGE');
});

test('original-normal displacement uses raw scalar and recomputes analytic deformed surface normals',()=>{
  const source=mesh(),before=JSON.stringify(source),result=displaceMeshAlongNormals(source,[0,1,2],displacement),owned=copyMeshBuffers(result.mesh);
  assert.deepEqual([...owned.positions],[0,0,0,1,0,1,0,1,2]);assert.deepEqual([...owned.indices],[0,1,2]);assert.equal(result.normalOrigin,'recomputed');
  const normal=[-1,-2,1].map(v=>v/Math.sqrt(6));close([...owned.normals!],[...normal,...normal,...normal]);
  assert.deepEqual(result.mesh.bounds,{min:[0,0,0],max:[1,1,2]});assert.deepEqual(result.sourceNormalFallbacks,[]);
  assert.equal(JSON.stringify(source),before);assert.equal(result.mesh.topologyRevision,source.topologyRevision);assert.deepEqual(validateMeshResource(result.mesh),[]);
});

test('zero amplitude is exact source geometry including original buffer types, normals and attributes',()=>{
  const source=attachMeshAttributes(mesh(),{captured:{domain:'vertex',valueType:'scalar',buffer:buffer([2,3,4],1)}});
  const mutable=JSON.parse(JSON.stringify(source)) as MeshResource;mutable.positions.componentType='float32';mutable.positions.byteStride=12;
  const result=displaceMeshAlongNormals(mutable,[null,Number.MAX_VALUE,-4],{...displacement,amplitude:0,normalPolicy:'drop'});
  assert.deepEqual(result.mesh,mutable);assert.equal(result.normalOrigin,'source');assert.deepEqual(result.sourceNormalFallbacks,[]);
  assert.notEqual(result.mesh,mutable);assert.ok(Object.isFrozen(result.mesh.positions.data));
  delete mutable.normals;
  const noNormal=displaceMeshAlongNormals(mutable,[null,0,0],{...displacement,amplitude:0});assert.deepEqual(noNormal.mesh,mutable);assert.equal(noNormal.normalOrigin,'none');
});

test('invalid raw values leave corresponding source positions unchanged and display geometry preserves attributes',()=>{
  const source=attachMeshAttributes(mesh(),{captured:{domain:'vertex',valueType:'scalar',buffer:buffer([2,3,4],1)}});
  const result=displaceMeshAlongNormals(source,[null,-2,3],{...displacement,amplitude:.5,normalPolicy:'drop'});
  assert.deepEqual([...copyMeshBuffers(result.mesh).positions],[0,0,0,1,0,-1,0,1,1.5]);assert.equal(result.mesh.normals,undefined);assert.equal(result.normalOrigin,'none');
  assert.deepEqual(result.mesh.attributes,source.attributes);assert.deepEqual(result.mesh.indices,source.indices);
  assert.deepEqual(displaceMeshAlongNormals(source,[null,-2,3],{...displacement,amplitude:.5,normalPolicy:'drop'}),result);
});

test('area weighting distinguishes a large face from a small face sharing vertices',()=>{
  const source=mesh();source.positions=buffer([0,0,0,1,0,0,0,1,0,0,0,2],3);source.indices=buffer([0,1,2,0,3,1],1,'uint32');
  source.normals=buffer([0,0,1,0,0,1,0,0,1,0,0,1],3);source.bounds={min:[0,0,0],max:[1,1,2]};
  const result=displaceMeshAlongNormals(source,[0,0,0,0],displacement),normal=copyMeshBuffers(result.mesh).normals!;
  close([...normal.slice(0,3)],[0,2/Math.sqrt(5),1/Math.sqrt(5)]);close([...normal.slice(6,9)],[0,0,1]);close([...normal.slice(9,12)],[0,1,0]);
});

test('degenerate and orphan normal handling explicitly errors or records source fallback indices',()=>{
  const source=mesh();source.normals=buffer([1,0,0,1,0,0,1,0,0],3);
  code(()=>displaceMeshAlongNormals(source,[0,-1,0],displacement),'FIELD_DISPLACEMENT_NORMAL');
  const fallback=displaceMeshAlongNormals(source,[0,-1,0],{...displacement,degenerateNormalPolicy:'source'});
  assert.equal(fallback.normalOrigin,'recomputed-with-source-fallback');assert.deepEqual(fallback.sourceNormalFallbacks,[0,1,2]);assert.deepEqual(fallback.mesh.normals,source.normals);
  const orphan=mesh();orphan.positions=buffer([0,0,0,1,0,0,0,1,0,4,4,4],3);orphan.normals=buffer([0,0,1,0,0,1,0,0,1,0,1,0],3);orphan.bounds={min:[0,0,0],max:[4,4,4]};
  const result=displaceMeshAlongNormals(orphan,[0,0,0,0],{...displacement,degenerateNormalPolicy:'source'});assert.deepEqual(result.sourceNormalFallbacks,[3]);
  const opposite=mesh();opposite.indices=buffer([0,1,2,0,2,1],1,'uint32');
  code(()=>displaceMeshAlongNormals(opposite,[0,0,0],displacement),'FIELD_DISPLACEMENT_NORMAL');
});

test('area-weighted normals support huge finite triangles without overflowing intermediate cross products',()=>{
  const source=mesh();source.positions=buffer([-1e308,0,0,1e308,0,0,0,1e308,0],3);source.bounds={min:[-1e308,0,0],max:[1e308,1e308,0]};
  const result=displaceMeshAlongNormals(source,[0,0,0],displacement);close([...copyMeshBuffers(result.mesh).normals!],[0,0,1,0,0,1,0,0,1]);
  assert.equal(result.normalOrigin,'recomputed');
});

test('displacement refuses missing original normals, mismatched counts, NaNs and overflowing finite input products',()=>{
  const source=mesh();delete source.normals;
  code(()=>displaceMeshAlongNormals(source,[0,0,0],displacement),'FIELD_DISPLACEMENT_SOURCE_NORMAL');
  code(()=>displaceMeshAlongNormals(mesh(),[1,2],displacement),'FIELD_SAMPLE_COUNT');
  code(()=>displaceMeshAlongNormals(mesh(),[NaN,0,0],displacement),'ASSET_JSON_VALUE');
  code(()=>displaceMeshAlongNormals(mesh(),[Number.MAX_VALUE,0,0],{...displacement,amplitude:2}),'FIELD_DISPLACEMENT_RANGE');
  code(()=>displaceMeshAlongNormals(mesh(),[0,0,0],{...displacement,normalPolicy:'preserve' as any}),'FIELD_DISPLACEMENT_NORMAL');
  const zeroNormal=mesh();zeroNormal.normals!.data=[0,0,0,0,0,1,0,0,1];
  code(()=>displaceMeshAlongNormals(zeroNormal,[0,0,0],{...displacement,degenerateNormalPolicy:'source'}),'MESH_NORMAL');
});

test('empty displacement is explicit and keeps all numeric resources empty',()=>{
  const source=mesh();source.positions=buffer([],3);source.indices=buffer([],1,'uint32');delete source.normals;source.bounds=null;
  const result=displaceMeshAlongNormals(source,[],displacement);
  assert.equal(result.mesh.bounds,null);assert.equal(result.mesh.normals!.count,0);assert.equal(result.normalOrigin,'recomputed');assert.deepEqual(result.sourceNormalFallbacks,[]);
});
