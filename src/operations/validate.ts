import type {Bundle} from '../schema.js';
import {propertySpec, relationOutputs, validateBundle} from '../schema.js';
import {geometryPointSlot, parseGeometryProperty} from '../path-contract.js';
import {OperationValidationError, type Diagnostic, type OperationGraph, type OperatorDefinition,
  type PreparedOperationGraph, type SourceSpan, type SpaceRef, type SocketType, type DeepReadonly} from '../ir/operations.js';
import {defaultOperatorRegistry, type OperatorRegistry} from './registry.js';
import {freezeSnapshot, validateJsonData, validateLiteralValue, validateSourceSpan, validateSpaceRef} from './values.js';
import {bindingProperties, propertiesOverlap} from './properties.js';
import {deformationWrites} from './deform.js';
import {validateDynamicInput,hasTransformWriter} from './inputs.js';
import {sameSpace} from '../geometry/spaces.js';
import type {Unit} from '../fields/ast.js';

type Obj = Record<string, any>;
type ResolvedType = {type: string; unit?:Unit; role?: string; space?: SpaceRef; from?: SpaceRef; to?: SpaceRef};
const object = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const named = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const own = (v: object, key: string) => Object.prototype.hasOwnProperty.call(v, key);

/** Validate a graph in a valid legacy scene context, without running any operator. */
function inspect(graph: unknown, bundle: Bundle, registry: OperatorRegistry, validatedContext = false): {diagnostics: Diagnostic[]; order: string[]} {
  const diagnostics = validateJsonData(graph, '$.operationGraph');
  const order: string[] = [];
  if (diagnostics.length) return {diagnostics, order};
  // Strip only the graph; validate every other scene field using the existing boundary.
  if (!object(bundle)) return {diagnostics: [{severity:'error',code:'OPERATION_CONTEXT',message:'Expected a scene bundle.',path:'$'}], order};
  if (!validatedContext) {
    const {operationGraph: ignored, ...base} = bundle;
    diagnostics.push(...validateBundle(base));
  }
  if (bundle.version !== '0.3') diagnostics.push({severity:'error',code:'OPERATION_BUNDLE_VERSION',message:'Operation graphs require bundle version 0.3.',path:'$.version'});
  if (diagnostics.some(d => d.severity === 'error')) return {diagnostics, order};
  const nodes = new Map(bundle.nodes.map(n => [n.id, n]));
  const error = (code: string, message: string, path: string, span?: SourceSpan, related?: Diagnostic['related']) => {
    diagnostics.push({severity:'error', code, message, path, ...(span ? {sourceSpan:span} : {}), ...(related?.length ? {related} : {})});
  };
  const keys = (v: Obj, allowed: string[], path: string, span?: SourceSpan) => {
    for (const key of Object.keys(v)) if (!allowed.includes(key)) error('OPERATION_FIELD', `Unknown field ${key}.`, `${path}.${key}`, span);
  };
  const source = (v: Obj, path: string): SourceSpan | undefined => {
    if (!own(v, 'sourceSpan')) return;
    const errors = validateSourceSpan(v.sourceSpan, path + '.sourceSpan');
    diagnostics.push(...errors);
    return errors.length ? undefined : v.sourceSpan;
  };
  const space = (v: unknown, path: string, span?: SourceSpan): v is SpaceRef => {
    const errors = validateSpaceRef(v, path);
    diagnostics.push(...errors.map(d => ({...d, ...(span ? {sourceSpan:span} : {})})));
    if (errors.length) return false;
    if ((v as SpaceRef).kind !== 'scene' && !nodes.has((v as {node:string}).node)) {
      error('OPERATION_SPACE_REFERENCE', `Missing local-space node ${(v as {node:string}).node}.`, path, span); return false;
    }
    if((v as SpaceRef).kind==='plot'&&nodes.get((v as {node:string}).node)?.kind!=='group'){
      error('OPERATION_PLOT_SPACE','Plot space requires a group node.',path,span);return false;
    }
    return true;
  };
  const valueSpaces = (v: Obj, path: string, span?: SourceSpan) => {
    if (['vec2','points2d','shape2d','path2d','intersections2d'].includes(v.type)) space(v.space, path + '.space', span);
    if (v.type === 'transform2d') {space(v.from, path + '.from', span); space(v.to, path + '.to', span);}
  };
  if (!object(graph)) {error('OPERATION_GRAPH', 'Expected an operation graph object.', '$.operationGraph'); return {diagnostics, order};}
  keys(graph, ['version','operations','bindings'], '$.operationGraph');
  if (graph.version !== 1) error('OPERATION_GRAPH_VERSION', 'Supported operation graph version is 1.', '$.operationGraph.version');
  if (!Array.isArray(graph.operations)) error('OPERATIONS_ARRAY', 'Expected an operations array.', '$.operationGraph.operations');
  if (!Array.isArray(graph.bindings)) error('OPERATION_BINDINGS', 'Expected a bindings array.', '$.operationGraph.bindings');
  if (!Array.isArray(graph.operations) || !Array.isArray(graph.bindings)) return {diagnostics, order};

  interface Entry {raw: Obj; path: string; span?: SourceSpan; definition?: DeepReadonly<OperatorDefinition>; spaces: Record<string, SpaceRef>}
  const entries = new Map<string, Entry>();
  const dependencies = new Map<string, Set<string>>();
  graph.operations.forEach((raw: unknown, index: number) => {
    const path = `$.operationGraph.operations[${index}]`;
    if (!object(raw)) {error('OPERATION_SHAPE', 'Expected an operation object.', path); return;}
    const span = source(raw, path);
    keys(raw, ['id','operator','version','spaces','inputs','sourceSpan'], path, span);
    if (!named(raw.id)) {error('OPERATION_ID', 'Expected a nonempty operation ID.', path + '.id', span); return;}
    if (entries.has(raw.id)) {error('OPERATION_DUPLICATE_ID', `Duplicate operation ID ${raw.id}.`, path + '.id', span); return;}
    const entry: Entry = {raw,path,span,spaces:Object.create(null)};
    entries.set(raw.id, entry); dependencies.set(raw.id, new Set());
    if (!named(raw.operator)) error('OPERATION_NAME', 'Expected an operator name.', path + '.operator', span);
    if (!Number.isSafeInteger(raw.version) || raw.version < 1) error('OPERATION_VERSION', 'An exact positive integer version is required.', path + '.version', span);
    else if (named(raw.operator)) {
      entry.definition = registry.get(raw.operator, raw.version);
      if (!entry.definition) error('OPERATION_UNKNOWN_OPERATOR', `No definition for ${raw.operator}@${raw.version}.`, path + '.operator', span);
    }
    if (!object(raw.inputs)) error('OPERATION_INPUTS', 'Expected a socket input dictionary.', path + '.inputs', span);
    if (!object(raw.spaces)) error('OPERATION_SPACES', 'Expected a space binding dictionary.', path + '.spaces', span);
    else {
      for (const [name,v] of Object.entries(raw.spaces)) {
        if (entry.definition && !entry.definition.spaces.includes(name)) error('OPERATION_SPACE_NAME', `Unknown space variable ${name}.`, path + '.spaces.' + name, span);
        if (space(v, path + '.spaces.' + name, span)) entry.spaces[name] = v;
      }
      for (const name of entry.definition?.spaces ?? []) if (!own(raw.spaces, name)) error('OPERATION_SPACE_REQUIRED', `Missing space variable ${name}.`, path + '.spaces.' + name, span);
    }
  });
  const resolveType = (socket: DeepReadonly<SocketType>, entry: Entry): ResolvedType | undefined => {
    if (socket.type === 'scalar') return {type:'scalar',...(socket.unit===undefined?{}:{unit:socket.unit})};
    if (socket.type === 'transform2d') {
      const from = entry.spaces[socket.from], to = entry.spaces[socket.to];
      return from && to ? {type:socket.type, from, to} : undefined;
    }
    const coordinateSpace = entry.spaces[socket.space];
    return coordinateSpace ? {type:socket.type, space:coordinateSpace, ...(socket.type === 'vec2' ? {role:socket.role} : {})} : undefined;
  };
  const output = (ref: unknown, path: string, span?: SourceSpan, consumer?: string): ResolvedType | undefined => {
    if (!object(ref)) {error('OPERATION_OUTPUT_REF', 'Expected {operation, socket}.', path, span); return;}
    keys(ref, ['operation','socket'], path, span);
    if (!named(ref.operation) || !named(ref.socket)) {error('OPERATION_OUTPUT_REF', 'Output references require an operation ID and socket name.', path, span); return;}
    const producer = entries.get(ref.operation);
    if (!producer) {error('OPERATION_MISSING_REFERENCE', `Missing operation ${ref.operation}.`, path + '.operation', span); return;}
    if (consumer) dependencies.get(consumer)!.add(ref.operation);
    if (!producer.definition) return;
    if (!own(producer.definition.outputs, ref.socket)) {
      error('OPERATION_OUTPUT_SOCKET', `No output socket ${ref.socket} on ${ref.operation}.`, path + '.socket', span,
        [{message:'Output producer.',path:producer.path,...(producer.span ? {sourceSpan:producer.span} : {})}]); return;
    }
    return resolveType(producer.definition.outputs[ref.socket], producer);
  };
  const compatible = (expected: ResolvedType | undefined, actual: ResolvedType | undefined, path: string, span?: SourceSpan) => {
    if (!expected || !actual) return;
    if (expected.type !== actual.type || expected.role !== actual.role) {
      error('OPERATION_TYPE_MISMATCH', `Expected ${expected.type}${expected.role ? ':' + expected.role : ''}; received ${actual.type}${actual.role ? ':' + actual.role : ''}.`, path, span); return;
    }
    if (!sameSpace(expected.space, actual.space) || !sameSpace(expected.from, actual.from) || !sameSpace(expected.to, actual.to))
      error('OPERATION_SPACE_MISMATCH', 'Coordinate spaces must match exactly; use an explicit transform operation.', path, span);
    if(expected.type==='scalar'&&expected.unit!==undefined&&expected.unit!==(actual.unit??'1'))
      error('OPERATION_UNIT_MISMATCH',`Expected scalar unit ${expected.unit}; received ${actual.unit??'1'}.`,path,span);
  };
  for (const [id, entry] of entries) {
    const {raw,path,span,definition} = entry;
    if (!definition || !object(raw.inputs)) continue;
    const resolveInput=(value:unknown,ip:string):ResolvedType|undefined=>{
      if (!object(value)) {error('OPERATION_INPUT_REF', 'Expected a typed input reference.', ip, span);return;}
      if(value.kind==='literal') {
        keys(value,['kind','value'],ip,span);
        const errors=validateLiteralValue(value.value,ip+'.value');
        diagnostics.push(...errors.map(d=>({...d,...(span?{sourceSpan:span}:{})})));
        if(!errors.length){valueSpaces(value.value,ip+'.value',span);return value.value;}
      }else if(value.kind==='output') {
        keys(value,['kind','ref'],ip,span);return output(value.ref,ip+'.ref',span,id);
      }else{
        const dynamic=validateDynamicInput(value,{...bundle,operationGraph:graph as unknown as OperationGraph},ip,span,resolveInput);
        diagnostics.push(...dynamic.diagnostics);return dynamic.type;
      }
    };
    for (const name of Object.keys(raw.inputs)) if (!own(definition.inputs, name)) error('OPERATION_INPUT_SOCKET', `Unknown input socket ${name}.`, path + '.inputs.' + name, span);
    for (const [name, socket] of Object.entries(definition.inputs)) {
      const ip = path + '.inputs.' + name;
      const value = own(raw.inputs, name) ? raw.inputs[name] : socket.default === undefined ? undefined : {kind:'literal',value:socket.default};
      if (value === undefined) {error('OPERATION_REQUIRED_INPUT', `Required input ${name} is missing.`, ip, span); continue;}
      const actual=resolveInput(value,ip);
      compatible(resolveType(socket.value, entry), actual, ip, span);
    }
  }

  interface Writer {target: string; slots: string[]; path: string; span?: SourceSpan}
  const writers: Writer[] = [];
  const inverseBindings = new Map<string, {path:string; span?:SourceSpan}>();
  bundle.tracks.forEach((t, i) => writers.push({target:t.target,slots:[t.property],path:`$.tracks[${i}]`}));
  bundle.relations.forEach((r, i) => writers.push({target:r.target,slots:relationOutputs(r),path:`$.relations[${i}]`}));
  // Standalone graph validation checked expressions in the graph-free base
  // above. Include their writers here. During full bundle validation the later
  // expression pass owns these cross-program conflicts, avoiding duplicates
  // and avoiding reads from an expression program that is not yet validated.
  if (!validatedContext) bundle.expressions?.bindings.forEach((binding, i) => writers.push({
    target:binding.target, slots:bindingProperties(binding,nodes).map(access => access.property),
    path:`$.expressions.bindings[${i}]`, ...(binding.sourceSpan ? {span:binding.sourceSpan} : {}),
  }));
  if (!validatedContext) bundle.fields?.bindings.forEach((binding,i) => binding.targets.forEach(target => writers.push({
    target:target.target, slots:bindingProperties({target:target.target,property:binding.property},nodes).map(access => access.property),
    path:`$.fields.bindings[${i}]`, ...(binding.sourceSpan ? {span:binding.sourceSpan} : {}),
  })));
  if (!validatedContext) bundle.deformations?.operations.forEach((operation,i) => writers.push({
    target:operation.target,slots:deformationWrites(operation.target).map(access=>access.property),
    path:`$.deformations.operations[${i}]`,...(operation.sourceSpan?{span:operation.sourceSpan}:{}),
  }));
  graph.bindings.forEach((raw: unknown, i: number) => {
    const path = `$.operationGraph.bindings[${i}]`;
    if (!object(raw)) {error('OPERATION_BINDING', 'Expected an output binding.', path); return;}
    const span = source(raw, path);
    keys(raw, ['target','property','value','sourceSpan'], path, span);
    let actual = output(raw.value, path + '.value', span);
    const target = nodes.get(raw.target), kind = raw.target === '$camera' ? 'camera' : target?.kind;
    if (!named(raw.target) || !kind) {error('OPERATION_BINDING_TARGET', typeof raw.target==='string'?`Missing target ${raw.target}.`:'Target must be a node ID string or $camera.', path + '.target', span); return;}
    if (!named(raw.property)) {error('OPERATION_BINDING_PROPERTY', 'Expected a property name.', path + '.property', span); return;}
    const local: SpaceRef = {kind:'local',node:raw.target};
    const parent: SpaceRef = target?.parent ? {kind:'local',node:target.parent} : {kind:'scene'};
    let expected: ResolvedType | undefined;
    const slots = bindingProperties({target:raw.target,property:raw.property},nodes).map(access => access.property);
    if (raw.property === 'position' && ['point','tex','ellipse'].includes(kind)) {
      expected = {type:'vec2',role:'point',space:{kind:'scene'}};
      inverseBindings.set(raw.target, {path,span});
    } else if (['start','end'].includes(raw.property) && kind === 'line') {
      expected = {type:'vec2',role:'point',space:{kind:'scene'}};
      inverseBindings.set(raw.target, {path,span});
    } else if (raw.property === 'geometry' && kind === 'path') {
      expected = {type:'path2d',space:local};
    } else if (raw.property === 'transform' && kind !== 'camera') {
      expected = {type:'transform2d',from:local,to:parent};
      // The sink's own parent(node) chart is exactly its immediate parent.
      // Accept that explicit alias here without weakening graph socket-space
      // identity or accepting another node's coincident numeric transform.
      if(actual?.type==='transform2d'&&actual.to?.kind==='parent'&&actual.to.node===raw.target)
        actual={...actual,to:parent};
    } else {
      const spec = propertySpec(kind, raw.property);
      if (spec) {
        if (raw.property === 'transform.translate') expected = {type:'vec2',role:'vector',space:parent};
        else if (raw.property === 'transform.scale') expected = {type:'vec2',role:'vector',space:local};
        else if (parseGeometryProperty(raw.property)) {
          expected = {type:'vec2',role:'point',space:local};
          if (!target || target.kind !== 'path' || !geometryPointSlot(target.geometry, raw.property)) error('OPERATION_GEOMETRY_SLOT', 'Geometry control must name an existing authored control.', path + '.property', span);
        } else expected = {type:'scalar'};
        if (raw.property === 'reveal' && (target?.kind !== 'path' || !target.geometry)) error('OPERATION_GEOMETRY_REQUIRED', 'Reveal requires structured geometry.', path + '.property', span);
      }
    }
    if (!expected) {error('OPERATION_BINDING_PROPERTY', `Unsupported ${kind} binding ${raw.property}.`, path + '.property', span); return;}
    compatible(expected, actual, path + '.value', span);
    for (const previous of writers) if (slots.some(a => previous.slots.some(b => propertiesOverlap({node:raw.target,property:a},{node:previous.target,property:b}))))
      error('OPERATION_WRITER_CONFLICT', `Multiple writers overlap on ${raw.target}.${raw.property}.`, path, span,
        [{message:'Earlier writer.',path:previous.path,...(previous.span ? {sourceSpan:previous.span} : {})}]);
    writers.push({target:raw.target,slots,path,span});
  });

  // Scene-position sinks require an inverse target world matrix at execution.
  // Reject known impossible static/track transforms now; computed matrices will
  // additionally require runtime domain checks when execution is introduced.
  const inverseChain = new Map<string, {path:string; span?:SourceSpan}>();
  for (const [id, binding] of inverseBindings) {
    let current: string | undefined = id;
    while (current && !inverseChain.has(current)) {
      inverseChain.set(current, binding); current = nodes.get(current)?.parent;
    }
  }
  for (const [id,binding] of inverseChain) {
    if (nodes.get(id)?.transform?.scale?.some(v => v === 0)&&
        !hasTransformWriter(new Set([id]),{...bundle,operationGraph:graph as unknown as OperationGraph}))
      error('OPERATION_SINGULAR_SPACE', `Scene-position binding requires an invertible transform; ${id} has zero scale.`, binding.path, binding.span);
  }
  bundle.tracks.forEach((track,index) => {
    const binding = inverseChain.get(track.target);
    if (!binding || track.property !== 'transform.scale') return;
    const scales = track.keys.map(([,value]) => value as number[]);
    if (scales.some((value,i) => value.some((v,axis) => v === 0 || (i > 0 && track.interpolation !== 'step' && Math.sign(v) !== Math.sign(scales[i-1][axis])))))
      error('OPERATION_SINGULAR_SPACE', 'Scale track makes a scene-position inverse singular.', `$.tracks[${index}]`, binding.span,
        [{message:'Scene-position binding.',path:binding.path}]);
  });

  // Kahn's algorithm also detects disconnected/self cycles. No recursive stack limit.
  const pending = new Map([...dependencies].map(([id, deps]) => [id, deps.size]));
  const consumers = new Map<string, string[]>();
  for (const [id,deps] of dependencies) for (const producer of deps) consumers.set(producer, [...(consumers.get(producer) ?? []),id]);
  const ready = [...pending].filter(([,n]) => n === 0).map(([id]) => id).sort();
  while (ready.length) {
    const id = ready.shift()!; order.push(id);
    for (const consumer of consumers.get(id) ?? []) {
      pending.set(consumer, pending.get(consumer)! - 1);
      if (pending.get(consumer) === 0) {ready.push(consumer); ready.sort();}
    }
  }
  if (order.length !== entries.size) {
    const blocked = [...pending].filter(([,n]) => n > 0).map(([id]) => id).sort();
    const entry = entries.get(blocked[0])!;
    error('OPERATION_CYCLE', `A dependency cycle blocks: ${blocked.join(', ')}.`, entry.path, entry.span,
      blocked.map(id => ({message:`Blocked operation ${id}.`,path:entries.get(id)!.path,...(entries.get(id)!.span ? {sourceSpan:entries.get(id)!.span} : {})})));
  }
  return {diagnostics, order};
}

export function validateOperationGraph(graph: unknown, bundle: Bundle, registry: OperatorRegistry = defaultOperatorRegistry): Diagnostic[] {
  return inspect(graph, bundle, registry).diagnostics;
}

/** @internal The schema has already validated the scene, including its warnings. */
export function validateOperationGraphInContext(graph: unknown, bundle: Bundle): Diagnostic[] {
  return inspect(graph, bundle, defaultOperatorRegistry, true).diagnostics;
}

/** Own a frozen snapshot, resolve defaults and order dependencies. No execution/cache. */
export function prepareOperationGraph(graph: unknown, bundle: Bundle, registry: OperatorRegistry = defaultOperatorRegistry): PreparedOperationGraph {
  const {diagnostics, order} = inspect(graph, bundle, registry);
  if (diagnostics.some(d => d.severity === 'error')) throw new OperationValidationError(diagnostics);
  const prepared = structuredClone(graph) as OperationGraph;
  const definitions = new Map<string, DeepReadonly<OperatorDefinition>>();
  for (const operation of prepared.operations) {
    const definition = registry.get(operation.operator, operation.version)!;
    definitions.set(JSON.stringify([operation.operator,operation.version]), definition);
    for (const [name,input] of Object.entries(definition.inputs)) if (!own(operation.inputs, name) && input.default !== undefined)
      Object.defineProperty(operation.inputs, name, {value:{kind:'literal',value:structuredClone(input.default)},enumerable:true,writable:true,configurable:true});
  }
  return freezeSnapshot({contract:'texloom-operations/1' as const,graph:prepared,order,definitions:[...definitions.values()]});
}
