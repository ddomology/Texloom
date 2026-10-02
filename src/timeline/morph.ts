import {validateBundle,relationOutputs,type Bundle,type Node,type PathNode} from '../schema.js';
import {OperationValidationError,type Diagnostic,type SourceSpan,type DeepReadonly} from '../ir/operations.js';
import {freezeSnapshot,validateJsonData,validateSourceSpan} from '../operations/values.js';
import {bindingProperties,propertiesOverlap,type PropertyAccess} from '../operations/properties.js';
import {deformationWrites} from '../operations/deform.js';
import {pathGeometryData,type PathGeometry} from '../path-geometry.js';
import {prepareCorrespondence,sampleCorrespondence,type CorrespondenceOptions,type CorrespondenceReport,type PreparedCorrespondence} from '../geometry/correspondence.js';

export interface MorphOperation {id:string;source:string;destination:string;instance:string;correspondence:CorrespondenceOptions;sourceSpan?:SourceSpan}
export interface MorphProgram {version:1;operations:MorphOperation[]}
export interface MorphReport {progress:number;correspondence:CorrespondenceReport}
export type MorphEvaluation=Readonly<Record<string,DeepReadonly<MorphReport>>>;
export interface PreparedMorph {
  readonly operation:DeepReadonly<MorphOperation>;readonly path:string;readonly reads:readonly PropertyAccess[];readonly writes:readonly PropertyAccess[];
  apply(nodes:Map<string,Node>):DeepReadonly<MorphReport>;
}
export interface PreparedMorphProgram {readonly operations:readonly PreparedMorph[]}
type Obj=Record<string,any>;
const object=(value:unknown):value is Obj=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const name=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.trim()===value;
const helperNames=(id:string)=>({shape:`${id}:shape`,leaving:`${id}:leaving`,entering:`${id}:entering`});
export function morphWrites(instance:string):PropertyAccess[]{
  const names=helperNames(instance);
  return [...Object.values(names).flatMap(deformationWrites),...[names.leaving,names.entering].flatMap(node=>[
    {node,property:'style.opacity'},{node,property:'reveal'}])];
}
function inherited(node:Node,key:'fill'|'fillRule',nodes:ReadonlyMap<string,Node>):string {
  let current:Node|undefined=node;const seen=new Set<string>();
  while(current&&!seen.has(current.id)){
    seen.add(current.id);const value=current.style?.[key];if(value!==undefined)return value;
    current=current.parent?nodes.get(current.parent):undefined;
  }
  return key==='fill'?'#e7eee4':'nonzero';
}
interface Entry {operation:DeepReadonly<MorphOperation>;path:string;correspondence:DeepReadonly<PreparedCorrespondence>}
function inspect(input:unknown,bundle:Bundle,validatedContext=false):{diagnostics:Diagnostic[];entries:Entry[]} {
  const diagnostics=validateJsonData(input,'$.morphs'),entries:Entry[]=[];
  const fail=(code:string,message:string,path:string,span?:SourceSpan,related?:Diagnostic['related'])=>diagnostics.push({severity:'error',code,message,path,
    ...(span?{sourceSpan:span}:{}),...(related?{related}:{})});
  if(diagnostics.length)return {diagnostics,entries};
  if(!object(bundle)){fail('MORPH_CONTEXT','Expected a scene bundle.','$');return {diagnostics,entries};}
  if(!validatedContext){const {morphs:ignored,...base}=bundle as Bundle&{morphs?:unknown};diagnostics.push(...validateBundle(base));}
  if(bundle.version!=='0.3')fail('MORPH_VERSION','Morph programs require Bundle 0.3.','$.version');
  if(diagnostics.some(d=>d.severity==='error'))return {diagnostics,entries};
  const keys=(value:Obj,allowed:string[],path:string,span?:SourceSpan)=>{for(const key of Object.keys(value))if(!allowed.includes(key))fail('MORPH_PROPERTY',`Unknown morph field ${key}.`,path+'.'+key,span);};
  if(!object(input)){fail('MORPH_PROGRAM','Expected a morph program.','$.morphs');return {diagnostics,entries};}
  keys(input,['version','operations'],'$.morphs');
  if(input.version!==1)fail('MORPH_VERSION','Supported morph program version is 1.','$.morphs.version');
  if(!Array.isArray(input.operations)||input.operations.length>256){fail('MORPH_OPERATIONS','Expected at most 256 morph operations.','$.morphs.operations');return {diagnostics,entries};}
  const nodes=new Map(bundle.nodes.map(n=>[n.id,n])),ids=new Set<string>(),instances=new Set<string>();
  const generated=new Set<string>();
  for(const raw of input.operations)if(object(raw)&&name(raw.instance)){generated.add(raw.instance);Object.values(helperNames(raw.instance)).forEach(id=>generated.add(id));}
  const writers:{slots:PropertyAccess[];path:string;sourceSpan?:SourceSpan}[]=[
    ...bundle.tracks.map((t,i)=>({slots:[{node:t.target,property:t.property}],path:`$.tracks[${i}]`,sourceSpan:t.sourceSpan})),
    ...bundle.relations.map((r,i)=>({slots:relationOutputs(r).map(property=>({node:r.target,property})),path:`$.relations[${i}]`,sourceSpan:r.sourceSpan})),
    ...(bundle.operationGraph?.bindings??[]).map((b,i)=>({slots:bindingProperties(b,nodes),path:`$.operationGraph.bindings[${i}]`,sourceSpan:b.sourceSpan})),
    ...(bundle.expressions?.bindings??[]).map((b,i)=>({slots:bindingProperties(b,nodes),path:`$.expressions.bindings[${i}]`,sourceSpan:b.sourceSpan})),
    ...(bundle.fields?.bindings??[]).flatMap((b,i)=>b.targets.map(t=>({slots:bindingProperties({target:t.target,property:b.property},nodes),path:`$.fields.bindings[${i}]`,sourceSpan:b.sourceSpan}))),
    ...(bundle.deformations?.operations??[]).map((p,i)=>({slots:deformationWrites(p.target),path:`$.deformations.operations[${i}]`,sourceSpan:p.sourceSpan})),
    ...(bundle.plots?.operations??[]).map((p,i)=>({slots:deformationWrites(p.target),path:`$.plots.operations[${i}]`,sourceSpan:p.sourceSpan})),
  ];
  input.operations.forEach((raw:unknown,index:number)=>{
    const path=`$.morphs.operations[${index}]`,before=diagnostics.length;
    if(!object(raw)){fail('MORPH_OPERATION','Expected a morph operation.',path);return;}
    if(raw.sourceSpan!==undefined){const errors=validateSourceSpan(raw.sourceSpan,path+'.sourceSpan');diagnostics.push(...errors);if(errors.length)return;}
    const span=raw.sourceSpan as SourceSpan|undefined;
    keys(raw,['id','source','destination','instance','correspondence','sourceSpan'],path,span);
    if(!name(raw.id)||ids.has(raw.id)||raw.id!==raw.instance){fail('MORPH_ID','Operation ID must be unique and equal its instance ID.',path+'.id',span);return;}ids.add(raw.id);
    if(!name(raw.instance)||instances.has(raw.instance)||raw.instance===raw.source||raw.instance===raw.destination){fail('MORPH_INSTANCE','Instance must be unique and distinct from both authored endpoints.',path+'.instance',span);return;}instances.add(raw.instance);
    const instance=nodes.get(raw.instance);
    if(instance?.kind!=='group'){fail('MORPH_INSTANCE','Instance must reference a group.',path+'.instance',span);return;}
    const progress=(instance as unknown as Obj).morphProgress;
    if(typeof progress!=='number'||!Number.isFinite(progress)||progress<0||progress>1)fail('MORPH_PROGRESS','Instance group requires morphProgress in [0,1].',path+'.instance',span);
    const endpoints:PathNode[]=[];
    for(const key of ['source','destination']){
      const node=name(raw[key])?nodes.get(raw[key]):undefined;
      if(node?.kind!=='path'||!node.geometry||generated.has(node.id))fail('MORPH_ENDPOINT',`${key} must name an authored editable path, not a transition instance/helper.`,path+'.'+key,span);
      else endpoints.push(node);
    }
    const helpers=helperNames(raw.instance);
    for(const [role,id] of Object.entries(helpers)){
      const node=nodes.get(id);
      if(node?.kind!=='path'||node.parent!==raw.instance||!node.geometry)fail('MORPH_HELPER',`${role} requires editable helper ${id} directly inside ${raw.instance}.`,path,span);
    }
    const slots=morphWrites(raw.instance);
    for(const writer of writers)if(slots.some(a=>writer.slots.some(b=>propertiesOverlap(a,b))))fail('MORPH_WRITER_CONFLICT','Another program already owns transition helper geometry or unmatched opacity/reveal.',path,span,
      [{message:'Earlier writer.',path:writer.path,...(writer.sourceSpan?{sourceSpan:writer.sourceSpan}:{})}]);
    writers.push({slots,path,sourceSpan:span});
    if(diagnostics.length>before)return;
    try{
      const correspondence=prepareCorrespondence(endpoints[0].geometry!,endpoints[1].geometry!,raw.correspondence);
      // Helpers are the paths that actually render. Authored helper overrides
      // and their instance ancestry must obey the same paint restrictions.
      const painted=[...endpoints,...Object.values(helpers).map(id=>nodes.get(id)!)];
      const fill=painted.map(n=>inherited(n,'fill',nodes)),nonzero=painted.map(n=>inherited(n,'fillRule',nodes)==='nonzero');
      const unmatched=correspondence.sourceOnly.length>0||correspondence.targetOnly.length>0;
      if(unmatched&&fill.some(value=>value!=='none'))fail('MORPH_UNMATCHED_FILL','Fade/create of unmatched contours requires endpoint and helper paints to be stroke-only (fill:none), including inherited fill.',path+'.correspondence',span);
      const reversals=new Set(correspondence.report.pairs.filter(p=>p.closed).map(p=>p.reverseTarget));
      if(reversals.size>1&&fill.some((value,i)=>value!=='none'&&nonzero[i]))fail('MORPH_HOLE_WINDING','Filled nonzero paths require uniform reversal of all paired closed contours; reversing individual holes changes the fill.',path+'.correspondence',span);
      if(diagnostics.length===before)entries.push({operation:freezeSnapshot(raw as MorphOperation),path,correspondence});
    }catch(error){
      const errors=error instanceof OperationValidationError?error.diagnostics:[{severity:'error' as const,code:(error as {code?:string})?.code??'MORPH_CORRESPONDENCE',message:error instanceof Error?error.message:String(error)}];
      diagnostics.push(...errors.map(d=>({...d,path:path+'.correspondence',...(d.sourceSpan?{}:span?{sourceSpan:span}:{})})));
    }
  });
  return {diagnostics,entries};
}

export function validateMorphProgram(input:unknown,bundle:Bundle):Diagnostic[]{return inspect(input,bundle).diagnostics;}
/** @internal Earlier scene programs and hierarchy have been validated. */
export function validateMorphProgramInContext(input:unknown,bundle:Bundle):Diagnostic[]{return inspect(input,bundle,true).diagnostics;}
export function prepareMorphProgram(input:MorphProgram,bundle:Bundle):PreparedMorphProgram {
  const checked=inspect(input,bundle);if(checked.diagnostics.some(d=>d.severity==='error'))throw new OperationValidationError(checked.diagnostics);
  const operations=checked.entries.map(({operation,path,correspondence}):PreparedMorph=>Object.freeze({
    operation,path,reads:freezeSnapshot([{node:operation.instance,property:'morphProgress'}]),writes:freezeSnapshot(morphWrites(operation.instance)),
    apply(nodes:Map<string,Node>){
      try{
        const progress=(nodes.get(operation.instance) as unknown as Obj).morphProgress;
        const sample=sampleCorrespondence(correspondence,progress),helpers=helperNames(operation.instance),endpoint=progress===0||progress===1;
        const assign=(id:string,geometry:DeepReadonly<PathGeometry>)=>{
          const target=nodes.get(id) as PathNode;target.geometry=structuredClone(geometry) as PathGeometry;
          target.d=pathGeometryData(target.geometry)||'M0 0';delete target.resolvedPath;
        };
        assign(helpers.shape,endpoint?sample.geometry:sample.matched);
        assign(helpers.leaving,endpoint?{contours:[]}:sample.sourceOnly);assign(helpers.entering,endpoint?{contours:[]}:sample.targetOnly);
        for(const [id,opacity,reveal] of [[helpers.leaving,sample.sourceOpacity,sample.sourceReveal],[helpers.entering,sample.targetOpacity,sample.targetReveal]] as const){
          const node=nodes.get(id) as PathNode;node.style={...node.style,opacity:endpoint?0:opacity};node.reveal=endpoint?0:reveal;
        }
        return freezeSnapshot({progress,correspondence:structuredClone(correspondence.report) as CorrespondenceReport});
      }catch(error){
        const errors=error instanceof OperationValidationError?error.diagnostics:[{severity:'error' as const,code:(error as {code?:string})?.code??'MORPH_EVALUATION',message:error instanceof Error?error.message:String(error)}];
        throw new OperationValidationError(errors.map(d=>({...d,path,...(d.sourceSpan?{}:operation.sourceSpan?{sourceSpan:structuredClone(operation.sourceSpan)}:{})})));
      }
    },
  }));
  return Object.freeze({operations:Object.freeze(operations)});
}
