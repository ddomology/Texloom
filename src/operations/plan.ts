import {assertBundle, BundleValidationError, type Bundle, type Camera, type Node, type Relation} from '../schema.js';
import {OperationValidationError, type Diagnostic, type LiteralValue, type Operation, type OperationBinding,
  type SourceSpan, type DeepReadonly} from '../ir/operations.js';
import {lowerRelations, type LoweredRelation} from '../ir/upgrade.js';
import {prepareOperationGraph} from './validate.js';
import {freezeSnapshot} from './values.js';
import {executeAuthoredOperation, requireAuthoredImplementation} from './builtins/authored.js';
import {executeLegacyOperation, type LegacyFrameContext} from './builtins/legacy.js';
import {applyOperationBinding} from './bindings.js';
import {bindingProperties, propertiesOverlap, transformReads, type PropertyAccess} from './properties.js';
import type {ExpressionValue} from '../fields/ast.js';
import {prepareExpressionProgram, evaluateExpressionBinding, type PreparedExpressionBinding} from '../fields/program.js';
import {prepareFieldProgram, type PreparedFieldProgram} from '../fields/program-fields.js';
import type {FieldEvaluation} from '../fields/types.js';
import {prepareDeformationProgram, type DeformationEvaluation} from './deform.js';
import {prepareOperationInputs,flattenOperationInputs,type PreparedOperationInputs} from './inputs.js';
import {isShapeOperator,type ShapeEvaluation} from './shapes.js';
import type {AnchorEvaluation} from './anchors.js';
import {isCurveOperator,type CurveEvaluation} from './curves.js';
import {isIntersectionOperator,type IntersectionEvaluation} from './intersections.js';
import {preparePlotProgram,type PlotEvaluation} from './plot.js';
import {prepareMorphProgram,type MorphEvaluation} from '../timeline/morph.js';

interface StepBase {
  id: string; path: string; sourceSpan?: DeepReadonly<SourceSpan>;
  dependencies: string[]; reads: PropertyAccess[]; writes: PropertyAccess[];
}
type Step = StepBase & ({kind:'relation'; lowered:LoweredRelation} |
  {kind:'operation'; operation:DeepReadonly<Operation>} | {kind:'binding'; binding:DeepReadonly<OperationBinding>} |
  {kind:'expression'; prepared:PreparedExpressionBinding} | {kind:'fields'} | {kind:'deformation'; index:number} | {kind:'plot';index:number} | {kind:'morph';index:number});
/** Optional frame metadata sink preserves the existing execute return contract. */
export interface ExecutionMetadata {deformations?:DeformationEvaluation;plots?:PlotEvaluation;morphs?:MorphEvaluation;shapes?:ShapeEvaluation;anchors?:AnchorEvaluation;curves?:CurveEvaluation;intersections?:IntersectionEvaluation}
export interface ExecutionPlan {
  readonly contract: 'texloom-execution/1';
  readonly order: readonly string[];
  /** Each execution receives new frame nodes/camera; no state survives this call. */
  execute(nodes: Map<string, Node>, resources: Bundle['resources'], camera: Camera, time:number, parameters?:Readonly<Record<string,ExpressionValue>>, metadata?:ExecutionMetadata): FieldEvaluation|undefined;
}

const operationID = (id: string) => JSON.stringify(['operation',id]);
const legacyParticipants = (r: Relation): string[] => r.type === 'pointOnEllipse' || r.type === 'attach' ? [r.target,r.source]
  : r.type === 'tangent' ? [r.target,r.source,r.point] : r.type === 'lineBetween' ? [r.target,r.a,r.b] : [];
function validateLegacyLocalTransforms(relation: Relation, nodes: ReadonlyMap<string, Node>): void {
  for (const id of legacyParticipants(relation)) {
    const transform = nodes.get(id)!.transform;
    if (transform && (transform.rotate !== undefined && transform.rotate !== 0 || transform.translate?.some(v => v !== 0) || transform.scale?.some(v => v !== 1)))
      throw new OperationValidationError([{severity:'error',code:'RELATION_LOCAL_TRANSFORM',message:`Legacy relation ${relation.type} requires identity local transform on ${id}; animate its shared parent instead.`}]);
  }
}

function diagnosticAt(error: unknown, step: Step): never {
  const diagnostics: Diagnostic[] = error instanceof OperationValidationError || error instanceof BundleValidationError
    ? error.diagnostics : [{severity:'error',code:'OPERATION_EXECUTION',message:error instanceof Error ? error.message : String(error)}];
  const prefix = step.kind === 'operation' ? `$.operations[${JSON.stringify(step.operation.id)}]` : undefined;
  const located = diagnostics.map(d => ({...d,
    path:prefix && d.path?.startsWith(prefix) ? step.path + d.path.slice(prefix.length) : d.path?.startsWith('$.operationGraph.') || d.path?.startsWith('$.fields.') || d.path?.startsWith('$.deformations.') || d.path?.startsWith('$.plots.') ? d.path : step.kind === 'expression' ? step.path + '.expression' : step.path,
    ...(d.sourceSpan ? {} : step.sourceSpan ? {sourceSpan:structuredClone(step.sourceSpan)} : {})}));
  if (error instanceof BundleValidationError) throw new BundleValidationError(located);
  throw new OperationValidationError(located);
}

/** Full deterministic evaluation plan; no dirty flags or temporal cache. */
export function prepareExecutionPlan(input: Bundle): ExecutionPlan {
  assertBundle(input);
  // Internal snapshots may contain functions only in the implementation closure;
  // portable inputs and graph metadata remain JSON and have detached ownership.
  const bundle = structuredClone(input);
  const nodes = new Map(bundle.nodes.map(n => [n.id,n]));
  const steps: Step[] = lowerRelations(bundle).map(lowered => ({...lowered,kind:'relation',lowered}));
  for (const step of steps) if (step.kind === 'relation') {
    for (const node of legacyParticipants(step.lowered.relation)) step.reads.push({node,property:'transform'});
  }
  const preparedGraph = bundle.operationGraph ? prepareOperationGraph(bundle.operationGraph,bundle) : undefined;
  const graph = preparedGraph?.graph;
  const operationInputs=new Map<string,PreparedOperationInputs>();
  for (const [index,operation] of (graph?.operations ?? []).entries()) {
    requireAuthoredImplementation(operation.operator,operation.version);
    const dependencies = [...new Set(flattenOperationInputs(operation.inputs).flatMap(input => input.kind === 'output' ? [operationID(input.ref.operation)] : []))];
    const inputs=prepareOperationInputs(operation,bundle,`$.operationGraph.operations[${index}]`,preparedGraph!.definitions);operationInputs.set(operation.id,inputs);
    steps.push({id:operationID(operation.id),path:`$.operationGraph.operations[${index}]`,sourceSpan:operation.sourceSpan,
      kind:'operation',operation,dependencies,reads:[...inputs.reads],writes:[]});
  }
  for (const [index,binding] of (graph?.bindings ?? []).entries()) {
    const reads = ['position','start','end'].includes(binding.property) ? transformReads(binding.target,nodes) : [];
    steps.push({id:`binding:${index}`,path:`$.operationGraph.bindings[${index}]`,sourceSpan:binding.sourceSpan,
      kind:'binding',binding,dependencies:[operationID(binding.value.operation)],reads,writes:bindingProperties(binding,nodes)});
  }
  const expressions = prepareExpressionProgram(bundle.expressions,bundle);
  for (const [index,prepared] of expressions.bindings.entries()) {
    const binding = prepared.binding;
    steps.push({id:`expression:${index}`,path:prepared.path,sourceSpan:binding.sourceSpan,kind:'expression',prepared,
      dependencies:[],reads:['position','start','end'].includes(binding.property) ? transformReads(binding.target,nodes) : [],writes:bindingProperties(binding,nodes)});
  }
  const fields:PreparedFieldProgram|undefined = bundle.fields ? prepareFieldProgram(bundle.fields,bundle) : undefined;
  if (fields) steps.push({id:'fields',path:'$.fields',kind:'fields',dependencies:[],reads:[...fields.reads],writes:[...fields.writes]});
  const deformations=bundle.deformations?prepareDeformationProgram(bundle.deformations,bundle):undefined;
  for(const [index,prepared] of (deformations?.operations??[]).entries())
    steps.push({id:`deformation:${index}`,path:prepared.path,sourceSpan:prepared.operation.sourceSpan,kind:'deformation',index,
      dependencies:[],reads:[...prepared.reads],writes:[...prepared.writes]});
  const plots=bundle.plots?preparePlotProgram(bundle.plots,bundle):undefined;
  for(const [index,prepared] of (plots?.operations??[]).entries())
    steps.push({id:`plot:${index}`,path:prepared.path,sourceSpan:prepared.operation.sourceSpan,kind:'plot',index,
      dependencies:prepared.dependencies.map(operationID),reads:[...prepared.reads],writes:[...prepared.writes]});
  const morphs=bundle.morphs?prepareMorphProgram(bundle.morphs,bundle):undefined;
  for(const [index,prepared] of (morphs?.operations??[]).entries())
    steps.push({id:`morph:${index}`,path:prepared.path,sourceSpan:prepared.operation.sourceSpan,kind:'morph',index,
      dependencies:[],reads:[...prepared.reads],writes:[...prepared.writes]});
  // Canonical property ownership catches whole-vs-component writers and joins
  // track, legacy and authored binding ownership without concatenating node IDs.
  const writers = bundle.tracks.map((track,index) => ({id:`track:${index}`,path:`$.tracks[${index}]`,
    writes:[{node:track.target,property:track.property}],sourceSpan:track.sourceSpan as DeepReadonly<SourceSpan>|undefined}));
  for (const step of steps) {
    for (const previous of writers) if (step.writes.some(a => previous.writes.some(b => propertiesOverlap(a,b))))
      throw new OperationValidationError([{severity:'error',code:'OPERATION_WRITER_CONFLICT',message:'Multiple execution steps write overlapping properties.',
        path:step.path,...(step.sourceSpan ? {sourceSpan:structuredClone(step.sourceSpan)} : {}),related:[{message:'Earlier writer.',path:previous.path,...(previous.sourceSpan?{sourceSpan:structuredClone(previous.sourceSpan)}:{})}]}]);
    writers.push({id:step.id,path:step.path,writes:step.writes,sourceSpan:step.sourceSpan});
  }
  // A consumer waits for every writer of a property it reads, including all
  // ancestors of matrices consumed by conversions and geometric relations.
  const byID = new Map(steps.map(step => [step.id,step]));
  for (const step of steps) {
    const dependencies = new Set(step.dependencies);
    for (const writer of steps) if (writer.id !== step.id && step.reads.some(read => writer.writes.some(write => propertiesOverlap(read,write))))
      dependencies.add(writer.id);
    step.dependencies = [...dependencies];
  }
  const pending = new Map(steps.map(s => [s.id,s.dependencies.length]));
  const consumers = new Map<string,string[]>();
  for (const step of steps) for (const dependency of step.dependencies) {
    if (!byID.has(dependency)) throw new OperationValidationError([{severity:'error',code:'OPERATION_PLAN_REFERENCE',message:`Missing execution step ${dependency}.`,path:step.path}]);
    consumers.set(dependency,[...(consumers.get(dependency) ?? []),step.id]);
  }
  // Original relation order breaks independent ties, retaining legacy arithmetic
  // sequencing. All required graph edges take precedence over source order.
  const rank = new Map(steps.map((step,index) => [step.id,index]));
  const ready = steps.filter(step => pending.get(step.id) === 0).map(s => s.id), order: string[] = [];
  while (ready.length) {
    const id = ready.shift()!; order.push(id);
    for (const consumer of consumers.get(id) ?? []) {
      pending.set(consumer,pending.get(consumer)! - 1);
      if (pending.get(consumer) === 0) {ready.push(consumer); ready.sort((a,b) => rank.get(a)!-rank.get(b)!);}
    }
  }
  if (order.length !== steps.length) {
    const blocked = steps.filter(step => pending.get(step.id)! > 0), first = blocked.find(s => s.sourceSpan) ?? blocked[0];
    throw new OperationValidationError([{severity:'error',code:'OPERATION_PLAN_CYCLE',message:`Dependency cycle blocks ${blocked.map(s => s.id).join(', ')}.`,path:first.path,
      ...(first.sourceSpan ? {sourceSpan:structuredClone(first.sourceSpan)} : {}),
      related:blocked.map(s => ({message:s.id,path:s.path,...(s.sourceSpan ? {sourceSpan:structuredClone(s.sourceSpan)} : {})}))}]);
  }
  const ordered = order.map(id => freezeSnapshot(byID.get(id)!));
  const hasShapes=graph?.operations.some(operation=>isShapeOperator(operation.operator,operation.version));
  const hasCurves=graph?.operations.some(operation=>isCurveOperator(operation.operator,operation.version));
  const hasIntersections=graph?.operations.some(operation=>isIntersectionOperator(operation.operator,operation.version));
  return Object.freeze({contract:'texloom-execution/1',order:Object.freeze(order),execute(frameNodes: Map<string,Node>,resources: Bundle['resources'],camera: Camera,time:number,overrides?:Readonly<Record<string,ExpressionValue>>,metadata?:ExecutionMetadata) {
    const parameters = expressions.resolveParameters(overrides);
    let fieldResult:FieldEvaluation|undefined;
    const deformationResults:Record<string,DeformationEvaluation[string]>=Object.create(null);
    const plotResults:Record<string,PlotEvaluation[string]>=Object.create(null);
    const morphResults:Record<string,MorphEvaluation[string]>=Object.create(null);
    const shapes:ShapeEvaluation={definitions:Object.create(null),approximations:Object.create(null)};
    const anchors:AnchorEvaluation=Object.create(null);
    const curves:CurveEvaluation={operations:Object.create(null),samples:Object.create(null)};
    const intersections:IntersectionEvaluation={sets:Object.create(null),selections:Object.create(null)};
    if(metadata){delete metadata.deformations;delete metadata.plots;delete metadata.morphs;delete metadata.shapes;delete metadata.anchors;delete metadata.curves;delete metadata.intersections;}
    const values = new Map<string,Record<string,LiteralValue>>();
    const context: LegacyFrameContext = {nodes:frameNodes,resources,samples:new Map()};
    for (const frozen of ordered) {
      const step = frozen as Step;
      try {
        if (step.kind === 'relation') {
          validateLegacyLocalTransforms(step.lowered.relation,frameNodes);
          executeLegacyOperation(step.lowered.relation,context);
        } else if (step.kind === 'operation') {
          const inputs=operationInputs.get(step.operation.id)!.resolve(frameNodes,time,parameters,values,anchors);
          values.set(step.operation.id,executeAuthoredOperation(step.operation,inputs,shapes,curves,intersections));
        } else if (step.kind === 'deformation') {
          const prepared=deformations!.operations[step.index];
          deformationResults[prepared.operation.id]=prepared.apply(frameNodes,time,parameters);
        } else if (step.kind === 'plot') {
          const prepared=plots!.operations[step.index];
          plotResults[prepared.operation.id]=prepared.apply(frameNodes,time,parameters,values,anchors);
        } else if (step.kind === 'morph') {
          const prepared=morphs!.operations[step.index];
          morphResults[prepared.operation.id]=prepared.apply(frameNodes);
        } else if (step.kind === 'fields') {
          fieldResult = fields!.sample(frameNodes,time,parameters);
          fields!.apply(fieldResult,frameNodes,camera);
        } else if (step.kind === 'expression') {
          const value = evaluateExpressionBinding(step.prepared,time,parameters), binding = step.prepared.binding;
          if (typeof value === 'boolean') frameNodes.get(binding.target)!.visible = value;
          else applyOperationBinding({...binding,value:{operation:'$expression',socket:'value'}},value,frameNodes,camera);
        } else applyOperationBinding(step.binding,values.get(step.binding.value.operation)![step.binding.value.socket],frameNodes,camera);
      } catch (error) {diagnosticAt(error,step);}
    }
    if(metadata&&deformations)metadata.deformations=freezeSnapshot(deformationResults);
    if(metadata&&plots)metadata.plots=freezeSnapshot(plotResults);
    if(metadata&&morphs)metadata.morphs=freezeSnapshot(morphResults);
    if(metadata&&hasShapes)metadata.shapes=structuredClone(shapes);
    if(metadata&&Object.keys(anchors).length)metadata.anchors=structuredClone(anchors);
    if(metadata&&hasCurves)metadata.curves=structuredClone(curves);
    if(metadata&&hasIntersections)metadata.intersections=structuredClone(intersections);
    return fieldResult;
  }});
}
