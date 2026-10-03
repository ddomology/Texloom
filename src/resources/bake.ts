import type {DeepReadonly,Diagnostic} from '../ir/operations.js';
import {copyMeshBuffers,validateMeshResource,type MeshResource,type MeshUnit} from '../ir/mesh.js';
import {freezeSnapshot} from '../operations/values.js';
import {validateAssetJson} from './package.js';
import {MAX_BUFFER_COMPONENTS} from './limits.js';
import {sha256BakeBytes} from './bake-hash.js';
export {sha256BakeBytes} from './bake-hash.js';

export interface BakeChannel {id:string;kind:'scalar'|'vector'|'position';componentType:'float32'|'float64';unit:string}
export interface BakeChunk {
  id:string;startSample:number;sampleCount:number;byteLength:number;sha256:string;
  source:{kind:'inline';data:string}|{kind:'external';uri:string;byteRange?:{offset:number;length:number}};
}
export interface BakeManifest {
  version:1;units:MeshUnit;timeUnit:'s';topology:{revision:string;vertexCount:number;indices:number[]};
  sampleTimes:number[];interpolation:'linear'|'step';outside:'clamp'|'error';seed:number;
  solver:{name:string;version:string;parameters:Record<string,unknown>};channels:BakeChannel[];chunks:BakeChunk[];
}
export interface BakeSample {
  time:number;bracket:{left:number;right:number;alpha:number;sourceTime:number};
  /** componentType describes stored precision; interpolation is performed in float64. */
  channels:Record<string,{kind:BakeChannel['kind'];componentType:BakeChannel['componentType'];components:1|3;count:number;unit:string;values:number[]}>;
}
export interface InlineBakeSampler {manifest:DeepReadonly<BakeManifest>;sample(time:number):DeepReadonly<BakeSample>}
export type BakeResolver=(chunk:DeepReadonly<BakeChunk>,context:{signal:AbortSignal})=>Promise<Uint8Array|ArrayBuffer>;
export interface BakeStoreOptions {resolver?:BakeResolver}
export interface BakeStoreStatus {
  state:'missing'|'loading'|'ready'|'failed'|'disposed';loadedBytes:number;totalBytes:number;
  chunks:{id:string;state:'missing'|'loading'|'ready'|'failed';code?:string}[];
}
export interface BakeStore extends InlineBakeSampler {
  prefetch(time:number,signal?:AbortSignal):Promise<void>;prefetchAll(signal?:AbortSignal):Promise<void>;
  materialize():DeepReadonly<BakeManifest>;status():DeepReadonly<BakeStoreStatus>;dispose():void;release():void;
}
export class BakeError extends Error {
  readonly diagnostics:DeepReadonly<Diagnostic[]>;
  constructor(readonly code:string,message:string,path='$.bake',diagnostics?:readonly Diagnostic[]){
    super(`${code}: ${message} (${path})`);this.name='BakeError';this.diagnostics=freezeSnapshot(diagnostics??[{severity:'error',code,message,path}]);
  }
}
export const MAX_BAKE_CHUNKS=256,MAX_BAKE_SAMPLES=4096,MAX_BAKE_VERTICES=65536,MAX_BAKE_CHANNELS=32,MAX_BAKE_BYTES=64*1024*1024;
const object=(v:unknown):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
const integer=(v:unknown,min:number,max:number):v is number=>Number.isSafeInteger(v)&&(v as number)>=min&&(v as number)<=max;
const safeName=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z_][A-Za-z0-9_.:-]{0,255}$/.test(v)&&!['constructor','prototype','__proto__'].includes(v);
const label=(v:unknown,max=512):v is string=>typeof v==='string'&&v.trim().length>0&&v.length<=max&&!/[\u0000-\u001f]/.test(v);
const components=(c:DeepReadonly<BakeChannel>):1|3=>c.kind==='scalar'?1:3;
const bytesPerComponent=(c:DeepReadonly<BakeChannel>)=>c.componentType==='float32'?4:8;
const frameBytes=(b:DeepReadonly<BakeManifest>)=>b.channels.reduce((sum,c)=>sum+b.topology.vertexCount*components(c)*bytesPerComponent(c),0);
function error(code:string,message:string,path='$.bake'):never{throw new BakeError(code,message,path);}

export function validateBakeManifest(input:unknown,mesh?:DeepReadonly<MeshResource>,path='$.bake'):Diagnostic[]{
  const out=validateAssetJson(input,path);if(out.length)return out;
  const fail=(code:string,message:string,p=path)=>out.push({severity:'error',code,message,path:p});
  const keys=(value:object,allowed:readonly string[],p:string)=>{for(const key of Object.keys(value))if(!allowed.includes(key))fail('BAKE_PROPERTY',`Unsupported property ${key}.`,`${p}.${key}`);};
  if(!object(input)){fail('BAKE_MANIFEST','Expected a temporal bake manifest.');return out;}
  keys(input,['version','units','timeUnit','topology','sampleTimes','interpolation','outside','seed','solver','channels','chunks'],path);
  if(input.version!==1)fail('BAKE_VERSION','Supported bake version is 1.',path+'.version');
  if(!['unit','m','cm','mm'].includes(input.units))fail('BAKE_UNITS','Expected explicit mesh units.',path+'.units');
  if(input.timeUnit!=='s')fail('BAKE_TIME_UNIT','Sample times use explicit seconds.',path+'.timeUnit');
  if(!['linear','step'].includes(input.interpolation))fail('BAKE_INTERPOLATION','Declare linear or step interpolation.',path+'.interpolation');
  if(!['clamp','error'].includes(input.outside))fail('BAKE_OUTSIDE','Declare clamp or error outside the time domain.',path+'.outside');
  if(!integer(input.seed,0,0xffffffff))fail('BAKE_SEED','Seed must be an explicit uint32.',path+'.seed');
  if(!object(input.solver))fail('BAKE_SOLVER','Explicit solver name, version and parameters are required.',path+'.solver');
  else {keys(input.solver,['name','version','parameters'],path+'.solver');
    if(!label(input.solver.name,256)||!label(input.solver.version,256)||!object(input.solver.parameters))fail('BAKE_SOLVER','Solver requires nonempty labels and finite plain JSON parameters.',path+'.solver');}
  const topology=input.topology;
  if(!object(topology))fail('BAKE_TOPOLOGY','Expected an exact topology snapshot.',path+'.topology');
  else {keys(topology,['revision','vertexCount','indices'],path+'.topology');
    if(!label(topology.revision))fail('BAKE_TOPOLOGY','Topology revision requires a nonblank label.',path+'.topology.revision');
    if(!integer(topology.vertexCount,1,MAX_BAKE_VERTICES))fail('BAKE_BUDGET',`Expected 1 to ${MAX_BAKE_VERTICES} vertices.`,path+'.topology.vertexCount');
    if(!Array.isArray(topology.indices)||topology.indices.length<3||topology.indices.length>MAX_BUFFER_COMPONENTS||topology.indices.length%3||topology.indices.some((n:unknown)=>!integer(n,0,topology.vertexCount-1)))fail('BAKE_TOPOLOGY','Expected complete triangle indices within the declared vertices.',path+'.topology.indices');}
  if(!Array.isArray(input.sampleTimes)||input.sampleTimes.length<1||input.sampleTimes.length>MAX_BAKE_SAMPLES||input.sampleTimes.some((t:unknown,i:number)=>!finite(t)||i>0&&t<=input.sampleTimes[i-1]))fail('BAKE_SAMPLE_TIMES',`Expected 1 to ${MAX_BAKE_SAMPLES} strictly increasing finite seconds.`,path+'.sampleTimes');
  if(!Array.isArray(input.channels)||input.channels.length<1||input.channels.length>MAX_BAKE_CHANNELS)fail('BAKE_CHANNELS',`Expected 1 to ${MAX_BAKE_CHANNELS} channels.`,path+'.channels');
  else {const names=new Set<string>();for(const [i,c] of input.channels.entries()){
    const p=`${path}.channels[${i}]`;if(!object(c)){fail('BAKE_CHANNEL','Expected a channel declaration.',p);continue;}
    keys(c,['id','kind','componentType','unit'],p);
    if(!safeName(c.id)||names.has(c.id))fail('BAKE_CHANNEL_ID','Channel IDs must be safe, unique names.',p+'.id');else names.add(c.id);
    if(!['scalar','vector','position'].includes(c.kind))fail('BAKE_CHANNEL_KIND','Expected scalar, vector or position.',p+'.kind');
    if(!['float32','float64'].includes(c.componentType))fail('BAKE_COMPONENT_TYPE','Expected float32 or float64.',p+'.componentType');
    if(!label(c.unit,256))fail('BAKE_CHANNEL_UNIT','Each channel requires an explicit unit string.',p+'.unit');
    if(c.kind==='position'&&c.unit!==input.units)fail('BAKE_POSITION_UNITS','Position channel units must exactly match the mesh units; no implicit conversion.',p+'.unit');
  }}
  if(!Array.isArray(input.chunks)||input.chunks.length<1||input.chunks.length>MAX_BAKE_CHUNKS)fail('BAKE_CHUNKS',`Expected 1 to ${MAX_BAKE_CHUNKS} chunks.`,path+'.chunks');
  // Layout arithmetic only follows complete structural validation.
  if(out.length)return out;
  const manifest=input as BakeManifest,expectedFrameBytes=frameBytes(manifest),names=new Set<string>();let next=0,total=0;
  for(const [i,c] of manifest.chunks.entries()){
    const p=`${path}.chunks[${i}]`;if(!object(c)){fail('BAKE_CHUNK','Expected a binary chunk.',p);continue;}
    keys(c,['id','startSample','sampleCount','byteLength','sha256','source'],p);
    if(!safeName(c.id)||names.has(c.id))fail('BAKE_CHUNK_ID','Chunk IDs must be safe, unique names.',p+'.id');else names.add(c.id);
    if(!integer(c.startSample,0,MAX_BAKE_SAMPLES-1)||c.startSample!==next||!integer(c.sampleCount,1,MAX_BAKE_SAMPLES)||c.startSample+c.sampleCount>manifest.sampleTimes.length)fail('BAKE_CHUNK_COVERAGE','Chunks must cover all samples exactly once, in contiguous index order.',p);
    next=c.startSample+c.sampleCount;
    if(!integer(c.byteLength,1,MAX_BAKE_BYTES)||c.byteLength!==expectedFrameBytes*c.sampleCount)fail('BAKE_CHUNK_SIZE','byteLength must exactly equal frame bytes times sampleCount.',p+'.byteLength');
    total+=c.byteLength;
    if(typeof c.sha256!=='string'||!/^[0-9a-f]{64}$/.test(c.sha256))fail('BAKE_HASH','Expected a lowercase SHA-256 digest.',p+'.sha256');
    if(!object(c.source)){fail('BAKE_SOURCE','Expected inline or external source.',p+'.source');continue;}
    if(c.source.kind==='inline'){
      keys(c.source,['kind','data'],p+'.source');
      if(typeof c.source.data!=='string'||c.source.data.length!==Math.ceil(c.byteLength/3)*4)fail('BAKE_BASE64','Inline data must have the exact canonical base64 length.',p+'.source.data');
    }else if(c.source.kind==='external'){
      keys(c.source,['kind','uri','byteRange'],p+'.source');
      if(!label(c.source.uri,8192)||/^\s*blob:/i.test(c.source.uri))fail('BAKE_URI','Expected a portable nonempty URI.',p+'.source.uri');
      if(c.source.byteRange!==undefined){const r=c.source.byteRange;
        if(!object(r)){fail('BAKE_BYTE_RANGE','Expected offset and length.',p+'.source.byteRange');continue;}
        keys(r,['offset','length'],p+'.source.byteRange');
        if(!integer(r.offset,0,Number.MAX_SAFE_INTEGER)||r.length!==c.byteLength||!Number.isSafeInteger(r.offset+r.length))fail('BAKE_BYTE_RANGE','Range offset must be nonnegative and range length must equal byteLength.',p+'.source.byteRange');}
    }else fail('BAKE_SOURCE','Expected inline or external source.',p+'.source.kind');
  }
  if(next!==manifest.sampleTimes.length)fail('BAKE_CHUNK_COVERAGE','Chunks must cover every declared sample exactly once.',path+'.chunks');
  if(!Number.isSafeInteger(total)||total>MAX_BAKE_BYTES)fail('BAKE_BUDGET',`Total binary payload exceeds ${MAX_BAKE_BYTES} bytes.`,path+'.chunks');
  if(mesh!==undefined){const ds=validateMeshResource(mesh,path+'.sourceMesh');out.push(...ds);
    if(!ds.some(d=>d.severity==='error')){
      const indices=copyMeshBuffers(mesh).indices;
      if(mesh.units!==manifest.units||mesh.topologyRevision!==manifest.topology.revision||mesh.positions.count!==manifest.topology.vertexCount||indices.length!==manifest.topology.indices.length||indices.some((n,i)=>n!==manifest.topology.indices[i]))fail('BAKE_TOPOLOGY_MISMATCH','Units, revision, vertex count and exact index snapshot must match the source mesh.',path+'.topology');
    }}
  return out;
}
export function snapshotBakeManifest(input:unknown,mesh?:DeepReadonly<MeshResource>,path='$.bake'):DeepReadonly<BakeManifest>{
  const diagnostics=validateBakeManifest(input,mesh,path);if(diagnostics.some(d=>d.severity==='error'))throw new BakeError('BAKE_MANIFEST','Invalid temporal bake manifest.',path,diagnostics);
  return freezeSnapshot(input as BakeManifest);
}

const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
/** Canonical RFC4648 base64, with padding and no whitespace or data-URI prefix. */
export function encodeBakeBase64(bytes:Uint8Array):string {
  const parts:string[]=[];let part='';
  for(let i=0;i<bytes.length;i+=3){
    const a=bytes[i],b=bytes[i+1]??0,c=bytes[i+2]??0;
    part+=alphabet[a>>>2]+alphabet[((a&3)<<4)|(b>>>4)]+(i+1<bytes.length?alphabet[((b&15)<<2)|(c>>>6)]:'=')+(i+2<bytes.length?alphabet[c&63]:'=');
    if(part.length>=8192){parts.push(part);part='';}
  }if(part)parts.push(part);return parts.join('');
}
export function decodeBakeBase64(text:string,byteLength:number):Uint8Array {
  if(typeof text!=='string'||!integer(byteLength,0,MAX_BAKE_BYTES)||text.length!==Math.ceil(byteLength/3)*4)error('BAKE_BASE64','Expected exact canonical base64 byte length.');
  const result=new Uint8Array(byteLength);let written=0;
  for(let i=0;i<text.length;i+=4){
    const a=alphabet.indexOf(text[i]),b=alphabet.indexOf(text[i+1]),c=text[i+2]==='='?-1:alphabet.indexOf(text[i+2]),d=text[i+3]==='='?-1:alphabet.indexOf(text[i+3]);
    const remaining=byteLength-written,last=i===text.length-4;
    if(a<0||b<0||remaining>=3&&(c<0||d<0)||remaining===2&&(c<0||text[i+3]!=='='||(c&3)!==0)||remaining===1&&(text[i+2]!=='='||text[i+3]!=='='||(b&15)!==0)||!last&&(c<0||d<0))error('BAKE_BASE64','Invalid alphabet, padding or noncanonical trailing bits.');
    result[written++]=(a<<2)|(b>>>4);
    if(remaining>1)result[written++]=((b&15)<<4)|(c>>>2);
    if(remaining>2)result[written++]=((c&3)<<6)|d;
  }return result;
}
function verifiedBytes(manifest:DeepReadonly<BakeManifest>,chunk:DeepReadonly<BakeChunk>,incoming:Uint8Array|ArrayBuffer):Uint8Array {
  if(!(incoming instanceof Uint8Array)&&!(incoming instanceof ArrayBuffer))error('BAKE_BYTES','Resolver must return Uint8Array or ArrayBuffer selected payload bytes.');
  if(incoming.byteLength!==chunk.byteLength)error('BAKE_CHUNK_SIZE',`Chunk ${chunk.id} must contain exactly ${chunk.byteLength} selected bytes; no implicit range slicing.`);
  const bytes=incoming instanceof Uint8Array?new Uint8Array(incoming):new Uint8Array(incoming.slice(0));
  if(sha256BakeBytes(bytes)!==chunk.sha256)error('BAKE_HASH',`SHA-256 mismatch for chunk ${chunk.id}.`);
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let offset=0;
  for(let sample=0;sample<chunk.sampleCount;sample++)for(const channel of manifest.channels){
    const width=bytesPerComponent(channel),count=manifest.topology.vertexCount*components(channel);
    for(let i=0;i<count;i++,offset+=width){const value=width===4?view.getFloat32(offset,true):view.getFloat64(offset,true);
      if(!finite(value))error('BAKE_VALUE',`Chunk ${chunk.id}, sample ${sample+chunk.startSample}, channel ${channel.id} contains NaN or infinity.`);
    }
  }return bytes;
}

function bracket(manifest:DeepReadonly<BakeManifest>,time:number):BakeSample['bracket'] {
  if(!finite(time))error('BAKE_TIME','Sample time must be finite.');
  const times=manifest.sampleTimes,first=times[0],last=times.at(-1)!;
  if((time<first||time>last)&&manifest.outside==='error')error('BAKE_TIME_RANGE','Requested time lies outside the declared samples.');
  const sourceTime=Math.max(first,Math.min(last,time));let low=0,high=times.length-1;
  while(low<=high){const mid=(low+high)>>>1;if(times[mid]===sourceTime)return {left:mid,right:mid,alpha:0,sourceTime};if(times[mid]<sourceTime)low=mid+1;else high=mid-1;}
  if(manifest.interpolation==='step')return {left:high,right:high,alpha:0,sourceTime};
  const width=times[low]-times[high],alpha=finite(width)?(sourceTime-times[high])/width:(sourceTime/2-times[high]/2)/(times[low]/2-times[high]/2);
  if(!finite(alpha)||alpha<0||alpha>1)error('BAKE_TIME_RANGE','Interpolation weight cannot be represented in the finite time domain.');
  return {left:high,right:low,alpha,sourceTime};
}
function chunkIndex(manifest:DeepReadonly<BakeManifest>,sample:number):number {
  // The validated index is ordered and bounded to 256 entries.
  return manifest.chunks.findIndex(c=>sample>=c.startSample&&sample<c.startSample+c.sampleCount);
}
function needed(manifest:DeepReadonly<BakeManifest>,b:BakeSample['bracket']):number[]{return [...new Set([chunkIndex(manifest,b.left),chunkIndex(manifest,b.right)])];}
function sampled(manifest:DeepReadonly<BakeManifest>,time:number,get:(index:number)=>Uint8Array|undefined):DeepReadonly<BakeSample>{
  const b=bracket(manifest,time),indices=needed(manifest,b),buffers=new Map<number,DataView>();
  for(const i of indices){const bytes=get(i);if(!bytes)error('BAKE_NOT_READY',`Required chunk ${manifest.chunks[i].id} is not verified and ready.`);buffers.set(i,new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength));}
  const leftChunk=chunkIndex(manifest,b.left),rightChunk=chunkIndex(manifest,b.right),size=frameBytes(manifest);
  let left=(b.left-manifest.chunks[leftChunk].startSample)*size,right=(b.right-manifest.chunks[rightChunk].startSample)*size;
  const leftView=buffers.get(leftChunk)!,rightView=buffers.get(rightChunk)!,channels:BakeSample['channels']=Object.create(null);
  for(const c of manifest.channels){const width=bytesPerComponent(c),count=manifest.topology.vertexCount*components(c),values=new Array<number>(count);
    for(let i=0;i<count;i++,left+=width,right+=width){
      const a=width===4?leftView.getFloat32(left,true):leftView.getFloat64(left,true);
      const z=width===4?rightView.getFloat32(right,true):rightView.getFloat64(right,true);
      const difference=z-a,value=b.left===b.right||a===z?a:finite(difference)?a+difference*b.alpha:a*(1-b.alpha)+z*b.alpha;
      if(!finite(value))error('BAKE_INTERPOLATION_RANGE',`Interpolated channel ${c.id} exceeds finite numeric range.`);values[i]=value;
    }
    channels[c.id]={kind:c.kind,componentType:c.componentType,components:components(c),count:manifest.topology.vertexCount,unit:c.unit,values};
  }return freezeSnapshot({time,bracket:b,channels});
}

/** Inline-only synchronous evaluation; all chunks are authenticated before a sampler is returned. */
export function prepareInlineBake(input:DeepReadonly<BakeManifest>):InlineBakeSampler {
  const manifest=snapshotBakeManifest(input),chunks=new Map<number,Uint8Array>();
  for(const [i,chunk] of manifest.chunks.entries()){
    if(chunk.source.kind!=='inline')error('BAKE_NOT_READY','External chunks require explicit asynchronous prefetch and materialization.');
    chunks.set(i,verifiedBytes(manifest,chunk,decodeBakeBase64(chunk.source.data,chunk.byteLength)));
  }
  return Object.freeze({manifest,sample:(time:number)=>sampled(manifest,time,i=>chunks.get(i))});
}

interface Waiter {signal?:AbortSignal;abort:()=>void;resolve:()=>void;reject:(error:BakeError)=>void}
interface ChunkState {state:'missing'|'loading'|'ready'|'failed';bytes?:Uint8Array;controller?:AbortController;waiters:Set<Waiter>;failure?:BakeError}
/** Bounded verified cache. Resolver URI/range policy is host-owned; the returned bytes must be the exact range. */
export function createBakeStore(input:DeepReadonly<BakeManifest>,options:BakeStoreOptions={}):BakeStore {
  const manifest=snapshotBakeManifest(input);
  if(options===null||typeof options!=='object'||Array.isArray(options))error('BAKE_OPTIONS','Expected store options.');
  const descriptors:Record<string,PropertyDescriptor>=Object.getOwnPropertyDescriptors(options);
  if(Object.getOwnPropertySymbols(options).length||Object.keys(descriptors).some(k=>k!=='resolver'||!descriptors[k].enumerable||!Object.hasOwn(descriptors[k],'value')))error('BAKE_OPTIONS','Store options must be plain data properties.');
  const resolver=descriptors.resolver?.value as BakeResolver|undefined;
  if(resolver!==undefined&&typeof resolver!=='function')error('BAKE_RESOLVER','Resolver must be an explicit host function.');
  const states:ChunkState[]=manifest.chunks.map(()=>({state:'missing',waiters:new Set()}));let disposed=false;
  const live=()=>{if(disposed)error('BAKE_DISPOSED','Bake store is disposed.');};
  const detach=(state:ChunkState,waiter:Waiter)=>{waiter.signal?.removeEventListener('abort',waiter.abort);state.waiters.delete(waiter);};
  const resolveAll=(state:ChunkState)=>{for(const waiter of [...state.waiters]){detach(state,waiter);waiter.resolve();}};
  const rejectAll=(state:ChunkState,cause:BakeError)=>{for(const waiter of [...state.waiters]){detach(state,waiter);waiter.reject(cause);}};
  const load=async(index:number,controller:AbortController)=>{
    const state=states[index],chunk=manifest.chunks[index],current=()=>!disposed&&state.controller===controller&&!controller.signal.aborted;
    try {
      let input:Uint8Array|ArrayBuffer;
      if(chunk.source.kind==='inline')input=decodeBakeBase64(chunk.source.data,chunk.byteLength);
      else {if(!resolver)error('BAKE_RESOLVER','External chunks require an explicit host resolver.');input=await resolver(chunk,{signal:controller.signal});}
      if(!current())return;
      const bytes=verifiedBytes(manifest,chunk,input);
      if(!current())return;
      state.bytes=bytes;state.state='ready';state.failure=undefined;state.controller=undefined;resolveAll(state);
    }catch(cause){if(!current())return;
      const failure=cause instanceof BakeError?cause:new BakeError('BAKE_RESOLVE',`Chunk ${chunk.id} could not be resolved: ${String(cause)}`);
      state.state='failed';state.failure=failure;state.controller=undefined;rejectAll(state,failure);
    }
  };
  const request=(index:number,signal?:AbortSignal):Promise<void>=>{
    try {
      live();if(signal!==undefined&&!(signal instanceof AbortSignal))error('BAKE_SIGNAL','Expected an AbortSignal.');
      if(signal?.aborted)error('BAKE_ABORTED','Prefetch subscriber was cancelled.');
      const state=states[index];if(state.state==='ready')return Promise.resolve();
      let fresh=false;if(state.state!=='loading'){state.state='loading';state.failure=undefined;state.controller=new AbortController();fresh=true;}
      const promise=new Promise<void>((resolve,reject)=>{
        const waiter:Waiter={signal,resolve,reject,abort:()=>{
          if(!state.waiters.has(waiter))return;detach(state,waiter);reject(new BakeError('BAKE_ABORTED','Prefetch subscriber was cancelled.'));
          if(state.state==='loading'&&!state.waiters.size){const controller=state.controller;state.controller=undefined;state.state='missing';controller?.abort();}
        }};
        state.waiters.add(waiter);signal?.addEventListener('abort',waiter.abort,{once:true});if(signal?.aborted)waiter.abort();
      });
      if(fresh&&state.controller)void load(index,state.controller);return promise;
    }catch(cause){return Promise.reject(cause);}
  };
  const dispose=()=>{if(disposed)return;disposed=true;for(const state of states){
    const controller=state.controller;state.controller=undefined;state.bytes=undefined;state.failure=undefined;state.state='missing';
    rejectAll(state,new BakeError('BAKE_DISPOSED','Bake store was disposed.'));controller?.abort();
  }};
  return Object.freeze({manifest,
    async prefetch(time:number,signal?:AbortSignal){live();await Promise.all(needed(manifest,bracket(manifest,time)).map(i=>request(i,signal)));},
    async prefetchAll(signal?:AbortSignal){live();await Promise.all(states.map((_,i)=>request(i,signal)));},
    sample(time:number){live();return sampled(manifest,time,i=>states[i].bytes);},
    materialize(){live();if(states.some(s=>s.state!=='ready'))error('BAKE_NOT_READY','Materialization requires every chunk to be verified and ready.');
      return freezeSnapshot({...manifest,chunks:manifest.chunks.map((c,i)=>({...c,source:{kind:'inline' as const,data:encodeBakeBase64(states[i].bytes!)}}))});},
    status(){const state:BakeStoreStatus['state']=disposed?'disposed':states.some(s=>s.state==='loading')?'loading':states.some(s=>s.state==='failed')?'failed':states.every(s=>s.state==='ready')?'ready':'missing';
      return freezeSnapshot({state,loadedBytes:states.reduce((n,s)=>n+(s.bytes?.byteLength??0),0),totalBytes:manifest.chunks.reduce((n,c)=>n+c.byteLength,0),
        chunks:states.map((s,i)=>({id:manifest.chunks[i].id,state:s.state,...(s.failure?{code:s.failure.code}:{})}))});},
    dispose,release:dispose,
  });
}
