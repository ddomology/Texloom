import {validateBundle, relationOutputs, type Bundle, type Node, type PathNode} from '../schema.js';
import {OperationValidationError, type Diagnostic, type DeepReadonly, type SourceSpan} from '../ir/operations.js';
import {freezeSnapshot, validateJsonData, validateSourceSpan} from './values.js';
import {bindingProperties, propertiesOverlap, type PropertyAccess} from './properties.js';
import {compileDeformation, type CompiledDeformation} from '../geometry/deform-expression.js';
import {deformGeometry, type DeformationReport, type DeformationMode} from '../geometry/deform.js';
import {pathGeometryData} from '../path-geometry.js';
import type {ExpressionValue} from '../fields/ast.js';

export interface DeformationOperation {
  id:string; source:string; target:string; mode:DeformationMode; expression:string;
  /** Error budget in source-local bp; never a screen-pixel tolerance. */
  tolerance?:number; maxDepth?:number; maxSegments?:number; sourceSpan?:SourceSpan;
}
export interface DeformationProgram {version:1; operations:DeformationOperation[]}
export type DeformationEvaluation = Readonly<Record<string,DeepReadonly<DeformationReport>>>;
export interface PreparedDeformation {
  readonly operation:DeepReadonly<DeformationOperation>; readonly expression:CompiledDeformation;
  readonly path:string; readonly reads:readonly PropertyAccess[]; readonly writes:readonly PropertyAccess[];
  apply(nodes:Map<string,Node>,time:number,parameters:Readonly<Record<string,ExpressionValue>>):DeepReadonly<DeformationReport>;
}
export interface PreparedDeformationProgram {readonly operations:readonly PreparedDeformation[]}

type Obj=Record<string,any>;
const object=(v:unknown):v is Obj=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const name=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.trim()===v;
interface Entry {operation:DeepReadonly<DeformationOperation>;expression:CompiledDeformation;path:string}
interface Inspection {diagnostics:Diagnostic[]; entries:Entry[]}

/** Whole-geometry ownership also invalidates the legacy connector cache. */
export function deformationWrites(target:string):PropertyAccess[] {
  return ['geometry','d','resolvedPath'].map(property=>({node:target,property}));
}

function inspect(input:unknown,bundle:Bundle,validatedContext=false):Inspection {
  const diagnostics=validateJsonData(input,'$.deformations'),entries:Entry[]=[];
  const fail=(code:string,message:string,path:string,source?:{sourceSpan?:SourceSpan},related?:Diagnostic['related'])=>
    diagnostics.push({severity:'error',code,message,path,...(source?.sourceSpan?{sourceSpan:source.sourceSpan}:{}),...(related?{related}:{})});
  if(diagnostics.length)return {diagnostics,entries};
  if(!object(bundle)){fail('DEFORMATION_CONTEXT','Expected a scene bundle.','$');return {diagnostics,entries};}
  if(!validatedContext){const {deformations:ignored,...base}=bundle;diagnostics.push(...validateBundle(base));}
  if(bundle.version!=='0.3')fail('DEFORMATION_BUNDLE_VERSION','Deformation programs require Bundle 0.3.','$.version');
  if(diagnostics.some(d=>d.severity==='error'))return {diagnostics,entries};
  const keys=(raw:Obj,allowed:string[],path:string)=>{
    for(const key of Object.keys(raw))if(!allowed.includes(key))fail('DEFORMATION_PROPERTY',`Unknown property ${key}.`,path+'.'+key);
  };
  if(!object(input)){fail('DEFORMATION_PROGRAM','Expected a deformation program.','$.deformations');return {diagnostics,entries};}
  keys(input,['version','operations'],'$.deformations');
  if(input.version!==1)fail('DEFORMATION_VERSION','Supported deformation program version is 1.','$.deformations.version');
  if(!Array.isArray(input.operations)||input.operations.length>256){
    fail('DEFORMATION_OPERATIONS','Expected an array of at most 256 deformations.','$.deformations.operations');return {diagnostics,entries};
  }
  const nodes=new Map(bundle.nodes.map(n=>[n.id,n])),ids=new Set<string>();
  const writers:{slots:PropertyAccess[];path:string;sourceSpan?:SourceSpan}[]=[
    ...bundle.tracks.map((t,i)=>({slots:[{node:t.target,property:t.property}],path:`$.tracks[${i}]`})),
    ...bundle.relations.map((r,i)=>({slots:relationOutputs(r).map(property=>({node:r.target,property})),path:`$.relations[${i}]`,sourceSpan:r.sourceSpan})),
    ...(bundle.operationGraph?.bindings??[]).map((b,i)=>({slots:bindingProperties(b,nodes),path:`$.operationGraph.bindings[${i}]`,sourceSpan:b.sourceSpan})),
    ...(bundle.expressions?.bindings??[]).map((b,i)=>({slots:bindingProperties(b,nodes),path:`$.expressions.bindings[${i}]`,sourceSpan:b.sourceSpan})),
    ...(bundle.fields?.bindings??[]).flatMap((b,i)=>b.targets.map(t=>({slots:bindingProperties({target:t.target,property:b.property},nodes),path:`$.fields.bindings[${i}]`,sourceSpan:b.sourceSpan}))),
    ...(!validatedContext?bundle.plots?.operations??[]:[]).map((p,i)=>({slots:deformationWrites(p.target),path:`$.plots.operations[${i}]`,sourceSpan:p.sourceSpan})),
  ];
  input.operations.forEach((raw:unknown,index:number)=>{
    const path=`$.deformations.operations[${index}]`;
    if(!object(raw)){fail('DEFORMATION_OPERATION','Expected a deformation operation.',path);return;}
    keys(raw,['id','source','target','mode','expression','tolerance','maxDepth','maxSegments','sourceSpan'],path);
    if(raw.sourceSpan!==undefined){const errors=validateSourceSpan(raw.sourceSpan,path+'.sourceSpan');diagnostics.push(...errors);if(errors.length)return;}
    const operation=raw as DeformationOperation;
    if(!name(raw.id)||ids.has(raw.id)){fail('DEFORMATION_ID','Operation IDs must be unique nonempty strings.',path+'.id',operation);return;}
    ids.add(raw.id);
    for(const role of ['source','target']){
      const node=name(raw[role])?nodes.get(raw[role]):undefined;
      if(node?.kind!=='path'||!node.geometry){fail('DEFORMATION_PATH',`${role} must reference an editable path.`,path+'.'+role,operation);return;}
    }
    if(!['controlDeform','pointwiseDeform'].includes(raw.mode)){fail('DEFORMATION_MODE','Expected controlDeform or pointwiseDeform.',path+'.mode',operation);return;}
    if(typeof raw.expression!=='string'){fail('DEFORMATION_EXPRESSION','Expected a literal expression string.',path+'.expression',operation);return;}
    if(raw.tolerance!==undefined&&(typeof raw.tolerance!=='number'||!Number.isFinite(raw.tolerance)||raw.tolerance<=0)){
      fail('DEFORMATION_TOLERANCE','Tolerance must be positive finite bp.',path+'.tolerance',operation);return;
    }
    for(const [key,max] of [['maxDepth',24],['maxSegments',131072]] as const)if(raw[key]!==undefined&&(!Number.isSafeInteger(raw[key])||raw[key]<1||raw[key]>max)){
      fail('DEFORMATION_BUDGET',`${key} must be an integer in [1, ${max}].`,path+'.'+key,operation);return;
    }
    const slots=deformationWrites(raw.target);
    for(const writer of writers)if(slots.some(a=>writer.slots.some(b=>propertiesOverlap(a,b))))
      fail('DEFORMATION_WRITER_CONFLICT','Multiple writers overlap the deformed geometry.',path,operation,[{message:'Earlier writer.',path:writer.path,...(writer.sourceSpan?{sourceSpan:writer.sourceSpan}:{})}]);
    writers.push({slots,path,sourceSpan:operation.sourceSpan});
    try{
      const expression=compileDeformation(raw.expression,bundle.expressions?.parameters??{},raw.sourceSpan);
      if(raw.mode==='pointwiseDeform'&&['index','count'].some(key=>Object.hasOwn(expression.parameterTypes,key)))
        fail('DEFORMATION_DOMAIN','index and count belong to the control domain; pointwise deformation uses position and parameter.',path+'.expression',operation);
      entries.push({operation:freezeSnapshot(operation),expression,path});
    }catch(error){
      if(error instanceof OperationValidationError)diagnostics.push(...error.diagnostics.map(d=>({...d,path:path+'.expression',...(d.sourceSpan?{}:raw.sourceSpan?{sourceSpan:raw.sourceSpan}:{})})));
      else fail('DEFORMATION_EXPRESSION',error instanceof Error?error.message:String(error),path+'.expression',operation);
    }
  });
  // Reject geometry feedback before any frame is evaluated. An in-place
  // operation reads its input exactly once; it is not a feedback edge.
  const byTarget=new Map(entries.map(e=>[e.operation.target,e])),done=new Set<Entry>(),active=new Set<Entry>();
  const visit=(entry:Entry):void=>{
    if(done.has(entry))return;
    if(active.has(entry)){fail('DEFORMATION_CYCLE','Deformation sources form a geometry dependency cycle.',entry.path,entry.operation as DeformationOperation);return;}
    active.add(entry);
    const upstream=byTarget.get(entry.operation.source);
    if(upstream&&upstream!==entry)visit(upstream);
    active.delete(entry);done.add(entry);
  };
  for(const entry of entries)visit(entry);
  return {diagnostics,entries};
}

export function validateDeformationProgram(input:unknown,bundle:Bundle):Diagnostic[]{return inspect(input,bundle).diagnostics;}
/** @internal All earlier scene programs have been validated. */
export function validateDeformationProgramInContext(input:unknown,bundle:Bundle):Diagnostic[]{return inspect(input,bundle,true).diagnostics;}
export function prepareDeformationProgram(input:DeformationProgram,bundle:Bundle):PreparedDeformationProgram{
  const checked=inspect(input,bundle);
  if(checked.diagnostics.some(d=>d.severity==='error'))throw new OperationValidationError(checked.diagnostics);
  const operations=checked.entries.map(({operation,expression,path}):PreparedDeformation=>Object.freeze({
    operation,expression,path,reads:freezeSnapshot([{node:operation.source,property:'geometry'}]),writes:freezeSnapshot(deformationWrites(operation.target)),
    apply(nodes:Map<string,Node>,time:number,parameters:Readonly<Record<string,ExpressionValue>>){
      try{
        const source=nodes.get(operation.source) as PathNode,target=nodes.get(operation.target) as PathNode;
        const result=deformGeometry(source.geometry!,expression,{mode:operation.mode,time,parameters,
          ...(operation.tolerance===undefined?{}:{tolerance:operation.tolerance}),
          ...(operation.maxDepth===undefined?{}:{maxDepth:operation.maxDepth}),
          ...(operation.maxSegments===undefined?{}:{maxSegments:operation.maxSegments})});
        // Frame nodes remain mutable for downstream consumers; no frozen source
        // or report shares their coordinate arrays.
        target.geometry=structuredClone(result.geometry) as PathNode['geometry'];
        target.d=pathGeometryData(target.geometry!);delete target.resolvedPath;
        return result.report;
      }catch(error){
        const errors:Diagnostic[]=error instanceof OperationValidationError?error.diagnostics:[{
          severity:'error',code:'DEFORMATION_EVALUATION',message:error instanceof Error?error.message:String(error)}];
        throw new OperationValidationError(errors.map(d=>({...d,path,...(d.sourceSpan?{}:operation.sourceSpan?{sourceSpan:structuredClone(operation.sourceSpan)}:{})})));
      }
    },
  }));
  return Object.freeze({operations:Object.freeze(operations)});
}
