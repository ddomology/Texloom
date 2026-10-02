import type {Matrix,Node} from '../schema.js';
import {identityMatrix,inverseMatrix,multiplyMatrix,transformPoint,worldMatrix} from '../geometry.js';
import {OperationValidationError,type DeepReadonly,type Diagnostic,type SpaceRef} from '../ir/operations.js';
import type {PropertyAccess} from '../operations/properties.js';

type Space=DeepReadonly<SpaceRef>;
function fail(code:string,message:string,path='$.space'):never {throw new OperationValidationError([{severity:'error',code,message,path}]);}
function located<T>(callback:()=>T):T {
  try{return callback();}catch(error){
    if(error instanceof OperationValidationError)throw error;
    const diagnostics=(error as {diagnostics?:Diagnostic[]})?.diagnostics;
    if(diagnostics)throw new OperationValidationError(diagnostics.map(d=>({...d,path:d.path??'$.space'})));
    throw error;
  }
}
/** Space identity is semantic: parent(A), local(B), and scene stay distinct
 * even if their current numeric matrices happen to coincide. */
export function sameSpace(a?:Space,b?:Space):boolean {
  if(a===undefined||b===undefined)return a===b;
  if(a.kind!==b.kind)return false;
  if(a.kind==='scene')return true;
  return ['local','parent','plot'].includes(a.kind)&&b.kind!=='scene'&&a.node===b.node;
}
function spaceRoot(space:Space,nodes:ReadonlyMap<string,Node>):string|undefined {
  if(!space||typeof space!=='object'||!['scene','local','parent','plot'].includes(space.kind))fail('OPERATION_SPACE_KIND','Expected scene, local, parent or plot space.');
  if(space.kind==='scene') {
    if(Object.keys(space).some(key=>key!=='kind'))fail('OPERATION_SPACE_FIELD','Scene space has no node or extra fields.');
    return;
  }
  if(Object.keys(space).some(key=>!['kind','node'].includes(key))||typeof space.node!=='string'||!space.node.trim())
    fail('OPERATION_SPACE_NODE','A named space requires a nonempty node ID.');
  const node=nodes.get(space.node);if(!node)fail('OPERATION_SPACE_REFERENCE',`Missing space node ${space.node}.`);
  if(space.kind==='plot'&&node.kind!=='group')fail('OPERATION_PLOT_SPACE','Plot space requires an explicit group chart.');
  return space.kind==='parent'?node.parent:space.node;
}
/** A space matrix maps into mathematical scene coordinates; no camera is read. */
export function spaceMatrix(space:Space,nodes:ReadonlyMap<string,Node>):Matrix {
  const root=spaceRoot(space,nodes);return located(()=>worldMatrix(root,nodes));
}
/** Singular forward maps are valid. Only the destination must be invertible. */
export function spaceTransform(from:Space,to:Space,nodes:ReadonlyMap<string,Node>):Matrix {
  const source=spaceMatrix(from,nodes),destination=spaceMatrix(to,nodes);
  const inverse=to.kind==='scene'?identityMatrix():located(()=>inverseMatrix(destination,`destination ${JSON.stringify(to)}`));
  const result=multiplyMatrix(inverse,source);
  if(!result.every(Number.isFinite))fail('OPERATION_NONFINITE_OUTPUT','Space conversion produced nonfinite affine coefficients.');
  return result;
}
/** Reads mirror the exact transform hierarchy consumed by spaceMatrix. */
export function spaceTransformReads(space:Space,nodes:ReadonlyMap<string,Node>):PropertyAccess[] {
  let next=spaceRoot(space,nodes);const result:PropertyAccess[]=[],seen=new Set<string>();
  while(next!==undefined) {
    if(seen.has(next))fail('PARENT_CYCLE',`Transform hierarchy cycles at ${next}.`);
    seen.add(next);const node=nodes.get(next);if(!node)fail('OPERATION_SPACE_REFERENCE',`Missing transform node ${next}.`);
    result.push({node:next,property:'transform'});next=node.parent;
  }
  return result;
}
function positionNode(nodeID:string,nodes:ReadonlyMap<string,Node>):Extract<Node,{kind:'point'|'ellipse'|'tex'}> {
  const node=nodes.get(nodeID);
  if(!node||!['point','ellipse','tex'].includes(node.kind))fail('OPERATION_NODE_POSITION','Node position requires a point, ellipse or TeX node.','$.nodePosition');
  return node as Extract<Node,{kind:'point'|'ellipse'|'tex'}>;
}
/** Node coordinates precede that node's own transform, including label origins. */
export function nodePosition(nodeID:string,desiredSpace:Space,nodes:ReadonlyMap<string,Node>):[number,number] {
  const node=positionNode(nodeID,nodes),point:[number,number]=node.kind==='ellipse'?[node.cx,node.cy]:[node.x,node.y];
  if(!point.every(value=>typeof value==='number'&&Number.isFinite(value)))fail('OPERATION_DOMAIN','Node position must contain finite coordinates.','$.nodePosition');
  const result=transformPoint(spaceTransform({kind:'local',node:nodeID},desiredSpace,nodes),point);
  if(!result.every(Number.isFinite))fail('OPERATION_NONFINITE_OUTPUT','Converted node position is nonfinite.','$.nodePosition');
  return result;
}
export function nodePositionReads(nodeID:string,desiredSpace:Space,nodes:ReadonlyMap<string,Node>):PropertyAccess[] {
  const node=positionNode(nodeID,nodes),positions=node.kind==='ellipse'?['cx','cy']:['x','y'];
  const result=[...positions.map(property=>({node:nodeID,property})),...spaceTransformReads({kind:'local',node:nodeID},nodes),...spaceTransformReads(desiredSpace,nodes)];
  const seen=new Set<string>();return result.filter(read=>{const key=JSON.stringify([read.node,read.property]);if(seen.has(key))return false;seen.add(key);return true;});
}
