import type {Bundle, Node} from '../schema.js';
import {propertySpec, relationOutputs, validateBundle} from '../schema.js';
import {geometryPointSlot, parseGeometryProperty} from '../path-contract.js';
import {OperationValidationError, type Diagnostic, type LiteralValue, type DeepReadonly, type SpaceRef} from '../ir/operations.js';
import {freezeSnapshot, validateJsonData, validateSourceSpan} from '../operations/values.js';
import {bindingProperties, propertiesOverlap, type PropertyAccess} from '../operations/properties.js';
import type {CompiledExpression, ExpressionBinding, ExpressionProgram, ExpressionValue, ParameterDefinition, Unit, Dimension} from './ast.js';
import {compileExpression, evaluateExpression} from './scalar.js';
import {validateFieldProgramInContext} from './program-fields.js';
import {validateDeformationProgramInContext} from '../operations/deform.js';
import {validateOperationGraphInContext} from '../operations/validate.js';

type Obj = Record<string, any>;
const object = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (v: object,key:string) => Object.prototype.hasOwnProperty.call(v,key);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const reserved = new Set(['time','pi','true','false','vec2','sin','cos','dot','length','normalize','mask','if']);
const units: Unit[] = ['1','bp','s','rad'];
const dimension = (unit: Unit): Dimension => ({length:unit === 'bp' ? 1 : 0,time:unit === 's' ? 1 : 0,angle:unit === 'rad' ? 1 : 0});

export interface ExpressionDestination {
  kind:'scalar'|'boolean'|'vec2'; unit:Unit; role?:'point'|'vector'; space?:SpaceRef;
}
export interface PreparedExpressionBinding {
  readonly binding:DeepReadonly<ExpressionBinding>; readonly expression:CompiledExpression; readonly destination:DeepReadonly<ExpressionDestination>; readonly path:string;
}
export interface PreparedExpressionProgram {
  readonly bindings:readonly PreparedExpressionBinding[];
  resolveParameters(overrides?:Readonly<Record<string,ExpressionValue>>):Record<string,ExpressionValue>;
}

function destination(binding: ExpressionBinding,nodes: ReadonlyMap<string,Node>): ExpressionDestination | undefined {
  const n = nodes.get(binding.target), kind = binding.target === '$camera' ? 'camera' : n?.kind, p = binding.property;
  if (!kind) return;
  if (p === 'visible' && n) return {kind:'boolean',unit:'1'};
  if ((p === 'position' && ['point','tex','ellipse'].includes(kind)) || (['start','end'].includes(p) && kind === 'line'))
    return {kind:'vec2',unit:'bp',role:'point',space:{kind:'scene'}};
  const spec = propertySpec(kind,p);
  if (!spec) return;
  if (parseGeometryProperty(p)) {
    if (n?.kind !== 'path' || !geometryPointSlot(n.geometry,p)) return;
    return {kind:'vec2',unit:'bp',role:'point',space:{kind:'local',node:n.id}};
  }
  if (p === 'transform.translate') return {kind:'vec2',unit:'bp',role:'vector',space:n?.parent ? {kind:'local',node:n.parent} : {kind:'scene'}};
  if (p === 'transform.scale') return {kind:'vec2',unit:'1',role:'vector',space:{kind:'local',node:binding.target}};
  if (p === 'reveal' && (n?.kind !== 'path' || !n.geometry)) return;
  const unit: Unit = ['transform.rotate','rotation','phase'].includes(p) ? 'rad'
    : ['x','y','cx','cy','x1','x2','y1','y2','rx','ry','r','width','height','style.strokeWidth'].includes(p) ? 'bp' : '1';
  return {kind:'scalar',unit};
}

function valueMatches(value: unknown,definition: ParameterDefinition): boolean {
  if (definition.type === 'boolean') return typeof value === 'boolean';
  if (definition.type === 'vec2') return Array.isArray(value) && value.length === 2 && value.every(finite);
  return finite(value) && (definition.min === undefined || value >= definition.min) && (definition.max === undefined || value <= definition.max);
}

function inspect(input: unknown,bundle:Bundle,validatedContext=false):{diagnostics:Diagnostic[];bindings:PreparedExpressionBinding[]} {
  const diagnostics = validateJsonData(input,'$.expressions'), bindings: PreparedExpressionBinding[] = [];
  const fail = (code:string,message:string,path:string,binding?:ExpressionBinding,related?:Diagnostic['related']) => diagnostics.push({severity:'error',code,message,path,
    ...(binding?.sourceSpan ? {sourceSpan:binding.sourceSpan} : {}),...(related?.length ? {related} : {})});
  if (diagnostics.length) return {diagnostics,bindings};
  if (!object(bundle)) {fail('EXPRESSION_CONTEXT','Expected a scene bundle.','$'); return {diagnostics,bindings};}
  if (!validatedContext) {
    // Graph expression inputs, fields and deformations consume these candidate
    // parameters; defer them until the declarations have been checked.
    const {expressions:ignored,fields:deferredFields,deformations:deferredDeformations,operationGraph:deferredGraph,...base} = bundle;
    diagnostics.push(...validateBundle(base));
  }
  if (bundle.version !== '0.3') fail('EXPRESSION_BUNDLE_VERSION','Expression programs require Bundle 0.3.','$.version');
  if (diagnostics.some(d => d.severity === 'error')) return {diagnostics,bindings};
  const keys = (v:Obj,allowed:string[],path:string) => {
    for (const key of Object.keys(v)) if (!allowed.includes(key)) fail('EXPRESSION_FIELD',`Unknown field ${key}.`,path+'.'+key);
  };
  if (!object(input)) {fail('EXPRESSION_PROGRAM','Expected an expression program.','$.expressions'); return {diagnostics,bindings};}
  keys(input,['version','parameters','bindings'],'$.expressions');
  if (input.version !== 1) fail('EXPRESSION_VERSION','Supported expression program version is 1.','$.expressions.version');
  if (!object(input.parameters)) fail('EXPRESSION_PARAMETERS','Expected a parameter dictionary.','$.expressions.parameters');
  else for (const [name,value] of Object.entries(input.parameters)) {
    const path = '$.expressions.parameters.'+name;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || reserved.has(name)) fail('EXPRESSION_PARAMETER_NAME',`Invalid or reserved parameter name ${name}.`,path);
    if (!object(value)) {fail('EXPRESSION_PARAMETER','Expected a parameter declaration.',path); continue;}
    keys(value,['type','unit','default','min','max'],path);
    if (!['scalar','boolean','vec2'].includes(value.type)) fail('EXPRESSION_PARAMETER_TYPE','Expected scalar, boolean or vec2.',path+'.type');
    if (value.unit !== undefined && (!units.includes(value.unit) || value.type === 'boolean')) fail('EXPRESSION_PARAMETER_UNIT','Numeric parameters use 1, bp, s or rad; booleans have no unit.',path+'.unit');
    for (const key of ['min','max']) if (value[key] !== undefined && (value.type !== 'scalar' || !finite(value[key]))) fail('EXPRESSION_PARAMETER_RANGE','Only scalar parameters have finite min/max bounds.',path+'.'+key);
    if (finite(value.min) && finite(value.max) && value.min > value.max) fail('EXPRESSION_PARAMETER_RANGE','min must not exceed max.',path);
    if (!valueMatches(value.default,value as ParameterDefinition)) fail('EXPRESSION_PARAMETER_DEFAULT','Default must match the declared type and bounds.',path+'.default');
  }
  if (!Array.isArray(input.bindings)) fail('EXPRESSION_BINDINGS','Expected expression bindings array.','$.expressions.bindings');
  if (diagnostics.some(d => d.severity === 'error')) return {diagnostics,bindings};
  if(!validatedContext&&bundle.operationGraph!==undefined){
    diagnostics.push(...validateOperationGraphInContext(bundle.operationGraph,{...bundle,expressions:input as ExpressionProgram}));
    if(diagnostics.some(d=>d.severity==='error'))return {diagnostics,bindings};
  }
  const nodes = new Map(bundle.nodes.map(n => [n.id,n]));
  const writers:{slots:PropertyAccess[];path:string}[] = [
    ...bundle.tracks.map((t,i) => ({slots:[{node:t.target,property:t.property}],path:`$.tracks[${i}]`})),
    ...bundle.relations.map((r,i) => ({slots:relationOutputs(r).map(property => ({node:r.target,property})),path:`$.relations[${i}]`})),
    ...(bundle.operationGraph?.bindings ?? []).map((b,i) => ({slots:bindingProperties(b,nodes),path:`$.operationGraph.bindings[${i}]`})),
  ];
  input.bindings.forEach((raw:unknown,index:number) => {
    const path = `$.expressions.bindings[${index}]`;
    if (!object(raw)) {fail('EXPRESSION_BINDING','Expected an expression binding.',path); return;}
    keys(raw,['target','property','expression','sourceSpan'],path);
    if (raw.sourceSpan !== undefined) {
      const errors = validateSourceSpan(raw.sourceSpan,path+'.sourceSpan'); diagnostics.push(...errors); if (errors.length) return;
    }
    const binding = raw as ExpressionBinding;
    if (typeof binding.target !== 'string' || typeof binding.property !== 'string') {fail('EXPRESSION_TARGET','Target and property must be strings.',path); return;}
    const expected = destination(binding,nodes);
    if (!expected) {fail('EXPRESSION_TARGET',`Unsupported expression target ${binding.target}.${binding.property}.`,path,binding); return;}
    if (typeof binding.expression !== 'string') {fail('EXPRESSION_TEXT','Expected an expression string.',path+'.expression',binding); return;}
    try {
      const expression = compileExpression(binding.expression,input.parameters,binding.sourceSpan);
      if (expression.type.kind !== expected.kind) fail('EXPRESSION_BINDING_TYPE',`Expected ${expected.kind}, received ${expression.type.kind}.`,path+'.expression',binding);
      else if (expression.type.kind !== 'boolean') {
        const wanted = dimension(expected.unit), actual = expression.type.dimension;
        if (wanted.length !== actual.length || wanted.time !== actual.time || wanted.angle !== actual.angle)
          fail('EXPRESSION_BINDING_UNIT',`Binding requires ${expected.unit} units.`,path+'.expression',binding);
      }
      bindings.push({binding:freezeSnapshot(binding),expression,destination:expected,path});
    } catch (error) {
      if (!(error instanceof OperationValidationError)) throw error;
      diagnostics.push(...error.diagnostics.map(d => ({...d,path:path+'.expression'})));
    }
    const slots = bindingProperties(binding,nodes);
    for (const writer of writers) if (slots.some(a => writer.slots.some(b => propertiesOverlap(a,b))))
      fail('EXPRESSION_WRITER_CONFLICT',`Multiple writers overlap ${binding.target}.${binding.property}.`,path,binding,[{message:'Earlier writer.',path:writer.path}]);
    writers.push({slots,path});
  });
  if (!validatedContext && bundle.fields && !diagnostics.some(d => d.severity === 'error'))
    diagnostics.push(...validateFieldProgramInContext(bundle.fields,{...bundle,expressions:input as ExpressionProgram}));
  if (!validatedContext && bundle.deformations && !diagnostics.some(d => d.severity === 'error'))
    diagnostics.push(...validateDeformationProgramInContext(bundle.deformations,{...bundle,expressions:input as ExpressionProgram}));
  return {diagnostics,bindings};
}

export function validateExpressionProgram(program:unknown,bundle:Bundle):Diagnostic[] {return inspect(program,bundle).diagnostics;}
/** @internal Base bundle, graph and warnings have already been validated. */
export function validateExpressionProgramInContext(program:unknown,bundle:Bundle):Diagnostic[] {return inspect(program,bundle,true).diagnostics;}

export function prepareExpressionProgram(program:ExpressionProgram|undefined,bundle:Bundle):PreparedExpressionProgram {
  const checked = program ? inspect(program,bundle) : {diagnostics:[],bindings:[]};
  if (checked.diagnostics.some(d => d.severity === 'error')) throw new OperationValidationError(checked.diagnostics);
  const definitions = freezeSnapshot(program?.parameters ?? {});
  return Object.freeze({bindings:freezeSnapshot(checked.bindings),resolveParameters(overrides:Readonly<Record<string,ExpressionValue>> = {}) {
    const diagnostics = validateJsonData(overrides,'$.parameters');
    if (!object(overrides)) diagnostics.push({severity:'error',code:'EXPRESSION_PARAMETER_OVERRIDES',message:'Expected a parameter override dictionary.',path:'$.parameters'});
    if (diagnostics.length) throw new OperationValidationError(diagnostics);
    for (const name of Object.keys(overrides)) if (!own(definitions,name)) diagnostics.push({severity:'error',code:'EXPRESSION_PARAMETER_UNKNOWN',message:`Unknown parameter ${name}.`,path:'$.parameters.'+name});
    const values:Record<string,ExpressionValue> = Object.create(null);
    for (const [name,definition] of Object.entries(definitions)) {
      const value = own(overrides,name) ? overrides[name] : definition.default;
      if (!valueMatches(value,definition as ParameterDefinition)) diagnostics.push({severity:'error',code:'EXPRESSION_PARAMETER_VALUE',message:`Parameter ${name} violates its type or bounds.`,path:'$.parameters.'+name});
      else values[name] = structuredClone(value) as ExpressionValue;
    }
    if (diagnostics.length) throw new OperationValidationError(diagnostics);
    return values;
  }});
}

/** Resolve one expression to the same typed values used by operation bindings. */
export function evaluateExpressionBinding(prepared:PreparedExpressionBinding,time:number,parameters:Record<string,ExpressionValue>):LiteralValue|boolean {
  const value = evaluateExpression(prepared.expression,{time,parameters}), type = prepared.destination;
  if (type.kind === 'boolean') return value as boolean;
  if (type.kind === 'scalar') return {type:'scalar',value:value as number};
  return {type:'vec2',role:type.role!,space:structuredClone(type.space!),value:value as [number,number]};
}
