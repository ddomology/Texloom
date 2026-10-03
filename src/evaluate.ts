import type {Bundle, Camera, EvaluatedFrame, FieldNode, Node, PathNode, ScalarFieldResource, Track, TrackValue} from './schema.js';
import {geometryPointSlot} from './path-contract.js';
import {pathGeometryData, revealGeometry, type PathPoint} from './path-geometry.js';
import {prepareExecutionPlan, type ExecutionPlan, type ExecutionMetadata} from './operations/plan.js';
import {withPathContext} from './operations/builtins/legacy.js';
import type {ExpressionValue} from './fields/ast.js';
import {createArrowGeometry,ARROW_DEFAULTS,type ArrowGeometryResult} from './geometry/arrowheads.js';
import {OperationValidationError} from './ir/operations.js';
import {evaluateTrack} from './timeline/track.js';
import {assertBundle} from './schema.js';
import {prepareTraceProgram,type PreparedTraceProgram} from './timeline/trace.js';
import {preparePresentationProgram,type PreparedPresentationProgram} from './ir/presentation-intent.js';
import {prepareSpace3DSampler} from './ir/scene3d.js';
import {prepareSurfaceProgram} from './operations/surface.js';
import {prepareCurveProgram3D} from './operations/curve3d.js';
import {prepareMeshAttributeProgram} from './operations/mesh-attributes.js';
import {prepareInstanceProgram} from './operations/instances.js';
import {prepareFieldVisualizationProgram} from './operations/field-visualization.js';
import {prepareSampledFieldProgram} from './operations/sampled-field.js';

/** Upper bound makes exact key times right-continuous, including step tracks. */
function interval(times: readonly number[], time: number): [number, number, number] {
  if (time <= times[0]) return [0, 0, 0];
  const last = times.length - 1;
  if (time >= times[last]) return [last, last, 0];
  let lo = 0, hi = times.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (times[mid] <= time) lo = mid + 1; else hi = mid; }
  const a = lo - 1, b = lo;
  return [a, b, (time - times[a]) / (times[b] - times[a])];
}
function mix(a: TrackValue, b: TrackValue, t: number): TrackValue {
  return typeof a === 'number' ? a + ((b as number) - a) * t : a.map((v, i) => v + ((b as number[])[i] - v) * t);
}
function setValue(target: Node | Camera, property: string, value: TrackValue): void {
  if(property.startsWith('geometry.')) {
    geometryPointSlot((target as PathNode).geometry,property)!.set(value as PathPoint);
    return;
  }
  const [head, tail] = property.split('.');
  const record = target as unknown as Record<string, any>;
  if (tail) { record[head] ??= {}; record[head][tail] = value; }
  else record[head] = value;
}
function sampleField(resource: ScalarFieldResource, time: number): number[] {
  const [a, b, t] = interval(resource.times, time);
  return mix(resource.samples[a], resource.samples[b], resource.interpolation === 'step' ? 0 : t) as number[];
}
function evaluatePrepared(bundle: Bundle, time: number, plan: ExecutionPlan, parameters?:Readonly<Record<string,ExpressionValue>>,traces?:PreparedTraceProgram,display=true,presentation?:PreparedPresentationProgram): EvaluatedFrame {
  if (!Number.isFinite(time)) throw new RangeError('Evaluation time must be finite.');
  const clamped = Math.max(0, Math.min(bundle.duration, time));
  const nodes = structuredClone(bundle.nodes), camera = structuredClone(bundle.camera);
  const byId = new Map(nodes.map(n => [n.id, n]));
  const arrowWriters=new Set([...bundle.tracks,...(bundle.operationGraph?.bindings??[]),...(bundle.expressions?.bindings??[])]
    .filter(b=>b.property.startsWith('arrows.')).map(b=>b.target));
  for(const node of nodes)if(node.kind==='path'&&(node.arrows!==undefined||arrowWriters.has(node.id)))
    node.arrows={...ARROW_DEFAULTS,...node.arrows};
  for (const track of bundle.tracks) setValue(track.target === '$camera' ? camera : byId.get(track.target)!, track.property, evaluateTrack(track, clamped));
  const metadata:ExecutionMetadata={};
  const fields = plan.execute(byId, bundle.resources, camera, clamped, parameters, metadata);
  if(traces)metadata.traces=traces.apply({time:clamped,viewport:bundle.viewport,camera,nodes,resources:bundle.resources},parameters);
  // Source probes need the executed scene state, not serialized display paths,
  // arrow tessellation or raster-field values. They reuse this same plan.
  if(!display)return {time:clamped,viewport:{...bundle.viewport},camera,nodes,resources:bundle.resources,...(fields?{fields}:{}),...metadata};
  for(const node of nodes) if(node.kind==='path'&&node.geometry) {
    // Full editable geometry survives reveal: dependent points keep sampling the
    // mathematical curve, while both renderers receive the same visible prefix.
    node.d=withPathContext(node.id,()=>pathGeometryData(node.reveal===undefined?node.geometry!:
      revealGeometry(node.geometry!,node.reveal,node.revealMode??'parameter',node.pathTolerance??.05)));
  }
  for(const node of nodes) if(node.kind==='path'&&(node.arrows!==undefined||node.geometry&&!node.resolvedPath&&(node.arrowStart||node.arrowEnd))) {
    try {
      if(!node.geometry)throw new Error('Arrow display requires editable path geometry.');
      if(node.arrows&&(node.arrowStart!==undefined||node.arrowEnd!==undefined||node.arrowSize!==undefined))
        throw new Error('Explicit arrows and legacy flags cannot be mixed.');
      const size=node.arrowSize??9;
      const options=node.arrows??{start:node.arrowStart?1:0,end:node.arrowEnd?1:0,length:size,width:size*.84,inset:0};
      const arrows=structuredClone(createArrowGeometry(node.geometry,options)) as ArrowGeometryResult;
      // Geometry read by labels and graph operations is never shortened. Reveal
      // affects the displayed shaft; the final tip appears at completed reveal.
      if(node.reveal!==undefined&&node.reveal<1){
        arrows.shaft=revealGeometry(arrows.shaft,node.reveal,node.revealMode??'parameter',node.pathTolerance??.05);
        arrows.endTip={contours:[]};if(node.reveal===0)arrows.startTip={contours:[]};
      }
      node.resolvedArrows=arrows;
    }catch(error){
      const source=bundle.operationGraph?.bindings.find(b=>b.target===node.id&&b.property.startsWith('arrows.')&&b.sourceSpan)?.sourceSpan
        ??bundle.expressions?.bindings.find(b=>b.target===node.id&&b.property.startsWith('arrows.')&&b.sourceSpan)?.sourceSpan;
      throw new OperationValidationError([{severity:'error',code:(error as {code?:string})?.code??'ARROW_DISPLAY',
        message:`Arrow path ${node.id}: ${error instanceof Error?error.message:String(error)}`,path:`$.nodes[${JSON.stringify(node.id)}].arrows`,
        ...(source?{sourceSpan:structuredClone(source)}:{})}]);
    }
  }
  for (const node of nodes) if (node.kind === 'field') (node as FieldNode).values = sampleField(bundle.resources[node.resourceId] as ScalarFieldResource, clamped);
  // Resources are immutable shared data; frame-local geometry and camera are independent.
  const frame:EvaluatedFrame={ time: clamped, viewport: { ...bundle.viewport }, camera, nodes, resources: bundle.resources,...(fields ? {fields} : {}),...metadata };
  if(presentation)frame.presentation=presentation.evaluate(frame);
  return frame;
}

/** Convenience evaluation at an absolute time. Treat returned resources as immutable. */
export function evaluate(bundle: Bundle, time: number, parameters?:Readonly<Record<string,ExpressionValue>>): EvaluatedFrame {
  return createEvaluator(bundle)(time,parameters);
}
function freezeDeep(value: any): void {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value); for (const child of Object.values(value)) freezeDeep(child);
  }
}
/** Validate and snapshot once for playback/export; seeking has no playback-history state. */
export function createEvaluator(bundle: Bundle): (time: number, parameters?:Readonly<Record<string,ExpressionValue>>) => EvaluatedFrame {
  assertBundle(bundle);
  const snapshot = structuredClone(bundle);
  freezeDeep(snapshot);
  return evaluatorFromSnapshot(snapshot);
}

/** Internal preparation boundary. AssetStore already owns and deeply freezes
 * these validated resources; retain their identity across independent scenes.
 * This is deliberately not part of the package's public exports. */
export function createEvaluatorWithSharedResources(bundle: Bundle): ReturnType<typeof createEvaluator> {
  assertBundle(bundle);
  const seen = new Set<object>();
  const deeplyFrozen = (value: unknown): boolean => {
    if (value === null || typeof value !== 'object' || seen.has(value)) return true;
    if (!Object.isFrozen(value)) return false;
    seen.add(value);
    return Object.values(value).every(deeplyFrozen);
  };
  if (!deeplyFrozen(bundle.resources))
    throw new Error('ASSET_OWNERSHIP: shared resources must be owned immutable snapshots.');
  const {resources, ...scene} = bundle;
  const snapshot: Bundle = {...structuredClone(scene), resources};
  freezeDeep(snapshot);
  return evaluatorFromSnapshot(snapshot);
}

function evaluatorFromSnapshot(snapshot: Bundle): ReturnType<typeof createEvaluator> {
  const {traces:input,...base}=snapshot;
  const plan=prepareExecutionPlan(base);
  const traces=input?prepareTraceProgram(input,snapshot,(time,parameters)=>evaluatePrepared(base,time,plan,parameters,undefined,false),plan.accesses):undefined;
  const presentation=snapshot.presentation?preparePresentationProgram(snapshot.presentation,snapshot):undefined;
  const surfaces=snapshot.surfaces?prepareSurfaceProgram(snapshot.surfaces,snapshot):undefined;
  const curves=snapshot.curves3d?prepareCurveProgram3D(snapshot.curves3d,snapshot):undefined;
  const attributes=snapshot.meshAttributes?prepareMeshAttributeProgram(snapshot.meshAttributes,snapshot,{...surfaces?.baseResources,...curves?.baseResources}):undefined;
  const sampledFields=snapshot.sampledFields?prepareSampledFieldProgram(snapshot.sampledFields,snapshot,{...surfaces?.baseResources,...curves?.baseResources,...attributes?.baseResources}):undefined;
  const fieldVisualization=snapshot.fieldVisualization?prepareFieldVisualizationProgram(snapshot.fieldVisualization,snapshot,{...surfaces?.baseResources,...curves?.baseResources,...attributes?.baseResources,...sampledFields?.baseResources}):undefined;
  const instances=snapshot.instances?prepareInstanceProgram(snapshot.instances,snapshot,{...surfaces?.baseResources,...curves?.baseResources,...attributes?.baseResources,...sampledFields?.baseResources,...fieldVisualization?.baseResources}):undefined;
  const spatialResources=surfaces||curves||attributes||sampledFields||fieldVisualization||instances?{...snapshot.resources,...surfaces?.baseResources,...curves?.baseResources,...attributes?.baseResources,...sampledFields?.baseResources,...fieldVisualization?.baseResources,...instances?.baseResources} as Bundle['resources']:snapshot.resources;
  const combineSets=(fields?:import('./operations/field-visualization.js').FieldVisualizationSample['instanceSets'],generic?:import('./operations/instances.js').InstanceProgramSample['instanceSets'])=>{
    if(!fields&&!generic)return undefined;const sets=fields&&generic?Object.freeze(Object.assign(Object.create(null),fields,generic)) as NonNullable<typeof fields>:fields??generic!;
    if(Object.values(sets).reduce((n,s)=>n+s.instances.length,0)>4096)throw new OperationValidationError([{severity:'error',code:'INSTANCE_BUDGET',message:'At most 4096 instances across field arrows and generic instance sets.'}]);return sets;
  };
  const baseSets=combineSets(fieldVisualization?.baseInstanceSets,instances?.baseInstanceSets);
  const space3d=snapshot.space3d?prepareSpace3DSampler(snapshot.space3d,spatialResources,{viewport:snapshot.viewport,duration:snapshot.duration},[...(surfaces?.resourceIds??[]),...(curves?.resourceIds??[]),...(attributes?.resourceIds??[]),...(sampledFields?.resourceIds??[]),...(fieldVisualization?.resourceIds??[]),...(instances?.resourceIds??[])],curves?.baseTransforms,baseSets):undefined;
  return (time,parameters) => {
    const frame=evaluatePrepared(base, time, plan, parameters,traces,true,presentation);
    const generated=surfaces?.sample(frame.time,parameters);
    const generatedCurves=curves?.sample(frame.time,parameters);
    const generatedAttributes=attributes?.sample(frame.time,parameters,{...generated?.resources,...generatedCurves?.resources});
    const generatedSampled=sampledFields?.sample(frame.time,parameters,{...generated?.resources,...generatedCurves?.resources,...generatedAttributes?.resources});
    const generatedFields=fieldVisualization?.sample(frame.time,parameters,{...generated?.resources,...generatedCurves?.resources,...generatedAttributes?.resources,...generatedSampled?.resources});
    const generatedInstances=instances?.sample(frame.time,parameters,{...generated?.resources,...generatedCurves?.resources,...generatedAttributes?.resources,...generatedSampled?.resources,...generatedFields?.resources});
    if(generated||generatedCurves||generatedAttributes||generatedSampled||generatedFields||generatedInstances)frame.resources=Object.freeze({...snapshot.resources,...generated?.resources,...generatedCurves?.resources,...generatedAttributes?.resources,...generatedSampled?.resources,...generatedFields?.resources,...generatedInstances?.resources}) as Bundle['resources'];
    if(generated)frame.surfaces=generated.surfaces;
    if(generatedCurves)frame.curves3d=generatedCurves.curves3d;
    if(generatedAttributes)frame.meshAttributes=generatedAttributes.meshAttributes;
    if(generatedSampled)frame.sampledFields=generatedSampled.sampledFields;
    if(generatedFields)frame.fieldVisualization=generatedFields.fieldVisualization;
    const instanceSets=combineSets(generatedFields?.instanceSets,generatedInstances?.instanceSets);if(instanceSets)frame.instanceSets=instanceSets;
    if(space3d)frame.space3d=space3d(frame.time,generated||generatedCurves||generatedAttributes||generatedSampled||generatedFields||generatedInstances?Object.fromEntries(Object.entries({...generated?.resources,...generatedCurves?.resources,...generatedAttributes?.resources,...generatedSampled?.resources,...generatedFields?.resources,...generatedInstances?.resources}).map(([id,r])=>[id,{bounds:r.bounds,topologyRevision:r.topologyRevision}])):undefined,generatedCurves?.transforms,instanceSets);
    return frame;
  };
}
