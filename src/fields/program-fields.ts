import {validateBundle, relationOutputs, type Bundle, type Node, type PathNode, type Camera} from '../schema.js';
import {OperationValidationError, type Diagnostic, type DeepReadonly} from '../ir/operations.js';
import {freezeSnapshot, validateJsonData, validateSourceSpan} from '../operations/values.js';
import {bindingProperties, propertiesOverlap, transformReads, type PropertyAccess} from '../operations/properties.js';
import {applyOperationBinding} from '../operations/bindings.js';
import {worldMatrix, transformPoint} from '../geometry.js';
import type {ExpressionType, ExpressionValue} from './ast.js';
import type {FieldProgram, FieldOperation, FieldBinding, FieldContext, FieldAttribute, FieldEvaluation} from './types.js';
import {createFieldContext} from './context.js';
import {compileFieldExpression, evaluateFieldExpression, type CompiledFieldExpression} from './evaluate.js';
import {captureAttribute, setFieldPositions} from '../operations/attributes.js';
import {validateDeformationProgramInContext} from '../operations/deform.js';

type Obj = Record<string, any>;
const object = (v:unknown):v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const name = (v:unknown):v is string => typeof v === 'string' && v.length > 0 && v.trim() === v;
const reserved = new Set(['time','pi','true','false','position','originalPosition','index','count','parameter',
  'vec2','sin','cos','dot','length','normalize','mask','if']);
const numericType = (type:DeepReadonly<ExpressionType>,kind:'scalar'|'vec2',length:number) => type.kind === kind &&
  type.dimension.length === length && type.dimension.time === 0 && type.dimension.angle === 0;

/** Call only for a validated program; used by every public ownership boundary. */
export function fieldBindingProperties(program:FieldProgram,nodes:ReadonlyMap<string,Node>):PropertyAccess[] {
  return program.bindings.flatMap(binding => binding.targets.flatMap(target =>
    bindingProperties({target:target.target,property:binding.property},nodes)));
}

interface CompiledOperation {operation:DeepReadonly<FieldOperation>; expression:CompiledFieldExpression; path:string}
interface Inspection {diagnostics:Diagnostic[]; operations:CompiledOperation[]}
function inspect(input:unknown,bundle:Bundle,validatedContext=false):Inspection {
  const diagnostics = validateJsonData(input,'$.fields'), operations:CompiledOperation[] = [];
  const fail = (code:string,message:string,path:string,source?:{sourceSpan?:FieldOperation['sourceSpan']},related?:Diagnostic['related']) =>
    diagnostics.push({severity:'error',code,message,path,...(source?.sourceSpan ? {sourceSpan:source.sourceSpan} : {}),...(related ? {related} : {})});
  if (diagnostics.length) return {diagnostics,operations};
  if (!object(bundle)) {fail('FIELD_CONTEXT','Expected a scene bundle.','$'); return {diagnostics,operations};}
  if (!validatedContext) {
    const {fields:ignored,deformations:deferredDeformations,...base} = bundle;
    diagnostics.push(...validateBundle(base));
  }
  if (bundle.version !== '0.3') fail('FIELD_BUNDLE_VERSION','Field programs require Bundle 0.3.','$.version');
  if (diagnostics.some(d => d.severity === 'error')) return {diagnostics,operations};
  const keys = (value:Obj,allowed:string[],path:string) => {
    for (const key of Object.keys(value)) if (!allowed.includes(key)) fail('FIELD_PROPERTY',`Unknown field ${key}.`,path+'.'+key);
  };
  const located = (error:unknown,path:string,source?:FieldOperation|FieldBinding) => {
    if (error instanceof OperationValidationError) diagnostics.push(...error.diagnostics.map(d => ({...d,path,
      ...(d.sourceSpan ? {} : source?.sourceSpan ? {sourceSpan:source.sourceSpan} : {})})));
    else fail('FIELD_CONTEXT',error instanceof Error ? error.message : String(error),path,source);
  };
  if (!object(input)) {fail('FIELD_PROGRAM','Expected a field program.','$.fields'); return {diagnostics,operations};}
  keys(input,['version','domains','operations','bindings'],'$.fields');
  if (input.version !== 1) fail('FIELD_VERSION','Supported field program version is 1.','$.fields.version');
  for (const key of ['domains','operations','bindings']) if (!Array.isArray(input[key])) fail('FIELD_ARRAY',`Expected ${key} array.`,'$.fields.'+key);
  if (diagnostics.some(d => d.severity === 'error')) return {diagnostics,operations};
  if (input.domains.length > 256 || input.operations.length > 4096 || input.bindings.length > 4096) {
    fail('FIELD_LIMIT','Field program exceeds 256 domains or 4096 operations/bindings.','$.fields'); return {diagnostics,operations};
  }
  const nodes = new Map(bundle.nodes.map(n => [n.id,n]));
  const domains = new Map<string,DeepReadonly<FieldContext>>();
  input.domains.forEach((raw:unknown,index:number) => {
    const path = `$.fields.domains[${index}]`;
    if (!object(raw)) {fail('FIELD_DOMAIN','Expected a domain declaration.',path); return;}
    keys(raw,['id','geometry','domain','samples'],path);
    if (!name(raw.id) || domains.has(raw.id)) {fail('FIELD_DOMAIN_ID','Domain IDs must be nonempty and unique.',path+'.id'); return;}
    if (Array.isArray(raw.samples)) {
      if (raw.samples.length > 65536) {fail('FIELD_LIMIT','A domain supports at most 65536 samples.',path+'.samples'); return;}
      raw.samples.forEach((sample:unknown,j:number) => {
        if (object(sample)) keys(sample,['id','parameter'],path+`.samples[${j}]`);
      });
    }
    const node = nodes.get(raw.geometry);
    if (node?.kind !== 'path' || !node.geometry) {fail('FIELD_GEOMETRY','Domain requires an editable path node.',path+'.geometry'); return;}
    try {domains.set(raw.id,createFieldContext(raw as any,node.geometry,node.geometry,0));}
    catch (error) {located(error,path);}
  });
  const types:Record<string,ExpressionType> = Object.create(null), owners = new Map<string,string>();
  const parameters = bundle.expressions?.parameters ?? {}, ids = new Set<string>();
  input.operations.forEach((raw:unknown,index:number) => {
    const path = `$.fields.operations[${index}]`;
    if (!object(raw)) {fail('FIELD_OPERATION','Expected a field operation.',path); return;}
    keys(raw,['id','domain','kind','expression','position','sourceSpan'],path);
    if (raw.sourceSpan !== undefined) {
      const errors = validateSourceSpan(raw.sourceSpan,path+'.sourceSpan'); diagnostics.push(...errors); if (errors.length) return;
    }
    const operation = raw as FieldOperation;
    if (typeof raw.id !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(raw.id) || reserved.has(raw.id) ||
      Object.hasOwn(parameters,raw.id) || ids.has(raw.id)) {fail('FIELD_OPERATION_ID','Operation ID must be a unique nonreserved variable name.',path+'.id',operation); return;}
    ids.add(raw.id);
    if (!domains.has(raw.domain)) {fail('FIELD_DOMAIN_REFERENCE','Unknown field domain.',path+'.domain',operation); return;}
    if (!['capture','evaluate','setPosition'].includes(raw.kind)) {fail('FIELD_OPERATION_KIND','Expected capture, evaluate or setPosition.',path+'.kind',operation); return;}
    if (raw.position !== undefined && !['current','original'].includes(raw.position)) {fail('FIELD_POSITION','Position source must be current or original.',path+'.position',operation); return;}
    if (typeof raw.expression !== 'string') {fail('FIELD_EXPRESSION','Expected a literal expression string.',path+'.expression',operation); return;}
    try {
      const expression = compileFieldExpression(raw.expression,parameters,types,raw.sourceSpan);
      for (const reference of Object.keys(expression.parameterTypes)) if (owners.has(reference) && owners.get(reference) !== raw.domain)
        fail('FIELD_DOMAIN_MISMATCH',`Attribute ${reference} belongs to another domain; an explicit domain conversion is required.`,path+'.expression',operation);
      if (raw.kind === 'setPosition' && !numericType(expression.type,'vec2',1))
        fail('FIELD_POSITION_TYPE','setPosition requires a vec2 in bp.',path+'.expression',operation);
      types[raw.id] = structuredClone(expression.type) as ExpressionType; owners.set(raw.id,raw.domain);
      operations.push({operation:freezeSnapshot(operation),expression,path});
    } catch (error) {located(error,path+'.expression',operation);}
  });
  const writers:{slots:PropertyAccess[];path:string}[] = [
    ...bundle.tracks.map((t,i) => ({slots:[{node:t.target,property:t.property}],path:`$.tracks[${i}]`})),
    ...bundle.relations.map((r,i) => ({slots:relationOutputs(r).map(property => ({node:r.target,property})),path:`$.relations[${i}]`})),
    ...(bundle.operationGraph?.bindings ?? []).map((b,i) => ({slots:bindingProperties(b,nodes),path:`$.operationGraph.bindings[${i}]`})),
    ...(bundle.expressions?.bindings ?? []).map((b,i) => ({slots:bindingProperties(b,nodes),path:`$.expressions.bindings[${i}]`})),
  ];
  input.bindings.forEach((raw:unknown,index:number) => {
    const path = `$.fields.bindings[${index}]`;
    if (!object(raw)) {fail('FIELD_BINDING','Expected a field binding.',path); return;}
    keys(raw,['domain','field','property','targets','ramp','sourceSpan'],path);
    if (raw.sourceSpan !== undefined) {
      const errors = validateSourceSpan(raw.sourceSpan,path+'.sourceSpan'); diagnostics.push(...errors); if (errors.length) return;
    }
    if (!name(raw.domain) || !name(raw.field) || !name(raw.property)) {
      fail('FIELD_BINDING_REFERENCE','Binding domain, field and property must be nonempty strings.',path); return;
    }
    const binding = raw as FieldBinding, context = domains.get(raw.domain), type = types[raw.field];
    if (!context || !type || owners.get(raw.field) !== raw.domain) {fail('FIELD_BINDING_DOMAIN','Binding field and domain must refer to the same declared domain.',path,binding); return;}
    const valid = raw.property === 'visible' ? type.kind === 'boolean' : raw.property === 'position' ? numericType(type,'vec2',1)
      : raw.property === 'r' ? numericType(type,'scalar',1) : ['style.fill','style.opacity'].includes(raw.property) && numericType(type,'scalar',0);
    if (!valid) {fail('FIELD_BINDING_TYPE','Property requires boolean visibility, bp position/radius or dimensionless color/opacity.',path,binding); return;}
    if (raw.property === 'style.fill') {
      if (!object(raw.ramp) || typeof raw.ramp.from !== 'string' || typeof raw.ramp.to !== 'string' ||
          !/^#[0-9a-f]{6}$/i.test(raw.ramp.from) || !/^#[0-9a-f]{6}$/i.test(raw.ramp.to))
        fail('FIELD_COLOR_RAMP','Color fields require a from/to #RRGGBB ramp.',path+'.ramp',binding);
      else keys(raw.ramp,['from','to'],path+'.ramp');
    } else if (raw.ramp !== undefined) fail('FIELD_COLOR_RAMP','A ramp applies only to style.fill.',path+'.ramp',binding);
    if (!Array.isArray(raw.targets) || !raw.targets.length || raw.targets.length > 65536) {fail('FIELD_TARGETS','Expected 1–65536 element-to-point targets.',path+'.targets',binding); return;}
    const elements = new Set(context.elements.map(e => e.id));
    raw.targets.forEach((target:unknown,j:number) => {
      const tp = path+`.targets[${j}]`;
      if (!object(target)) {fail('FIELD_TARGET','Expected an element/target pair.',tp,binding); return;}
      keys(target,['element','target'],tp);
      if (!elements.has(target.element) || nodes.get(target.target)?.kind !== 'point') {fail('FIELD_TARGET','Target must map an existing element ID to a point node.',tp,binding); return;}
      const slots = bindingProperties({target:target.target,property:raw.property},nodes);
      for (const writer of writers) if (slots.some(a => writer.slots.some(b => propertiesOverlap(a,b))))
        fail('FIELD_WRITER_CONFLICT','Multiple writers overlap a field binding.',tp,binding,[{message:'Earlier writer.',path:writer.path}]);
      writers.push({slots,path:tp});
    });
  });
  if (!validatedContext && bundle.deformations && !diagnostics.some(d => d.severity === 'error'))
    diagnostics.push(...validateDeformationProgramInContext(bundle.deformations,{...bundle,fields:input as FieldProgram}));
  return {diagnostics,operations};
}

export function validateFieldProgram(program:unknown,bundle:Bundle):Diagnostic[] {return inspect(program,bundle).diagnostics;}
/** @internal Prior scene, graph and expression validation has succeeded. */
export function validateFieldProgramInContext(program:unknown,bundle:Bundle):Diagnostic[] {return inspect(program,bundle,true).diagnostics;}

export interface PreparedFieldProgram {
  readonly reads:readonly PropertyAccess[]; readonly writes:readonly PropertyAccess[];
  sample(nodes:Map<string,Node>,time:number,parameters:Readonly<Record<string,ExpressionValue>>):FieldEvaluation;
  apply(result:FieldEvaluation,nodes:Map<string,Node>,camera:Camera):void;
}
export function prepareFieldProgram(input:FieldProgram,bundle:Bundle):PreparedFieldProgram {
  const checked = inspect(input,bundle);
  if (checked.diagnostics.some(d => d.severity === 'error')) throw new OperationValidationError(checked.diagnostics);
  const program = freezeSnapshot(input), operations = freezeSnapshot(checked.operations);
  const originals = new Map(program.domains.map(d => [d.id,freezeSnapshot((bundle.nodes.find(n => n.id === d.geometry) as PathNode).geometry!)]));
  const nodes = new Map(bundle.nodes.map(n => [n.id,n]));
  const reads:PropertyAccess[] = program.domains.flatMap(d => [{node:d.geometry,property:'geometry'},...transformReads(d.geometry,nodes)]);
  for (const binding of program.bindings) if (binding.property === 'position')
    for (const target of binding.targets) reads.push(...transformReads(target.target,nodes));
  return Object.freeze({reads:freezeSnapshot(reads),writes:freezeSnapshot(fieldBindingProperties(input,nodes)),
    sample(frameNodes:Map<string,Node>,time:number,parameters:Readonly<Record<string,ExpressionValue>>):FieldEvaluation {
      const contexts:Record<string,DeepReadonly<FieldContext>> = Object.create(null), attributes:Record<string,DeepReadonly<FieldAttribute>> = Object.create(null);
      for (const domain of program.domains) {
        try {contexts[domain.id] = createFieldContext(domain,originals.get(domain.id)!,(frameNodes.get(domain.geometry) as PathNode).geometry!,time);}
        catch (error) {throw locate(error,`$.fields.domains[${program.domains.indexOf(domain)}]`);}
      }
      for (const entry of operations) {
        const {operation,expression,path} = entry, context = contexts[operation.domain];
        try {
          const attribute = evaluateFieldExpression(expression,context,parameters,attributes,operation.position ?? 'current');
          attributes[operation.id] = captureAttribute(context,attribute);
          if (operation.kind === 'setPosition') contexts[operation.domain] = setFieldPositions(context,attribute);
        } catch (error) {throw locate(error,path+'.expression',operation.sourceSpan);}
      }
      return Object.freeze({contexts:freezeSnapshot(contexts),attributes:freezeSnapshot(attributes)});
    },
    apply(result:FieldEvaluation,frameNodes:Map<string,Node>,camera:Camera) {
      for (const [i,binding] of program.bindings.entries()) {
        const attribute = result.attributes[binding.field], source = attribute.geometry.id;
        try {
          for (const target of binding.targets) {
            const node = frameNodes.get(target.target)!, value = attribute.values[target.element];
            if (binding.property === 'visible') node.visible = value as boolean;
            else if (binding.property === 'style.fill') {node.style ??= {}; node.style.fill = rampColor(value as number,binding.ramp!);}
            else {
              const literal = binding.property === 'position' ? {type:'vec2' as const,role:'point' as const,space:{kind:'scene' as const},
                value:transformPoint(worldMatrix(source,frameNodes),[...(value as readonly [number,number])])}
                : {type:'scalar' as const,value:value as number};
              applyOperationBinding({target:target.target,property:binding.property,value:{operation:'$field',socket:binding.field}},literal,frameNodes,camera);
            }
          }
        } catch (error) {throw locate(error,`$.fields.bindings[${i}]`,binding.sourceSpan);}
      }
    },
  });
}
function rampColor(value:number,ramp:DeepReadonly<NonNullable<FieldBinding['ramp']>>):string {
  const t = Math.max(0,Math.min(1,value));
  return '#'+[1,3,5].map(i => Math.round((1-t)*parseInt(ramp.from.slice(i,i+2),16)+t*parseInt(ramp.to.slice(i,i+2),16)).toString(16).padStart(2,'0')).join('');
}
function locate(error:unknown,path:string,span?:DeepReadonly<FieldOperation['sourceSpan']>):OperationValidationError {
  const diagnostics:Diagnostic[] = error instanceof OperationValidationError ? error.diagnostics
    : [{severity:'error',code:'FIELD_EVALUATION',message:error instanceof Error ? error.message : String(error)}];
  return new OperationValidationError(diagnostics.map(d => ({...d,path,...(d.sourceSpan ? {} : span ? {sourceSpan:structuredClone(span)} : {})})));
}
