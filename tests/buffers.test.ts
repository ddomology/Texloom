import test from 'node:test';
import assert from 'node:assert/strict';
import {BufferError,copyNumericBuffer,snapshotNumericBuffer,validateNumericBuffer,MAX_BUFFER_COMPONENTS,type NumericBuffer} from '../src/resources/buffers.ts';

const buffer=():NumericBuffer=>({version:1,componentType:'float64',components:3,count:2,byteOffset:8,byteStride:32,
  data:[999,1.25,2.5,3.75,777,4.25,5.5,6.75,888]});
const code=(input:unknown,expected:string)=>assert.ok(validateNumericBuffer(input).some(d=>d.code===expected),JSON.stringify(validateNumericBuffer(input)));

test('byte-aligned strided JSON storage produces compact independent typed arrays',()=>{
  const input=buffer(),snapshot=JSON.stringify(input);
  assert.deepEqual(validateNumericBuffer(input),[]);
  const first=copyNumericBuffer(input),second=copyNumericBuffer(input);
  assert.ok(first instanceof Float64Array);
  assert.deepEqual([...first],[1.25,2.5,3.75,4.25,5.5,6.75]);
  assert.notEqual(first.buffer,second.buffer);first[0]=100;
  assert.equal(second[0],1.25);assert.equal(JSON.stringify(input),snapshot);
  const frozen=snapshotNumericBuffer(input);input.data[1]=-100;
  assert.equal(frozen.data[1],1.25);assert.ok(Object.isFrozen(frozen.data));
  assert.throws(()=>{(frozen.data as number[])[0]=0;},TypeError);
  assert.equal(copyNumericBuffer(frozen)[0],1.25);
});

test('float32 conversion is explicit and float64 retains precision without host-byte assumptions',()=>{
  const source:NumericBuffer={version:1,componentType:'float32',components:1,count:4,byteOffset:0,byteStride:4,data:[.1,-0,1e-50,3.4028234663852886e38]};
  const result=copyNumericBuffer(source);
  assert.ok(result instanceof Float32Array);assert.equal(result[0],Math.fround(.1));
  assert.ok(Object.is(result[1],-0));assert.equal(result[2],0);assert.ok(Number.isFinite(result[3]));
  const precise={...source,componentType:'float64',byteStride:8} as NumericBuffer;
  assert.equal(copyNumericBuffer(precise)[0],.1);assert.equal(copyNumericBuffer(precise)[2],1e-50);
  for(const [componentType,maximum,size] of [['uint16',65535,2],['uint32',4294967295,4]] as const){
    const value:NumericBuffer={version:1,componentType,components:1,count:2,byteOffset:0,byteStride:size,data:[0,maximum]};
    assert.deepEqual([...copyNumericBuffer(value)],[0,maximum]);
  }
});

test('invalid layouts, conversion overflow and integer truncation fail before allocation',()=>{
  const variants:[(b:any)=>void,string][]=[
    [b=>b.version=2,'BUFFER_VERSION'],[b=>b.componentType='int32','BUFFER_COMPONENT_TYPE'],
    [b=>b.components=5,'BUFFER_COMPONENTS'],[b=>b.count=-1,'BUFFER_LAYOUT'],
    [b=>b.count=.5,'BUFFER_LAYOUT'],[b=>b.byteOffset=1,'BUFFER_ALIGNMENT'],
    [b=>b.byteStride=8,'BUFFER_ALIGNMENT'],[b=>b.byteOffset=800,'BUFFER_RANGE'],
    [b=>b.count=Number.MAX_SAFE_INTEGER,'BUFFER_RANGE'],[b=>b.extra=true,'BUFFER_PROPERTY'],
    [b=>b.data[0]=Infinity,'ASSET_JSON_VALUE'],[b=>b.data[0]='2','BUFFER_VALUE'],
    [b=>{b.componentType='float32';b.byteOffset=4;b.byteStride=16;b.data[0]=1e100;},'BUFFER_OVERFLOW'],
    [b=>{b.componentType='uint32';b.byteOffset=4;b.byteStride=16;b.data[0]=.25;},'BUFFER_VALUE'],
    [b=>{b.componentType='uint32';b.byteOffset=4;b.byteStride=16;b.data[0]=4294967296;},'BUFFER_VALUE'],
  ];
  for(const [change,expected] of variants){const input=buffer();change(input);code(input,expected);assert.throws(()=>copyNumericBuffer(input),BufferError);}
  code({...buffer(),data:Array(MAX_BUFFER_COMPONENTS+1).fill(0)},'BUFFER_LIMIT');
  code({...buffer(),count:0,byteOffset:100},'BUFFER_RANGE');
});

test('empty buffers remain explicit and hostile JSON descriptors never execute accessors',()=>{
  const empty:NumericBuffer={version:1,componentType:'uint16',components:1,count:0,byteOffset:0,byteStride:2,data:[]};
  assert.equal(copyNumericBuffer(empty).length,0);
  let called=0;const input=buffer();Object.defineProperty(input,'data',{enumerable:true,get(){called++;throw Error('getter');}});
  code(input,'ASSET_JSON_VALUE');assert.throws(()=>snapshotNumericBuffer(input),BufferError);assert.equal(called,0);
  const cycle:any={};cycle.self=cycle;code(cycle,'ASSET_JSON_CYCLE');
  code({...empty,data:new Float64Array(0)},'ASSET_JSON_OBJECT');
  code({...empty,data:[,1]},'ASSET_JSON_VALUE');
});
