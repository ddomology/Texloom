import {validateBundle, type Resource} from '../schema.js';
import type {DeepReadonly} from '../ir/operations.js';
import {freezeSnapshot} from '../operations/values.js';
import {AssetError,validateAssetEntry,validateAssetJson,sha256Bytes,type AssetEntry} from './package.js';

export type AssetResolver=(entry:DeepReadonly<AssetEntry>,context:{signal:AbortSignal})=>Promise<Uint8Array|ArrayBuffer>;
export interface AssetLease {readonly resource:DeepReadonly<Resource>;release():void}
export interface AssetStoreStats {entries:number;pending:number;ready:number;waiters:number;leases:number;reservedBytes:number;disposed:boolean}
export interface AssetStore {
  acquire(entry:DeepReadonly<AssetEntry>,signal?:AbortSignal):Promise<AssetLease>;
  stats():Readonly<AssetStoreStats>;
  dispose():void;
}
export interface AssetStoreOptions {resolver?:AssetResolver;maxAssetBytes?:number;maxTotalBytes?:number}
interface Waiter {
  entry:DeepReadonly<AssetEntry>;signal?:AbortSignal;abort:()=>void;
  resolve:(lease:AssetLease)=>void;reject:(error:AssetError)=>void;lease?:AssetLease;done:boolean;
}
interface EntryState {
  key:string;entry:DeepReadonly<AssetEntry>;controller:AbortController;waiters:Set<Waiter>;
  leases:Set<AssetLease>;resource?:DeepReadonly<Resource>;removed:boolean;
}
const context=(entry:DeepReadonly<AssetEntry>)=>({assetId:entry.id,
  ...(entry.source.kind==='external'?{uri:entry.source.uri}:{}),path:`$.assets.entries[${JSON.stringify(entry.id)}]`});
const fail=(entry:DeepReadonly<AssetEntry>,code:string,message:string,cause?:unknown)=>new AssetError(code,message,{...context(entry),cause});
const identity=(e:DeepReadonly<AssetEntry>)=>JSON.stringify([e.sha256,e.kind,e.mediaType,e.byteLength,e.bounds]);

/** A content-addressed, reference-counted store. Transport and URI policy belong to the host. */
export function createAssetStore(options:AssetStoreOptions={}):AssetStore {
  if(options===null||typeof options!=='object'||Array.isArray(options))throw new AssetError('ASSET_OPTIONS','Expected asset store options.');
  const {resolver,maxAssetBytes=16*1024*1024,maxTotalBytes=64*1024*1024}=options;
  for(const [name,value] of Object.entries({maxAssetBytes,maxTotalBytes}))if(!Number.isSafeInteger(value)||value<=0)
    throw new AssetError('ASSET_BUDGET',`${name} must be a positive safe integer.`);
  if(resolver!==undefined&&typeof resolver!=='function')throw new AssetError('ASSET_RESOLVER','Resolver must be a host function.');
  const entries=new Map<string,EntryState>();let reservedBytes=0,disposed=false;

  const detach=(waiter:Waiter)=>waiter.signal?.removeEventListener('abort',waiter.abort);
  const remove=(state:EntryState)=>{
    if(state.removed)return;
    state.removed=true;
    if(entries.get(state.key)===state){entries.delete(state.key);reservedBytes-=state.entry.byteLength;}
    state.resource=undefined;state.controller.abort();
  };
  const unreferenced=(state:EntryState)=>{if(!state.waiters.size&&!state.leases.size)remove(state);};
  const rejectWaiter=(state:EntryState,waiter:Waiter,error:AssetError)=>{
    if(waiter.done)return;
    waiter.done=true;detach(waiter);state.waiters.delete(waiter);waiter.reject(error);
  };
  const publish=(state:EntryState,waiter:Waiter)=>{
    if(waiter.done||state.removed||!state.resource)return;
    state.waiters.delete(waiter);waiter.done=true;let released=false;
    const lease:AssetLease=Object.freeze({resource:state.resource,release:()=>{
      if(released)return;released=true;detach(waiter);state.leases.delete(lease);unreferenced(state);
    }});
    waiter.lease=lease;state.leases.add(lease);waiter.resolve(lease);
  };
  const ensureLive=(state:EntryState)=>{
    if(state.removed||disposed||state.controller.signal.aborted)throw fail(state.entry,'ASSET_ABORTED','Asset acquisition was cancelled.');
  };
  const load=async(state:EntryState):Promise<void>=>{
    const e=state.entry;
    try {
      ensureLive(state);
      let incoming:Uint8Array|ArrayBuffer;
      if(e.source.kind==='inline'){
        // Avoid allocating a large UTF-8 buffer for an obviously wrong declared size.
        if(e.source.data.length>e.byteLength)throw fail(e,'ASSET_SIZE','Inline JSON exceeds the declared UTF-8 payload size.');
        incoming=new TextEncoder().encode(e.source.data);
      }else{
        if(!resolver)throw fail(e,'ASSET_RESOLVER','External assets require an explicit host resolver.');
        incoming=await resolver(e,{signal:state.controller.signal});
      }
      ensureLive(state);
      let bytes:Uint8Array;
      if(incoming instanceof Uint8Array){
        if(incoming.byteLength!==e.byteLength)throw fail(e,'ASSET_SIZE','Resolver must return exactly byteLength selected payload bytes; the store never slices a full response.');
        bytes=new Uint8Array(incoming);
      }else if(incoming instanceof ArrayBuffer){
        if(incoming.byteLength!==e.byteLength)throw fail(e,'ASSET_SIZE','Resolver must return exactly byteLength selected payload bytes; the store never slices a full response.');
        bytes=new Uint8Array(incoming.slice(0));
      }else throw fail(e,'ASSET_BYTES','Resolver must return Uint8Array or ArrayBuffer payload bytes.');
      if(await sha256Bytes(bytes)!==e.sha256)throw fail(e,'ASSET_HASH','SHA-256 digest does not match the declared payload.');
      ensureLive(state);
      let json:string,resource:unknown;
      try {json=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}
      catch(error){throw fail(e,'ASSET_UTF8','Payload is not valid UTF-8.',error);}
      try {resource=JSON.parse(json);}
      catch(error){throw fail(e,'ASSET_JSON','Payload is not a JSON resource.',error);}
      const jsonDiagnostics=validateAssetJson(resource,'$.resource');
      if(jsonDiagnostics.length)throw new AssetError('ASSET_RESOURCE','Resource exceeds the JSON contract.',{...context(e),diagnostics:jsonDiagnostics});
      const diagnostics=validateBundle({version:'0.3',title:'Asset validation',duration:0,units:'bp',
        viewport:{width:1,height:1},camera:{x:0,y:0,zoom:1},nodes:[],tracks:[],relations:[],resources:{asset:resource}});
      if(diagnostics.some(d=>d.severity==='error'))throw new AssetError('ASSET_RESOURCE','Resource payload failed validation.',{...context(e),diagnostics});
      const r=resource as Resource;
      if(r.kind!==e.kind)throw fail(e,'ASSET_KIND','Payload kind differs from the manifest entry.');
      const bounds=r.kind==='vector'?r.inkBounds:[0,0,1,1];
      if(bounds.some((value,i)=>value!==e.bounds[i]))throw fail(e,'ASSET_BOUNDS','Payload bounds differ from the manifest entry.');
      ensureLive(state);state.resource=freezeSnapshot(r);
      for(const waiter of [...state.waiters])publish(state,waiter);
      unreferenced(state);
    }catch(error){
      if(!state.removed){
        for(const waiter of [...state.waiters]){
          const failure=error instanceof AssetError?new AssetError(error.code,'Asset payload could not be loaded or verified.',{...context(waiter.entry),
            diagnostics:error.diagnostics.map(d=>({...d,path:context(waiter.entry).path+
              (d.path&&/^\$\.resources\.asset(?:\.|$)|^\$\.resource(?:\.|$)/.test(d.path)?
                '.payload'+d.path.replace(/^\$\.resources\.asset|^\$\.resource/,''):'')})),cause:error}):fail(waiter.entry,'ASSET_RESOLVE','Asset resolver or verification failed.',error);
          rejectWaiter(state,waiter,failure);
        }
        remove(state);
      }
      // A resolver may ignore abort and settle late. Detached states never re-enter the cache.
    }
  };
  return Object.freeze({
    acquire(entry:DeepReadonly<AssetEntry>,signal?:AbortSignal):Promise<AssetLease>{
      try {
        if(disposed)throw new AssetError('ASSET_DISPOSED','Asset store is disposed.');
        if(signal!==undefined&&!(signal instanceof AbortSignal))throw new AssetError('ASSET_SIGNAL','Expected an AbortSignal.');
        const diagnostics=validateAssetEntry(entry);
        if(diagnostics.length)throw new AssetError('ASSET_ENTRY','Invalid asset entry.',{diagnostics});
        const e=freezeSnapshot(entry);
        if(signal?.aborted)throw fail(e,'ASSET_ABORTED','Asset acquisition was cancelled.');
        if(e.byteLength>maxAssetBytes)throw fail(e,'ASSET_BUDGET','Asset exceeds maxAssetBytes.');
        const key=identity(e);let state=entries.get(key),fresh=false;
        if(!state){
          if(e.byteLength>maxTotalBytes-reservedBytes)throw fail(e,'ASSET_BUDGET','Asset would exceed the store total reserved-byte budget.');
          state={key,entry:e,controller:new AbortController(),waiters:new Set(),leases:new Set(),removed:false};
          entries.set(key,state);reservedBytes+=e.byteLength;fresh=true;
        }
        const current=state;
        const promise=new Promise<AssetLease>((resolve,reject)=>{
          const waiter:Waiter={entry:e,signal,resolve,reject,done:false,abort:()=>{
            if(waiter.lease){waiter.lease.release();return;}
            rejectWaiter(current,waiter,fail(e,'ASSET_ABORTED','Asset acquisition was cancelled.'));unreferenced(current);
          }};
          current.waiters.add(waiter);signal?.addEventListener('abort',waiter.abort,{once:true});
          if(signal?.aborted)waiter.abort();else if(current.resource)publish(current,waiter);
        });
        if(fresh)void load(current);
        return promise;
      }catch(error){return Promise.reject(error instanceof AssetError?error:new AssetError('ASSET_ACQUIRE','Could not acquire asset.',{cause:error}));}
    },
    stats():Readonly<AssetStoreStats>{
      let pending=0,ready=0,waiters=0,leases=0;
      for(const state of entries.values()){if(state.resource)ready++;else pending++;waiters+=state.waiters.size;leases+=state.leases.size;}
      return Object.freeze({entries:entries.size,pending,ready,waiters,leases,reservedBytes,disposed});
    },
    dispose():void{
      if(disposed)return;disposed=true;
      for(const state of [...entries.values()]){
        for(const waiter of [...state.waiters])rejectWaiter(state,waiter,fail(waiter.entry,'ASSET_DISPOSED','Asset store was disposed.'));
        for(const lease of [...state.leases])lease.release();remove(state);
      }
    },
  });
}
