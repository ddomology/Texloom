import {validateBundle,type Bundle,type Resource} from '../schema.js';
import {OperationValidationError,type Diagnostic,type SourceSpan,type DeepReadonly} from '../ir/operations.js';
import {snapshotCurve3DResource,type Curve3DResource} from '../ir/curve3d.js';
import type {MeshUnit} from '../ir/mesh.js';
import {composeTransform3D,identityMatrix4,type Vec3,type Quaternion} from '../geometry/matrix4.js';
import {prepareCurve3D,validateCurve3DOptions,type Curve3DOptions,type SampledCurve3D} from '../geometry/curve3d.js';
import {prepareTransportFrames3D,sampleTransportFrame3D,validateTransportFrameOptions3D,
  type TransportFrameOptions3D,type PreparedTransportFrames3D,type CurveFrameSample3D} from '../geometry/frames3d.js';
import {compileExpression,evaluateExpression} from '../fields/scalar.js';
import {prepareParameterResolver} from '../fields/program.js';
import type {CompiledExpression,ExpressionValue,ExpressionType} from '../fields/ast.js';
import {freezeSnapshot,validateJsonData,validateSourceSpan} from './values.js';
import {surfaceResourceDeclarations} from './surface.js';
import {surfaceValidationResources} from './surface.js';
import {validateSpace3DInContext,type FrameTransform3D} from '../ir/scene3d.js';
import {meshAttributeValidationResources} from './mesh-attributes.js';
import {instanceValidationResources,instanceValidationSets} from './instances.js';
import {fieldVisualizationValidationResources,fieldVisualizationValidationSets} from './field-visualization.js';

export interface CurveOperation3D {
  id:string;resourceId:string;units:MeshUnit;domain:[number,number];segments:number;position:[string,string,string];
  closed?:boolean;closureTolerance?:number;frame:TransportFrameOptions3D;
  sourceSpan?:SourceSpan;expressionSpans?:{position:[SourceSpan,SourceSpan,SourceSpan]};
}
export interface CurveFollower3D {id:string;curveNode:string;target:string;progress:string;sourceSpan?:SourceSpan;expressionSpan?:SourceSpan}
export interface CurveProgram3D {version:1;operations:CurveOperation3D[];followers:CurveFollower3D[]}
export interface CurveEvaluation3D {
  curves:Record<string,{resourceId:string;curve:DeepReadonly<SampledCurve3D>;frames:DeepReadonly<PreparedTransportFrames3D>}>;
  followers:Record<string,{curveNode:string;target:string;progress:number;sample:DeepReadonly<CurveFrameSample3D>}>;
}
export interface CurveSample3D {
  resources:Readonly<Record<string,DeepReadonly<Curve3DResource>>>;
  transforms:DeepReadonly<Record<string,FrameTransform3D>>;
  curves3d:DeepReadonly<CurveEvaluation3D>;
}
export interface PreparedCurveProgram3D {
  readonly resourceIds:readonly string[];readonly followerTargets:readonly string[];
  readonly baseResources:CurveSample3D['resources'];readonly baseTransforms:CurveSample3D['transforms'];
  sample(time:number,parameters?:Readonly<Record<string,ExpressionValue>>):CurveSample3D;
}
export const CURVE3D_MAX_OPERATIONS=16,CURVE3D_MAX_SEGMENTS=32768,CURVE3D_MAX_FOLLOWERS=256;
const object=(v:unknown):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const name=(v:unknown,max=256):v is string=>typeof v==='string'&&v.length>0&&v.length<=max&&v.trim()===v;
const hasErrors=(d:readonly Diagnostic[])=>d.some(x=>x.severity==='error');
const scalar:ExpressionType={kind:'scalar',dimension:{length:0,time:0,angle:0}};
interface Entry {operation:DeepReadonly<CurveOperation3D>;path:string;expressions:CompiledExpression[];options:Curve3DOptions}
interface Follower {operation:DeepReadonly<CurveFollower3D>;path:string;expression:CompiledExpression;curve:string}

/** Lightweight IDs/units inventory; full semantic validation requires hydrated context. */
export function curveResourceDeclarations(input:unknown):{resourceId:string;units:MeshUnit}[]{
  if(input===undefined||validateJsonData(input,'$.curves3d').length||!object(input)||input.version!==1||!Array.isArray(input.operations)||input.operations.length>CURVE3D_MAX_OPERATIONS)return [];
  return input.operations.filter((v:unknown)=>object(v)&&name(v.resourceId,512)&&['unit','m','cm','mm'].includes(v.units)).map((v:CurveOperation3D)=>({resourceId:v.resourceId,units:v.units}));
}
/** @internal Empty metadata used only to validate generated resource references. */
export function curveValidationResources(input:unknown,resources:Record<string,Resource>):Record<string,Resource>{
  const result={...resources};for(const {resourceId,units} of curveResourceDeclarations(input))if(!Object.hasOwn(result,resourceId))Object.defineProperty(result,resourceId,{enumerable:true,configurable:true,value:{
    kind:'curve3d',version:1,primitive:'line-strip',units,coordinateSpace:'object',closed:false,bounds:null,topologyRevision:'curve-validation-only',
    positions:{version:1,componentType:'float64',components:3,count:0,byteOffset:0,byteStride:24,data:[]}}});return result;
}
function inspect(input:unknown,bundle:Bundle,inContext=false):{diagnostics:Diagnostic[];entries:Entry[];followers:Follower[]}{
  const diagnostics=validateJsonData(input,'$.curves3d'),entries:Entry[]=[],followers:Follower[]=[];
  const error=(code:string,message:string,path:string,sourceSpan?:SourceSpan)=>diagnostics.push({severity:'error',code,message,path,...(sourceSpan?{sourceSpan}:{})});
  const result=()=>({diagnostics,entries,followers});
  if(hasErrors(diagnostics))return result();if(!object(bundle)){error('CURVE3D_CONTEXT','Expected a scene bundle.','$');return result();}
  if(!inContext){diagnostics.push(...validateJsonData(bundle));if(hasErrors(diagnostics))return result();}
  if(!object(bundle.resources)){error('CURVE3D_CONTEXT','Expected authored resource dictionary.','$.resources');return result();}
  if(!inContext){const {curves3d:ignored,...base}=bundle;diagnostics.push(...validateBundle({...base,resources:curveValidationResources(input,base.resources)}));}
  if(bundle.version!=='0.3')error('CURVE3D_VERSION','Curve programs require Bundle 0.3.','$.version');
  if(hasErrors(diagnostics))return result();
  const keys=(v:Record<string,unknown>,allowed:readonly string[],path:string)=>{for(const k of Object.keys(v))if(!allowed.includes(k))error('CURVE3D_PROPERTY',`Unknown property ${k}.`,path+'.'+k);};
  if(!object(input)){error('CURVE3D_PROGRAM','Expected a curve program.','$.curves3d');return result();}
  keys(input,['version','operations','followers'],'$.curves3d');if(input.version!==1)error('CURVE3D_VERSION','Supported curve program version is 1.','$.curves3d.version');
  if(!Array.isArray(input.operations)||input.operations.length>CURVE3D_MAX_OPERATIONS||!Array.isArray(input.followers)||input.followers.length>CURVE3D_MAX_FOLLOWERS){error('CURVE3D_BUDGET','Expected at most16 curve operations and256 followers.','$.curves3d');return result();}
  const ids=new Set<string>(),resourceIds=new Set(surfaceResourceDeclarations(bundle.surfaces).map(r=>r.resourceId));let segments=0;
  const compile=(text:unknown,path:string,span?:SourceSpan,local=false):CompiledExpression|undefined=>{
    if(typeof text!=='string'){error('CURVE3D_EXPRESSION','Expected a scalar expression string.',path,span);return;}
    try{const expression=compileExpression(text,bundle.expressions?.parameters??{},span,local?{u:scalar}:{}),t=expression.type;
      if(t.kind!=='scalar'||Object.values(t.dimension).some(v=>v!==0))error('CURVE3D_EXPRESSION_TYPE','Expected a dimensionless scalar; curve coordinates use the declared units.',path,span);else return expression;
    }catch(cause){const ds=(cause as {diagnostics?:readonly Diagnostic[]}).diagnostics??[{severity:'error' as const,code:'CURVE3D_EXPRESSION',message:String(cause)}];diagnostics.push(...ds.map(d=>({...d,path,...(span?{sourceSpan:span}:{})})));}
  };
  input.operations.forEach((raw:unknown,index:number)=>{
    const path=`$.curves3d.operations[${index}]`,before=diagnostics.length;
    if(!object(raw)){error('CURVE3D_OPERATION','Expected a curve operation.',path);return;}
    keys(raw,['id','resourceId','units','domain','segments','position','closed','closureTolerance','frame','sourceSpan','expressionSpans'],path);
    if(raw.sourceSpan!==undefined)diagnostics.push(...validateSourceSpan(raw.sourceSpan,path+'.sourceSpan'));const span=raw.sourceSpan as SourceSpan|undefined;
    if(!name(raw.id)||ids.has(raw.id))error('CURVE3D_ID','Operation IDs must be unique nonempty strings of at most256 characters.',path+'.id',span);else ids.add(raw.id);
    if(!name(raw.resourceId,512)||resourceIds.has(raw.resourceId)||Object.hasOwn(bundle.resources,raw.resourceId))error('CURVE3D_RESOURCE','Generated curve resource IDs cannot collide with authored or generated resources.',path+'.resourceId',span);else resourceIds.add(raw.resourceId);
    if(!['unit','m','cm','mm'].includes(raw.units))error('CURVE3D_UNITS','Expected explicit unit, m, cm or mm.',path+'.units',span);
    if(Object.hasOwn(bundle.expressions?.parameters??{},'u'))error('CURVE3D_PARAMETER_SHADOW','Scene parameter u conflicts with the curve local.',path,span);
    const options={domain:raw.domain,segments:raw.segments,...(raw.closed!==undefined?{closed:raw.closed}:{}),...(raw.closureTolerance!==undefined?{closureTolerance:raw.closureTolerance}:{})} as Curve3DOptions;
    diagnostics.push(...validateCurve3DOptions(options,path).map(d=>({...d,...(span?{sourceSpan:span}:{})})),...validateTransportFrameOptions3D(raw.frame,path+'.frame').map(d=>({...d,...(span?{sourceSpan:span}:{})})));
    if(Number.isInteger(raw.segments))segments+=raw.segments;
    if(raw.expressionSpans!==undefined){if(!object(raw.expressionSpans)||!Array.isArray(raw.expressionSpans.position)||raw.expressionSpans.position.length!==3)error('CURVE3D_SOURCE','Expected three position source spans.',path+'.expressionSpans',span);
      else {keys(raw.expressionSpans,['position'],path+'.expressionSpans');raw.expressionSpans.position.forEach((s:unknown,i:number)=>diagnostics.push(...validateSourceSpan(s,`${path}.expressionSpans.position[${i}]`)));}}
    if(diagnostics.slice(before).some(d=>d.severity==='error'))return;
    if(!Array.isArray(raw.position)||raw.position.length!==3){error('CURVE3D_EXPRESSION','Expected three coordinate expressions.',path+'.position',span);return;}
    const expressions=raw.position.map((text:unknown,i:number)=>compile(text,`${path}.position[${i}]`,raw.expressionSpans?.position[i]??span,true));
    if(diagnostics.length===before)entries.push({operation:freezeSnapshot(raw as CurveOperation3D),path,expressions:expressions as CompiledExpression[],options:structuredClone(options)});
  });
  if(segments>CURVE3D_MAX_SEGMENTS)error('CURVE3D_BUDGET','At most32768 segments are supported across the curve program.','$.curves3d.operations');
  if(bundle.space3d!==undefined&&!hasErrors(diagnostics))diagnostics.push(...validateSpace3DInContext(bundle.space3d,instanceValidationResources(bundle.instances,fieldVisualizationValidationResources(bundle.fieldVisualization,meshAttributeValidationResources(bundle.meshAttributes,curveValidationResources(input,surfaceValidationResources(bundle.surfaces,bundle.resources))))),'$.space3d',{viewport:bundle.viewport,duration:bundle.duration},{...fieldVisualizationValidationSets(bundle.fieldVisualization),...instanceValidationSets(bundle.instances)}));
  if(hasErrors(diagnostics))return result();
  const nodes=new Map(bundle.space3d?.nodes.map(n=>[n.id,n])??[]),curves=new Map(entries.map(e=>[e.operation.resourceId,e.operation.id])),targets=new Set<string>();
  input.followers.forEach((raw:unknown,index:number)=>{
    const path=`$.curves3d.followers[${index}]`,before=diagnostics.length;
    if(!object(raw)){error('CURVE3D_FOLLOWER','Expected a curve follower.',path);return;}
    keys(raw,['id','curveNode','target','progress','sourceSpan','expressionSpan'],path);
    if(raw.sourceSpan!==undefined)diagnostics.push(...validateSourceSpan(raw.sourceSpan,path+'.sourceSpan'));if(raw.expressionSpan!==undefined)diagnostics.push(...validateSourceSpan(raw.expressionSpan,path+'.expressionSpan'));
    const span=raw.sourceSpan as SourceSpan|undefined;if(!name(raw.id)||ids.has(raw.id))error('CURVE3D_ID','Follower IDs must be unique across the program.',path+'.id',span);else ids.add(raw.id);
    const curve=typeof raw.curveNode==='string'?nodes.get(raw.curveNode):undefined,target=typeof raw.target==='string'?nodes.get(raw.target):undefined;
    if(curve?.kind!=='curve'||!curves.has(curve.resourceId))error('CURVE3D_FOLLOW_SOURCE','Expected a curve node backed by this generated curve program.',path+'.curveNode',span);
    if(!target||!['group','mesh'].includes(target.kind))error('CURVE3D_FOLLOW_TARGET','Follower target must be an existing 3D group or mesh.',path+'.target',span);
    if(target&&curve){
      if(target.parent!==curve.parent)error('CURVE3D_FOLLOW_SPACE','Follower and curve node must have the same parent chart.',path,span);
      if(target.transform&&'matrix' in target.transform)error('CURVE3D_FOLLOW_TRANSFORM','Follower target requires a TRS transform.',path+'.target',span);
      try{if(composeTransform3D(curve.transform).some((v,i)=>v!==identityMatrix4()[i]))error('CURVE3D_FOLLOW_SPACE','The referenced curve node requires an identity local transform; transform their common parent.',path+'.curveNode',span);}catch{error('CURVE3D_FOLLOW_TRANSFORM','Invalid curve node transform.',path+'.curveNode',span);}
    }
    if(targets.has(raw.target))error('CURVE3D_FOLLOW_CONFLICT','Multiple followers write the same target.',path+'.target',span);targets.add(raw.target);
    for(const [i,track] of (bundle.space3d?.tracks??[]).entries())if(track.target===raw.target&&['translation','rotation'].includes(track.property)||track.target===raw.curveNode)
      diagnostics.push({severity:'error',code:'CURVE3D_FOLLOW_CONFLICT',message:'A transform track overlaps the follower target or referenced curve chart.',path,...(span?{sourceSpan:span}:{}),related:[{message:'Conflicting transform track.',path:`$.space3d.tracks[${i}]`}]});
    if(diagnostics.slice(before).some(d=>d.severity==='error'))return;
    const expression=compile(raw.progress,path+'.progress',raw.expressionSpan??span);
    if(expression&&diagnostics.length===before)followers.push({operation:freezeSnapshot(raw as CurveFollower3D),path,expression,curve:curves.get((curve as {resourceId:string}).resourceId)!});
  });
  return result();
}
export function validateCurveProgram3D(input:unknown,bundle:Bundle):Diagnostic[]{return inspect(input,bundle).diagnostics;}
/** @internal Bundle base and expression parameter declarations are already validated. */
export function validateCurveProgram3DInContext(input:unknown,bundle:Bundle):Diagnostic[]{return inspect(input,bundle,true).diagnostics;}
function located(cause:unknown,path:string,sourceSpan?:DeepReadonly<SourceSpan>):OperationValidationError{
  const ds=(cause as {diagnostics?:readonly Diagnostic[]})?.diagnostics??[{severity:'error' as const,code:'CURVE3D_EVALUATION',message:String(cause)}];
  return new OperationValidationError(ds.map(d=>({...d,path:d.path?.startsWith('$.curves3d')?d.path:path,...(d.sourceSpan?{}:sourceSpan?{sourceSpan:structuredClone(sourceSpan)}:{})})));
}
export function prepareCurveProgram3D(input:CurveProgram3D,bundle:Bundle):PreparedCurveProgram3D{
  const {diagnostics,entries,followers}=inspect(input,bundle);if(hasErrors(diagnostics))throw new OperationValidationError(diagnostics);
  const resolve=prepareParameterResolver(bundle.expressions?.parameters??{});
  const sample=(time:number,overrides?:Readonly<Record<string,ExpressionValue>>):CurveSample3D=>{
    if(!Number.isFinite(time))throw new RangeError('Curve sample time must be finite.');const parameters=resolve(overrides);
    const resources:Record<string,DeepReadonly<Curve3DResource>>=Object.create(null),transforms:Record<string,DeepReadonly<FrameTransform3D>>=Object.create(null),curves:CurveEvaluation3D['curves']=Object.create(null),follows:CurveEvaluation3D['followers']=Object.create(null);
    for(const entry of entries){const o=entry.operation;try{
      const curve=prepareCurve3D(entry.options,u=>{const values={...parameters,u};return entry.expressions.map((expr,i)=>{try{return evaluateExpression(expr,{time,parameters:values}) as number;}catch(cause){throw located(cause,`${entry.path}.position[${i}]`,o.expressionSpans?.position[i]??o.sourceSpan);}}) as Vec3;}),frames=prepareTransportFrames3D(curve,structuredClone(o.frame) as TransportFrameOptions3D);
      const positions=curve.positions.flat(),bounds={min:[0,1,2].map(i=>Math.min(...curve.positions.map(p=>p[i]))) as Vec3,max:[0,1,2].map(i=>Math.max(...curve.positions.map(p=>p[i]))) as Vec3};
      resources[o.resourceId]=snapshotCurve3DResource({kind:'curve3d',version:1,primitive:'line-strip',units:o.units,coordinateSpace:'object',closed:curve.closed,topologyRevision:`curve3d/1:${o.segments}:${curve.closed?'closed':'open'}`,
        positions:{version:1,componentType:'float64',components:3,count:curve.positions.length,byteOffset:0,byteStride:24,data:positions},bounds,
        provenance:{curve3d:{version:1,domain:o.domain,segments:o.segments,frame:o.frame}}});
      curves[o.id]=Object.freeze({resourceId:o.resourceId,curve,frames});
    }catch(cause){throw located(cause,entry.path,o.sourceSpan);}}
    for(const f of followers){try{const progress=evaluateExpression(f.expression,{time,parameters}) as number;if(progress<0||progress>1)throw new OperationValidationError([{severity:'error',code:'CURVE3D_PROGRESS',message:'Follower progress must be in [0,1].',path:f.path+'.progress',...(f.operation.expressionSpan??f.operation.sourceSpan?{sourceSpan:structuredClone(f.operation.expressionSpan??f.operation.sourceSpan)}:{})}]);
      const frame=sampleTransportFrame3D(curves[f.curve].frames,progress);transforms[f.operation.target]=Object.freeze({translation:frame.position,rotation:frame.quaternion});follows[f.operation.id]=Object.freeze({curveNode:f.operation.curveNode,target:f.operation.target,progress,sample:frame});
    }catch(cause){throw located(cause,f.path+'.progress',f.operation.expressionSpan??f.operation.sourceSpan);}}
    return Object.freeze({resources:Object.freeze(resources),transforms:Object.freeze(transforms),curves3d:Object.freeze({curves:Object.freeze(curves),followers:Object.freeze(follows)})});
  };
  const base=sample(0);return Object.freeze({resourceIds:Object.freeze(entries.map(e=>e.operation.resourceId)),followerTargets:Object.freeze(followers.map(f=>f.operation.target)),baseResources:base.resources,baseTransforms:base.transforms,sample});
}
