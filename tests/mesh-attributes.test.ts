import test from 'node:test';
import assert from 'node:assert/strict';
import {attachMeshAttributes,copyMeshAttribute,copyMeshAttributeCollection,meshAttributeTopology,validateMeshAttributeCollection,type MeshAttribute,type MeshAttributeCollection} from '../src/ir/attributes.ts';
import {copyMeshBuffers,snapshotMeshResource,validateMeshResource,type MeshResource} from '../src/ir/mesh.ts';
import type {NumericBuffer} from '../src/resources/buffers.ts';

const buffer=(data:number[],components:1|2|3,componentType:NumericBuffer['componentType']='float64'):NumericBuffer=>({version:1,componentType,components,count:data.length/components,byteOffset:0,byteStride:components*(componentType==='float64'?8:componentType==='uint16'?2:4),data});
const mesh=():MeshResource=>({kind:'mesh',version:1,primitive:'triangles',units:'unit',coordinateSpace:'object',winding:'ccw',topologyRevision:'two-faces',positions:buffer([0,0,0,2,0,0,0,1,0,0,4,0],3),indices:buffer([0,1,2,0,1,3],1,'uint16'),bounds:{min:[0,0,0],max:[2,4,0]}});
const scalar=(data:number[]):MeshAttribute=>({domain:'vertex',valueType:'scalar',buffer:buffer(data,1)});
const expectCode=(fn:()=>unknown,code:string)=>assert.throws(fn,(e:any)=>e.diagnostics?.some((d:any)=>d.code===code));

test('named attributes capture a frozen exact topology and every consumer owns compact typed storage',()=>{
  const original=mesh(),attribute=scalar([0,2,1,4]),before=JSON.stringify(original);
  const captured=attachMeshAttributes(original,{height:attribute});
  assert.equal(JSON.stringify(original),before);assert.ok(Object.isFrozen(captured.attributes!.topology.indices));assert.ok(Object.isFrozen(captured.attributes!.values.height.buffer.data));
  assert.deepEqual(captured.attributes!.topology,{revision:'two-faces',vertexCount:4,indices:[0,1,2,0,1,3]});
  attribute.buffer.data[0]=99;assert.equal(captured.attributes!.values.height.buffer.data[0],0);
  const one=copyMeshBuffers(captured),two=copyMeshAttribute(captured,'height');one.attributes!.height.values[1]=91;two[2]=92;
  assert.deepEqual([...copyMeshAttribute(captured,'height')],[0,2,1,4]);
  const copied=copyMeshAttributeCollection(captured.attributes!,meshAttributeTopology(captured));copied.height.values[0]=33;
  assert.equal(copyMeshAttribute(captured,'height')[0],0);assert.deepEqual(validateMeshResource(captured),[]);
});

test('topology agreement permits coordinate deformation but rejects same-length rewiring and revision changes',()=>{
  const source=attachMeshAttributes(mesh(),{height:scalar([0,2,1,4])});
  const changed=structuredClone(source) as MeshResource;changed.positions.data=changed.positions.data.map((v,i)=>i%3===2?2:v);changed.bounds={min:[0,0,2],max:[2,4,2]};
  const frozen=snapshotMeshResource(changed);assert.deepEqual(copyMeshAttribute(frozen,'height'),copyMeshAttribute(source,'height'));
  changed.indices.data=[0,2,1,0,1,3];expectCode(()=>snapshotMeshResource(changed),'ATTRIBUTE_TOPOLOGY');
  const revised=structuredClone(source) as MeshResource;revised.topologyRevision='new';expectCode(()=>snapshotMeshResource(revised),'ATTRIBUTE_TOPOLOGY');
  const padded=structuredClone(source) as MeshResource;padded.indices={version:1,componentType:'uint32',components:1,count:6,byteOffset:4,byteStride:8,data:[999,0,999,1,999,2,999,0,999,1,999,3]};
  assert.deepEqual(validateMeshResource(padded),[]);assert.deepEqual(meshAttributeTopology(padded),meshAttributeTopology(source));
});

test('all value types have explicit float buffers and domain counts, with no implicit sRGB conversion',()=>{
  const resource=attachMeshAttributes(mesh(),{
    weight:scalar([0,1,2,3]),
    uv:{domain:'corner',valueType:'vec2',buffer:buffer([0,0,1,0,0,1,.8,.9,1,0,0,1],2,'float32')},
    normal:{domain:'face',valueType:'vec3',buffer:buffer([0,0,1,0,0,-1],3)},
    color:{domain:'vertex',valueType:'color',buffer:buffer([.1,.2,.3,.4,.5,.6,.7,.8,.9,1,0,0],3,'float32')},
  });
  const arrays=copyMeshBuffers(resource).attributes!;assert.equal(arrays.uv.domain,'corner');assert.ok(arrays.uv.values instanceof Float32Array);
  assert.equal(arrays.color.values[0],Math.fround(.1));assert.equal(arrays.color.values[0],resource.attributes!.values.color.buffer.componentType==='float32'?Math.fround(.1):.1);
  assert.equal(arrays.normal.valueType,'vec3');assert.deepEqual([...arrays.normal.values],[0,0,1,0,0,-1]);
});

test('attribute buffers may be padded but color range is checked on addressed converted values',()=>{
  const color:MeshAttribute={domain:'vertex',valueType:'color',buffer:{version:1,componentType:'float64',components:3,count:4,byteOffset:8,byteStride:32,data:[99,.1,.2,.3,99,.4,.5,.6,99,.7,.8,.9,99,1,0,0]}};
  const result=attachMeshAttributes(mesh(),{color});assert.deepEqual([...copyMeshAttribute(result,'color')],[.1,.2,.3,.4,.5,.6,.7,.8,.9,1,0,0]);
  color.buffer.data[1]=1.001;expectCode(()=>attachMeshAttributes(mesh(),{color}),'ATTRIBUTE_COLOR');
});

test('invalid type, counts, layout, named ownership and collection versions produce explicit errors',()=>{
  const captured=attachMeshAttributes(mesh(),{height:scalar([0,2,1,4])});
  const changes:[(x:any)=>void,string][]=[
    [x=>x.attributes.version=2,'ATTRIBUTE_VERSION'],[x=>x.attributes.extra=1,'ATTRIBUTE_PROPERTY'],
    [x=>x.attributes.values.height.domain='instance','ATTRIBUTE_DOMAIN'],[x=>x.attributes.values.height.valueType='rgba','ATTRIBUTE_TYPE'],
    [x=>x.attributes.values.height.buffer.count=3,'ATTRIBUTE_COUNT'],[x=>x.attributes.values.height.valueType='vec2','ATTRIBUTE_COMPONENTS'],
    [x=>x.attributes.values.height.buffer=buffer([0,1,2,3],1,'uint16'),'ATTRIBUTE_COMPONENT_TYPE'],
    [x=>x.attributes.values.height.buffer.data[0]=Infinity,'ASSET_JSON_VALUE'],
    [x=>x.attributes.values.height.buffer.byteOffset=1,'BUFFER_ALIGNMENT'],[x=>x.attributes.topology.indices=[0,1,3,0,1,2],'ATTRIBUTE_TOPOLOGY'],
    [x=>x.attributes.topology.vertexCount=5,'ATTRIBUTE_TOPOLOGY'],[x=>x.attributes=null,'ATTRIBUTE_COLLECTION'],
  ];
  for(const [change,code] of changes){const changed=structuredClone(captured);change(changed);expectCode(()=>snapshotMeshResource(changed),code);}
  expectCode(()=>attachMeshAttributes(captured,{height:scalar([1,2,3,4])}),'ATTRIBUTE_EXISTS');
  assert.deepEqual([...copyMeshAttribute(attachMeshAttributes(captured,{height:scalar([1,2,3,4])},{replace:true}),'height')],[1,2,3,4]);
  expectCode(()=>copyMeshAttribute(captured,'constructor'),'ATTRIBUTE_MISSING');
  expectCode(()=>attachMeshAttributes(mesh(),{constructor:scalar([0,1,2,3])}),'ATTRIBUTE_NAME');
});

test('attribute validation rejects accessors without invocation and bounds aggregate storage',()=>{
  const topology=meshAttributeTopology(mesh());let calls=0;const values:any={};Object.defineProperty(values,'height',{enumerable:true,get(){calls++;throw Error('no');}});
  expectCode(()=>attachMeshAttributes(mesh(),values),'ASSET_JSON_VALUE');assert.equal(calls,0);
  const many=Object.fromEntries(Array.from({length:33},(_,i)=>['a'+i,scalar([0,1,2,3])]));
  assert.ok(validateMeshAttributeCollection({version:1,topology,values:many},topology).some(d=>d.code==='ATTRIBUTE_LIMIT'));
  const large=scalar([0,1,2,3]);large.buffer.data=Array(131_073).fill(0);
  assert.ok(validateMeshAttributeCollection({version:1,topology,values:{a:large,b:large}},topology).some(d=>d.code==='ATTRIBUTE_LIMIT'));
  assert.ok(validateMeshAttributeCollection(null,topology).some(d=>d.code==='ATTRIBUTE_COLLECTION'));
});

test('empty and warning-only degenerate meshes retain valid empty or authored attribute collections',()=>{
  const empty=mesh();empty.positions=buffer([],3);empty.indices=buffer([],1,'uint16');empty.bounds=null;
  const value=attachMeshAttributes(empty,{a:scalar([])});assert.equal(copyMeshAttribute(value,'a').length,0);
  const degenerate=mesh();degenerate.indices.data=[0,0,1,0,1,3];const d=attachMeshAttributes(degenerate,{a:scalar([0,1,2,3])});
  assert.ok(validateMeshResource(d).some(d=>d.code==='MESH_DEGENERATE'&&d.severity==='warning'));
  assert.equal(copyMeshBuffers(d).attributes!.a.values.length,4);
});
