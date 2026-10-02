import type {Bundle, Node} from '../schema.js';
import {BundleValidationError,relationOutputs} from '../schema.js';
import {OperationValidationError, type DeepReadonly, type Diagnostic, type InputRef, type LiteralValue,
  type Operation, type SourceSpan, type SpaceRef} from '../ir/operations.js';
import type {CompiledExpression, ExpressionValue, Unit} from '../fields/ast.js';
import {compileExpression,evaluateExpression} from '../fields/scalar.js';
import {validateSpaceRef,validateSourceSpan} from './values.js';
import type {PropertyAccess} from './properties.js';
import {nodePosition,nodePositionReads,spaceTransform,spaceTransformReads} from '../geometry/spaces.js';

type Obj=Record<string,any>;
const object=(v:unknown):v is Obj=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const name=(v:unknown):v is string=>typeof v==='string'&&v.length>0;
export interface InputValueType {type:string;unit?:Unit;role?:string;space?:SpaceRef;from?:SpaceRef;to?:SpaceRef}
const dimension=(unit:Unit)=>({length:unit==='bp'?1:0,time:unit==='s'?1:0,angle:unit==='rad'?1:0});
function compileInput(input:Extract<DeepReadonly<InputRef>,{kind:'expression'}>,bundle:Bundle):CompiledExpression{
  const compiled=compileExpression(input.expression,bundle.expressions?.parameters??{},input.sourceSpan);
  const d=dimension(input.unit),t=compiled.type;
  if(t.kind!=='scalar'||t.dimension.length!==d.length||t.dimension.time!==d.time||t.dimension.angle!==d.angle)
    throw new OperationValidationError([{severity:'error',code:'OPERATION_EXPRESSION_UNIT',message:`Input expression must return a scalar in ${input.unit}.`,
      sourceSpan:structuredClone(compiled.ast.location.sourceSpan)}]);
  return compiled;
}
function located(error:unknown,path:string,span?:DeepReadonly<SourceSpan>):Diagnostic[]{
  const diagnostics=error instanceof OperationValidationError||error instanceof BundleValidationError?error.diagnostics:[{
    severity:'error' as const,code:'OPERATION_INPUT',message:error instanceof Error?error.message:String(error)}];
  return diagnostics.map(d=>({...d,path,...(span?{sourceSpan:structuredClone(span)}:{})}));
}

/** Scene shape is validated; graph/expression bindings may still be inspected. */
export function hasTransformWriter(chain:ReadonlySet<string>,bundle:Bundle):boolean{
  const changesMatrix=(value:unknown)=>object(value)&&chain.has(value.target)&&typeof value.property==='string'&&
    (value.property==='transform'||value.property.startsWith('transform.'));
  const expressionBindings=bundle.expressions?.bindings,graphBindings=bundle.operationGraph?.bindings;
  return bundle.tracks.some(changesMatrix)||
    (Array.isArray(expressionBindings)&&expressionBindings.some(changesMatrix))||
    (Array.isArray(graphBindings)&&graphBindings.some(changesMatrix))||
    bundle.relations.some(r=>chain.has(r.target)&&relationOutputs(r).some(p=>p==='transform'||p.startsWith('transform.')));
}

/** Shared graph validation for frame-dependent inputs; no graph mutation. */
export function validateDynamicInput(raw:unknown,bundle:Bundle,path:string,span?:SourceSpan):{diagnostics:Diagnostic[];type?:InputValueType}{
  const diagnostics:Diagnostic[]=[];
  const fail=(code:string,message:string,at=path)=>diagnostics.push({severity:'error',code,message,path:at,...(span?{sourceSpan:span}:{})});
  if(!object(raw)){fail('OPERATION_INPUT_REF','Expected an input reference.');return {diagnostics};}
  const keys=(allowed:string[])=>{for(const key of Object.keys(raw))if(!allowed.includes(key))fail('OPERATION_INPUT_FIELD',`Unknown input property ${key}.`,path+'.'+key);};
  const nodes=new Map(bundle.nodes.map(n=>[n.id,n]));
  const space=(value:unknown,at:string):value is SpaceRef=>{
    const errors=validateSpaceRef(value,at);diagnostics.push(...errors.map(d=>({...d,...(span?{sourceSpan:span}:{})})));
    if(errors.length)return false;
    const ref=value as SpaceRef;
    if(ref.kind!=='scene'&&!nodes.has(ref.node)){fail('OPERATION_SPACE_REFERENCE','Space references a missing node.',at);return false;}
    if(ref.kind==='plot'&&nodes.get(ref.node)?.kind!=='group'){fail('OPERATION_PLOT_SPACE','Plot space requires a group node.',at);return false;}
    return true;
  };
  const inverse=(to:SpaceRef)=>{
    const chain=new Set(spaceTransformReads(to,nodes).map(read=>read.node));
    // An authored matrix can be replaced before this read. Static checks must
    // not reject that obsolete value; the resolved matrix is checked at runtime.
    if(!hasTransformWriter(chain,bundle))try{spaceTransform({kind:'scene'},to,nodes);}catch(error){diagnostics.push(...located(error,path,span));}
    for(const [i,track] of bundle.tracks.entries())if(chain.has(track.target)&&track.property==='transform.scale'){
      const scales=track.keys.map(([,value])=>value as number[]);
      if(scales.some((value,j)=>value.some((v,axis)=>v===0||j>0&&track.interpolation!=='step'&&Math.sign(v)!==Math.sign(scales[j-1][axis]))))
        fail('OPERATION_SINGULAR_SPACE',`Destination space becomes singular in scale track ${i}.`,path);
    }
  };
  let type:InputValueType|undefined;
  if(raw.kind==='node'){
    keys(['kind','node','property','space']);
    const node=name(raw.node)?nodes.get(raw.node):undefined;
    if(!node||!['point','ellipse','tex'].includes(node.kind))fail('OPERATION_NODE_REFERENCE','Position input requires an existing point, ellipse or tex node.',path+'.node');
    if(raw.property!=='position')fail('OPERATION_NODE_PROPERTY','Only position is supported for node inputs.',path+'.property');
    if(space(raw.space,path+'.space')){inverse(raw.space);type={type:'vec2',role:'point',space:raw.space};}
  }else if(raw.kind==='spaceTransform'){
    keys(['kind','from','to']);
    const from=space(raw.from,path+'.from'),to=space(raw.to,path+'.to');
    if(to)inverse(raw.to);
    if(from&&to)type={type:'transform2d',from:raw.from,to:raw.to};
  }else if(raw.kind==='expression'){
    keys(['kind','expression','unit','sourceSpan']);
    if(raw.sourceSpan!==undefined)diagnostics.push(...validateSourceSpan(raw.sourceSpan,path+'.sourceSpan'));
    if(typeof raw.expression!=='string')fail('OPERATION_INPUT_EXPRESSION','Expected a literal expression string.',path+'.expression');
    if(!['1','bp','s','rad'].includes(raw.unit))fail('OPERATION_INPUT_UNIT','Expression input requires unit 1, bp, s or rad.',path+'.unit');
    if(!diagnostics.length)try{compileInput(raw as any,bundle);type={type:'scalar',unit:raw.unit};}
      catch(error){diagnostics.push(...located(error,path+'.expression',raw.sourceSpan?undefined:span));}
  }else fail('OPERATION_INPUT_REF','Input kind must be literal, output, node, expression or spaceTransform.',path+'.kind');
  return {diagnostics,...(type?{type}:{})};
}

export interface PreparedOperationInputs {
  readonly reads:readonly PropertyAccess[];
  resolve(nodes:Map<string,Node>,time:number,parameters:Readonly<Record<string,ExpressionValue>>,
    outputs:ReadonlyMap<string,Record<string,LiteralValue>>):Record<string,LiteralValue>;
}
/** The containing operation and scene have already passed graph validation. */
export function prepareOperationInputs(operation:DeepReadonly<Operation>,bundle:Bundle,path:string):PreparedOperationInputs{
  const nodes=new Map(bundle.nodes.map(n=>[n.id,n])),reads:PropertyAccess[]=[],compiled=new Map<string,CompiledExpression>();
  for(const [name,input] of Object.entries(operation.inputs)){
    if(input.kind==='node')reads.push(...nodePositionReads(input.node,input.space,nodes));
    else if(input.kind==='spaceTransform')reads.push(...spaceTransformReads(input.from,nodes),...spaceTransformReads(input.to,nodes));
    else if(input.kind==='expression')compiled.set(name,compileInput(input,bundle));
  }
  return Object.freeze({reads:Object.freeze(reads),resolve(frameNodes,time,parameters,outputs){
    const result:Record<string,LiteralValue>=Object.create(null);
    for(const [name,input] of Object.entries(operation.inputs))try{
      if(input.kind==='literal')result[name]=structuredClone(input.value) as LiteralValue;
      else if(input.kind==='output')result[name]=outputs.get(input.ref.operation)![input.ref.socket];
      else if(input.kind==='node')result[name]={type:'vec2',role:'point',space:structuredClone(input.space),value:nodePosition(input.node,input.space,frameNodes)};
      else if(input.kind==='spaceTransform')result[name]={type:'transform2d',from:structuredClone(input.from),to:structuredClone(input.to),value:spaceTransform(input.from,input.to,frameNodes)};
      else result[name]={type:'scalar',unit:input.unit,value:evaluateExpression(compiled.get(name)!,{time,parameters}) as number};
    }catch(error){throw new OperationValidationError(located(error,path+'.inputs.'+name,
      input.kind==='expression'&&input.sourceSpan?undefined:operation.sourceSpan));}
    return result;
  }} as PreparedOperationInputs);
}
