import {validateAssetJson} from './package.js';
import {copyMeshBuffers} from '../ir/mesh.js';
import {validateSpace3D,type Space3D} from '../ir/scene3d.js';
import {multiplyMatrix4,composeTransform3D,normalizeQuaternion,type Matrix4,type Quaternion} from '../geometry/matrix4.js';
import {freezeSnapshot} from '../operations/values.js';
import {sha256BakeBytes} from './bake-hash.js';
import type {Diagnostic} from '../ir/operations.js';

type Obj=Record<string,any>;
export interface GltfExportResult {
  asset:{document:Obj;buffers:string[]};
  sidecar:Obj;
  report:Obj;
}
export class GltfExportError extends Error {
  readonly diagnostics:Diagnostic[];
  constructor(readonly code:string,message:string,path='$'){
    super(`${code}: ${message} (${path})`);this.name='GltfExportError';
    this.diagnostics=[{severity:'error',code,message,path}];
  }
}
const fail=(code:string,message:string,path='$'):never=>{throw new GltfExportError(code,message,path);};
const object=(v:unknown):v is Obj=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const C:Matrix4=[1,0,0,0,0,0,1,0,0,-1,0,0,0,0,0,1];
const D:Matrix4=[1,0,0,0,0,0,-1,0,0,1,0,0,0,0,0,1];
const toY=(v:readonly number[])=>[v[0]||0,v[2]||0,-v[1]||0];
const scaleY=(v:readonly number[])=>[v[0],v[2],v[1]];
const quaternionY=(v:readonly number[])=>{const q=normalizeQuaternion(v as Quaternion);return [q[0]||0,q[2]||0,-q[1]||0,q[3]||0];};
const nonempty=(v:unknown)=>v!==undefined&&v!==null&&(typeof v!=='object'||Object.keys(v).length>0);
const canonical=(v:any):string=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?`[${v.map(canonical).join(',')}]`:`{${Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')}}`;
const digest=(v:any)=>sha256BakeBytes(new TextEncoder().encode(canonical(v)));
function base64(bytes:Uint8Array):string {
  let s='';for(let i=0;i<bytes.length;i+=16384)s+=String.fromCharCode(...bytes.subarray(i,i+16384));return btoa(s);
}
function matrixWithoutShear(m:readonly number[],path:string):void {
  const cols=[[m[0],m[1],m[2]],[m[4],m[5],m[6]],[m[8],m[9],m[10]]];
  const lengths=cols.map(c=>Math.hypot(...c));
  if(lengths.some(n=>!Number.isFinite(n)||n===0))fail('GLTF_EXPORT_TRANSFORM','Singular or unbounded matrices cannot be exported.',path);
  for(let i=0;i<3;i++)for(let j=i+1;j<3;j++){
    const dot=cols[i].reduce((sum,n,k)=>sum+n/lengths[i]*cols[j][k]/lengths[j],0);
    if(Math.abs(dot)>1e-10)fail('GLTF_EXPORT_SHEAR','glTF matrices must decompose into TRS without shear.',path);
  }
}

/** Spatial delivery export. The sidecar keeps native author metadata explicitly separate. */
export function exportGltfAsset(input:unknown):GltfExportResult {
  const malformed=validateAssetJson(input);
  if(malformed.length)fail('GLTF_EXPORT_JSON',malformed[0].message,malformed[0].path);
  if(!object(input)||!object(input.resources)||!object(input.space3d))fail('GLTF_EXPORT_INPUT','Expected a bundle or fragment with resources and space3d.');
  const source=structuredClone(input) as Obj,space=source.space3d as Space3D;
  for(const key of ['bakes','sampledFields','surfaces','curves3d','meshAttributes','instances','fieldVisualization'])
    if(nonempty(source[key]))fail('GLTF_EXPORT_UNEVALUATED',`Export requires explicit geometry; ${key} cannot be silently dropped.`,`$.${key}`);
  if(space.units!=='m'||space.handedness!=='right'||space.upAxis!=='z')fail('GLTF_EXPORT_UNITS','Export requires right-handed Z-up metres.','$.space3d');
  const declaredAspect=source.requiredAspectRatio??source.report?.requiredAspectRatio;
  const context:Obj={};if(source.viewport!==undefined)context.viewport=source.viewport;
  else if(typeof declaredAspect==='number'&&Number.isFinite(declaredAspect)&&declaredAspect>0)context.viewport={width:declaredAspect,height:1};
  if(source.duration!==undefined)context.duration=source.duration;
  const errors=validateSpace3D(space,source.resources,'$.space3d',context);
  if(errors.some(e=>e.severity==='error')){const e=errors.find(e=>e.severity==='error')!;fail('GLTF_EXPORT_SPATIAL',e.message,e.path);}
  if(space.clippingPlanes?.length||space.overlays?.length)fail('GLTF_EXPORT_UNSUPPORTED','Clipping planes and spatial overlays are not glTF delivery data.','$.space3d');
  const resources=source.resources as Obj;
  for(const [id,r] of Object.entries(resources))if(r.kind==='curve3d')fail('GLTF_EXPORT_UNSUPPORTED','Curve resources require an explicit mesh conversion.',`$.resources.${id}`);
  const document:Obj={asset:{version:'2.0',generator:'Texloom glTF interchange/1'},scene:0,scenes:[{nodes:[]}],nodes:[],meshes:[],materials:[],accessors:[],bufferViews:[],buffers:[],extensionsUsed:['KHR_materials_unlit']};
  const losses:Obj[]=[],converted=['Right-handed Z-up metres to right-handed Y-up metres by a proper rotation.','Negative node determinants remain explicit; local CCW indices retain their order.','Unlit display sRGB colors become linear glTF baseColorFactor values.'];
  let rounded=0,maxAbsoluteError=0,totalBytes=0;
  const chunks:{offset:number;bytes:Uint8Array}[]=[];
  const float=(n:number,path:string)=>{const value=Math.fround(n);if(!Number.isFinite(value))fail('GLTF_EXPORT_FLOAT32','Value overflows glTF float32.',path);if(value!==n){rounded++;maxAbsoluteError=Math.max(maxAbsoluteError,Math.abs(value-n));}return value;};
  function accessor(values:readonly number[],size:1|3|4,kind:'float'|'index',path:string,target?:number,extrema=false):number {
    if(!values.length||values.length%size)fail('GLTF_EXPORT_ACCESSOR','Accessors require a nonempty complete element array.',path);
    const wide=kind==='index'&&values.some(n=>n>=65535),componentType=kind==='float'?5126:wide?5125:5123,bytesPer=componentType===5123?2:4;
    const offset=Math.ceil(totalBytes/4)*4,nextBytes=offset+values.length*bytesPer;
    if(nextBytes>64*1024*1024)fail('GLTF_EXPORT_BUDGET','Binary output exceeds 64 MiB.');
    const numbers=kind==='float'?values.map(n=>float(n,path)):[...values];
    const raw=new Uint8Array(numbers.length*bytesPer),view=new DataView(raw.buffer);
    numbers.forEach((n,i)=>{if(kind==='float')view.setFloat32(i*4,n,true);else if(bytesPer===2)view.setUint16(i*2,n,true);else view.setUint32(i*4,n,true);});
    totalBytes=nextBytes;
    const bufferView=document.bufferViews.length;document.bufferViews.push({buffer:0,byteOffset:offset,byteLength:raw.length,...(target?{target}:{})});chunks.push({offset,bytes:raw});
    const a:Obj={bufferView,byteOffset:0,componentType,count:numbers.length/size,type:size===1?'SCALAR':size===3?'VEC3':'VEC4'};
    if(extrema){a.min=Array.from({length:size},()=>Infinity);a.max=Array.from({length:size},()=>-Infinity);numbers.forEach((n,i)=>{const k=i%size;a.min[k]=Math.min(a.min[k],n);a.max[k]=Math.max(a.max[k],n);});}
    const index=document.accessors.length;document.accessors.push(a);return index;
  }
  const geometry=new Map<string,Obj>(),materials=new Map<string,number>(),meshes=new Map<string,number>(),nodeIds=new Map<string,number>(),meshMapping=new Map<string,number[]>(),nodeMapping=new Map<string,number>();
  function geometryFor(id:string):Obj {
    if(geometry.has(id))return geometry.get(id)!;
    const r=resources[id];if(r.attributes&&Object.keys(r.attributes.values??{}).length)fail('GLTF_EXPORT_ATTRIBUTES','Authored mesh attributes require an explicit profile conversion.',`$.resources.${id}.attributes`);
    const arrays=copyMeshBuffers(r),positions:number[]=[];
    for(let i=0;i<arrays.positions.length;i+=3)positions.push(...toY([arrays.positions[i],arrays.positions[i+1],arrays.positions[i+2]]));
    const attributes:Obj={POSITION:accessor(positions,3,'float',`$.resources.${id}.positions`,34962,true)};
    if(arrays.normals){const normals:number[]=[];for(let i=0;i<arrays.normals.length;i+=3)normals.push(...toY([arrays.normals[i],arrays.normals[i+1],arrays.normals[i+2]]));attributes.NORMAL=accessor(normals,3,'float',`$.resources.${id}.normals`,34962);}
    const value={attributes,indices:accessor([...arrays.indices],1,'index',`$.resources.${id}.indices`,34963)};geometry.set(id,value);return value;
  }
  function materialFor(material:Obj|undefined,nodeId:string):number {
    const m=material??{kind:'unlit',color:'#d4d9e2'},hex=m.color??'#d4d9e2';
    if(m.colorAttribute)fail('GLTF_EXPORT_MATERIAL','Vertex color attributes are outside this delivery profile.',`$.space3d.nodes.${nodeId}.material`);
    if(m.wireframe)losses.push({code:'GLTF_EXPORT_WIREFRAME',path:`$.space3d.nodes.${nodeId}.material.wireframe`,message:'Wireframe is preserved in the native sidecar; the glTF delivery uses solid triangles.'});
    const channels=[1,3,5].map(offset=>parseInt(hex.slice(offset,offset+2),16)/255).map(c=>c<=.04045?c/12.92:((c+.055)/1.055)**2.4);
    const value={pbrMetallicRoughness:{baseColorFactor:[...channels,1],metallicFactor:0,roughnessFactor:1},extensions:{KHR_materials_unlit:{}},doubleSided:m.side==='double'};
    const key=canonical(value);if(materials.has(key))return materials.get(key)!;
    const index=document.materials.length;document.materials.push(value);materials.set(key,index);return index;
  }
  function transform(t:Obj|undefined,path:string,camera=false):Obj {
    const value=t??{};
    if(camera||value.matrix){const matrix=composeTransform3D(value);const converted=camera?multiplyMatrix4(D,matrix):multiplyMatrix4(multiplyMatrix4(D,matrix),C);matrixWithoutShear(converted,path);return {matrix:[...converted]};}
    const result:Obj={};
    if(value.translation)result.translation=toY(value.translation);
    if(value.rotation)result.rotation=quaternionY(value.rotation);
    if(value.scale){if(value.scale.some((n:number)=>n===0))fail('GLTF_EXPORT_TRANSFORM','Zero scales are outside the invertible delivery profile.',path);result.scale=scaleY(value.scale);}
    return result;
  }
  for(const node of space.nodes){
    if(node.kind!=='group'&&node.kind!=='mesh')fail('GLTF_EXPORT_UNSUPPORTED','Only explicit mesh and group nodes are supported.',`$.space3d.nodes.${node.id}`);
    if(node.kind==='mesh'&&node.visible===false)fail('GLTF_EXPORT_VISIBILITY','Hidden mesh nodes need an explicit visibility policy.',`$.space3d.nodes.${node.id}`);
    const n:Obj={name:node.id,...transform(node.transform,`$.space3d.nodes.${node.id}.transform`)};
    if(node.kind==='mesh'){
      const material=materialFor(node.material,node.id),key=node.resourceId+'|'+material;
      if(!meshes.has(key)){const index=document.meshes.length;document.meshes.push({name:node.resourceId,primitives:[{...geometryFor(node.resourceId),material,mode:4}]});meshes.set(key,index);if(!meshMapping.has(node.resourceId))meshMapping.set(node.resourceId,[]);meshMapping.get(node.resourceId)!.push(index);}
      n.mesh=meshes.get(key);
    }
    nodeIds.set(node.id,document.nodes.length);nodeMapping.set(node.id,document.nodes.length);document.nodes.push(n);
  }
  for(const node of space.nodes){const index=nodeIds.get(node.id)!;if(node.parent){const parent=document.nodes[nodeIds.get(node.parent)!];(parent.children??=[]).push(index);}else document.scenes[0].nodes.push(index);}
  if(!document.meshes.length)fail('GLTF_EXPORT_EMPTY','The profile requires at least one explicit triangle mesh.');
  if(space.camera){
    const camera=space.camera,projection=camera.projection;
    if(!projection)fail('GLTF_EXPORT_CAMERA','An exported camera requires an explicit finite projection.','$.space3d.camera');
    const ancestors=new Set<string>([camera.id]);let parent=camera.parent;
    while(parent){ancestors.add(parent);parent=space.nodes.find(n=>n.id===parent)?.parent;}
    if(space.tracks?.some(t=>ancestors.has(t.target)))fail('GLTF_EXPORT_CAMERA_ANIMATION','Only static cameras and camera ancestors are supported.');
    let cameraWorld=composeTransform3D(camera.transform),ancestor=camera.parent;
    while(ancestor){const node=space.nodes.find(n=>n.id===ancestor)!;cameraWorld=multiplyMatrix4(composeTransform3D(node.transform),cameraWorld);ancestor=node.parent;}
    const columns=[[cameraWorld[0],cameraWorld[1],cameraWorld[2]],[cameraWorld[4],cameraWorld[5],cameraWorld[6]],[cameraWorld[8],cameraWorld[9],cameraWorld[10]]];
    const determinant=columns[0][0]*(columns[1][1]*columns[2][2]-columns[1][2]*columns[2][1])-columns[1][0]*(columns[0][1]*columns[2][2]-columns[0][2]*columns[2][1])+columns[2][0]*(columns[0][1]*columns[1][2]-columns[0][2]*columns[1][1]);
    if(columns.some(c=>Math.abs(Math.hypot(...c)-1)>1e-10)||Math.abs(determinant-1)>1e-10||columns.some((c,i)=>columns.some((d,j)=>i<j&&Math.abs(c.reduce((s,n,k)=>s+n*d[k],0))>1e-10)))
      fail('GLTF_EXPORT_CAMERA_RIGID','The global camera basis must be proper rigid; affine scale or reflection cannot be preserved by glTF camera view rules.','$.space3d.camera');
    const aspect=source.viewport?source.viewport.width/source.viewport.height:source.requiredAspectRatio??source.report?.requiredAspectRatio;
    if(typeof aspect!=='number'||!Number.isFinite(aspect)||aspect<=0)fail('GLTF_EXPORT_CAMERA_ASPECT','Camera export requires a finite viewport aspect or fragment requiredAspectRatio.');
    const p=projection!,gltfCamera=p.kind==='perspective'?{type:'perspective',perspective:{yfov:p.fovY,znear:p.near,zfar:p.far,aspectRatio:aspect}}:{type:'orthographic',orthographic:{xmag:p.height*aspect/2,ymag:p.height/2,znear:p.near,zfar:p.far}};
    if(p.kind==='orthographic'&&!Number.isFinite(p.height*aspect/2))fail('GLTF_EXPORT_CAMERA','Orthographic width overflows its finite JSON representation.');
    document.cameras=[gltfCamera];const n:Obj={name:camera.id,camera:0,...transform(camera.transform,'$.space3d.camera.transform',true)},index=document.nodes.length;document.nodes.push(n);nodeMapping.set(camera.id,index);
    if(camera.parent)(document.nodes[nodeIds.get(camera.parent)!].children??=[]).push(index);else document.scenes[0].nodes.push(index);
  }
  if(space.tracks?.length){
    const samplers:Obj[]=[],channels:Obj[]=[];
    for(const [i,track] of space.tracks.entries()){
      const path=`$.space3d.tracks[${i}]`;
      if(!nodeIds.has(track.target))fail('GLTF_EXPORT_ANIMATION','Track target must be an exported mesh or group.',path);
      const times=track.keys.map(k=>float(k[0],path+'.keys.time'));
      if(times.some((n,i)=>i>0&&n<=times[i-1]))fail('GLTF_EXPORT_TIME_PRECISION','Distinct key times collapse after float32 conversion.',path);
      const values:number[]=[];for(const [,value] of track.keys){
        const converted=track.property==='translation'?toY(value):track.property==='scale'?scaleY(value):quaternionY(value);
        if(track.property==='scale'&&converted.some(n=>n===0||Math.fround(n)===0))fail('GLTF_EXPORT_TRANSFORM','Zero or float32-underflowing scale keyframes are outside the invertible profile.',path);
        values.push(...converted);
      }
      if(track.property==='scale'&&track.interpolation!=='step')for(let j=1;j<track.keys.length;j++)for(let axis=0;axis<3;axis++)if(Math.sign(track.keys[j-1][1][axis])!==Math.sign(track.keys[j][1][axis]))fail('GLTF_EXPORT_TRANSFORM','Linear scale tracks cannot cross a singular transform.',path);
      const sampler=samplers.length;samplers.push({input:accessor(times,1,'float',path+'.times',undefined,true),output:accessor(values,track.property==='rotation'?4:3,'float',path+'.values'),interpolation:track.interpolation==='step'?'STEP':'LINEAR'});channels.push({sampler,target:{node:nodeIds.get(track.target),path:track.property}});
    }
    document.animations=[{name:'Texloom spatial motion',samplers,channels}];
  }
  const bytes=new Uint8Array(totalBytes);for(const chunk of chunks)bytes.set(chunk.bytes,chunk.offset);
  document.buffers=[{uri:'buffer-000.bin',byteLength:bytes.byteLength}];
  if(rounded)losses.push({code:'GLTF_EXPORT_FLOAT32_ROUNDING',path:'$.asset.buffers',message:'Numeric accessors were rounded to finite IEEE float32.',componentCount:rounded,maxAbsoluteError});
  const native=structuredClone(source);delete native.space3d;native.resources=Object.fromEntries(Object.entries(resources).filter(([id])=>!geometry.has(id)));
  const sidecar={version:1,profile:'gltf-interchange-sidecar/1',roundTrip:false,boundary:'Native math, 2D authoring and lecture metadata require Texloom. This sidecar is not a glTF extension or an automatic reconstruction recipe.',native,spatialSource:space,meshMetadata:Object.fromEntries([...geometry.keys()].map(id=>[id,{topologyRevision:resources[id].topologyRevision,provenance:resources[id].provenance??null}]))};
  const report={version:1,profile:'gltf-interchange/1',direction:'export',coordinates:{source:'right-handed Z-up metres',target:'right-handed Y-up metres'},counts:{meshes:document.meshes.length,resources:geometry.size,nodes:document.nodes.length,materials:document.materials.length,animations:document.animations?.length??0,bufferBytes:bytes.byteLength},mappings:{meshes:Object.fromEntries(meshMapping),nodes:Object.fromEntries(nodeMapping)},preserved:['Triangle topology and shared vertex accessors','Group hierarchy and supported TRS animation','Opaque unlit base color and explicit side setting','Native author metadata in a separate sidecar'],converted,unsupported:[],losses,precision:{roundedComponents:rounded,maxAbsoluteError},output:{documentSha256:digest(document),bufferSha256:[sha256BakeBytes(bytes)]},sidecar:{roundTrip:false,sha256:digest(sidecar)}};
  return freezeSnapshot({asset:{document,buffers:[base64(bytes)]},sidecar,report}) as unknown as GltfExportResult;
}
