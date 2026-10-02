import type {Bundle, Node} from '../schema.js';
import {BundleValidationError,relationOutputs,propertySpec} from '../schema.js';
import {OperationValidationError, type DeepReadonly, type Diagnostic, type InputRef, type LiteralValue,
  type Operation, type OperatorDefinition, type OutputRef, type SourceSpan, type SpaceRef} from '../ir/operations.js';
import type {CompiledExpression, ExpressionValue, Unit} from '../fields/ast.js';
import {compileExpression,evaluateExpression} from '../fields/scalar.js';
import {validateSpaceRef,validateSourceSpan} from './values.js';
import {scalarPropertyUnit,type PropertyAccess} from './properties.js';
import {nodePosition,nodePositionReads,spaceTransform,spaceTransformReads} from '../geometry/spaces.js';
import {validateAnchorInput,anchorInputReads,resolveAnchorInput,type AnchorEvaluation} from './anchors.js';
import type {PathGeometry} from '../path-geometry.js';
import {seedCurveProvenance,transformCurveInput,type CurveProvenance} from '../geometry/curves.js';

type Obj=Record<string,any>;
const object=(v:unknown):v is Obj=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const name=(v:unknown):v is string=>typeof v==='string'&&v.length>0;
export interface InputValueType {type:string;unit?:Unit;role?:string;space?:SpaceRef;from?:SpaceRef;to?:SpaceRef}
const dimension=(unit:Unit)=>({length:unit==='bp'?1:0,time:unit==='s'?1:0,angle:unit==='rad'?1:0});
function compileInput(input:Extract<DeepReadonly<InputRef>,{kind:'expression'|'pointExpression'}>,bundle:Bundle):CompiledExpression{
  const compiled=compileExpression(input.expression,bundle.expressions?.parameters??{},input.sourceSpan);
  const unit=input.kind==='pointExpression'?'bp':input.unit,d=dimension(unit),t=compiled.type;
  const kind=input.kind==='pointExpression'?'vec2':'scalar';
  if(t.kind==='boolean'||t.kind!==kind||t.dimension.length!==d.length||t.dimension.time!==d.time||t.dimension.angle!==d.angle)
    throw new OperationValidationError([{severity:'error',code:'OPERATION_EXPRESSION_UNIT',message:`Input expression must return a ${kind} in ${unit}.`,
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
export function validateDynamicInput(raw:unknown,bundle:Bundle,path:string,span?:SourceSpan,
  resolveInput?:(raw:unknown,path:string)=>InputValueType|undefined):{diagnostics:Diagnostic[];type?:InputValueType}{
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
  }else if(raw.kind==='path'){
    keys(['kind','node','space']);
    if(!name(raw.node)||nodes.get(raw.node)?.kind!=='path')fail('OPERATION_PATH_REFERENCE','Path input requires an existing path node.',path+'.node');
    if(space(raw.space,path+'.space')){inverse(raw.space);type={type:'path2d',space:raw.space};}
  }else if(raw.kind==='spaceTransform'){
    keys(['kind','from','to']);
    const from=space(raw.from,path+'.from'),to=space(raw.to,path+'.to');
    if(to)inverse(raw.to);
    if(from&&to)type={type:'transform2d',from:raw.from,to:raw.to};
  }else if(raw.kind==='anchor'||raw.kind==='textPlacement'||raw.kind==='textAnchor'){
    const valid=raw.kind!=='anchor'||space(raw.space,path+'.space');
    if(raw.kind==='anchor'&&valid)inverse(raw.space);
    if(!resolveInput)fail('ANCHOR_CONTEXT','Anchor validation requires its containing graph.');
    else {
      const result=validateAnchorInput(raw,bundle,path,span,resolveInput);
      diagnostics.push(...result.diagnostics);if(valid)type=result.type;
    }
  }else if(raw.kind==='property'){
    keys(['kind','node','property','unit']);
    const node=name(raw.node)?nodes.get(raw.node):undefined;
    const spec=node&&typeof raw.property==='string'?propertySpec(node.kind,raw.property):undefined;
    if(!node||!spec||spec.size)fail('OPERATION_PROPERTY_INPUT','Property input requires an existing numeric scalar node property.');
    else if(raw.unit!==scalarPropertyUnit(raw.property))fail('OPERATION_INPUT_UNIT',`Property ${raw.property} requires ${scalarPropertyUnit(raw.property)}.`);
    else type={type:'scalar',unit:raw.unit};
  }else if(raw.kind==='points'){
    keys(['kind','space','items']);
    const valid=space(raw.space,path+'.space');
    if(!Array.isArray(raw.items)||raw.items.length>16384)fail('OPERATION_POINTS_INPUT','Expected at most 16384 point inputs.',path+'.items');
    else raw.items.forEach((item:unknown,index:number)=>{
      const at=`${path}.items[${index}]`,itemType=resolveInput?.(item,at);
      if(!resolveInput)fail('OPERATION_POINTS_CONTEXT','Point list validation requires the containing graph.',at);
      if(itemType&&(itemType.type!=='vec2'||itemType.role!=='point'))fail('OPERATION_TYPE_MISMATCH','Point list items must produce points.',at);
      else if(valid&&itemType&&!sameInputSpace(raw.space,itemType.space))fail('OPERATION_SPACE_MISMATCH','Point list items must share its declared space.',at);
    });
    if(valid)type={type:'points2d',space:raw.space};
  }else if(raw.kind==='expression'||raw.kind==='pointExpression'){
    const point=raw.kind==='pointExpression';
    keys(point?['kind','expression','space','sourceSpan']:['kind','expression','unit','sourceSpan']);
    if(raw.sourceSpan!==undefined)diagnostics.push(...validateSourceSpan(raw.sourceSpan,path+'.sourceSpan'));
    if(typeof raw.expression!=='string')fail('OPERATION_INPUT_EXPRESSION','Expected a literal expression string.',path+'.expression');
    if(point)space(raw.space,path+'.space');
    else if(!['1','bp','s','rad'].includes(raw.unit))fail('OPERATION_INPUT_UNIT','Expression input requires unit 1, bp, s or rad.',path+'.unit');
    if(!diagnostics.length)try{compileInput(raw as any,bundle);type=point?{type:'vec2',role:'point',space:raw.space}:{type:'scalar',unit:raw.unit};}
      catch(error){diagnostics.push(...located(error,path+'.expression',raw.sourceSpan?undefined:span));}
  }else fail('OPERATION_INPUT_REF','Unknown dynamic input kind.',path+'.kind');
  return {diagnostics,...(type?{type}:{})};
}

const sameInputSpace=(a:SpaceRef,b:SpaceRef|undefined)=>!!b&&a.kind===b.kind&&(a.kind==='scene'||b.kind!=='scene'&&a.node===b.node);
/** Nested point lists participate in the same graph and property dependency plan. */
export function flattenOperationInputs(inputs:Readonly<Record<string,DeepReadonly<InputRef>>>):DeepReadonly<InputRef>[] {
  const result:DeepReadonly<InputRef>[]=[];
  const visit=(input:DeepReadonly<InputRef>)=>{
    result.push(input);
    if(input.kind==='points')input.items.forEach(visit);
    else if(input.kind==='textPlacement')visit(input.point);
    else if(input.kind==='anchor') {
      if(input.source.kind==='shape')visit({kind:'output',ref:input.source.ref});
      if(input.query.kind==='border')visit(input.query.towards);
    }
  };
  Object.values(inputs).forEach(visit);return result;
}

export interface PreparedOperationInputs {
  readonly reads:readonly PropertyAccess[];
  resolve(nodes:Map<string,Node>,time:number,parameters:Readonly<Record<string,ExpressionValue>>,
    outputs:ReadonlyMap<string,Record<string,LiteralValue>>,anchors?:AnchorEvaluation):Record<string,LiteralValue>;
}
/** The containing operation and scene have already passed graph validation. */
export function prepareOperationInputs(operation:DeepReadonly<Operation>,bundle:Bundle,path:string,
  definitions:readonly DeepReadonly<OperatorDefinition>[]):PreparedOperationInputs{
  const nodes=new Map(bundle.nodes.map(n=>[n.id,n])),reads:PropertyAccess[]=[],compiled=new Map<DeepReadonly<InputRef>,CompiledExpression>();
  const outputSpace=(ref:DeepReadonly<OutputRef>):SpaceRef=>{
    const producer=bundle.operationGraph!.operations.find(p=>p.id===ref.operation)!;
    const definition=definitions.find(d=>d.name===producer.operator&&d.version===producer.version)!;
    const socket=definition.outputs[ref.socket];
    if(socket.type!=='shape2d')throw new Error('Anchor source is not a shape output.');
    return producer.spaces[socket.space];
  };
  for(const input of flattenOperationInputs(operation.inputs)){
    if(input.kind==='node')reads.push(...nodePositionReads(input.node,input.space,nodes));
    else if(input.kind==='path')reads.push({node:input.node,property:'geometry'},
      ...spaceTransformReads({kind:'local',node:input.node},nodes),...spaceTransformReads(input.space,nodes));
    else if(input.kind==='spaceTransform')reads.push(...spaceTransformReads(input.from,nodes),...spaceTransformReads(input.to,nodes));
    else if(input.kind==='property')reads.push({node:input.node,property:input.property});
    else if(input.kind==='anchor'||input.kind==='textPlacement'||input.kind==='textAnchor')reads.push(...anchorInputReads(input,nodes,outputSpace));
    else if(input.kind==='expression'||input.kind==='pointExpression')compiled.set(input,compileInput(input,bundle));
  }
  return Object.freeze({reads:Object.freeze(reads),resolve(frameNodes,time,parameters,outputs,anchors){
    const resolve=(input:DeepReadonly<InputRef>,at:string):LiteralValue=>{
      try{
        if(input.kind==='literal')return structuredClone(input.value) as LiteralValue;
        if(input.kind==='output')return outputs.get(input.ref.operation)![input.ref.socket];
        if(input.kind==='node')return {type:'vec2',role:'point',space:structuredClone(input.space),value:nodePosition(input.node,input.space,frameNodes)};
        if(input.kind==='path'){
          const node=frameNodes.get(input.node);
          if(node?.kind!=='path'||!node.geometry)throw new OperationValidationError([{severity:'error',code:'OPERATION_PATH_GEOMETRY',message:'Path input requires current editable geometry; SVG d strings are not parsed implicitly.'}]);
          const transformed=transformCurveInput({geometry:node.geometry,provenance:seedCurveProvenance(node.geometry,input.node)},
            spaceTransform({kind:'local',node:input.node},input.space,frameNodes));
          return {type:'path2d',space:structuredClone(input.space),
            value:structuredClone(transformed.geometry) as PathGeometry,
            provenance:structuredClone(transformed.provenance) as CurveProvenance};
        }
        if(input.kind==='spaceTransform')return {type:'transform2d',from:structuredClone(input.from),to:structuredClone(input.to),value:spaceTransform(input.from,input.to,frameNodes)};
        if(input.kind==='anchor'||input.kind==='textPlacement'||input.kind==='textAnchor')return resolveAnchorInput(input,frameNodes,bundle.resources,resolve,at,anchors);
        if(input.kind==='points')return {type:'points2d',space:structuredClone(input.space),value:input.items.map((item,index)=>{
          const value=resolve(item,`${at}.items[${index}]`);
          if(value.type!=='vec2'||value.role!=='point')throw new Error('Point list item did not resolve to a point.');return [...value.value];
        })};
        if(input.kind==='property'){
          const [head,tail]=input.property.split('.'),node=frameNodes.get(input.node)! as unknown as Obj;
          const value=tail?node[head]?.[tail]:node[head];
          if(typeof value!=='number'||!Number.isFinite(value))throw new Error(`Property ${input.node}.${input.property} has no finite numeric value.`);
          return {type:'scalar',unit:input.unit,value};
        }
        const value=evaluateExpression(compiled.get(input)!,{time,parameters});
        return input.kind==='pointExpression'?{type:'vec2',role:'point',space:structuredClone(input.space),value:value as [number,number]}
          :{type:'scalar',unit:input.unit,value:value as number};
      }catch(error){
        if(error instanceof OperationValidationError&&error.diagnostics.every(d=>d.path?.startsWith(path+'.inputs.')))throw error;
        throw new OperationValidationError(located(error,at,
          (input.kind==='expression'||input.kind==='pointExpression')&&input.sourceSpan?undefined:operation.sourceSpan));
      }
    };
    const result:Record<string,LiteralValue>=Object.create(null);
    for(const [name,input] of Object.entries(operation.inputs))result[name]=resolve(input,path+'.inputs.'+name);
    return result;
  }} as PreparedOperationInputs);
}
