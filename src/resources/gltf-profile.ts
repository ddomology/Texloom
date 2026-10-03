import {validateAssetJson} from './package.js';
import {sha256BakeBytes} from './bake-hash.js';
import {validateBundle,type Bundle} from '../schema.js';
import {validateSpace3D,type Space3D,type SceneNode3D,type TransformTrack3D} from '../ir/scene3d.js';
import {composeTransform3D,multiplyMatrix4,inverseMatrix4,identityMatrix4,type Matrix4,type Transform3D} from '../geometry/matrix4.js';
import {freezeSnapshot} from '../operations/values.js';
import type {Diagnostic} from '../ir/operations.js';
import type {MeshResource} from '../ir/mesh.js';
export {exportGltfAsset,GltfExportError,type GltfExportResult} from './gltf-export.js';

type Obj=Record<string,any>;
export interface GltfAsset {document:unknown;buffers:string[]}
export interface GltfImportOptions {wireframe?:boolean;materialPolicy?:'error'|'fallback';animation?:number;camera?:number}
export interface GltfImport {id:string;asset:GltfAsset;options?:GltfImportOptions}
export interface GltfBundleFragment {duration:number;rootId:string;resources:Record<string,MeshResource>;space3d:Space3D;report:Obj;requiredAspectRatio?:number}
export class GltfImportError extends Error {
  readonly diagnostics:Diagnostic[];
  constructor(readonly code:string,message:string,path='$') {super(`${code}: ${message} (${path})`);this.name='GltfImportError';this.diagnostics=[{severity:'error',code,message,path}];}
}
const fail=(code:string,message:string,path='$'):never=>{throw new GltfImportError(code,message,path);};
const object=(v:unknown):v is Obj=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
const uint=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0;
const tuple=(v:unknown,n:number):v is number[]=>Array.isArray(v)&&v.length===n&&v.every(finite);
const scope=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(v);
const C:Matrix4=[1,0,0,0,0,0,1,0,0,-1,0,0,0,0,0,1];
const D:Matrix4=[1,0,0,0,0,0,-1,0,0,1,0,0,0,0,0,1];
const point=(v:readonly number[])=>[v[0],-v[2],v[1]];
const scale=(v:readonly number[])=>[v[0],v[2],v[1]];
const rotation=(v:readonly number[])=>[v[0],-v[2],v[1],v[3]];
const hash=(v:unknown)=>sha256BakeBytes(new TextEncoder().encode(JSON.stringify(v)));
function json(value:unknown,path:string):void {const d=validateAssetJson(value,path);if(d.length)fail('GLTF_JSON',d[0].message,d[0].path);}
function index(v:unknown,array:readonly unknown[],path:string):number {if(!uint(v)||v>=array.length)fail('GLTF_INDEX','Expected an existing array index.',path);return v as number;}
function list(d:Obj,key:string,max=4096):Obj[] {const a=d[key]??[];if(!Array.isArray(a)||a.length>max||a.some(x=>!object(x)))fail('GLTF_ARRAY',`Expected at most ${max} ${key} objects.`,`$.document.${key}`);return a;}
function unitQuaternion(v:unknown,path:string):number[] {if(!tuple(v,4)||Math.abs(Math.hypot(...v)-1)>1e-4)fail('GLTF_QUATERNION','A normalized quaternion is required.',path);return v as number[];}
function matrixCheck(m:Readonly<Matrix4>,path:string,rigid=false):void {
  const columns=[[m[0],m[1],m[2]],[m[4],m[5],m[6]],[m[8],m[9],m[10]]],lengths=columns.map(c=>Math.hypot(...c));
  if(lengths.some(n=>!Number.isFinite(n)||n===0)||m[3]!==0||m[7]!==0||m[11]!==0||m[15]!==1)fail('GLTF_TRANSFORM','Expected an invertible finite affine matrix.',path);
  for(let a=0;a<3;a++)for(let b=a+1;b<3;b++)if(Math.abs(columns[a].reduce((s,n,k)=>s+n/lengths[a]*columns[b][k]/lengths[b],0))>1e-8)fail('GLTF_TRANSFORM','Matrix shear is outside the supported TRS profile.',path);
  if(rigid){const det=m[0]*(m[5]*m[10]-m[6]*m[9])-m[4]*(m[1]*m[10]-m[2]*m[9])+m[8]*(m[1]*m[6]-m[2]*m[5]);
    if(lengths.some(n=>Math.abs(n-1)>1e-8)||Math.abs(det-1)>1e-8)fail('GLTF_CAMERA_TRANSFORM','Selected camera must have a proper rigid global transform; camera scale/reflection is unsupported.',path);}
  try{inverseMatrix4(m);}catch{fail('GLTF_TRANSFORM','Matrix inverse cannot be represented.',path);}
}

/** Pure bounded interchange: callers resolve container bytes; no URI is fetched here. */
export function importGltfAsset(asset:GltfAsset,id='gltf',options:GltfImportOptions={}):GltfBundleFragment {
  json(asset,'$.asset');json(options,'$.options');
  if(!scope(id))fail('GLTF_SCOPE','Expected a safe ASCII scope of at most 64 characters.');
  if(!object(options)||Object.keys(options).some(k=>!['wireframe','materialPolicy','animation','camera'].includes(k))||options.wireframe!==undefined&&typeof options.wireframe!=='boolean'||options.materialPolicy!==undefined&&!['error','fallback'].includes(options.materialPolicy)||['animation','camera'].some(k=>Object.hasOwn(options,k)&&!uint((options as Obj)[k])))fail('GLTF_OPTIONS','Malformed import options.');
  if(!object(asset)||Object.keys(asset).some(k=>!['document','buffers'].includes(k))||!object(asset.document)||!Array.isArray(asset.buffers))fail('GLTF_INPUT','Expected a document and resolved base64 buffers.');
  const d=asset.document as Obj;
  // Bound strings before serialization, including callers that bypass file capture.
  let stringUnits=0;const jsonStack:unknown[]=[d];while(jsonStack.length){const value=jsonStack.pop();if(typeof value==='string')stringUnits+=value.length;else if(Array.isArray(value))for(const child of value)jsonStack.push(child);else if(object(value))for(const [key,child] of Object.entries(value)){stringUnits+=key.length;jsonStack.push(child);}if(stringUnits>8*1024*1024)fail('GLTF_DOCUMENT_BUDGET','glTF JSON exceeds the 8 MiB document budget.');}
  const documentBytes=new TextEncoder().encode(JSON.stringify(d));if(documentBytes.length>8*1024*1024)fail('GLTF_DOCUMENT_BUDGET','glTF JSON exceeds the 8 MiB document budget.');
  if(!object(d.asset)||d.asset.version!=='2.0'||d.asset.minVersion!==undefined&&d.asset.minVersion!=='2.0')fail('GLTF_VERSION','Only glTF 2.0 is supported.');
  const losses:Obj[]=[],unsupported:Obj[]=[],fallback=options.materialPolicy==='fallback';
  for(const key of ['extensionsUsed','extensionsRequired'])if(d[key]!==undefined&&(!Array.isArray(d[key])||d[key].some((x:unknown)=>typeof x!=='string')||new Set(d[key]).size!==d[key].length))fail('GLTF_EXTENSION','Expected unique extension names.',`$.document.${key}`);
  for(const name of d.extensionsRequired??[])if(name!=='KHR_materials_unlit')fail('GLTF_EXTENSION',`Unsupported required extension: ${name}.`);
  for(const name of d.extensionsRequired??[])if(!(d.extensionsUsed??[]).includes(name))fail('GLTF_EXTENSION','Required extensions must also be declared used.');
  function extensions(o:Obj,path:string,material=false):void {
    if(o.extensions===undefined)return;if(!object(o.extensions))fail('GLTF_EXTENSION','Expected extension data.',path);
    for(const [name,value] of Object.entries(o.extensions)){
      if(!(d.extensionsUsed??[]).includes(name))fail('GLTF_EXTENSION','Extension is not declared in extensionsUsed.',path);
      if(name==='KHR_materials_unlit'&&material){if(!object(value)||Object.keys(value).length)fail('GLTF_MATERIAL','Malformed unlit extension.',path);continue;}
      if(material&&fallback){unsupported.push({code:'GLTF_MATERIAL_EXTENSION',path,name});continue;}
      fail('GLTF_EXTENSION',`Unsupported extension: ${name}.`,path);
    }
  }
  extensions(d,'$.document.extensions');extensions(d.asset,'$.document.asset.extensions');
  const declarations=list(d,'buffers',64),views=list(d,'bufferViews',8192),accessors=list(d,'accessors',8192),meshes=list(d,'meshes'),nodes=list(d,'nodes'),scenes=list(d,'scenes'),materials=list(d,'materials'),animations=list(d,'animations',64),cameras=list(d,'cameras');
  if(list(d,'skins').length)fail('GLTF_SKIN','Skinning is outside this profile.');
  for(const key of ['images','textures','samplers'])if(list(d,key).length){if(!fallback)fail('GLTF_MATERIAL','Textures require explicit material fallback.');unsupported.push({code:'GLTF_MATERIAL_TEXTURES',path:`$.document.${key}`,count:d[key].length});}
  if(!declarations.length||asset.buffers.length!==declarations.length)fail('GLTF_BUFFER','Every declared buffer needs exactly one resolved payload.');
  let total=0;
  const buffers=declarations.map((b,i)=>{
    extensions(b,`$.document.buffers[${i}]`);
    if(!uint(b.byteLength)||b.byteLength<1||(total+=b.byteLength)>64*1024*1024)fail('GLTF_BUFFER_BUDGET','Buffers require positive lengths within a combined 64 MiB budget.');
    const encoded=asset.buffers[i];
    if(typeof encoded!=='string'||encoded.length!==4*Math.ceil(b.byteLength/3)||/[^A-Za-z0-9+/=]/.test(encoded))fail('GLTF_BUFFER_ENCODING','Expected canonical base64 bytes.');
    let text='';try{text=atob(encoded);}catch{fail('GLTF_BUFFER_ENCODING','Malformed base64 payload.');}if(text.length!==b.byteLength||btoa(text)!==encoded)fail('GLTF_BUFFER_LENGTH','Buffer declaration and resolved payload differ.');
    return Uint8Array.from(text,c=>c.charCodeAt(0));
  });
  views.forEach((v,i)=>{const path=`$.document.bufferViews[${i}]`;extensions(v,path);index(v.buffer,buffers,path+'.buffer');
    if(!uint(v.byteOffset??0)||!uint(v.byteLength)||v.byteLength<1||(v.byteOffset??0)+v.byteLength>buffers[v.buffer].length)fail('GLTF_BUFFER_VIEW','Buffer view lies outside its payload.',path);
    if(v.byteStride!==undefined&&(!uint(v.byteStride)||v.byteStride<4||v.byteStride>252||v.byteStride%4))fail('GLTF_STRIDE','Stride must be a multiple of four between 4 and 252.',path);
    if(v.target!==undefined&&![34962,34963].includes(v.target))fail('GLTF_BUFFER_VIEW','Unsupported buffer target.',path);
  });
  const cache=new Map<number,{values:number[];size:number;type:number;count:number}>(),viewUsage=new Map<number,string>();let cells=0;
  function read(number:unknown,type:string,components:number[],path:string,vertex=false,element=false):number[] {
    const ai=index(number,accessors,path),a=accessors[ai];extensions(a,path);
    if(a.sparse!==undefined)fail('GLTF_ACCESSOR_SPARSE','Sparse accessors are outside this profile.',path);
    if(a.type!==type||!components.includes(a.componentType)||a.normalized!==undefined&&a.normalized!==false)fail('GLTF_ACCESSOR','Unsupported accessor type, component type or normalization.',path);
    const vi=index(a.bufferView,views,path+'.bufferView'),v=views[vi],bytes=a.componentType===5121?1:a.componentType===5123?2:4,size=type==='SCALAR'?1:type==='VEC3'?3:4,offset=a.byteOffset??0,stride=v.byteStride??bytes*size;
    if(!uint(a.count)||a.count<1||a.count>262144||!uint(offset)||offset%bytes||(offset+(v.byteOffset??0))%bytes||stride<bytes*size||offset+(a.count-1)*stride+bytes*size>v.byteLength)fail('GLTF_ACCESSOR_BOUNDS','Accessor alignment, count, stride or bounds are invalid.',path);
    if(vertex&&(offset%4||stride%4))fail('GLTF_ACCESSOR_ALIGNMENT','Vertex elements require four-byte alignment.',path);
    if(element&&v.byteStride!==undefined||!vertex&&!element&&v.byteStride!==undefined)fail('GLTF_ACCESSOR_STRIDE','Only vertex attributes may have a byte stride.',path);
    if(v.target!==undefined&&v.target!==(element?34963:34962)||!vertex&&!element&&v.target!==undefined)fail('GLTF_ACCESSOR_TARGET','Buffer target disagrees with accessor usage.',path);
    const usage=vertex?'vertex':element?'index':'animation';if(viewUsage.has(vi)&&viewUsage.get(vi)!==usage)fail('GLTF_BUFFER_VIEW_USAGE','Vertex, index and animation data require separate buffer views.',path);viewUsage.set(vi,usage);
    if(cache.has(ai))return cache.get(ai)!.values;
    if((cells+=a.count*size)>750000)fail('GLTF_ACCESSOR_BUDGET','Decoded accessor component budget exceeded.');
    const data=buffers[v.buffer],view=new DataView(data.buffer,data.byteOffset,data.byteLength),values:number[]=[];
    for(let i=0;i<a.count;i++)for(let c=0;c<size;c++){const p=(v.byteOffset??0)+offset+i*stride+c*bytes;const n=a.componentType===5126?view.getFloat32(p,true):bytes===1?view.getUint8(p):bytes===2?view.getUint16(p,true):view.getUint32(p,true);if(!Number.isFinite(n))fail('GLTF_ACCESSOR_NUMBER','Accessor contains a nonfinite number.',path);values.push(n);}
    for(const key of ['min','max'])if(a[key]!==undefined){if(!tuple(a[key],size))fail('GLTF_ACCESSOR_EXTREMA','Malformed accessor extrema.',path);for(let c=0;c<size;c++){let extreme=key==='min'?Infinity:-Infinity;for(let i=c;i<values.length;i+=size)extreme=key==='min'?Math.min(extreme,values[i]):Math.max(extreme,values[i]);if((a.componentType===5126?Math.fround(a[key][c]):a[key][c])!==extreme)fail('GLTF_ACCESSOR_EXTREMA','Accessor extrema disagree with the decoded bytes.',path);}}
    cache.set(ai,{values,size,type:a.componentType,count:a.count});return values;
  }
  // Remaining lowering operates only on validated detached numeric data.
  return lower();

  function lower():GltfBundleFragment {
    if(!nodes.length||!scenes.length)fail('GLTF_SCENE','An explicit nonempty scene graph is required.');
    const sceneIndex=d.scene===undefined?0:index(d.scene,scenes,'$.document.scene'),parents=new Map<number,number>(),locals:Transform3D[]=[];
    nodes.forEach((n,i)=>{const path=`$.document.nodes[${i}]`;extensions(n,path);
      if(n.skin!==undefined||n.weights!==undefined)fail('GLTF_SKIN_MORPH','Skinning and morph weights are unsupported.',path);
      if(n.mesh!==undefined)index(n.mesh,meshes,path+'.mesh');if(n.camera!==undefined)index(n.camera,cameras,path+'.camera');
      if(n.children!==undefined&&(!Array.isArray(n.children)||new Set(n.children).size!==n.children.length))fail('GLTF_HIERARCHY','Children must be unique node indices.',path);
      for(const child of n.children??[]){index(child,nodes,path+'.children');if(parents.has(child))fail('GLTF_HIERARCHY','Nodes may have only one parent.',path);parents.set(child,i);}
      if(n.matrix!==undefined){if(['translation','rotation','scale'].some(k=>n[k]!==undefined)||!tuple(n.matrix,16))fail('GLTF_TRANSFORM','Matrix and TRS are exclusive.',path);matrixCheck(n.matrix as Matrix4,path);locals.push({matrix:[...multiplyMatrix4(multiplyMatrix4(C,n.matrix as Matrix4),D)]});}
      else {const t:Obj={};for(const [key,convert] of [['translation',point],['scale',scale]] as const)if(n[key]!==undefined){if(!tuple(n[key],3)||key==='scale'&&n[key].some((x:number)=>x===0))fail('GLTF_TRANSFORM','TRS vectors must be finite and scale invertible.',path);t[key]=convert(n[key]);}
        if(n.rotation!==undefined)t.rotation=rotation(unitQuaternion(n.rotation,path+'.rotation'));locals.push(t as Transform3D);}
    });
    const done=new Set<number>();for(let i=0;i<nodes.length;i++){const chain=new Set<number>();let c:number|undefined=i;while(c!==undefined&&!done.has(c)){if(chain.has(c))fail('GLTF_HIERARCHY','Node hierarchy contains a cycle.');chain.add(c);c=parents.get(c);}for(const n of chain)done.add(n);}
    scenes.forEach((s,i)=>{extensions(s,`$.document.scenes[${i}]`);if(!Array.isArray(s.nodes)||!s.nodes.length||new Set(s.nodes).size!==s.nodes.length)fail('GLTF_SCENE','Scene roots must be nonempty and unique.');for(const root of s.nodes){index(root,nodes,'$.document.scenes.nodes');if(parents.has(root))fail('GLTF_HIERARCHY','Scene roots must not have a parent.');}});
    const active=new Set<number>(),pending=[...scenes[sceneIndex].nodes] as number[];while(pending.length){const n=pending.pop()!;active.add(n);pending.push(...(nodes[n].children??[]));}
    let outputNodes=1+active.size;for(const n of active){const mesh=nodes[n].mesh;if(mesh!==undefined){const primitives=meshes[mesh].primitives;if(!Array.isArray(primitives)||!primitives.length||primitives.length>256)fail('GLTF_MESH','Expected 1–256 mesh primitives.');outputNodes+=primitives.length;}}if(outputNodes>4096)fail('GLTF_OUTPUT_BUDGET','Expanded spatial graph exceeds 4096 nodes.');
    const spatial:SceneNode3D[]=[{kind:'group',id}],resources:Record<string,MeshResource>={},meshCache=new Map<string,{resourceId:string;material:Obj}>(),nodeMap=new Map<number,string>();
    let outputVertices=0,outputIndices=0;
    for(const n of active)nodeMap.set(n,`${id}:node:${n}`);
    const numeric=(data:number[],components:1|3,componentType:'float64'|'uint16'|'uint32')=>({version:1 as const,componentType,components,count:data.length/components,byteOffset:0,byteStride:components*(componentType==='float64'?8:componentType==='uint16'?2:4),data});
    const materialCache=new Map<number,Obj>();
    function material(mi:unknown,path:string):Obj {
      const mindex=mi===undefined?-1:index(mi,materials,path);if(materialCache.has(mindex))return materialCache.get(mindex)!;
      const m=mindex<0?{}:materials[mindex];extensions(m,path,true);
      const pbr=m.pbrMetallicRoughness??{};if(!object(pbr))fail('GLTF_MATERIAL','Expected a PBR material object.',path);extensions(pbr,path+'.pbrMetallicRoughness');
      const rgba:number[]=pbr.baseColorFactor??[1,1,1,1];if(!tuple(rgba,4)||rgba.some(n=>n<0||n>1)||m.doubleSided!==undefined&&typeof m.doubleSided!=='boolean')fail('GLTF_MATERIAL','Invalid material color or side.',path);
      const unlit=object(m.extensions)&&Object.hasOwn(m.extensions,'KHR_materials_unlit');
      const lossy=!unlit||m.alphaMode!==undefined&&m.alphaMode!=='OPAQUE'||rgba[3]!==1||['baseColorTexture','metallicRoughnessTexture'].some(k=>pbr[k]!==undefined)||['normalTexture','occlusionTexture','emissiveTexture'].some(k=>m[k]!==undefined)||m.emissiveFactor!==undefined&&(!tuple(m.emissiveFactor,3)||m.emissiveFactor.some((n:number)=>n!==0));
      if(lossy){if(!fallback)fail('GLTF_MATERIAL','Only opaque unlit colors are supported; material=fallback must be explicit.',path);losses.push({code:'GLTF_MATERIAL_FALLBACK',path,message:'Lighting, textures and transparency are replaced with an opaque unlit base color.'});}
      const channels=rgba.slice(0,3).map(v=>v<=.0031308?12.92*v:1.055*v**(1/2.4)-.055),bytes=channels.map(v=>Math.round(v*255));
      if(channels.some((v,i)=>v*255!==bytes[i]))losses.push({code:'GLTF_COLOR_QUANTIZATION',path,message:'Linear base color converted to native eight-bit display sRGB.'});
      const value={kind:'unlit',color:'#'+bytes.map(v=>v.toString(16).padStart(2,'0')).join(''),side:m.doubleSided?'double':'front',wireframe:options.wireframe??false};materialCache.set(mindex,value);return value;
    }
    function primitive(meshIndex:number,pi:number):{resourceId:string;material:Obj} {
      const key=`${meshIndex}:${pi}`;if(meshCache.has(key))return meshCache.get(key)!;
      const mesh=meshes[meshIndex],p=mesh.primitives[pi],path=`$.document.meshes[${meshIndex}].primitives[${pi}]`;extensions(p,path);
      if(p.mode!==undefined&&p.mode!==4||p.targets!==undefined)fail('GLTF_PRIMITIVE','Only triangle primitives without morph targets are supported.',path);
      if(!object(p.attributes)||p.attributes.POSITION===undefined)fail('GLTF_PRIMITIVE','POSITION is required.',path);
      for(const attr of Object.keys(p.attributes))if(!['POSITION','NORMAL'].includes(attr)){if(!fallback||!['TEXCOORD_0','TEXCOORD_1','TANGENT','COLOR_0'].includes(attr))fail('GLTF_ATTRIBUTE',`Unsupported vertex attribute ${attr}.`,path);unsupported.push({code:'GLTF_ATTRIBUTE_FALLBACK',path,attribute:attr});}
      const source=read(p.attributes.POSITION,'VEC3',[5126],path+'.POSITION',true),positionAccessor=accessors[p.attributes.POSITION];
      if(positionAccessor.min===undefined||positionAccessor.max===undefined)fail('GLTF_ACCESSOR_EXTREMA','POSITION requires min and max.',path);
      const indexCount=p.indices===undefined?source.length/3:accessors[index(p.indices,accessors,path+'.indices')].count;
      if(!uint(indexCount)||(outputVertices+=source.length/3)>65536||(outputIndices+=indexCount)>262143||meshCache.size>=1024)fail('GLTF_OUTPUT_BUDGET','Expanded geometry exceeds 65536 vertices, 262143 indices or 1024 resources.',path);
      const positions:number[]=[];for(let i=0;i<source.length;i+=3)positions.push(...point(source.slice(i,i+3)));
      const vertexCount=positions.length/3,indices=p.indices===undefined?Array.from({length:vertexCount},(_,i)=>i):read(p.indices,'SCALAR',[5121,5123,5125],path+'.indices',false,true);
      const maximum=p.indices===undefined?Infinity:({5121:255,5123:65535,5125:4294967295} as Obj)[accessors[p.indices].componentType];
      if(indices.length%3||indices.some(i=>i>=vertexCount||i===maximum))fail('GLTF_INDICES','Triangle indices must address vertices and exclude restart values.',path);
      let normals:number[]|undefined;if(p.attributes.NORMAL!==undefined){const raw=read(p.attributes.NORMAL,'VEC3',[5126],path+'.NORMAL',true);if(raw.length!==positions.length)fail('GLTF_NORMAL','Normals and positions must have matching counts.',path);normals=[];for(let i=0;i<raw.length;i+=3){if(Math.abs(Math.hypot(...raw.slice(i,i+3))-1)>1e-4)fail('GLTF_NORMAL','Normals must have unit length.',path);normals.push(...point(raw.slice(i,i+3)));}}
      const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];positions.forEach((n,i)=>{min[i%3]=Math.min(min[i%3],n);max[i%3]=Math.max(max[i%3],n);});
      const resourceId=`${id}:mesh:${key}`,resource={kind:'mesh',version:1,primitive:'triangles',units:'m',coordinateSpace:'object',winding:'ccw',topologyRevision:`gltf:${hash({positions,indices})}`,positions:numeric(positions,3,'float64'),indices:numeric(indices,1,vertexCount>65535?'uint32':'uint16'),...(normals?{normals:numeric(normals,3,'float64')}:{}),bounds:{min,max},provenance:{profile:'gltf-interchange/1',mesh:meshIndex,primitive:pi}};
      resources[resourceId]=resource as unknown as MeshResource;const result={resourceId,material:material(p.material,path+'.material')};meshCache.set(key,result);return result;
    }
    for(const n of [...active].sort((a,b)=>a-b)){
      const source=nodes[n],parent=parents.get(n);spatial.push({kind:'group',id:nodeMap.get(n)!,parent:parent===undefined?id:nodeMap.get(parent)!,transform:locals[n]});
      if(source.mesh===undefined)continue;const mesh=meshes[source.mesh];extensions(mesh,`$.document.meshes[${source.mesh}]`);
      if(mesh.weights!==undefined||!Array.isArray(mesh.primitives)||!mesh.primitives.length||mesh.primitives.length>256||mesh.primitives.some((p:unknown)=>!object(p)))fail('GLTF_MESH','Expected bounded primitives without morph weights.');
      for(let p=0;p<mesh.primitives.length;p++){const value=primitive(source.mesh,p);spatial.push({kind:'mesh',id:`${id}:primitive:${n}:${p}`,parent:nodeMap.get(n)!,resourceId:value.resourceId,material:value.material as any});}
    }
    if(!meshCache.size)fail('GLTF_EMPTY','Selected scene has no supported triangle meshes.');
    const tracks:TransformTrack3D[]=[];let duration=0,outputKeys=0;
    let selectedAnimation:number|undefined=options.animation;if(selectedAnimation!==undefined)index(selectedAnimation,animations,'$.options.animation');else if(animations.length===1)selectedAnimation=0;else if(animations.length>1)fail('GLTF_ANIMATION_SELECTION','Multiple animations require explicit selection.');
    if(selectedAnimation!==undefined){const animation=animations[selectedAnimation];extensions(animation,'$.document.animations');const samplers=list(animation,'samplers'),channels=list(animation,'channels');if(!channels.length)fail('GLTF_ANIMATION','Selected animation requires channels.');const writers=new Set<string>();
      for(const [ci,channel] of channels.entries()){const path=`$.document.animations[${selectedAnimation}].channels[${ci}]`;extensions(channel,path);if(!object(channel.target))fail('GLTF_ANIMATION','Animation target is required.',path);extensions(channel.target,path+'.target');
        const target=index(channel.target.node,nodes,path+'.target.node'),property=channel.target.path;if(!active.has(target))fail('GLTF_ANIMATION_TARGET','Selected animation targets a node outside the selected scene.',path);
        if(!['translation','rotation','scale'].includes(property)||nodes[target].matrix!==undefined)fail('GLTF_ANIMATION_TARGET','TRS animation requires a TRS-authored node.',path);
        const writer=`${target}:${property}`;if(writers.has(writer))fail('GLTF_ANIMATION_CONFLICT','Multiple channels write one node property.',path);writers.add(writer);
        const sampler=samplers[index(channel.sampler,samplers,path+'.sampler')];extensions(sampler,path+'.sampler');const interpolation=sampler.interpolation??'LINEAR';if(!['STEP','LINEAR'].includes(interpolation))fail('GLTF_ANIMATION_INTERPOLATION','Only STEP and LINEAR are supported.',path);
        const times=read(sampler.input,'SCALAR',[5126],path+'.input'),size=property==='rotation'?4:3,values=read(sampler.output,size===4?'VEC4':'VEC3',[5126],path+'.output');
        if((outputKeys+=times.length)>65536)fail('GLTF_OUTPUT_BUDGET','Expanded animation exceeds 65536 keyframes.',path);
        if(times.length>4096||times.some((t,i)=>t<0||i>0&&t<=times[i-1])||values.length!==times.length*size||accessors[sampler.input].min===undefined||accessors[sampler.input].max===undefined)fail('GLTF_ANIMATION_KEYS','Keys require matching output counts and strictly increasing nonnegative time extrema.',path);
        const keys=times.map((time,i)=>{const value=values.slice(i*size,(i+1)*size);if(property==='rotation')unitQuaternion(value,path+'.output');if(property==='scale'&&(value.some(n=>n===0)||interpolation==='LINEAR'&&i>0&&value.some((n,k)=>Math.sign(n)!==Math.sign(values[(i-1)*size+k]))))fail('GLTF_ANIMATION_SCALE','Scale keys must stay invertible between samples.',path);return [time,(property==='translation'?point(value):property==='rotation'?rotation(value):scale(value))] as TransformTrack3D['keys'][number];});
        duration=Math.max(duration,times.at(-1)!);tracks.push({target:nodeMap.get(target)!,property,interpolation:interpolation==='STEP'?'step':'linear',keys});
      }
    }
    const space3d:Space3D={version:1,units:'m',handedness:'right',upAxis:'z',nodes:spatial,...(tracks.length?{tracks}:{})};let requiredAspectRatio:number|undefined;
    if(options.camera!==undefined){const selected=index(options.camera,cameras,'$.options.camera'),instances=[...active].filter(n=>nodes[n].camera===selected);if(instances.length!==1)fail('GLTF_CAMERA_SELECTION','A selected camera must have exactly one scene instance.');
      const camera=cameras[selected],node=instances[0];extensions(camera,'$.document.cameras');const chain:number[]=[];let current:number|undefined=node;while(current!==undefined){chain.unshift(current);current=parents.get(current);}if(tracks.some(t=>chain.some(n=>t.target===nodeMap.get(n))))fail('GLTF_CAMERA_ANIMATION','Selected camera and its ancestors must be static.');
      let world:Readonly<Matrix4>=identityMatrix4();for(const n of chain)world=multiplyMatrix4(world,composeTransform3D(locals[n]));matrixCheck(multiplyMatrix4(world,C),'$.document.camera.global',true);
      let projection:Obj={};
      if(camera.type==='perspective'&&object(camera.perspective)){const p=camera.perspective;extensions(p,'$.document.camera.perspective');if(!finite(p.zfar))fail('GLTF_CAMERA','An explicit finite far plane is required.');if(p.aspectRatio!==undefined){if(!finite(p.aspectRatio)||p.aspectRatio<=0)fail('GLTF_CAMERA','Invalid aspect ratio.');requiredAspectRatio=p.aspectRatio;}projection={kind:'perspective',fovY:p.yfov,near:p.znear,far:p.zfar};}
      else if(camera.type==='orthographic'&&object(camera.orthographic)){const p=camera.orthographic;extensions(p,'$.document.camera.orthographic');if(!finite(p.xmag)||!finite(p.ymag)||p.xmag<=0||p.ymag<=0)fail('GLTF_CAMERA','Orthographic magnitudes must be positive.');requiredAspectRatio=p.xmag/p.ymag;projection={kind:'orthographic',height:2*p.ymag,near:p.znear,far:p.zfar};}
      else fail('GLTF_CAMERA','Expected a finite perspective or orthographic camera.');
      space3d.camera={id:`${id}:camera:${selected}`,parent:nodeMap.get(node)!,transform:{matrix:[...C]},projection:projection as any};
    }
    const errors=validateSpace3D(space3d,resources,'$.space3d',{viewport:{width:requiredAspectRatio??1,height:1},duration}).filter(d=>d.severity==='error');if(errors.length)fail('GLTF_SPATIAL',errors[0].message,errors[0].path);
    const report={version:1,profile:'gltf-interchange/1',direction:'import',scope:id,rootId:id,source:{documentSha256:sha256BakeBytes(documentBytes),bufferSha256:buffers.map(sha256BakeBytes)},selection:{scene:sceneIndex,animation:selectedAnimation??null,camera:options.camera??null},counts:{resources:meshCache.size,instances:spatial.filter(n=>n.kind==='mesh').length,nodes:spatial.length,tracks:tracks.length,bufferBytes:total},coordinates:{source:'right-handed Y-up metres',target:'right-handed Z-up metres',map:'(x,y,z) -> (x,-z,y)'},preserved:['Triangle topology and shared geometry','Hierarchy and supported TRS tracks','Opaque unlit base colors'],converted:['Local geometry C*p and node transforms C*M*C^-1','Camera optical transform C*M','Float32 accessors retained exactly in native float64 buffers'],unsupported,losses,ignored:{scenes:scenes.map((_,i)=>i).filter(i=>i!==sceneIndex),nodes:nodes.map((_,i)=>i).filter(i=>!active.has(i)),animations:animations.map((_,i)=>i).filter(i=>i!==selectedAnimation),cameras:cameras.map((_,i)=>i).filter(i=>i!==options.camera)},mappings:{nodes:Object.fromEntries(nodeMap),resources:Object.fromEntries([...meshCache].map(([key,value])=>[key,value.resourceId]))},...(requiredAspectRatio!==undefined?{requiredAspectRatio}:{})};
    return freezeSnapshot({duration,rootId:id,resources,space3d,report,...(requiredAspectRatio!==undefined?{requiredAspectRatio}:{})}) as unknown as GltfBundleFragment;
  }
}

/** Atomic import into a native scene. An authored group with the scope ID provides placement. */
export function mergeGltfAssets(input:unknown,imports:readonly GltfImport[]):{bundle:Bundle;reports:Obj[]} {
  json(input,'$.bundle');json(imports,'$.imports');
  if(!object(input)||!object(input.resources)||!finite(input.duration)||input.duration<0||input.provenance!==undefined&&!object(input.provenance))fail('GLTF_MERGE','Expected a native bundle with resources, duration and object provenance.');
  if(!Array.isArray(imports)||imports.length>8)fail('GLTF_MERGE','At most eight imports are supported.');
  const bundle=structuredClone(input) as Bundle,reports:Obj[]=[],scopes=new Set<string>();if(imports.length)bundle.version='0.3';
  for(const entry of imports){if(!object(entry)||Object.keys(entry).some(k=>!['id','asset','options'].includes(k))||!scope(entry.id)||scopes.has(entry.id))fail('GLTF_MERGE','Expected unique safe import IDs.');scopes.add(entry.id);
    const fragment=structuredClone(importGltfAsset(entry.asset,entry.id,entry.options));
    if(fragment.duration>bundle.duration)fail('GLTF_MERGE_DURATION','Imported duration exceeds the authored scene.');
    if(bundle.space3d&&(!object(bundle.space3d)||bundle.space3d.units!=='m'||bundle.space3d.upAxis!=='z'||bundle.space3d.handedness!=='right'||!Array.isArray(bundle.space3d.nodes)))fail('GLTF_MERGE_BASIS','Authored and imported coordinate units must agree.');
    for(const rid of Object.keys(fragment.resources))if(Object.hasOwn(bundle.resources,rid))fail('GLTF_MERGE_RESOURCE','Imported resource ID collides with existing data.');
    Object.assign(bundle.resources,fragment.resources);bundle.space3d??={version:1,units:'m',handedness:'right',upAxis:'z',nodes:[]};
    const existing=new Map(bundle.space3d.nodes.map(n=>[n.id,n]));if(bundle.space3d.camera)existing.set(bundle.space3d.camera.id,bundle.space3d.camera as any);
    for(const node of fragment.space3d.nodes){const previous=existing.get(node.id);if(previous){if(node.id!==fragment.rootId||previous.kind!=='group')fail('GLTF_MERGE_NODE',`Node collision: ${node.id}.`);}else bundle.space3d.nodes.push(node);}
    if(fragment.space3d.tracks){bundle.space3d.tracks??=[];bundle.space3d.tracks.push(...fragment.space3d.tracks);}
    if(fragment.space3d.camera){if(bundle.space3d.camera)fail('GLTF_MERGE_CAMERA','An authored or previously selected camera already exists.');if(existing.has(fragment.space3d.camera.id))fail('GLTF_MERGE_CAMERA','Camera ID collides with a node.');
      const aspect=bundle.viewport.width/bundle.viewport.height;if(fragment.requiredAspectRatio!==undefined&&Math.abs(aspect-fragment.requiredAspectRatio)>1e-10*Math.max(1,aspect))fail('GLTF_MERGE_ASPECT','Logical viewport aspect differs from the selected glTF camera.');bundle.space3d.camera=fragment.space3d.camera;
      const byId=new Map<string,any>(bundle.space3d.nodes.map(n=>[n.id,n]));byId.set(fragment.space3d.camera.id,fragment.space3d.camera);const chain:any[]=[],seen=new Set<string>();let c:any=fragment.space3d.camera;
      while(c){if(seen.has(c.id))fail('GLTF_MERGE_CAMERA','Camera parent cycle.');seen.add(c.id);chain.unshift(c);if(c.parent&&!byId.has(c.parent))fail('GLTF_MERGE_CAMERA','Missing camera ancestor.');c=c.parent?byId.get(c.parent):undefined;}
      if(bundle.space3d.tracks?.some(t=>seen.has(t.target)))fail('GLTF_MERGE_CAMERA','Selected camera ancestors must be static.');let world:Readonly<Matrix4>=identityMatrix4();for(const n of chain)world=multiplyMatrix4(world,composeTransform3D(n.transform??{}));matrixCheck(world,'$.bundle.space3d.camera',true);
    }
    reports.push(fragment.report);
  }
  bundle.provenance??={};if(Object.hasOwn(bundle.provenance,'gltfImports'))fail('GLTF_MERGE_PROVENANCE','Import provenance already exists.');bundle.provenance.gltfImports=reports;
  const errors=validateBundle(bundle).filter(d=>d.severity==='error');if(errors.length)fail('GLTF_MERGE_BUNDLE',errors[0].message,errors[0].path);
  return freezeSnapshot({bundle,reports}) as unknown as {bundle:Bundle;reports:Obj[]};
}
