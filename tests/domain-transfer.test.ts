import test from 'node:test';
import assert from 'node:assert/strict';
import {attachMeshAttributes,copyMeshAttribute,type MeshAttribute} from '../src/ir/attributes.ts';
import {type MeshResource,snapshotMeshResource} from '../src/ir/mesh.ts';
import {createMeshFieldContext} from '../src/fields/mesh-context.ts';
import {transferMeshAttribute} from '../src/operations/domain-transfer.ts';
import type {NumericBuffer} from '../src/resources/buffers.ts';

const buffer=(data:number[],components:1|2|3,componentType:NumericBuffer['componentType']='float64'):NumericBuffer=>({version:1,componentType,components,count:data.length/components,byteOffset:0,byteStride:components*(componentType==='float64'?8:componentType==='uint16'?2:4),data});
// Face areas are exactly 1 and 4, with shared vertices 0 and 1.
const mesh=():MeshResource=>({kind:'mesh',version:1,primitive:'triangles',units:'unit',coordinateSpace:'object',winding:'ccw',topologyRevision:'two-faces',positions:buffer([0,0,0,2,0,0,0,1,0,0,4,0],3),indices:buffer([0,1,2,0,1,3],1,'uint16'),bounds:{min:[0,0,0],max:[2,4,0]}});
const attribute=(domain:MeshAttribute['domain'],data:number[],valueType:MeshAttribute['valueType']='scalar'):MeshAttribute=>({domain,valueType,buffer:buffer(data,valueType==='scalar'?1:valueType==='vec2'?2:3)});
const numbers=(value:Readonly<MeshAttribute>|any)=>value.buffer.data as number[];
const close=(actual:readonly number[],expected:readonly number[])=>{assert.equal(actual.length,expected.length);actual.forEach((v,i)=>assert.ok(Math.abs(v-expected[i])<=1e-12*Math.max(1,Math.abs(expected[i])),`${i}: ${v} != ${expected[i]}`));};
const expectCode=(fn:()=>unknown,code:string)=>assert.throws(fn,(e:any)=>e.diagnostics?.some((d:any)=>d.code===code));

test('mesh field contexts expose distinct vertex, face and corner identity with immutable original positions',()=>{
  const original=mesh(),current=mesh();current.positions.data=current.positions.data.map((v,i)=>i%3===2?3:v);current.bounds={min:[0,0,3],max:[2,4,3]};
  const faces=createMeshFieldContext(original,current,'face',2);assert.equal(faces.time,2);assert.equal(faces.elements.length,2);
  close(faces.elements[0].position,[2/3,1/3,3]);close(faces.elements[0].originalPosition,[2/3,1/3,0]);assert.deepEqual(faces.elements[1].vertexIndices,[0,1,3]);
  const corners=createMeshFieldContext(original,current,'corner');assert.equal(corners.elements.length,6);assert.equal(corners.elements[3].cornerIndex,3);assert.equal(corners.elements[3].faceIndex,1);assert.deepEqual(corners.elements[3].vertexIndices,[0]);
  const vertices=createMeshFieldContext(original,current,'vertex');assert.equal(vertices.elements.length,4);assert.deepEqual(vertices.elements[3].position,[0,4,3]);
  current.positions.data[0]=99;assert.deepEqual(corners.elements[0].position,[0,0,3]);assert.ok(Object.isFrozen(corners.elements[0].position));
  const changed=mesh();changed.indices.data=[0,2,1,0,1,3];expectCode(()=>createMeshFieldContext(original,changed,'vertex'),'ATTRIBUTE_TOPOLOGY');
  const units=mesh();units.units='m';expectCode(()=>createMeshFieldContext(original,units,'vertex'),'ATTRIBUTE_UNITS');
  expectCode(()=>createMeshFieldContext(original,original,'face',Infinity),'ATTRIBUTE_TIME');
});

test('vertex-to-face mean uses authored triangle indices for scalar, vec2, vec3 and linear colors',()=>{
  const resource=attachMeshAttributes(mesh(),{height:attribute('vertex',[0,2,1,4]),uv:attribute('vertex',[0,0,1,0,0,1,0,4],'vec2'),vector:attribute('vertex',[0,0,1,2,0,1,0,1,1,0,4,1],'vec3'),color:attribute('vertex',[1,0,0,0,1,0,0,0,1,1,1,1],'color')});
  close(numbers(transferMeshAttribute(resource,'height',{to:'face',method:'mean'})),[1,2]);
  close(numbers(transferMeshAttribute(resource,'uv',{to:'face',method:'mean'})),[1/3,1/3,1/3,4/3]);
  close(numbers(transferMeshAttribute(resource,'vector',{to:'face',method:'mean'})),[2/3,1/3,1,2/3,4/3,1]);
  close(numbers(transferMeshAttribute(resource,'color',{to:'face',method:'mean'})),[1/3,1/3,1/3,2/3,2/3,1/3]);
});

test('face-to-vertex conversion distinguishes uniform from unequal-area weights',()=>{
  const resource=attachMeshAttributes(mesh(),{faceValue:attribute('face',[10,30])});
  close(numbers(transferMeshAttribute(resource,'faceValue',{to:'vertex',method:'uniform'})),[20,20,10,30]);
  close(numbers(transferMeshAttribute(resource,'faceValue',{to:'vertex',method:'area-weighted'})),[26,26,10,30]);
  const shifted=structuredClone(resource) as MeshResource;shifted.positions.data=shifted.positions.data.map((v,i)=>i%3===2?1e308:v);shifted.bounds={min:[0,0,1e308],max:[2,4,1e308]};
  close(numbers(transferMeshAttribute(shifted,'faceValue',{to:'vertex',method:'area-weighted'})),[26,26,10,30]);
});

test('corner promotion preserves UV seams until explicit corner averaging is requested',()=>{
  const resource=attachMeshAttributes(mesh(),{uv:attribute('corner',[0,0,1,0,0,1,1,1,1,0,0,1],'vec2'),v:attribute('vertex',[10,20,30,40]),f:attribute('face',[1,2])});
  close(numbers(transferMeshAttribute(resource,'uv',{to:'vertex',method:'mean'})),[.5,.5,1,0,0,1,0,1]);
  close(numbers(transferMeshAttribute(resource,'uv',{to:'face',method:'mean'})),[1/3,1/3,2/3,2/3]);
  close(numbers(transferMeshAttribute(resource,'v',{to:'corner',method:'promote'})),[10,20,30,10,20,40]);
  close(numbers(transferMeshAttribute(resource,'f',{to:'corner',method:'promote'})),[1,1,1,2,2,2]);
  expectCode(()=>transferMeshAttribute(resource,'uv',{to:'vertex',method:'promote'}),'ATTRIBUTE_TRANSFER');
});

test('orphans and zero-area weights need explicit policies and do not create implicit fallback averages',()=>{
  const source=mesh();source.positions.data.push(9,9,9);source.positions.count=5;source.bounds={min:[0,0,0],max:[9,9,9]};
  const orphan=attachMeshAttributes(source,{f:attribute('face',[10,30])});
  expectCode(()=>transferMeshAttribute(orphan,'f',{to:'vertex',method:'uniform'}),'ATTRIBUTE_ORPHAN');
  close(numbers(transferMeshAttribute(orphan,'f',{to:'vertex',method:'uniform',orphan:'zero'})),[20,20,10,30,0]);
  const flat=mesh();flat.positions.data[7]=0;const zero=attachMeshAttributes(flat,{f:attribute('face',[10,30])});
  expectCode(()=>transferMeshAttribute(zero,'f',{to:'vertex',method:'area-weighted'}),'ATTRIBUTE_ZERO_AREA');
  expectCode(()=>transferMeshAttribute(zero,'f',{to:'vertex',method:'area-weighted',zeroArea:'ignore'}),'ATTRIBUTE_ORPHAN');
  close(numbers(transferMeshAttribute(zero,'f',{to:'vertex',method:'area-weighted',zeroArea:'ignore',orphan:'zero'})),[30,30,0,30]);
});

test('deformation changes area weights while original named captures remain exactly unchanged',()=>{
  const original=attachMeshAttributes(mesh(),{position:attribute('vertex',mesh().positions.data,'vec3'),f:attribute('face',[0,10])}),before=JSON.stringify(original);
  const deformed=structuredClone(original) as MeshResource;deformed.positions.data[10]=9;deformed.bounds!.max[1]=9;
  const final=snapshotMeshResource(deformed);close(numbers(transferMeshAttribute(original,'f',{to:'vertex',method:'area-weighted'})),[8,8,0,10]);
  close(numbers(transferMeshAttribute(final,'f',{to:'vertex',method:'area-weighted'})),[9,9,0,10]);
  assert.deepEqual(copyMeshAttribute(final,'position'),copyMeshAttribute(original,'position'));assert.equal(JSON.stringify(original),before);
  assert.ok(Object.isFrozen(transferMeshAttribute(final,'f',{to:'vertex',method:'uniform'}).buffer.data));
});

test('relative area weights and scalar means avoid finite-value sum or physical-area overflow',()=>{
  const large=mesh();large.positions.data=large.positions.data.map(v=>v*1e200);large.bounds={min:[0,0,0],max:[2e200,4e200,0]};
  const weighted=attachMeshAttributes(large,{f:attribute('face',[1e308,0])});
  const actual=numbers(transferMeshAttribute(weighted,'f',{to:'vertex',method:'area-weighted'}));
  assert.ok(Math.abs(actual[0]/1e308-.2)<1e-12);assert.ok(actual.every(Number.isFinite));
  const high=attachMeshAttributes(mesh(),{v:attribute('vertex',[1e308,1e308,-1e308,1e308])});
  close(numbers(transferMeshAttribute(high,'v',{to:'face',method:'mean'})),[1e308/3,1e308]);
  const extreme=mesh();extreme.positions=buffer([0,0,0,1e-150,0,0,0,1e-150,0,1e150,0,0,0,1e150,0],3);
  extreme.indices=buffer([0,1,2,0,3,4],1,'uint16');extreme.bounds={min:[0,0,0],max:[1e150,1e150,0]};
  const scaled=attachMeshAttributes(extreme,{f:attribute('face',[1e308,0])});
  const tiny=numbers(transferMeshAttribute(scaled,'f',{to:'vertex',method:'area-weighted'}))[0];
  assert.ok(Math.abs(tiny/1e-292-1)<1e-12,`${tiny} must retain a representable weighted contribution`);
});

test('unsupported implicit conversions and malformed policies fail before publishing any attribute',()=>{
  const value=attachMeshAttributes(mesh(),{a:attribute('vertex',[0,1,2,3])});
  for(const options of [{to:'vertex',method:'mean'},{to:'face',method:'nearest'},{to:'face',method:'mean',orphan:'zero'},{to:'corner',method:'promote',zeroArea:'ignore'},null])
    expectCode(()=>transferMeshAttribute(value,'a',options as any),'ATTRIBUTE_TRANSFER');
  expectCode(()=>transferMeshAttribute(value,'missing',{to:'face',method:'mean'}),'ATTRIBUTE_MISSING');
  let calls=0;const accessor:any={to:'face'};Object.defineProperty(accessor,'method',{enumerable:true,get(){calls++;return 'mean';}});
  expectCode(()=>transferMeshAttribute(value,'a',accessor),'ASSET_JSON_VALUE');assert.equal(calls,0);
});

test('face incidence is unique while repeated corners remain distinct, and output allocation is bounded',()=>{
  const degenerate=mesh();degenerate.indices.data=[0,0,1,0,1,3];
  const value=attachMeshAttributes(degenerate,{face:attribute('face',[10,30]),corner:attribute('corner',[0,6,10,12,10,20])});
  close(numbers(transferMeshAttribute(value,'face',{to:'vertex',method:'uniform',orphan:'zero'})),[20,20,0,30]);
  close(numbers(transferMeshAttribute(value,'corner',{to:'vertex',method:'mean',orphan:'zero'})),[6,10,0,20]);
  const repeated=mesh();repeated.indices=buffer(Array.from({length:30_000},()=>[0,1,2]).flat(),1,'uint32');
  const large=attachMeshAttributes(repeated,{v:attribute('vertex',[0,0,0,1,0,0,0,1,0,0,0,1],'vec3')});
  expectCode(()=>transferMeshAttribute(large,'v',{to:'corner',method:'promote'}),'ATTRIBUTE_LIMIT');
});
