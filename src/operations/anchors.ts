import type {Bundle,Node,TexNode,VectorResource,Matrix} from '../schema.js';
import {OperationValidationError,type AnchorInput,type TextPlacementInput,type TextAnchorInput,type DeepReadonly,type InputRef,
  type LiteralValue,type OutputRef,type SpaceRef,type Diagnostic,type SourceSpan} from '../ir/operations.js';
import {anchorNames,type AnchorName,type AnchorProvider} from '../ir/text.js';
import {anchorPosition,createShapeAnchorProvider,createTextAnchorProvider,createMeasuredAnchorProvider} from '../geometry/anchors.js';
import {worldMatrix,multiplyMatrix,inverseMatrix,transformPoint,transformVector} from '../geometry.js';
import {spaceMatrix,spaceTransformReads,sameSpace} from '../geometry/spaces.js';
import type {InputValueType} from './inputs.js';
import type {PropertyAccess} from './properties.js';

type AnchorRef=DeepReadonly<AnchorInput|TextPlacementInput|TextAnchorInput>;
type Obj=Record<string,any>;
const object=(v:unknown):v is Obj=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const pair=(v:unknown):v is [number,number]=>Array.isArray(v)&&v.length===2&&v.every(n=>typeof n==='number'&&Number.isFinite(n)&&n>=0);
const named=(v:unknown):v is AnchorName=>typeof v==='string'&&(anchorNames as readonly string[]).includes(v);
function fail(code:string,message:string):never {throw new OperationValidationError([{severity:'error',code,message}]);}

export interface AnchorEvaluationEntry {provider:DeepReadonly<AnchorProvider>;space:SpaceRef;position:[number,number]}
export type AnchorEvaluation=Record<string,AnchorEvaluationEntry>;

/** Content fingerprint, not an authentication hash. Run paths and timestamps are excluded. */
export function textResourceRevision(resource:VectorResource):string {
  const text=JSON.stringify([resource.metrics,resource.inkBounds,resource.sourceTex??'',resource.items]);
  let hash=14695981039346656037n;
  for(const character of text){hash^=BigInt(character.codePointAt(0)!);hash=BigInt.asUintN(64,hash*1099511628211n);}
  return 'text-v1:'+hash.toString(16).padStart(16,'0');
}

/** Every dynamic input is validated in the containing graph's reference context. */
export function validateAnchorInput(raw:Obj,bundle:Bundle,path:string,span:SourceSpan|undefined,
  resolve:(raw:unknown,path:string)=>InputValueType|undefined):{diagnostics:Diagnostic[];type?:InputValueType} {
  const diagnostics:Diagnostic[]=[];
  const error=(code:string,message:string,at=path)=>diagnostics.push({severity:'error',code,message,path:at,...(span?{sourceSpan:span}:{})});
  const keys=(v:Obj,allowed:string[],at:string)=>{for(const key of Object.keys(v))if(!allowed.includes(key))error('ANCHOR_FIELD',`Unknown anchor property ${key}.`,at+'.'+key);};
  const spacing=(v:Obj,at:string)=>{for(const key of ['innerSep','outerSep'])if(v[key]!==undefined&&!pair(v[key]))error('ANCHOR_SEPARATION','Separation must contain two nonnegative finite bp values.',at+'.'+key);};
  const point=(type:InputValueType|undefined,space:SpaceRef,at:string)=>{
    if(type&&(type.type!=='vec2'||type.role!=='point'))error('ANCHOR_POINT','Expected a point input.',at);
    else if(type&&object(space)&&['scene','local','parent','plot'].includes(space.kind)&&!sameSpace(type.space,space))error('OPERATION_SPACE_MISMATCH','Anchor target point must use the declared output space.',at);
  };
  if(raw.kind==='textPlacement'||raw.kind==='textAnchor') {
    keys(raw,raw.kind==='textAnchor'?['kind','node','anchor','innerSep','outerSep']:['kind','node','anchor','point','innerSep','outerSep'],path);spacing(raw,path);
    if(typeof raw.node!=='string'||bundle.nodes.find(n=>n.id===raw.node)?.kind!=='tex')error('ANCHOR_PLACEMENT_NODE','Placement requires a TeX node.',path+'.node');
    if(!named(raw.anchor))error('ANCHOR_NAME','Unknown anchor name.',path+'.anchor');
    if(raw.kind==='textPlacement')point(resolve(raw.point,path+'.point'),{kind:'scene'},path+'.point');
    return {diagnostics,type:{type:'vec2',role:'point',space:raw.kind==='textAnchor'?{kind:'local',node:raw.node}:{kind:'scene'}}};
  }
  keys(raw,['kind','source','query','space'],path);
  if(!object(raw.source))error('ANCHOR_SOURCE','Expected an anchor source.',path+'.source');
  else {
    const source=raw.source,at=path+'.source';spacing(source,at);
    if(source.kind==='shape') {
      keys(source,['kind','ref','outerSep'],at);
      const type=resolve({kind:'output',ref:source.ref},at+'.value');
      if(type&&type.type!=='shape2d')error('ANCHOR_SOURCE_TYPE','Shape anchor source requires a shape2d output.',at+'.ref');
    }else if(source.kind==='node') {
      keys(source,['kind','node','innerSep','outerSep'],at);
      const node=typeof source.node==='string'?bundle.nodes.find(n=>n.id===source.node):undefined;
      if(!node||!['tex','ellipse','group'].includes(node.kind))error('ANCHOR_SOURCE_NODE','Expected a TeX node, ellipse, or group with measured anchors.',at+'.node');
      else if(node.kind==='group') {
        if(!node.anchors)error('ANCHOR_MEASURED','Group has no measured anchors.',at+'.node');
        if(source.innerSep!==undefined||source.outerSep!==undefined)error('ANCHOR_SEPARATION','Measured anchors already include authored separation; overrides are unsupported.',at);
      }else if(node.kind==='ellipse'&&source.innerSep!==undefined)error('ANCHOR_SEPARATION','Analytic shape sources do not have inner separation.',at);
    }else error('ANCHOR_SOURCE','Source kind must be node or shape.',at+'.kind');
  }
  if(!object(raw.query))error('ANCHOR_QUERY','Expected a named or border query.',path+'.query');
  else if(raw.query.kind==='named') {
    keys(raw.query,['kind','name'],path+'.query');
    if(!named(raw.query.name))error('ANCHOR_NAME','Unknown anchor name.',path+'.query.name');
  }else if(raw.query.kind==='border') {
    keys(raw.query,['kind','towards'],path+'.query');
    point(resolve(raw.query.towards,path+'.query.towards'),raw.space,path+'.query.towards');
  }else error('ANCHOR_QUERY','Query kind must be named or border.',path+'.query.kind');
  return {diagnostics,type:{type:'vec2',role:'point',space:raw.space}};
}

export function anchorInputReads(input:AnchorRef,nodes:ReadonlyMap<string,Node>,outputSpace:(ref:DeepReadonly<OutputRef>)=>SpaceRef):PropertyAccess[] {
  if(input.kind==='textAnchor')return [{node:input.node,property:'scale'}];
  const source=input.kind==='textPlacement'?{kind:'node' as const,node:input.node}:input.source;
  const space=source.kind==='shape'?outputSpace(source.ref):{kind:'local' as const,node:source.node};
  const reads=spaceTransformReads(space,nodes);
  if(input.kind==='anchor')reads.push(...spaceTransformReads(input.space,nodes));
  if(source.kind==='node') {
    const node=nodes.get(source.node)!;
    const properties=node.kind==='tex'?(input.kind==='textPlacement'?['scale']:['x','y','scale'])
      :node.kind==='ellipse'?['cx','cy','rx','ry']:['anchors','anchorMetrics'];
    reads.push(...properties.map(property=>({node:node.id,property})));
  }
  return reads;
}

function textProvider(node:TexNode,resources:Bundle['resources'],options:{innerSep?:readonly [number,number];outerSep?:readonly [number,number]}):DeepReadonly<AnchorProvider> {
  const resource=resources[node.resourceId];
  if(resource?.kind!=='vector')fail('ANCHOR_RESOURCE','TeX anchor requires a vector resource.');
  const scale=node.scale??1;
  return createTextAnchorProvider({width:resource.metrics.width*scale,height:resource.metrics.height*scale,depth:resource.metrics.depth*scale},
    resource.inkBounds.map(v=>v*scale) as [number,number,number,number],{
      ...(options.innerSep===undefined?{}:{innerSep:options.innerSep}),
      ...(options.outerSep===undefined?{}:{outerSep:options.outerSep}),revision:textResourceRevision(resource)});
}

/** Resolves live matrices and dimensions without caching a previous frame. */
export function resolveAnchorInput(input:AnchorRef,nodes:ReadonlyMap<string,Node>,resources:Bundle['resources'],
  resolve:(input:DeepReadonly<InputRef>,path:string)=>LiteralValue,path:string,metadata?:AnchorEvaluation):LiteralValue {
  let provider:DeepReadonly<AnchorProvider>,matrix:Matrix;
  if(input.kind==='textAnchor') {
    provider=textProvider(nodes.get(input.node) as TexNode,resources,input);
    const position=anchorPosition(provider,{kind:'named',name:input.anchor});
    const space:SpaceRef={kind:'local',node:input.node};
    if(metadata)metadata[path]={provider:structuredClone(provider),space,position:[...position]};
    return {type:'vec2',role:'point',space,value:[...position]};
  }
  if(input.kind==='textPlacement') {
    const node=nodes.get(input.node) as TexNode;
    provider=textProvider(node,resources,input);
    const value=resolve(input.point,path+'.point');
    if(value.type!=='vec2'||value.role!=='point'||value.space.kind!=='scene')fail('ANCHOR_POINT','Text placement requires a scene point.');
    const offset=anchorPosition(provider,{kind:'named',name:input.anchor});
    const delta=transformVector(worldMatrix(node.id,nodes),offset);
    const position:[number,number]=[value.value[0]-delta[0],value.value[1]-delta[1]];
    if(!position.every(Number.isFinite))fail('ANCHOR_NONFINITE','Text placement is nonfinite.');
    if(metadata)metadata[path]={provider:structuredClone(provider),space:{kind:'scene'},position:[...position]};
    return {type:'vec2',role:'point',space:{kind:'scene'},value:position};
  }
  if(input.source.kind==='shape') {
    const value=resolve({kind:'output',ref:input.source.ref},path+'.source.value');
    if(value.type!=='shape2d')fail('ANCHOR_SOURCE_TYPE','Shape source must resolve to shape2d.');
    provider=createShapeAnchorProvider(value.value,input.source.outerSep);
    matrix=spaceMatrix(value.space,nodes);
  }else {
    const node=nodes.get(input.source.node)!;matrix=worldMatrix(node.id,nodes);
    if(node.kind==='tex') {
      provider=textProvider(node,resources,input.source);
      matrix=multiplyMatrix(matrix,[1,0,0,1,node.x,node.y]);
    }else if(node.kind==='ellipse')provider=createShapeAnchorProvider({kind:'ellipse',center:[node.cx,node.cy],rx:node.rx,ry:node.ry},input.source.outerSep);
    else if(node.kind==='group'&&node.anchors)provider=createMeasuredAnchorProvider(node.anchors,
      node.anchorMetrics?{logicalBounds:node.anchorMetrics.logicalTextBox,revision:node.anchorMetrics.revision}:{});
    else fail('ANCHOR_SOURCE_NODE','Node does not supply anchors.');
  }
  let local:[number,number];
  if(input.query.kind==='named')local=anchorPosition(provider,input.query);
  else {
    const towards=resolve(input.query.towards,path+'.query.towards');
    if(towards.type!=='vec2'||towards.role!=='point')fail('ANCHOR_POINT','Border query requires a target point.');
    const destination=transformPoint(multiplyMatrix(inverseMatrix(matrix,'anchor provider'),spaceMatrix(input.space,nodes)),towards.value);
    const center=anchorPosition(provider,{kind:'named',name:'center'});
    local=anchorPosition(provider,{kind:'border',direction:[destination[0]-center[0],destination[1]-center[1]]});
  }
  const position=transformPoint(multiplyMatrix(inverseMatrix(spaceMatrix(input.space,nodes),'anchor output space'),matrix),local);
  if(!position.every(Number.isFinite))fail('ANCHOR_NONFINITE','Converted anchor is nonfinite.');
  if(metadata)metadata[path]={provider:structuredClone(provider),space:structuredClone(input.space),position:[...position]};
  return {type:'vec2',role:'point',space:structuredClone(input.space),value:position};
}
