import type {Bundle, Resource} from '../schema.js';
import type {DeepReadonly, Diagnostic} from '../ir/operations.js';
import {freezeSnapshot} from '../operations/values.js';

export const RESOURCE_MEDIA_TYPE = 'application/vnd.texloom.resource+json' as const;
export interface AssetEntry {
  id: string; kind: Resource['kind']; mediaType: typeof RESOURCE_MEDIA_TYPE;
  byteLength: number; sha256: string; bounds: [number, number, number, number];
  source: {kind:'inline';data:string} | {kind:'external';uri:string;byteRange?:{offset:number;length:number}};
}
export interface AssetManifest {version:1;requiredFeatures:string[];entries:AssetEntry[]}
export interface ScenePackage {contract:'texloom-package/1';scene:Omit<Bundle,'resources'>;assets:AssetManifest}
export interface AssetErrorContext {assetId?:string;uri?:string;path?:string;diagnostics?:readonly DeepReadonly<Diagnostic>[];cause?:unknown}
export class AssetError extends Error {
  readonly code:string;
  readonly assetId?:string;
  readonly uri?:string;
  readonly diagnostics:DeepReadonly<Diagnostic[]>;
  constructor(code:string,message:string,context:AssetErrorContext={}) {
    const suffix=[context.assetId&&`asset ${context.assetId}`,context.uri&&`URI ${context.uri}`].filter(Boolean).join(', ');
    super(`${code}: ${message}${suffix?` (${suffix})`:''}`, {cause:context.cause});
    this.name='AssetError';this.code=code;this.assetId=context.assetId;this.uri=context.uri;
    this.diagnostics=freezeSnapshot(context.diagnostics??[{severity:'error',code,message:this.message,path:context.path??'$.assets'}]);
  }
}

type Obj=Record<string,unknown>;
const object=(v:unknown):v is Obj=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
const text=(v:unknown):v is string=>typeof v==='string'&&v.trim().length>0;
const own=(v:object,k:string)=>Object.prototype.hasOwnProperty.call(v,k);
const error=(out:Diagnostic[],code:string,message:string,path:string)=>out.push({severity:'error',code,message,path});
const keys=(v:Obj,allowed:string[],path:string,out:Diagnostic[])=>{
  for(const key of Object.keys(v))if(!allowed.includes(key))error(out,'ASSET_PROPERTY',`Unsupported property ${key}.`,`${path}.${key}`);
};

/** Bounded descriptor traversal; validation never invokes a caller's getter. */
export function validateAssetJson(input:unknown,path='$'):Diagnostic[] {
  const out:Diagnostic[]=[],ancestors=new Set<object>();let count=0;
  const stop=(code:string,message:string,where:string)=>{if(!out.length)error(out,code,message,where);};
  const visit=(v:unknown,p:string,depth:number):void=>{
    if(out.length)return;
    if(++count>1_000_000){stop('ASSET_JSON_LIMIT','JSON data exceeds one million values.',p);return;}
    if(depth>128){stop('ASSET_JSON_DEPTH','Maximum JSON nesting depth is 128.',p);return;}
    if(v===null||typeof v==='string'||typeof v==='boolean'||finite(v))return;
    if(typeof v!=='object'){stop('ASSET_JSON_VALUE','Expected finite JSON data without functions or undefined.',p);return;}
    if(ancestors.has(v)){stop('ASSET_JSON_CYCLE','JSON data cannot contain cycles.',p);return;}
    const array=Array.isArray(v),proto=Object.getPrototypeOf(v);
    if(array?proto!==Array.prototype:proto!==Object.prototype&&proto!==null){stop('ASSET_JSON_OBJECT','Expected a plain JSON object or array.',p);return;}
    if(array&&v.length>1_000_000-count){stop('ASSET_JSON_LIMIT','Array exceeds the JSON value budget.',p);return;}
    const names=Reflect.ownKeys(v);
    if(names.length>1_000_000-count){stop('ASSET_JSON_LIMIT','Object exceeds the JSON value budget.',p);return;}
    ancestors.add(v);let indices=0;
    for(const key of names){
      if(array&&key==='length')continue;
      if(typeof key!=='string'){stop('ASSET_JSON_KEY','Symbol properties are not JSON.',p);break;}
      const descriptor=Object.getOwnPropertyDescriptor(v,key)!;
      if(!descriptor.enumerable||!own(descriptor,'value')||(array&&!/^(0|[1-9]\d*)$/.test(key))){
        stop('ASSET_JSON_VALUE','Only enumerable data properties and ordinary array elements are supported.',`${p}.${key}`);break;
      }
      if(array)indices++;
      visit(descriptor.value,`${p}.${key}`,depth+1);if(out.length)break;
    }
    if(array&&indices!==v.length&&!out.length)stop('ASSET_JSON_VALUE','Sparse arrays are not JSON.',p);
    ancestors.delete(v);
  };
  visit(input,path,0);return out;
}

function entryDiagnostics(input:unknown,path:string,out:Diagnostic[]):void {
  if(!object(input)){error(out,'ASSET_ENTRY','Expected an asset entry.',path);return;}
  keys(input,['id','kind','mediaType','byteLength','sha256','bounds','source'],path,out);
  if(!text(input.id)||input.id.length>512)error(out,'ASSET_ID','Asset ID must contain 1–512 characters.',`${path}.id`);
  if(!['vector','scalar-field'].includes(input.kind as string))error(out,'ASSET_KIND','Expected vector or scalar-field.',`${path}.kind`);
  if(input.mediaType!==RESOURCE_MEDIA_TYPE)error(out,'ASSET_MEDIA_TYPE',`Expected ${RESOURCE_MEDIA_TYPE}.`,`${path}.mediaType`);
  if(!Number.isSafeInteger(input.byteLength)||(input.byteLength as number)<=0)error(out,'ASSET_SIZE','byteLength must be a positive safe integer.',`${path}.byteLength`);
  if(typeof input.sha256!=='string'||!/^[0-9a-f]{64}$/.test(input.sha256))error(out,'ASSET_HASH','Expected a lowercase SHA-256 hex digest.',`${path}.sha256`);
  const b=input.bounds;
  if(!Array.isArray(b)||b.length!==4||!b.every(finite)||b[2]<0||b[3]<0||!finite(b[0]+b[2])||!finite(b[1]+b[3]))
    error(out,'ASSET_BOUNDS','Bounds must be finite [x,y,width,height] with nonnegative size.',`${path}.bounds`);
  else if(input.kind==='scalar-field'&&b.some((n,i)=>n!==[0,0,1,1][i]))error(out,'ASSET_BOUNDS','Scalar field bounds are normalized [0,0,1,1].',`${path}.bounds`);
  const s=input.source;
  if(!object(s)){error(out,'ASSET_SOURCE','Expected an inline or external source.',`${path}.source`);return;}
  if(s.kind==='inline'){
    keys(s,['kind','data'],`${path}.source`,out);
    if(typeof s.data!=='string')error(out,'ASSET_INLINE','Inline data must be a UTF-8 JSON string.',`${path}.source.data`);
  }else if(s.kind==='external'){
    keys(s,['kind','uri','byteRange'],`${path}.source`,out);
    if(!text(s.uri)||s.uri.length>8192||/^\s*blob:/i.test(s.uri)||s.uri.includes('\0'))
      error(out,'ASSET_URI','Expected a portable nonempty URI, not an ephemeral blob URL.',`${path}.source.uri`);
    if(s.byteRange!==undefined){
      const r=s.byteRange;
      if(!object(r)){error(out,'ASSET_RANGE','Expected byte range offset and length.',`${path}.source.byteRange`);return;}
      keys(r,['offset','length'],`${path}.source.byteRange`,out);
      if(!Number.isSafeInteger(r.offset)||(r.offset as number)<0||!Number.isSafeInteger(r.length)||(r.length as number)<=0||
         !Number.isSafeInteger((r.offset as number)+(r.length as number))||r.length!==input.byteLength)
        error(out,'ASSET_RANGE','Range offset must be nonnegative, its length must equal byteLength, and its end must be a safe integer.',`${path}.source.byteRange`);
    }
  }else error(out,'ASSET_SOURCE','Expected inline or external source kind.',`${path}.source.kind`);
}

export function validateAssetEntry(input:unknown,path='$.asset'):Diagnostic[] {
  const out=validateAssetJson(input,path);if(!out.length)entryDiagnostics(input,path,out);return out;
}

/** Resource-dependent graph validation is deliberately deferred until hydration. */
export function validateScenePackage(input:unknown):Diagnostic[] {
  const out=validateAssetJson(input);if(out.length)return out;
  if(!object(input)){error(out,'ASSET_PACKAGE','Expected a portable scene package.','$');return out;}
  keys(input,['contract','scene','assets'],'$',out);
  if(input.contract!=='texloom-package/1')error(out,'ASSET_CONTRACT','Expected texloom-package/1.','$.contract');
  const assets=input.assets,entries=new Map<string,AssetEntry>();
  if(!object(assets))error(out,'ASSET_MANIFEST','Expected an asset manifest.','$.assets');
  else {
    keys(assets,['version','requiredFeatures','entries'],'$.assets',out);
    if(assets.version!==1)error(out,'ASSET_VERSION','Supported manifest version is 1.','$.assets.version');
    if(!Array.isArray(assets.requiredFeatures)||assets.requiredFeatures.length>256||!assets.requiredFeatures.every(text)||
       new Set(assets.requiredFeatures).size!==assets.requiredFeatures.length)
      error(out,'ASSET_FEATURES','Expected at most 256 unique nonempty required feature names.','$.assets.requiredFeatures');
    if(!Array.isArray(assets.entries)||assets.entries.length>4096)error(out,'ASSET_ENTRIES','Expected at most 4096 asset entries.','$.assets.entries');
    else assets.entries.forEach((entry,i)=>{
      const p=`$.assets.entries[${i}]`;entryDiagnostics(entry,p,out);
      if(object(entry)&&text(entry.id)){
        if(entries.has(entry.id))error(out,'ASSET_DUPLICATE',`Duplicate asset ID ${entry.id}.`,p+'.id');
        else entries.set(entry.id,entry as unknown as AssetEntry);
      }
    });
  }
  const scene=input.scene;
  if(!object(scene)){error(out,'ASSET_SCENE','Expected a scene without embedded resources.','$.scene');return out;}
  if(own(scene,'resources'))error(out,'ASSET_SCENE_RESOURCES','Package scenes use manifest entries instead of an embedded resources dictionary.','$.scene.resources');
  if(!['0.1','0.2','0.3'].includes(scene.version as string)||scene.units!=='bp'||!text(scene.title)||!finite(scene.duration)||scene.duration<0)
    error(out,'ASSET_SCENE','Scene requires a supported version, bp units, title and finite nonnegative duration.','$.scene');
  if(!object(scene.viewport)||!finite(scene.viewport.width)||scene.viewport.width<=0||!finite(scene.viewport.height)||scene.viewport.height<=0)
    error(out,'ASSET_SCENE','Scene requires a positive finite viewport.','$.scene.viewport');
  if(!object(scene.camera)||!finite(scene.camera.x)||!finite(scene.camera.y)||!finite(scene.camera.zoom)||scene.camera.zoom<=0||
     (scene.camera.rotation!==undefined&&!finite(scene.camera.rotation)))error(out,'ASSET_SCENE','Scene requires a finite camera with positive zoom.','$.scene.camera');
  for(const name of ['nodes','tracks','relations'])if(!Array.isArray(scene[name]))error(out,'ASSET_SCENE',`Scene requires ${name} array.`,`$.scene.${name}`);
  if(Array.isArray(scene.nodes))scene.nodes.forEach((node,i)=>{
    if(!object(node)||!['tex','field'].includes(node.kind as string))return;
    const asset=typeof node.resourceId==='string'?entries.get(node.resourceId):undefined;
    if(!asset)error(out,'ASSET_REFERENCE',`No manifest asset for resource ${String(node.resourceId)}.`,`$.scene.nodes[${i}].resourceId`);
    else if(asset.kind!==(node.kind==='tex'?'vector':'scalar-field'))error(out,'ASSET_KIND','Node and asset resource kinds disagree.',`$.scene.nodes[${i}].resourceId`);
  });
  return out;
}

export function snapshotScenePackage(input:unknown):DeepReadonly<ScenePackage> {
  const diagnostics=validateScenePackage(input);
  if(diagnostics.some(d=>d.severity==='error'))throw new AssetError('ASSET_PACKAGE','Invalid scene package.',{diagnostics});
  return freezeSnapshot(input as ScenePackage);
}

export async function sha256Bytes(bytes:Uint8Array):Promise<string> {
  if(!globalThis.crypto?.subtle)throw new AssetError('ASSET_CRYPTO','Web Crypto SHA-256 is unavailable in this host.');
  const owned=new Uint8Array(bytes);
  const result=await globalThis.crypto.subtle.digest('SHA-256',owned);
  return Array.from(new Uint8Array(result),b=>b.toString(16).padStart(2,'0')).join('');
}
