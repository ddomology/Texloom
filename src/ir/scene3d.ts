import {validateBundle,type Resource} from '../schema.js';
import {type Diagnostic,type DeepReadonly,OperationValidationError} from './operations.js';
import {validateJsonData,freezeSnapshot} from '../operations/values.js';
import {validateMeshResource,type MeshUnit,type MeshResource} from './mesh.js';
import {validateCurve3DResource,type Curve3DResource} from './curve3d.js';
import {composeTransform3D,identityMatrix4,multiplyMatrix4,inverseMatrix4,normalMatrix3D,
  orientationMatrix4,transformBounds3D,transformPoint3D,normalizeQuaternion,normalizeVec3,validateTransform3D,
  type Transform3D,type Matrix4,type Matrix3,type Bounds3D,type Vec3,type Quaternion} from '../geometry/matrix4.js';
import {projectionMatrix3D,viewProjectionMatrix3D,projectPoint3D,validateProjection3D,validateViewport3D,
  type Projection3D,type Viewport3D} from '../geometry/projection3d.js';

interface SpatialNode {id:string;parent?:string;transform?:Transform3D}
export interface Group3D extends SpatialNode {kind:'group'}
export interface UnlitMaterial3D {kind:'unlit';color:string;side?:'front'|'double';wireframe?:boolean;colorAttribute?:string}
export interface MeshInstance3D extends SpatialNode {kind:'mesh';resourceId:string;visible?:boolean;material?:UnlitMaterial3D}
export interface CurveInstance3D extends SpatialNode {kind:'curve';resourceId:string;visible?:boolean;color?:string}
export type SceneNode3D=Group3D|MeshInstance3D|CurveInstance3D;
/** Camera local forward -Z, up +Y. Projection uses the logical Bundle viewport aspect. */
export interface Camera3D extends SpatialNode {projection?:Projection3D}
/** World half-space: keep dot(normal, point) + constant >= 0. */
export interface ClippingPlane3D {normal:Vec3;constant:number}
export interface Overlay3D {id:string;resourceId:string;parent?:string;position:Vec3;offset?:[number,number];scale?:number;color?:string}
export interface TransformTrack3D {target:string;property:'translation'|'rotation'|'scale';keys:[number,Vec3|Quaternion][];interpolation?:'linear'|'step'}
export interface Space3D {
  version:1;units:MeshUnit;handedness:'right';upAxis:'z';nodes:SceneNode3D[];camera?:Camera3D;
  clippingPlanes?:ClippingPlane3D[];overlays?:Overlay3D[];tracks?:TransformTrack3D[];
}
export interface Space3DContext {viewport?:Viewport3D;duration?:number}
export interface EvaluatedMeshInstance3D {
  id:string;resourceId:string;visible:boolean;topologyRevision:string;material:{kind:'unlit';color:string;side:'front'|'double';wireframe:boolean;colorAttribute?:string};
  worldMatrix:Readonly<Matrix4>;modelViewMatrix:Readonly<Matrix4>|null;
  /** World inverse-transpose, separate from the winding/reflection sign. */
  normalMatrix:Readonly<Matrix3>|null;orientation:-1|0|1;worldWinding:'ccw'|'cw'|null;worldBounds:DeepReadonly<Bounds3D>|null;
}
export interface EvaluatedOverlay3D {
  id:string;resourceId:string;worldPosition:Vec3;position:[number,number]|null;ndc:Vec3|null;visible:boolean;scale:number;color:string;
}
export interface EvaluatedCurveInstance3D {
  id:string;resourceId:string;visible:boolean;color:string;topologyRevision:string;
  worldMatrix:Readonly<Matrix4>;modelViewMatrix:Readonly<Matrix4>|null;worldBounds:DeepReadonly<Bounds3D>|null;
}
export interface Space3DEvaluation {
  version:1;units:MeshUnit;handedness:'right';upAxis:'z';
  groups:{id:string;worldMatrix:Readonly<Matrix4>}[];instances:EvaluatedMeshInstance3D[];
  curves:EvaluatedCurveInstance3D[];
  camera:{id:string;worldMatrix:Readonly<Matrix4>;viewMatrix:Readonly<Matrix4>;forwardAxis:'-z';upAxis:'y';
    projection:Projection3D|null;projectionMatrix:Readonly<Matrix4>|null;viewProjectionMatrix:Readonly<Matrix4>|null;aspect:number|null}|null;
  clippingPlanes:ClippingPlane3D[];overlays:EvaluatedOverlay3D[];diagnostics:Diagnostic[];
}
export const SPACE3D_MAX_NODES=4096,SPACE3D_MAX_TRACKS=4096,SPACE3D_MAX_KEYS=65536,SPACE3D_MAX_PLANES=32,SPACE3D_MAX_OVERLAYS=1024;
const object=(v:unknown):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
const name=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=256&&v.trim()===v;
const resourceName=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=512&&v.trim()===v;
const color=(v:unknown):v is string=>typeof v==='string'&&/^#[0-9a-fA-F]{6}$/.test(v);
const tuple=(v:unknown,length:number):v is number[]=>Array.isArray(v)&&v.length===length&&v.every(finite);
const hasErrors=(d:readonly Diagnostic[])=>d.some(x=>x.severity==='error');
const range=(v:readonly number[])=>{if(v.some(n=>!Number.isFinite(n)))throw new OperationValidationError([{severity:'error',code:'SPACE3D_RANGE',message:'Spatial arithmetic exceeded the finite numeric range.',path:'$.space3d'}]);};

function inspect(input:unknown,resources:Record<string,Resource>,path:string,inContext:boolean,context:Space3DContext):Diagnostic[] {
  const diagnostics=validateJsonData(input,path);if(!inContext)diagnostics.push(...validateJsonData(resources,'$.resources'));
  diagnostics.push(...validateJsonData(context,'$.context'));if(hasErrors(diagnostics))return diagnostics;
  const error=(code:string,message:string,at=path)=>diagnostics.push({severity:'error',code,message,path:at});
  const keys=(v:Record<string,unknown>,allowed:readonly string[],at:string)=>{for(const key of Object.keys(v))if(!allowed.includes(key))error('SPACE3D_FIELD',`Unknown property ${key}.`,at+'.'+key);};
  if(!object(context)){error('SPACE3D_CONTEXT','Expected a spatial preparation context.');return diagnostics;}
  keys(context as Record<string,unknown>,['viewport','duration'],'$.context');if(context.viewport!==undefined)diagnostics.push(...validateViewport3D(context.viewport,'$.context.viewport'));
  if(context.duration!==undefined&&(!finite(context.duration)||context.duration<0))error('SPACE3D_DURATION','Duration must be finite and nonnegative.','$.context.duration');
  if(!object(input)||input.version!==1||!Array.isArray(input.nodes)){error('SPACE3D_PROGRAM','Expected version 1 and a nodes array.');return diagnostics;}
  if(!object(resources)){error('SPACE3D_RESOURCES','Expected a resource dictionary.');return diagnostics;}
  keys(input,['version','units','handedness','upAxis','nodes','camera','clippingPlanes','overlays','tracks'],path);
  if(!['unit','m','cm','mm'].includes(input.units))error('SPACE3D_UNITS','Expected explicit unit, m, cm or mm. No bp conversion is implicit.',path+'.units');
  if(input.handedness!=='right'||input.upAxis!=='z')error('SPACE3D_BASIS','Version 1 uses a right-handed, Z-up world basis.');
  if(input.nodes.length>SPACE3D_MAX_NODES){error('SPACE3D_BUDGET',`At most ${SPACE3D_MAX_NODES} nodes are supported.`);return diagnostics;}
  const byId=new Map<string,SceneNode3D|Camera3D>(),checkedResources=new Set<string>();
  const check=(node:unknown,at:string,camera=false)=>{
    if(!object(node)){error('SPACE3D_NODE','Expected a spatial object.',at);return;}
    keys(node,camera?['id','parent','transform','projection']:node.kind==='mesh'?['kind','id','parent','transform','resourceId','visible','material']:node.kind==='curve'?['kind','id','parent','transform','resourceId','visible','color']:['kind','id','parent','transform'],at);
    if(!name(node.id)||byId.has(node.id))error('SPACE3D_ID','IDs must be unique, nonempty and at most 256 characters.',at+'.id');else byId.set(node.id,node as SceneNode3D);
    if(!camera&&!['group','mesh','curve'].includes(node.kind))error('SPACE3D_KIND','Expected group, mesh or curve.',at+'.kind');
    if(node.parent!==undefined&&!name(node.parent))error('SPACE3D_PARENT','Expected a parent group ID.',at+'.parent');
    if(node.transform!==undefined)diagnostics.push(...validateTransform3D(node.transform,at+'.transform'));
    if(camera&&node.projection!==undefined){diagnostics.push(...validateProjection3D(node.projection,at+'.projection'));if(context.viewport===undefined)error('SPACE3D_VIEWPORT','Projected cameras require a logical viewport.',at+'.projection');}
    if(!camera&&node.kind==='mesh'){
      if(node.visible!==undefined&&typeof node.visible!=='boolean')error('SPACE3D_VISIBLE','visible must be boolean.',at+'.visible');
      const r=resourceName(node.resourceId)&&Object.hasOwn(resources,node.resourceId)?resources[node.resourceId]:undefined;
      if(!r||r.kind!=='mesh')error('SPACE3D_RESOURCE','Mesh instances require an existing mesh resource ID of at most 512 characters.',at+'.resourceId');
      else {if(r.units!==input.units)error('SPACE3D_UNIT_MISMATCH','Mesh and world units must match exactly.',at+'.resourceId');
        if(!inContext&&!checkedResources.has(node.resourceId)){diagnostics.push(...validateMeshResource(r,`$.resources.${node.resourceId}`));checkedResources.add(node.resourceId);}}
      if(node.material!==undefined){if(!object(node.material))error('SPACE3D_MATERIAL','Expected an unlit material.',at+'.material');
        else {keys(node.material,['kind','color','side','wireframe','colorAttribute'],at+'.material');if(node.material.kind!=='unlit'||!color(node.material.color)||node.material.side!==undefined&&!['front','double'].includes(node.material.side)||node.material.wireframe!==undefined&&typeof node.material.wireframe!=='boolean')error('SPACE3D_MATERIAL','Expected kind unlit, #rrggbb color, front/double side and optional boolean wireframe.',at+'.material');
          if(node.material.colorAttribute!==undefined){const n=node.material.colorAttribute;
            if(!resourceName(n)||r?.kind!=='mesh'||!Object.hasOwn(r.attributes?.values??{},n)||r.attributes!.values[n]?.valueType!=='color')
              error('SPACE3D_COLOR_ATTRIBUTE','colorAttribute must name a color attribute on this mesh.',at+'.material.colorAttribute');}}}
    }
    if(!camera&&node.kind==='curve'){
      if(node.visible!==undefined&&typeof node.visible!=='boolean')error('SPACE3D_VISIBLE','visible must be boolean.',at+'.visible');
      if(node.color!==undefined&&!color(node.color))error('SPACE3D_CURVE_COLOR','Expected an opaque #rrggbb curve color.',at+'.color');
      const r=resourceName(node.resourceId)&&Object.hasOwn(resources,node.resourceId)?resources[node.resourceId]:undefined;
      if(!r||r.kind!=='curve3d')error('SPACE3D_RESOURCE','Curve instances require an existing curve3d resource.',at+'.resourceId');
      else {if(r.units!==input.units)error('SPACE3D_UNIT_MISMATCH','Curve and world units must match exactly.',at+'.resourceId');
        if(!inContext&&!checkedResources.has(node.resourceId)){diagnostics.push(...validateCurve3DResource(r,`$.resources.${node.resourceId}`));checkedResources.add(node.resourceId);}}
    }
  };
  input.nodes.forEach((n:unknown,i:number)=>check(n,`${path}.nodes[${i}]`));if(input.camera!==undefined)check(input.camera,path+'.camera',true);
  for(const [id,node] of byId)if(node.parent!==undefined){const p=byId.get(node.parent);if(!p||!('kind' in p)||p.kind!=='group')error('SPACE3D_PARENT',`${id} requires an existing 3D group parent.`);}
  if(hasErrors(diagnostics))return diagnostics;
  const done=new Set<string>();for(const id of byId.keys()){const chain=new Set<string>();let cursor:string|undefined=id;
    while(cursor!==undefined&&!done.has(cursor)){if(chain.has(cursor)){error('SPACE3D_CYCLE',`Parent cycle includes ${cursor}.`);return diagnostics;}chain.add(cursor);cursor=byId.get(cursor)!.parent;}for(const item of chain)done.add(item);}
  if(input.clippingPlanes!==undefined){
    if(!Array.isArray(input.clippingPlanes)||input.clippingPlanes.length>SPACE3D_MAX_PLANES)error('SPACE3D_PLANES',`Expected at most ${SPACE3D_MAX_PLANES} world planes.`,path+'.clippingPlanes');
    else input.clippingPlanes.forEach((p:unknown,i:number)=>{const at=`${path}.clippingPlanes[${i}]`;if(!object(p)){error('SPACE3D_PLANE','Expected a plane.',at);return;}keys(p,['normal','constant'],at);
      if(!tuple(p.normal,3)||p.normal.every(n=>n===0)||!finite(p.constant))error('SPACE3D_PLANE','Plane requires a nonzero finite normal and finite constant.',at);});
  }
  if(input.overlays!==undefined){
    if(!Array.isArray(input.overlays)||input.overlays.length>SPACE3D_MAX_OVERLAYS)error('SPACE3D_OVERLAYS',`Expected at most ${SPACE3D_MAX_OVERLAYS} overlays.`,path+'.overlays');
    else {const ids=new Set(byId.keys());input.overlays.forEach((o:unknown,i:number)=>{const at=`${path}.overlays[${i}]`;if(!object(o)){error('SPACE3D_OVERLAY','Expected an overlay.',at);return;}
      keys(o,['id','resourceId','parent','position','offset','scale','color'],at);if(!name(o.id)||ids.has(o.id))error('SPACE3D_ID','Overlay IDs must be unique across the 3D space.',at+'.id');else ids.add(o.id);
      const r=resourceName(o.resourceId)&&Object.hasOwn(resources,o.resourceId)?resources[o.resourceId]:undefined;if(!r||r.kind!=='vector')error('SPACE3D_OVERLAY_RESOURCE','Overlays require a native vector resource.',at+'.resourceId');
      else if(!inContext&&!checkedResources.has(o.resourceId)){
        diagnostics.push(...validateBundle({version:'0.3',units:'bp',title:'Overlay validation',duration:0,viewport:{width:1,height:1},camera:{x:0,y:0,zoom:1},nodes:[],tracks:[],relations:[],resources:{overlay:r}}).map(d=>({...d,path:d.path?.replace('$.resources.overlay',`$.resources.${o.resourceId}`)})));
        checkedResources.add(o.resourceId);
      }
      const parent=typeof o.parent==='string'?byId.get(o.parent):undefined;if(o.parent!==undefined&&(!parent||!('kind' in parent)))error('SPACE3D_OVERLAY_PARENT','Overlay parent must name a group or mesh.',at+'.parent');
      if(!tuple(o.position,3)||o.offset!==undefined&&!tuple(o.offset,2)||o.scale!==undefined&&(!finite(o.scale)||o.scale<=0)||o.color!==undefined&&!color(o.color))error('SPACE3D_OVERLAY','Expected finite position/offset, positive scale, and #rrggbb color.',at);
    });}
  }
  if(input.tracks!==undefined){
    if(!Array.isArray(input.tracks)||input.tracks.length>SPACE3D_MAX_TRACKS)error('SPACE3D_TRACKS',`Expected at most ${SPACE3D_MAX_TRACKS} transform tracks.`,path+'.tracks');
    else {const writers=new Set<string>();let count=0;const cameraAncestors=new Set<string>();let c=input.camera?.id as string|undefined;while(c!==undefined){cameraAncestors.add(c);c=byId.get(c)!.parent;}
      input.tracks.forEach((t:unknown,i:number)=>{const at=`${path}.tracks[${i}]`;if(!object(t)){error('SPACE3D_TRACK','Expected a transform track.',at);return;}keys(t,['target','property','keys','interpolation'],at);
        const target=typeof t.target==='string'?byId.get(t.target):undefined;if(!target)error('SPACE3D_TRACK_TARGET','Track target must name a group, mesh or camera.',at+'.target');
        if(target?.transform&&'matrix' in target.transform)error('SPACE3D_TRACK_MATRIX','TRS tracks cannot target an authored matrix transform.',at);
        if(!['translation','rotation','scale'].includes(t.property))error('SPACE3D_TRACK_PROPERTY','Expected translation, rotation or scale.',at+'.property');
        if(t.interpolation!==undefined&&!['linear','step'].includes(t.interpolation))error('SPACE3D_TRACK_INTERPOLATION','Expected linear or step.',at+'.interpolation');
        const writer=JSON.stringify([t.target,t.property]);if(writers.has(writer))error('SPACE3D_TRACK_CONFLICT','Only one track may write each target/property.',at);writers.add(writer);
        if(!Array.isArray(t.keys)||t.keys.length===0||t.keys.length>4096){error('SPACE3D_TRACK_KEYS','Expected 1–4096 keyframes.',at+'.keys');return;}count+=t.keys.length;let previous=-1;const values:number[][]=[];
        t.keys.forEach((k:unknown,j:number)=>{const kp=`${at}.keys[${j}]`;if(!Array.isArray(k)||k.length!==2||!finite(k[0])||k[0]<0||k[0]<=previous||context.duration!==undefined&&k[0]>context.duration){error('SPACE3D_TRACK_TIME','Times must be finite, nonnegative, strictly increasing and within scene duration.',kp);return;}previous=k[0];
          if(!tuple(k[1],t.property==='rotation'?4:3)||t.property==='rotation'&&k[1].every(n=>n===0)){error('SPACE3D_TRACK_VALUE','Expected a finite vector or nonzero quaternion of the correct size.',kp+'[1]');return;}values.push(k[1]);});
        if(t.property==='scale'&&cameraAncestors.has(t.target)&&values.length===t.keys.length)for(let j=0;j<values.length;j++)for(let axis=0;axis<3;axis++)if(values[j][axis]===0||j>0&&t.interpolation!=='step'&&Math.sign(values[j][axis])!==Math.sign(values[j-1][axis]))error('SPACE3D_CAMERA_SCALE','Camera ancestor scale must stay invertible; linear sign crossings are unsupported.',at+'.keys');
      });if(count>SPACE3D_MAX_KEYS)error('SPACE3D_TRACK_BUDGET',`At most ${SPACE3D_MAX_KEYS} total keyframes are supported.`,path+'.tracks');}
  }
  if(hasErrors(diagnostics))return diagnostics;
  try{diagnostics.push(...evaluateValidated(input as Space3D,metadata(input as Space3D,resources),context,0).diagnostics);}catch(cause){const e=cause as {code?:string;message?:string;diagnostics?:readonly Diagnostic[]};if(e.diagnostics)diagnostics.push(...e.diagnostics);else error(e.code??'SPACE3D_EVALUATION',e.message??String(cause));}
  return diagnostics;
}
export function validateSpace3D(input:unknown,resources:Record<string,Resource>,path='$.space3d',context:Space3DContext={}):Diagnostic[]{return inspect(input,resources,path,false,context);}
export function validateSpace3DInContext(input:unknown,resources:Record<string,Resource>,path='$.space3d',context:Space3DContext={}):Diagnostic[]{return inspect(input,resources,path,true,context);}
export interface MeshFrameMetadata3D {bounds:Bounds3D|null;topologyRevision:string}
/** Local translation and rotation supplied by a prepared geometric constraint. Scale stays authored. */
export interface FrameTransform3D {translation:Vec3;rotation:Quaternion}
type MeshMetadata=Record<string,MeshFrameMetadata3D>;
function metadata(program:Space3D,resources:Record<string,Resource>):MeshMetadata {
  const result:MeshMetadata={};for(const node of program.nodes)if(node.kind!=='group'&&!Object.hasOwn(result,node.resourceId)){const r=resources[node.resourceId] as MeshResource|Curve3DResource;Object.defineProperty(result,node.resourceId,{value:{bounds:structuredClone(r.bounds),topologyRevision:r.topologyRevision},enumerable:true});}return result;
}
function interpolate(track:TransformTrack3D,time:number):Vec3|Quaternion {
  const keys=track.keys;if(time<=keys[0][0])return [...keys[0][1]] as Vec3|Quaternion;if(time>=keys.at(-1)![0])return [...keys.at(-1)![1]] as Vec3|Quaternion;
  let lo=0,hi=keys.length;while(lo<hi){const mid=(lo+hi)>>>1;if(keys[mid][0]<=time)lo=mid+1;else hi=mid;}const [start,a]=keys[lo-1],[end,b]=keys[lo];
  if(track.interpolation==='step'||time===start)return [...a] as Vec3|Quaternion;const u=(time-start)/(end-start);
  if(track.property!=='rotation')return a.map((v,i)=>{const d=b[i]-v;return Number.isFinite(d)?v+d*u:v*(1-u)+b[i]*u;}) as Vec3;
  const qa=normalizeQuaternion(a as Quaternion),qb=[...normalizeQuaternion(b as Quaternion)];let dot=qa.reduce((s,v,i)=>s+v*qb[i],0);if(dot<0){for(let i=0;i<4;i++)qb[i]=-qb[i];dot=-dot;}dot=Math.max(0,Math.min(1,dot));
  if(dot>.9995)return [...normalizeQuaternion(qa.map((v,i)=>v*(1-u)+qb[i]*u) as Quaternion)];
  const angle=Math.acos(dot),denominator=Math.sin(angle),aWeight=Math.sin((1-u)*angle)/denominator,bWeight=Math.sin(u*angle)/denominator;
  return [...normalizeQuaternion(qa.map((v,i)=>v*aWeight+qb[i]*bWeight) as Quaternion)];
}
function normalizedPlane(p:ClippingPlane3D):ClippingPlane3D {
  const maximum=Math.max(...p.normal.map(Math.abs)),scaled=p.normal.map(v=>v/maximum),constant=(p.constant/maximum)/Math.hypot(...scaled);range([constant]);return {normal:[...normalizeVec3(p.normal)],constant};
}
function planeContains(p:ClippingPlane3D,point:readonly number[]):boolean {
  const terms=[...p.normal.map((n,i)=>n*point[i]),p.constant],scale=Math.max(...terms.map(Math.abs))||1;
  const scaled=terms.map(n=>n/scale),sum=scaled.reduce((a,b)=>a+b,0);
  // Closed half-spaces tolerate arithmetic roundoff only, relative to the actual plane terms.
  return sum>=-8*Number.EPSILON*scaled.reduce((s,n)=>s+Math.abs(n),0);
}
function evaluateValidated(program:Space3D,resources:MeshMetadata,context:Space3DContext,time:number,frameTransforms:DeepReadonly<Record<string,FrameTransform3D>>={}):Space3DEvaluation {
  const objects:(SceneNode3D|Camera3D)[]=[...program.nodes,...(program.camera?[program.camera]:[])],byId=new Map(objects.map(n=>[n.id,n])),transforms=new Map(objects.map(n=>[n.id,structuredClone(n.transform??{})]));
  for(const track of program.tracks??[])Object.assign(transforms.get(track.target)!,{[track.property]:interpolate(track,time)});
  for(const [id,value] of Object.entries(frameTransforms))Object.assign(transforms.get(id)!,{translation:[...value.translation],rotation:[...value.rotation]});
  const world=new Map<string,Readonly<Matrix4>>();for(const node of objects){const pending:(SceneNode3D|Camera3D)[]=[];let current:SceneNode3D|Camera3D|undefined=node;
    while(current&&!world.has(current.id)){pending.push(current);current=current.parent?byId.get(current.parent):undefined;}
    while(pending.length){const next=pending.pop()!;world.set(next.id,multiplyMatrix4(next.parent?world.get(next.parent)!:identityMatrix4(),composeTransform3D(transforms.get(next.id))));}}
  let camera:Space3DEvaluation['camera']=null;if(program.camera){const worldMatrix=world.get(program.camera.id)!,viewMatrix=inverseMatrix4(worldMatrix),projection=program.camera.projection??null,projectionMatrix=projection?projectionMatrix3D(projection,context.viewport!):null;
    camera={id:program.camera.id,worldMatrix,viewMatrix,forwardAxis:'-z',upAxis:'y',projection:projection?structuredClone(projection):null,projectionMatrix,viewProjectionMatrix:projectionMatrix?viewProjectionMatrix3D(projectionMatrix,viewMatrix):null,aspect:projection?context.viewport!.width/context.viewport!.height:null};}
  const diagnostics:Diagnostic[]=[],instances:EvaluatedMeshInstance3D[]=[],curves:EvaluatedCurveInstance3D[]=[],groups:Space3DEvaluation['groups']=[];
  for(const node of program.nodes){const worldMatrix=world.get(node.id)!;if(node.kind==='group'){groups.push({id:node.id,worldMatrix});continue;}
    if(node.kind==='curve'){const r=resources[node.resourceId];curves.push({id:node.id,resourceId:node.resourceId,visible:node.visible!==false,color:node.color??'#d4d9e2',topologyRevision:r.topologyRevision,worldMatrix,modelViewMatrix:camera?multiplyMatrix4(camera.viewMatrix,worldMatrix):null,worldBounds:r.bounds?transformBounds3D(worldMatrix,r.bounds):null});continue;}
    const r=resources[node.resourceId],orientation=orientationMatrix4(worldMatrix);let normalMatrix:Readonly<Matrix3>|null=null;
    if(orientation===0)diagnostics.push({severity:'warning',code:'SPACE3D_SINGULAR_NORMAL',message:`${node.id}: singular transform has no normal matrix or winding.`,path:`$.space3d.nodes[${program.nodes.indexOf(node)}].transform`});else normalMatrix=normalMatrix3D(worldMatrix);
    instances.push({id:node.id,resourceId:node.resourceId,visible:node.visible!==false,topologyRevision:r.topologyRevision,material:{kind:'unlit',color:node.material?.color??'#d4d9e2',side:node.material?.side??'front',wireframe:node.material?.wireframe??false,...(node.material?.colorAttribute!==undefined?{colorAttribute:node.material.colorAttribute}:{})},worldMatrix,modelViewMatrix:camera?multiplyMatrix4(camera.viewMatrix,worldMatrix):null,normalMatrix,orientation,worldWinding:orientation===0?null:orientation===1?'ccw':'cw',worldBounds:r.bounds?transformBounds3D(worldMatrix,r.bounds):null});}
  const clippingPlanes=(program.clippingPlanes??[]).map(normalizedPlane),overlays=(program.overlays??[]).map((overlay):EvaluatedOverlay3D=>{
    const worldPosition=[...transformPoint3D(overlay.parent?world.get(overlay.parent)!:identityMatrix4(),overlay.position)] as Vec3,projected=camera?.viewProjectionMatrix?projectPoint3D(worldPosition,camera.viewProjectionMatrix,context.viewport!):null;
    const position=projected?.position?[projected.position[0]+(overlay.offset?.[0]??0),projected.position[1]+(overlay.offset?.[1]??0)] as [number,number]:null;if(position)range(position);
    const parent=overlay.parent?byId.get(overlay.parent):undefined,hidden=parent&&'kind' in parent&&parent.kind!=='group'&&parent.visible===false;
    return {id:overlay.id,resourceId:overlay.resourceId,worldPosition,position,ndc:projected?.ndc?[...projected.ndc]:null,visible:!hidden&&!!projected?.visible&&clippingPlanes.every(p=>planeContains(p,worldPosition)),scale:overlay.scale??1,color:overlay.color??'#ffffff'};});
  return {version:1,units:program.units,handedness:'right',upAxis:'z',groups,instances,curves,camera,clippingPlanes,overlays,diagnostics};
}
/** Static time-zero preparation remains available for existing numeric consumers. */
export function prepareSpace3D(program:Space3D,resources:Record<string,Resource>,context:Space3DContext={}):DeepReadonly<Space3DEvaluation>{
  const diagnostics=validateSpace3D(program,resources,'$.space3d',context);if(hasErrors(diagnostics))throw new OperationValidationError(diagnostics);return freezeSnapshot(evaluateValidated(program,metadata(program,resources),context,0));
}
/** Snapshot declarations and mesh metadata, without copying or retaining caller-owned vertex buffers. */
export function prepareSpace3DSampler(program:Space3D,resources:Record<string,Resource>,context:{viewport:Viewport3D;duration:number},dynamicResourceIds:readonly string[]=[],initialTransforms:DeepReadonly<Record<string,FrameTransform3D>>={}):(time:number,dynamicMeshes?:DeepReadonly<Record<string,MeshFrameMetadata3D>>,frameTransforms?:DeepReadonly<Record<string,FrameTransform3D>>)=>DeepReadonly<Space3DEvaluation>{
  if(context===undefined)throw new OperationValidationError([{severity:'error',code:'SPACE3D_CONTEXT',message:'Sampler requires viewport and finite nonnegative duration.'}]);
  const diagnostics=validateSpace3D(program,resources,'$.space3d',context);if(hasErrors(diagnostics))throw new OperationValidationError(diagnostics);
  if(!finite(context.duration)||context.duration<0||!context.viewport)throw new OperationValidationError([{severity:'error',code:'SPACE3D_CONTEXT',message:'Sampler requires viewport and finite nonnegative duration.'}]);
  const idsDiagnostics=validateJsonData(dynamicResourceIds,'$.dynamicResourceIds');if(idsDiagnostics.length)throw new OperationValidationError(idsDiagnostics);
  if(!Array.isArray(dynamicResourceIds)||dynamicResourceIds.length>4096||new Set(dynamicResourceIds).size!==dynamicResourceIds.length||dynamicResourceIds.some(id=>!resourceName(id)||!Object.hasOwn(resources,id)||!['mesh','curve3d'].includes(resources[id].kind)))throw new OperationValidationError([{severity:'error',code:'SPACE3D_DYNAMIC_RESOURCE',message:'Dynamic IDs must be distinct declared mesh or curve resources.'}]);
  const snapshot=structuredClone(program),ctx=structuredClone(context);
  const validateTransforms=(input:unknown,expected?:readonly string[]):DeepReadonly<Record<string,FrameTransform3D>>=>{
    const ds=validateJsonData(input,'$.frameTransforms');if(ds.length)throw new OperationValidationError(ds);
    const fail=():never=>{throw new OperationValidationError([{severity:'error',code:'SPACE3D_DYNAMIC_TRANSFORM',message:'Supply exactly the declared mesh/group targets with a finite translation and nonzero quaternion, without conflicting tracks.',path:'$.frameTransforms'}]);};
    if(!object(input)||Object.keys(input).length>256)fail();
    const values=input as Record<string,unknown>,names=Object.keys(values);if(expected&&(names.length!==expected.length||names.some(id=>!expected.includes(id))))fail();
    for(const [id,v] of Object.entries(values)){
      const node=snapshot.nodes.find(n=>n.id===id);
      if(!node||!['mesh','group'].includes(node.kind)||node.transform&&'matrix' in node.transform||(snapshot.tracks??[]).some(t=>t.target===id&&t.property!=='scale'))fail();
      if(!object(v)||Object.keys(v).length!==2||Object.keys(v).some(k=>!['translation','rotation'].includes(k))||!tuple(v.translation,3)||!tuple(v.rotation,4)||v.rotation.every(n=>n===0))fail();
    }
    return freezeSnapshot(input as Record<string,FrameTransform3D>);
  };
  const initial=validateTransforms(initialTransforms),targets=Object.freeze(Object.keys(initial)),ids=Object.freeze([...dynamicResourceIds]),meshes=metadata(snapshot,resources);
  // Validate real initial generated bounds and constraint transforms before publishing readiness.
  const initialFrame=freezeSnapshot(evaluateValidated(snapshot,meshes,ctx,0,initial));
  const constant=snapshot.tracks?.length||ids.length||targets.length?undefined:initialFrame;
  return (time,dynamicMeshes,frameTransforms)=>{
    if(!finite(time))throw new RangeError('Spatial sample time must be finite.');let sampled=meshes;
    if(ids.length||dynamicMeshes!==undefined){
      const ds=validateJsonData(dynamicMeshes,'$.dynamicMeshes');if(ds.length)throw new OperationValidationError(ds);
      const fail=()=>{throw new OperationValidationError([{severity:'error',code:'SPACE3D_DYNAMIC_RESOURCE',message:'Supply exactly the declared dynamic resource IDs with finite ordered bounds and a topology revision.',path:'$.dynamicMeshes'}]);};
      if(!object(dynamicMeshes)||Object.keys(dynamicMeshes).length!==ids.length||Object.keys(dynamicMeshes).some(id=>!ids.includes(id)))fail();
      sampled={...meshes};for(const id of ids){const r=dynamicMeshes![id];if(!object(r)||Object.keys(r).some(k=>!['bounds','topologyRevision'].includes(k))||!resourceName(r.topologyRevision)||r.bounds!==null&&(!object(r.bounds)||Object.keys(r.bounds).some(k=>!['min','max'].includes(k))||!tuple(r.bounds.min,3)||!tuple(r.bounds.max,3)||r.bounds.min.some((n:number,i:number)=>n>r.bounds!.max[i])))fail();
        Object.defineProperty(sampled,id,{enumerable:true,value:structuredClone(r)});}
    }
    const transforms=targets.length||frameTransforms!==undefined?validateTransforms(frameTransforms,targets):initial;
    return constant??freezeSnapshot(evaluateValidated(snapshot,sampled,ctx,Math.max(0,Math.min(ctx.duration,time)),transforms));
  };
}
