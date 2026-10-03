import type {Resource} from '../schema.js';
import {type Diagnostic, type DeepReadonly, OperationValidationError} from './operations.js';
import {validateJsonData, freezeSnapshot} from '../operations/values.js';
import {validateMeshResource, type MeshUnit, type MeshResource} from './mesh.js';
import {composeTransform3D, identityMatrix4, multiplyMatrix4, inverseMatrix4,
  normalMatrix3D, orientationMatrix4, transformBounds3D, validateTransform3D,
  type Transform3D, type Matrix4, type Matrix3, type Bounds3D} from '../geometry/matrix4.js';

interface SpatialNode {id:string;parent?:string;transform?:Transform3D}
export interface Group3D extends SpatialNode {kind:'group'}
export interface MeshInstance3D extends SpatialNode {kind:'mesh';resourceId:string;visible?:boolean}
export type SceneNode3D=Group3D|MeshInstance3D;
/** Camera pose maps camera-local coordinates to its parent. Local forward is -Z, up +Y. */
export interface Camera3D extends SpatialNode {}
/** A separate world chart; no implicit conversion to the enclosing document's bp chart. */
export interface Space3D {
  version:1;units:MeshUnit;handedness:'right';upAxis:'z';nodes:SceneNode3D[];camera?:Camera3D;
}
export interface EvaluatedMeshInstance3D {
  id:string;resourceId:string;visible:boolean;topologyRevision:string;
  worldMatrix:Readonly<Matrix4>;modelViewMatrix:Readonly<Matrix4>|null;
  /** Inverse-transpose of the object-to-world linear map, column-major. */
  normalMatrix:Readonly<Matrix3>|null;
  orientation:-1|0|1;worldWinding:'ccw'|'cw'|null;
  /** Conservative transformed object AABB, not a tight vertex hull. */
  worldBounds:DeepReadonly<Bounds3D>|null;
}
export interface Space3DEvaluation {
  version:1;units:MeshUnit;handedness:'right';upAxis:'z';
  groups:{id:string;worldMatrix:Readonly<Matrix4>}[];
  instances:EvaluatedMeshInstance3D[];
  camera:{id:string;worldMatrix:Readonly<Matrix4>;viewMatrix:Readonly<Matrix4>;forwardAxis:'-z';upAxis:'y'}|null;
  diagnostics:Diagnostic[];
}
export const SPACE3D_MAX_NODES=4096;
const object=(v:unknown):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const name=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=256&&v.trim()===v;
const resourceName=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=512&&v.trim()===v;
const hasErrors=(d:Diagnostic[])=>d.some(x=>x.severity==='error');

function inspect(input:unknown,resources:Record<string,Resource>,path:string,inContext:boolean):Diagnostic[] {
  const diagnostics=validateJsonData(input,path);
  if(!inContext)diagnostics.push(...validateJsonData(resources,'$.resources'));
  if(hasErrors(diagnostics))return diagnostics;
  const error=(code:string,message:string,at=path)=>diagnostics.push({severity:'error',code,message,path:at});
  const keys=(v:Record<string,unknown>,allowed:string[],at:string)=>{
    for(const key of Object.keys(v))if(!allowed.includes(key))error('SPACE3D_FIELD',`Unknown property ${key}.`,at+'.'+key);
  };
  if(!object(input)||input.version!==1||!Array.isArray(input.nodes)){
    error('SPACE3D_PROGRAM','Expected version 1 and a nodes array.');return diagnostics;
  }
  if(!object(resources)){error('SPACE3D_RESOURCES','Expected a resource dictionary.');return diagnostics;}
  keys(input,['version','units','handedness','upAxis','nodes','camera'],path);
  if(!['unit','m','cm','mm'].includes(input.units))error('SPACE3D_UNITS','Expected explicit unit, m, cm or mm. No bp conversion is implicit.',path+'.units');
  if(input.handedness!=='right'||input.upAxis!=='z')error('SPACE3D_BASIS','Version 1 uses a right-handed, Z-up world basis.');
  if(input.nodes.length>SPACE3D_MAX_NODES){error('SPACE3D_BUDGET',`At most ${SPACE3D_MAX_NODES} nodes are supported.`);return diagnostics;}
  const byId=new Map<string,SceneNode3D|Camera3D>(),checkedResources=new Set<string>();
  const check=(node:unknown,at:string,camera=false)=>{
    if(!object(node)){error('SPACE3D_NODE','Expected a spatial object.',at);return;}
    keys(node,camera?['id','parent','transform']:node.kind==='mesh'?['kind','id','parent','transform','resourceId','visible']:['kind','id','parent','transform'],at);
    if(!name(node.id)||byId.has(node.id))error('SPACE3D_ID','IDs must be unique, nonempty and at most 256 characters.',at+'.id');
    else byId.set(node.id,node as SceneNode3D);
    if(!camera&&!['group','mesh'].includes(node.kind))error('SPACE3D_KIND','Expected group or mesh.',at+'.kind');
    if(node.parent!==undefined&&!name(node.parent))error('SPACE3D_PARENT','Expected a parent group ID.',at+'.parent');
    if(node.transform!==undefined)diagnostics.push(...validateTransform3D(node.transform,at+'.transform'));
    if(!camera&&node.kind==='mesh'){
      if(node.visible!==undefined&&typeof node.visible!=='boolean')error('SPACE3D_VISIBLE','visible must be boolean.',at+'.visible');
      const r=resourceName(node.resourceId)&&Object.hasOwn(resources,node.resourceId)?resources[node.resourceId]:undefined;
      if(!resourceName(node.resourceId)||!r||r.kind!=='mesh')error('SPACE3D_RESOURCE','Mesh instances require an existing mesh resource ID of at most 512 characters.',at+'.resourceId');
      else{
        if(r.units!==input.units)error('SPACE3D_UNIT_MISMATCH','Mesh and world units must match exactly; normalize explicitly before import.',at+'.resourceId');
        if(!inContext&&!checkedResources.has(node.resourceId)){
          diagnostics.push(...validateMeshResource(r,`$.resources.${node.resourceId}`));checkedResources.add(node.resourceId);
        }
      }
    }
  };
  input.nodes.forEach((n:unknown,i:number)=>check(n,`${path}.nodes[${i}]`));
  if(input.camera!==undefined)check(input.camera,path+'.camera',true);
  for(const [id,node] of byId)if(node.parent!==undefined){
    const parent=byId.get(node.parent);
    if(!parent||!('kind' in parent)||parent.kind!=='group')error('SPACE3D_PARENT',`${id} requires an existing 3D group parent.`);
  }
  if(hasErrors(diagnostics))return diagnostics;
  // Iterative walk: a valid flat JSON hierarchy may still be thousands of levels deep.
  const done=new Set<string>();
  for(const id of byId.keys()){
    const chain=new Set<string>();let cursor:string|undefined=id;
    while(cursor!==undefined&&!done.has(cursor)){
      if(chain.has(cursor)){error('SPACE3D_CYCLE',`Parent cycle includes ${cursor}.`);return diagnostics;}
      chain.add(cursor);cursor=byId.get(cursor)!.parent;
    }
    for(const item of chain)done.add(item);
  }
  try{diagnostics.push(...evaluateValidated(input as Space3D,resources).diagnostics);}catch(cause){
    const e=cause as {code?:string;message?:string};error(e.code??'SPACE3D_EVALUATION',e.message??String(cause));
  }
  return diagnostics;
}
export function validateSpace3D(input:unknown,resources:Record<string,Resource>,path='$.space3d'):Diagnostic[]{return inspect(input,resources,path,false);}
/** Called only after the bundle resource table has been validated. */
export function validateSpace3DInContext(input:unknown,resources:Record<string,Resource>,path='$.space3d'):Diagnostic[]{return inspect(input,resources,path,true);}

function evaluateValidated(program:Space3D,resources:Record<string,Resource>):Space3DEvaluation {
  const objects: (SceneNode3D|Camera3D)[]=[...program.nodes,...(program.camera?[program.camera]:[])];
  const byId=new Map(objects.map(n=>[n.id,n])),world=new Map<string,Readonly<Matrix4>>();
  for(const node of objects){
    const pending:(SceneNode3D|Camera3D)[]=[];let current:SceneNode3D|Camera3D|undefined=node;
    while(current&&!world.has(current.id)){pending.push(current);current=current.parent?byId.get(current.parent):undefined;}
    while(pending.length){const next=pending.pop()!;
      world.set(next.id,multiplyMatrix4(next.parent?world.get(next.parent)!:identityMatrix4(),composeTransform3D(next.transform)));
    }
  }
  const camera=program.camera?{id:program.camera.id,worldMatrix:world.get(program.camera.id)!,
    viewMatrix:inverseMatrix4(world.get(program.camera.id)!),forwardAxis:'-z' as const,upAxis:'y' as const}:null;
  const diagnostics:Diagnostic[]=[],instances:EvaluatedMeshInstance3D[]=[],groups:Space3DEvaluation['groups']=[];
  for(const node of program.nodes){
    const worldMatrix=world.get(node.id)!;
    if(node.kind==='group'){groups.push({id:node.id,worldMatrix});continue;}
    const resource=resources[node.resourceId] as MeshResource,orientation=orientationMatrix4(worldMatrix);
    let normalMatrix:Readonly<Matrix3>|null=null;
    if(orientation===0)diagnostics.push({severity:'warning',code:'SPACE3D_SINGULAR_NORMAL',message:`${node.id}: singular transform has no normal matrix or winding.`,path:`$.space3d.nodes[${program.nodes.indexOf(node)}].transform`});
    else normalMatrix=normalMatrix3D(worldMatrix);
    instances.push({id:node.id,resourceId:node.resourceId,visible:node.visible!==false,topologyRevision:resource.topologyRevision,
      worldMatrix,modelViewMatrix:camera?multiplyMatrix4(camera.viewMatrix,worldMatrix):null,normalMatrix,orientation,
      worldWinding:orientation===0?null:orientation===1?'ccw':'cw',worldBounds:resource.bounds?transformBounds3D(worldMatrix,resource.bounds):null});
  }
  return {version:1,units:program.units,handedness:'right',upAxis:'z',groups,instances,camera,diagnostics};
}
/** Static spatial evaluation for PR29. No hidden clock, inferred projection or mutable buffers. */
export function prepareSpace3D(program:Space3D,resources:Record<string,Resource>):DeepReadonly<Space3DEvaluation>{
  const diagnostics=validateSpace3D(program,resources);
  if(hasErrors(diagnostics))throw new OperationValidationError(diagnostics);
  return freezeSnapshot(evaluateValidated(program,resources));
}
