import type {Bundle} from '../schema.js';
import type {DeepReadonly, Diagnostic} from '../ir/operations.js';
import type {MeshBounds} from '../ir/mesh.js';
import {freezeSnapshot} from '../operations/values.js';
import {surfaceResourceDeclarations} from '../operations/surface.js';
import {curveResourceDeclarations} from '../operations/curve3d.js';
import {meshAttributeResourceDeclarations} from '../operations/mesh-attributes.js';
import {instanceResourceDeclarations} from '../operations/instances.js';
import {fieldVisualizationResourceDeclarations} from '../operations/field-visualization.js';

export const RESOURCE_MEDIA_TYPE = 'application/vnd.texloom.resource+json' as const;
interface AssetEntryData {
  id: string; mediaType: typeof RESOURCE_MEDIA_TYPE;
  byteLength: number; sha256: string;
  source: {kind:'inline';data:string} | {kind:'external';uri:string;byteRange?:{offset:number;length:number}};
}
/** Mesh bounds use their object-space chart; 2D resources retain the original tuple contract. */
export type AssetEntry = AssetEntryData & (
  {kind:'vector'|'scalar-field';bounds:[number,number,number,number]} |
  {kind:'mesh';bounds:MeshBounds|null} |
  {kind:'curve3d';bounds:MeshBounds|null}
);
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
  if(!['vector','scalar-field','mesh','curve3d'].includes(input.kind as string))error(out,'ASSET_KIND','Expected vector, scalar-field, mesh or curve3d.',`${path}.kind`);
  if(input.mediaType!==RESOURCE_MEDIA_TYPE)error(out,'ASSET_MEDIA_TYPE',`Expected ${RESOURCE_MEDIA_TYPE}.`,`${path}.mediaType`);
  if(!Number.isSafeInteger(input.byteLength)||(input.byteLength as number)<=0)error(out,'ASSET_SIZE','byteLength must be a positive safe integer.',`${path}.byteLength`);
  if(typeof input.sha256!=='string'||!/^[0-9a-f]{64}$/.test(input.sha256))error(out,'ASSET_HASH','Expected a lowercase SHA-256 hex digest.',`${path}.sha256`);
  const b=input.bounds;
  if(input.kind==='mesh'||input.kind==='curve3d'){
    if(b!==null){
      if(!object(b))error(out,'ASSET_BOUNDS','Mesh bounds must be null or finite ordered min/max triples.',`${path}.bounds`);
      else {
        keys(b,['min','max'],`${path}.bounds`,out);
        if(!Array.isArray(b.min)||!Array.isArray(b.max)||b.min.length!==3||b.max.length!==3||
           !b.min.every(finite)||!b.max.every(finite)||b.min.some((n,i)=>n>(b.max as number[])[i]))
          error(out,'ASSET_BOUNDS','Mesh bounds must be null or finite ordered min/max triples.',`${path}.bounds`);
      }
    }
  }else if(!Array.isArray(b)||b.length!==4||!b.every(finite)||b[2]<0||b[3]<0||!finite(b[0]+b[2])||!finite(b[1]+b[3]))
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
    if(!asset)error(out,'ASSET_REFERENCE','Expected an existing manifest resource ID.',`$.scene.nodes[${i}].resourceId`);
    else if(asset.kind!==(node.kind==='tex'?'vector':'scalar-field'))error(out,'ASSET_KIND','Node and asset resource kinds disagree.',`$.scene.nodes[${i}].resourceId`);
  });
  const generated=new Map<string,'mesh'|'curve3d'>();
  for(const declaration of surfaceResourceDeclarations(scene.surfaces)){
    if(generated.has(declaration.resourceId)||entries.has(declaration.resourceId))
      error(out,'ASSET_DUPLICATE',`Generated resource ID ${declaration.resourceId} must be unique and cannot replace a manifest asset.`,'$.scene.surfaces');
    generated.set(declaration.resourceId,'mesh');
  }
  for(const declaration of curveResourceDeclarations(scene.curves3d)){
    if(generated.has(declaration.resourceId)||entries.has(declaration.resourceId))
      error(out,'ASSET_DUPLICATE',`Generated resource ID ${declaration.resourceId} must be unique and cannot replace a manifest asset.`,'$.scene.curves3d');
    generated.set(declaration.resourceId,'curve3d');
  }
  // Attribute operations are ordered. Only a transported mesh, generated surface,
  // or an earlier valid attribute result may be an input; forward references do
  // not become available merely because they have an output declaration.
  const attributeDeclarations=meshAttributeResourceDeclarations(scene.meshAttributes);
  if(scene.meshAttributes!==undefined){
    const program=scene.meshAttributes;
    if(!object(program)||program.version!==1||!Array.isArray(program.operations)||attributeDeclarations.length!==program.operations.length)
      error(out,'ASSET_GENERATOR','Expected valid ordered mesh attribute source/output declarations.','$.scene.meshAttributes');
  }
  for(const [index,declaration] of attributeDeclarations.entries()){
    const path=`$.scene.meshAttributes.operations[${index}]`;
    if(generated.has(declaration.resourceId)||entries.has(declaration.resourceId)){
      error(out,'ASSET_DUPLICATE',`Generated resource ID ${declaration.resourceId} must be unique and cannot replace a manifest asset.`,`${path}.resourceId`);
      continue;
    }
    const sourceKind=entries.get(declaration.source)?.kind??generated.get(declaration.source);
    if(!sourceKind){error(out,'ASSET_REFERENCE','Attribute inputs require a manifest mesh, generated surface or an earlier attribute result; forward references and cycles are unsupported.',`${path}.source`);continue;}
    if(sourceKind!=='mesh'){error(out,'ASSET_KIND','Mesh attribute operations require a mesh source.',`${path}.source`);continue;}
    generated.set(declaration.resourceId,'mesh');
  }
  const instanceSets=new Set<string>(),fieldIds=new Set<string>(),fieldDeclarations=fieldVisualizationResourceDeclarations(scene.fieldVisualization);
  if(scene.fieldVisualization!==undefined){
    const program=scene.fieldVisualization;
    if(!object(program)||program.version!==1||!Array.isArray(program.operations)||fieldDeclarations.length!==program.operations.length)
      error(out,'ASSET_GENERATOR','Expected valid ordered field source/output declarations.','$.scene.fieldVisualization');
  }
  for(const [index,declaration] of fieldDeclarations.entries()){
    const path=`$.scene.fieldVisualization.operations[${index}]`;let valid=true;
    if(fieldIds.has(declaration.id)){error(out,'ASSET_DUPLICATE','Field operation IDs must be unique.',`${path}.id`);valid=false;}fieldIds.add(declaration.id);
    if(generated.has(declaration.resourceId)||entries.has(declaration.resourceId)){
      error(out,'ASSET_DUPLICATE','Field display meshes cannot replace manifest or generated resources.',`${path}.resourceId`);valid=false;
    }
    if(declaration.instanceSetId!==undefined&&instanceSets.has(declaration.instanceSetId)){
      error(out,'ASSET_DUPLICATE','Field arrow set IDs must be unique.',`${path}.arrows.instanceSetId`);valid=false;
    }
    for(const [id,where] of [[declaration.source,`${path}.source`],...(declaration.prototype===undefined?[]:[[declaration.prototype,`${path}.arrows.prototype`]])]){
      const kind=entries.get(id)?.kind??generated.get(id);
      if(!kind){error(out,'ASSET_REFERENCE','Fields require an authored mesh, surface, attribute result or earlier field display mesh; forward references are unsupported.',where);valid=false;}
      else if(kind!=='mesh'){error(out,'ASSET_KIND','Field sources and arrow prototypes require mesh resources.',where);valid=false;}
    }
    if(valid){generated.set(declaration.resourceId,'mesh');if(declaration.instanceSetId!==undefined)instanceSets.add(declaration.instanceSetId);}
  }
  // Instance prototypes and sampled sources are ordered mesh dependencies.
  // Only explicit realization creates a transport-independent mesh output.
  const instanceDeclarations=instanceResourceDeclarations(scene.instances);
  if(scene.instances!==undefined){
    const program=scene.instances;
    if(!object(program)||program.version!==1||!Array.isArray(program.operations)||instanceDeclarations.length!==program.operations.length)
      error(out,'ASSET_GENERATOR','Expected valid ordered instance prototype/source/output declarations.','$.scene.instances');
  }
  for(const [index,declaration] of instanceDeclarations.entries()){
    const path=`$.scene.instances.operations[${index}]`;let valid=true;
    if(instanceSets.has(declaration.id)){error(out,'ASSET_DUPLICATE','Instance set IDs must be unique.',`${path}.id`);valid=false;}
    if(declaration.resourceId!==undefined&&(generated.has(declaration.resourceId)||entries.has(declaration.resourceId))){
      error(out,'ASSET_DUPLICATE','Realized mesh IDs must be unique and cannot replace a manifest or generated asset.',`${path}.realize.resourceId`);valid=false;
    }
    for(const [resourceId,where] of [[declaration.prototype,`${path}.prototype`],...(declaration.source.kind==='mesh'?[[declaration.source.resourceId,`${path}.source.resourceId`]]:[])]){
      const kind=entries.get(resourceId)?.kind??generated.get(resourceId);
      if(!kind){error(out,'ASSET_REFERENCE','Instances require a manifest mesh, generated surface, attribute result or earlier realized mesh; forward references and cycles are unsupported.',where);valid=false;}
      else if(kind!=='mesh'){error(out,'ASSET_KIND','Instance prototypes and mesh-domain sources require mesh resources.',where);valid=false;}
    }
    instanceSets.add(declaration.id);
    if(valid&&declaration.resourceId!==undefined)generated.set(declaration.resourceId,'mesh');
  }
  if(object(scene.space3d)&&Array.isArray(scene.space3d.nodes))scene.space3d.nodes.forEach((node,i)=>{
    if(object(node)&&node.kind==='instances'){
      if(typeof node.instanceSetId!=='string'||!instanceSets.has(node.instanceSetId))error(out,'ASSET_REFERENCE','Expected an existing generated instance set ID.',`$.scene.space3d.nodes[${i}].instanceSetId`);
      return;
    }
    if(!object(node)||!['mesh','curve'].includes(node.kind as string))return;
    const asset=typeof node.resourceId==='string'?entries.get(node.resourceId):undefined;
    const kind=asset?.kind??generated.get(node.resourceId as string),expected=node.kind==='mesh'?'mesh':'curve3d';
    if(!kind)error(out,'ASSET_REFERENCE','Expected an existing manifest or generated 3D resource ID.',`$.scene.space3d.nodes[${i}].resourceId`);
    else if(kind!==expected)error(out,'ASSET_KIND',`3D ${String(node.kind)} nodes require ${expected} assets.`,`$.scene.space3d.nodes[${i}].resourceId`);
  });
  if(object(scene.space3d)&&Array.isArray(scene.space3d.overlays))scene.space3d.overlays.forEach((overlay,i)=>{
    if(!object(overlay))return;
    const asset=typeof overlay.resourceId==='string'?entries.get(overlay.resourceId):undefined;
    if(!asset)error(out,'ASSET_REFERENCE','Expected an existing manifest resource ID.',`$.scene.space3d.overlays[${i}].resourceId`);
    else if(asset.kind!=='vector')error(out,'ASSET_KIND','3D TeX overlays require vector assets.',`$.scene.space3d.overlays[${i}].resourceId`);
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
