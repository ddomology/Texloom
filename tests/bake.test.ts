import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,webcrypto} from 'node:crypto';
import {createBakeStore,prepareInlineBake,snapshotBakeManifest,validateBakeManifest,sha256BakeBytes,encodeBakeBase64,decodeBakeBase64,type BakeManifest,type BakeChunk,type BakeResolver} from '../src/resources/bake.ts';
import type {MeshResource} from '../src/ir/mesh.ts';
import type {NumericBuffer} from '../src/resources/buffers.ts';

const buffer=(data:number[],components:1|3,componentType:NumericBuffer['componentType']='float64'):NumericBuffer=>({version:1,componentType,components,count:data.length/components,byteOffset:0,byteStride:components*(componentType==='float64'?8:4),data});
const mesh=():MeshResource=>({kind:'mesh',version:1,primitive:'triangles',units:'m',coordinateSpace:'object',winding:'ccw',topologyRevision:'tri',positions:buffer([0,0,0,1,0,0,0,1,0],3),indices:buffer([0,1,2],1,'uint32'),bounds:{min:[0,0,0],max:[1,1,0]}});
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const code=(fn:()=>unknown,expected:string)=>assert.throws(fn,(e:any)=>e.code===expected||e.diagnostics?.some((d:any)=>d.code===expected));
const rejectCode=(promise:Promise<unknown>,expected:string)=>assert.rejects(promise,(e:any)=>e.code===expected||e.diagnostics?.some((d:any)=>d.code===expected));
const close=(actual:readonly number[],expected:readonly number[])=>{assert.equal(actual.length,expected.length);actual.forEach((v,i)=>assert.ok(Math.abs(v-expected[i])<=1e-12,`${v} != ${expected[i]}`));};

function fixture(external=false):{manifest:BakeManifest;bytes:Uint8Array[]} {
  const manifest:BakeManifest={version:1,units:'m',timeUnit:'s',topology:{revision:'tri',vertexCount:3,indices:[0,1,2]},sampleTimes:[-1,0,.25,2,8],interpolation:'linear',outside:'clamp',seed:36,
    solver:{name:'external-experiment',version:'1.0',parameters:{meaning:'test signal, no PDE claim',step:[.1,.25]}},
    channels:[{id:'phi',kind:'scalar',componentType:'float64',unit:'K'},{id:'velocity',kind:'vector',componentType:'float32',unit:'m/s'},{id:'position',kind:'position',componentType:'float64',unit:'m'}],chunks:[]};
  const bytes:Uint8Array[]=[];let start=0;
  for(const [index,count] of [2,1,2].entries()){
    const chunkBytes=new Uint8Array(count*3*(8+12+24)),view=new DataView(chunkBytes.buffer);let offset=0;
    for(const time of manifest.sampleTimes.slice(start,start+count))for(const channel of manifest.channels)for(let vertex=0;vertex<3;vertex++){
      const values=channel.kind==='scalar'?[time+vertex]:channel.kind==='vector'?[time,vertex,-time]:[vertex,time,vertex+time];
      for(const value of values){if(channel.componentType==='float32'){view.setFloat32(offset,value,true);offset+=4;}else{view.setFloat64(offset,value,true);offset+=8;}}
    }
    manifest.chunks.push({id:`chunk-${index}`,startSample:start,sampleCount:count,byteLength:chunkBytes.length,sha256:sha(chunkBytes),
      source:external?{kind:'external',uri:`chunks/${index}.bin`}:{kind:'inline',data:Buffer.from(chunkBytes).toString('base64')}});
    bytes.push(chunkBytes);start+=count;
  }return {manifest,bytes};
}
function scalarFixture(times:number[],values:number[][]):BakeManifest {
  const bytes=new Uint8Array(times.length*3*8),view=new DataView(bytes.buffer);let offset=0;
  for(const frame of values)for(const value of frame){view.setFloat64(offset,value,true);offset+=8;}
  const base=fixture().manifest;return {...base,sampleTimes:times,channels:[base.channels[0]],chunks:[{id:'values',startSample:0,sampleCount:times.length,byteLength:bytes.length,sha256:sha(bytes),source:{kind:'inline',data:Buffer.from(bytes).toString('base64')}}]};
}
function controlled(){
  const pending:{chunk:Readonly<BakeChunk>;signal:AbortSignal;resolve:(value:Uint8Array|ArrayBuffer)=>void;reject:(error:Error)=>void}[]=[];
  const resolver:BakeResolver=(chunk,{signal})=>new Promise((resolve,reject)=>pending.push({chunk:chunk as BakeChunk,signal,resolve,reject}));
  return {pending,resolver};
}

test('portable SHA-256 matches Node crypto and WebCrypto at padding boundaries and long vectors',async()=>{
  const cases=[new Uint8Array(),new TextEncoder().encode('abc'),new Uint8Array(1_000_000).fill(97),...[1,55,56,63,64,65,127,128,129,1024,65537].map(n=>Uint8Array.from({length:n},(_,i)=>(i*137+91)&255))];
  for(const bytes of cases){assert.equal(sha256BakeBytes(bytes),sha(bytes));const reference=await webcrypto.subtle.digest('SHA-256',bytes);assert.equal(sha256BakeBytes(bytes),Buffer.from(reference).toString('hex'));}
  const backing=Uint8Array.from({length:257},(_,i)=>i);assert.equal(sha256BakeBytes(backing.subarray(13,239)),sha(backing.subarray(13,239)));
});

test('canonical base64 is portable and rejects bad padding, trailing bits and data URI input',()=>{
  for(const count of [0,1,2,3,4,1024,10003]){const bytes=Uint8Array.from({length:count},(_,i)=>i%256),encoded=Buffer.from(bytes).toString('base64');assert.equal(encodeBakeBase64(bytes),encoded);assert.deepEqual(decodeBakeBase64(encoded,count),bytes);}
  for(const [text,count] of [['AB==',1],['AAA=',1],['AAB=',2],['AA=A',2],['????',3],['AA==\n',1],['data:base64,AA==',1]] as const)code(()=>decodeBakeBase64(text,count),'BAKE_BASE64');
});

test('manifest validates fixed topology, solver metadata and exact little-endian frame/channel ordering',()=>{
  const {manifest}=fixture();assert.deepEqual(validateBakeManifest(manifest,mesh()),[]);
  const sampler=prepareInlineBake(manifest),sample=sampler.sample(.25);
  assert.deepEqual(sample.bracket,{left:2,right:2,alpha:0,sourceTime:.25});assert.equal(sample.time,.25);
  assert.deepEqual(sample.channels.phi.values,[.25,1.25,2.25]);assert.deepEqual(sample.channels.velocity.values,[.25,0,-.25,.25,1,-.25,.25,2,-.25]);
  assert.deepEqual(sample.channels.position.values,[0,.25,.25,1,.25,1.25,2,.25,2.25]);
  assert.equal(sample.channels.velocity.componentType,'float32');assert.equal(sample.channels.phi.unit,'K');assert.equal(sample.channels.position.components,3);
});

test('nonuniform cross-chunk interpolation uses neighboring source times and preserves exact knots',()=>{
  const sampler=prepareInlineBake(fixture().manifest);
  for(const [time,left,right,alpha] of [[.125,1,2,.5],[1.125,2,3,.5],[5,3,4,.5]] as const){const sample=sampler.sample(time);assert.deepEqual(sample.bracket,{left,right,alpha,sourceTime:time});close(sample.channels.phi.values,[time,time+1,time+2]);}
  for(const [index,time] of [-1,0,.25,2,8].entries())assert.deepEqual(sampler.sample(time).bracket,{left:index,right:index,alpha:0,sourceTime:time});
});

test('step interpolation chooses the left knot and reads only its chunk',async()=>{
  const {manifest,bytes}=fixture(true);manifest.interpolation='step';const calls:string[]=[],store=createBakeStore(manifest,{resolver:async chunk=>{calls.push(chunk.id);return bytes[Number(chunk.id.at(-1))];}});
  await store.prefetch(1);assert.deepEqual(calls,['chunk-1']);assert.deepEqual(store.sample(1).channels.phi.values,[.25,1.25,2.25]);assert.deepEqual(store.sample(1).bracket,{left:2,right:2,alpha:0,sourceTime:1});store.dispose();
});

test('outside-time policy is explicit, supports negative origins and single-sample sequences',()=>{
  const {manifest}=fixture(),sampler=prepareInlineBake(manifest);
  assert.deepEqual(sampler.sample(-100).bracket,{left:0,right:0,alpha:0,sourceTime:-1});assert.equal(sampler.sample(-100).time,-100);
  assert.deepEqual(sampler.sample(100).bracket,{left:4,right:4,alpha:0,sourceTime:8});
  manifest.outside='error';const strict=prepareInlineBake(manifest);code(()=>strict.sample(-1.1),'BAKE_TIME_RANGE');code(()=>strict.sample(8.1),'BAKE_TIME_RANGE');
  for(const time of [NaN,Infinity,-Infinity])code(()=>sampler.sample(time),'BAKE_TIME');
  const single=prepareInlineBake(scalarFixture([-2],[[4,5,6]]));assert.deepEqual(single.sample(100).channels.phi.values,[4,5,6]);assert.deepEqual(single.sample(-2).bracket,{left:0,right:0,alpha:0,sourceTime:-2});
});

test('finite extreme time and value ranges interpolate without overflowing differences',()=>{
  const sampler=prepareInlineBake(scalarFixture([-Number.MAX_VALUE,Number.MAX_VALUE],[[-Number.MAX_VALUE,1,Number.MAX_VALUE],[Number.MAX_VALUE,3,Number.MAX_VALUE]]));
  assert.deepEqual(sampler.sample(0).channels.phi.values,[0,2,Number.MAX_VALUE]);assert.equal(sampler.sample(0).bracket.alpha,.5);
  const tiny=prepareInlineBake(scalarFixture([0,Number.MIN_VALUE],[[0,1,2],[3,4,5]]));assert.deepEqual(tiny.sample(Number.MIN_VALUE).channels.phi.values,[3,4,5]);
});

test('sampling is immutable, reverse-safe and independent from consumer fps or call history',()=>{
  const {manifest}=fixture(),before=JSON.stringify(manifest),sampler=prepareInlineBake(manifest),baseline=sampler.sample(1.125);
  for(const fps of [24,30,60])for(let index=0;index<Math.ceil(fps*2);index++)sampler.sample(index/fps);
  for(const time of [8,1,-1,.125,0,8,.25])sampler.sample(time);
  assert.deepEqual(sampler.sample(1.125),baseline);assert.equal(JSON.stringify(manifest),before);assert.ok(Object.isFrozen(baseline.channels.phi.values));assert.ok(Object.isFrozen(baseline.bracket));
  manifest.seed=99;manifest.sampleTimes[2]=.5;assert.equal(sampler.manifest.seed,36);assert.equal(sampler.manifest.sampleTimes[2],.25);assert.deepEqual(sampler.sample(1.125),baseline);
  assert.notEqual(sampler.sample(1.125).channels.phi.values,baseline.channels.phi.values);
});

test('exact source topology and units reject revisions, vertex counts, index permutations and position units',()=>{
  for(const change of [(m:MeshResource)=>{m.topologyRevision='changed';},(m:MeshResource)=>{m.units='cm';},(m:MeshResource)=>{m.indices.data=[0,2,1];}]){const m=mesh();change(m);assert.ok(validateBakeManifest(fixture().manifest,m).some(d=>d.code==='BAKE_TOPOLOGY_MISMATCH'));}
  const extra=mesh();extra.positions=buffer([0,0,0,1,0,0,0,1,0,0,0,0],3);assert.ok(validateBakeManifest(fixture().manifest,extra).some(d=>d.code==='BAKE_TOPOLOGY_MISMATCH'));
  const manifest=fixture().manifest;manifest.channels[2].unit='cm';assert.ok(validateBakeManifest(manifest).some(d=>d.code==='BAKE_POSITION_UNITS'));
});

test('manifest rejects missing metadata, unknown properties, duplicate channels and invalid layouts before allocation',()=>{
  const cases:[(m:BakeManifest)=>void,string][]=[
    [m=>{delete (m as any).solver;},'BAKE_SOLVER'],[m=>{(m as any).codec='native';},'BAKE_PROPERTY'],[m=>{m.seed=-1;},'BAKE_SEED'],
    [m=>{m.channels[1].id='phi';},'BAKE_CHANNEL_ID'],[m=>{m.channels[0].id='constructor';},'BAKE_CHANNEL_ID'],[m=>{m.channels[0].componentType='uint32' as any;},'BAKE_COMPONENT_TYPE'],
    [m=>{m.sampleTimes=[0,1,1,2,8];},'BAKE_SAMPLE_TIMES'],[m=>{m.topology.vertexCount=0;},'BAKE_BUDGET'],[m=>{m.topology.indices=[0,1,8];},'BAKE_TOPOLOGY'],
    [m=>{m.chunks[1].startSample=3;},'BAKE_CHUNK_COVERAGE'],[m=>{m.chunks.pop();},'BAKE_CHUNK_COVERAGE'],[m=>{m.chunks[0].byteLength++;},'BAKE_CHUNK_SIZE'],
    [m=>{m.chunks[0].sha256='bad';},'BAKE_HASH'],[m=>{m.chunks[1].id=m.chunks[0].id;},'BAKE_CHUNK_ID'],
    [m=>{m.chunks[0].source={kind:'external',uri:'x',byteRange:{offset:-1,length:m.chunks[0].byteLength}};},'BAKE_BYTE_RANGE'],
  ];
  for(const [change,expected] of cases){const m=fixture().manifest;change(m);assert.ok(validateBakeManifest(m).some(d=>d.code===expected),expected);}
  const huge=fixture().manifest;huge.channels=Array(33).fill(huge.channels[0]);assert.ok(validateBakeManifest(huge).some(d=>d.code==='BAKE_CHANNELS'));
  huge.channels=[fixture().manifest.channels[0]];huge.topology.vertexCount=65536;huge.chunks=huge.chunks.map(c=>({...c,byteLength:64*1024*1024,source:{kind:'external',uri:'x'}}));
  assert.ok(validateBakeManifest(huge).some(d=>d.code==='BAKE_BUDGET'));
});

test('getters are rejected before reading fields, payloads, metadata or source topology',()=>{
  let reads=0;const m=fixture().manifest;Object.defineProperty(m,'sampleTimes',{enumerable:true,get(){reads++;return [];}});assert.ok(validateBakeManifest(m).some(d=>d.severity==='error'));
  const n=fixture().manifest;Object.defineProperty(n.chunks[0].source,'data',{enumerable:true,get(){reads++;return '';}});code(()=>prepareInlineBake(n),'ASSET_JSON_VALUE');
  const source=mesh();Object.defineProperty(source,'indices',{enumerable:true,get(){reads++;return null;}});assert.ok(validateBakeManifest(fixture().manifest,source).some(d=>d.severity==='error'));
  const options:any={};Object.defineProperty(options,'resolver',{enumerable:true,get(){reads++;return undefined;}});code(()=>createBakeStore(fixture().manifest,options),'BAKE_OPTIONS');assert.equal(reads,0);
});

test('inline authentication rejects corrupt hashes, noncanonical base64, wrong lengths and nonfinite binary values',()=>{
  const {manifest}=fixture();manifest.chunks[0].sha256='0'.repeat(64);code(()=>prepareInlineBake(manifest),'BAKE_HASH');
  const invalid=fixture().manifest;(invalid.chunks[0].source as {data:string}).data='?'.repeat(Math.ceil(invalid.chunks[0].byteLength/3)*4);code(()=>prepareInlineBake(invalid),'BAKE_BASE64');
  const length=fixture().manifest;(length.chunks[0].source as {data:string}).data+='AAAA';code(()=>prepareInlineBake(length),'BAKE_BASE64');
  for(const invalidValue of [NaN,Infinity,-Infinity]){const bad=scalarFixture([0],[[invalidValue,0,0]]);code(()=>prepareInlineBake(bad),'BAKE_VALUE');}
  code(()=>prepareInlineBake(fixture(true).manifest),'BAKE_NOT_READY');
});

test('external stores never reuse prior frames while required chunks are missing',async()=>{
  const {manifest,bytes}=fixture(true),calls:string[]=[],store=createBakeStore(manifest,{resolver:async chunk=>{calls.push(chunk.id);return bytes[Number(chunk.id.at(-1))];}});
  code(()=>store.sample(0),'BAKE_NOT_READY');code(()=>store.materialize(),'BAKE_NOT_READY');
  await store.prefetch(0);assert.deepEqual(calls,['chunk-0']);assert.deepEqual(store.sample(0).channels.phi.values,[0,1,2]);code(()=>store.sample(1),'BAKE_NOT_READY');
  await store.prefetch(.125);assert.deepEqual(calls,['chunk-0','chunk-1']);close(store.sample(.125).channels.phi.values,[.125,1.125,2.125]);
  assert.deepEqual(store.status().chunks.map(c=>c.state),['ready','ready','missing']);store.dispose();
});

test('prefetchAll verifies independent chunks then materializes a portable synchronous manifest',async()=>{
  const {manifest,bytes}=fixture(true),c=controlled(),store=createBakeStore(manifest,{resolver:c.resolver});let finished=false;
  const all=store.prefetchAll().then(()=>{finished=true;});assert.equal(c.pending.length,3);c.pending[1].resolve(bytes[1]);await Promise.resolve();assert.equal(finished,false);
  c.pending[0].resolve(bytes[0]);c.pending[2].resolve(bytes[2]);await all;assert.equal(store.status().state,'ready');
  assert.equal(store.status().loadedBytes,bytes.reduce((n,b)=>n+b.length,0));const materialized=store.materialize();assert.ok(materialized.chunks.every(c=>c.source.kind==='inline'));
  const inline=prepareInlineBake(materialized);for(const time of [-1,0,.125,.25,1,2,5,8])assert.deepEqual(store.sample(time),inline.sample(time));
  assert.ok(manifest.chunks.every(c=>c.source.kind==='external'));store.release();assert.equal(store.status().state,'disposed');assert.equal(store.status().loadedBytes,0);
});

test('duplicate concurrent requests share transport while cancellation is per subscriber',async()=>{
  const {manifest,bytes}=fixture(true),c=controlled(),store=createBakeStore(manifest,{resolver:c.resolver}),controller=new AbortController();
  const a=store.prefetch(0,controller.signal),b=store.prefetch(0);assert.equal(c.pending.length,1);controller.abort();await rejectCode(a,'BAKE_ABORTED');assert.equal(c.pending[0].signal.aborted,false);
  c.pending[0].resolve(bytes[0]);await b;assert.deepEqual(store.sample(0).channels.phi.values,[0,1,2]);assert.equal(store.status().chunks[0].state,'ready');store.dispose();
});

test('last subscriber cancellation aborts transport and late completion never publishes into a replacement request',async()=>{
  const {manifest,bytes}=fixture(true),c=controlled(),store=createBakeStore(manifest,{resolver:c.resolver}),controller=new AbortController();
  const first=store.prefetch(0,controller.signal);controller.abort();await rejectCode(first,'BAKE_ABORTED');assert.ok(c.pending[0].signal.aborted);assert.equal(store.status().chunks[0].state,'missing');
  const second=store.prefetch(0);assert.equal(c.pending.length,2);c.pending[0].resolve(bytes[0]);await Promise.resolve();code(()=>store.sample(0),'BAKE_NOT_READY');
  c.pending[1].resolve(bytes[0]);await second;assert.equal(store.sample(0).channels.phi.values[0],0);store.dispose();
});

test('dispose rejects every pending subscriber, aborts transports and ignores late resolutions',async()=>{
  const {manifest,bytes}=fixture(true),c=controlled(),store=createBakeStore(manifest,{resolver:c.resolver});const pending=store.prefetchAll();store.dispose();store.dispose();
  await rejectCode(pending,'BAKE_DISPOSED');assert.ok(c.pending.every(p=>p.signal.aborted));c.pending.forEach((p,i)=>p.resolve(bytes[i]));await Promise.resolve();
  assert.equal(store.status().state,'disposed');assert.equal(store.status().loadedBytes,0);code(()=>store.sample(0),'BAKE_DISPOSED');code(()=>store.materialize(),'BAKE_DISPOSED');await rejectCode(store.prefetch(0),'BAKE_DISPOSED');
});

test('verification failures are visible, never sampled, and a later explicit prefetch may retry',async()=>{
  const {manifest,bytes}=fixture(true);let calls=0;const store=createBakeStore(manifest,{resolver:async()=>{calls++;const output=new Uint8Array(bytes[0]);if(calls===1)output[0]^=1;return output;}});
  await rejectCode(store.prefetch(0),'BAKE_HASH');assert.equal(store.status().state,'failed');assert.equal(store.status().chunks[0].code,'BAKE_HASH');code(()=>store.sample(0),'BAKE_NOT_READY');
  await store.prefetch(0);assert.equal(calls,2);assert.deepEqual(store.sample(0).channels.phi.values,[0,1,2]);assert.equal(store.status().chunks[0].state,'ready');store.dispose();
});

test('resolver byte ranges are explicit, borrowed arrays are copied and malformed payloads fail',async()=>{
  const {manifest,bytes}=fixture(true);manifest.chunks[0].source={kind:'external',uri:'all.bin',byteRange:{offset:99,length:bytes[0].length}};
  const backing=new Uint8Array(bytes[0].length+8);backing.set(bytes[0],4);let passed:any;
  const store=createBakeStore(manifest,{resolver:async chunk=>{passed=chunk;return backing.subarray(4,backing.length-4);}});await store.prefetch(0);backing.fill(0);
  assert.deepEqual(passed.source.byteRange,{offset:99,length:bytes[0].length});assert.ok(Object.isFrozen(passed.source));assert.deepEqual(store.sample(0).channels.phi.values,[0,1,2]);store.dispose();
  const missing=createBakeStore(manifest);await rejectCode(missing.prefetch(0),'BAKE_RESOLVER');missing.dispose();
  const short=createBakeStore(manifest,{resolver:async()=>bytes[0].subarray(1)});await rejectCode(short.prefetch(0),'BAKE_CHUNK_SIZE');short.dispose();
  const bad=createBakeStore(manifest,{resolver:async()=>[] as any});await rejectCode(bad.prefetch(0),'BAKE_BYTES');bad.dispose();
  const stopped=new AbortController();stopped.abort();const cancelled=createBakeStore(manifest,{resolver:async()=>{throw Error('must not call');}});await rejectCode(cancelled.prefetchAll(stopped.signal),'BAKE_ABORTED');assert.equal(cancelled.status().loadedBytes,0);cancelled.dispose();
});

test('mixed inline and external stores use identical verification and exact samples',async()=>{
  const {manifest,bytes}=fixture(true);manifest.chunks[1].source={kind:'inline',data:Buffer.from(bytes[1]).toString('base64')};let calls=0;
  const store=createBakeStore(manifest,{resolver:async chunk=>{calls++;return new Uint8Array(bytes[Number(chunk.id.at(-1))]).buffer;}});
  await store.prefetchAll();assert.equal(calls,2);assert.deepEqual(store.sample(.25),prepareInlineBake(fixture().manifest).sample(.25));store.release();
});
