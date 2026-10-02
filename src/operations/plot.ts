import {validateBundle, relationOutputs, type Bundle, type Node, type PathNode} from '../schema.js';
import {OperationValidationError, type Diagnostic, type DeepReadonly, type SourceSpan, type SpaceRef,
  type InputRef, type LiteralValue, type Operation, type OperatorDefinition} from '../ir/operations.js';
import {freezeSnapshot, validateJsonData, validateSourceSpan} from './values.js';
import {bindingProperties, propertiesOverlap, type PropertyAccess} from './properties.js';
import {deformationWrites} from './deform.js';
import {prepareOperationInputs, flattenOperationInputs, type PreparedOperationInputs} from './inputs.js';
import {createOperatorRegistry, defaultOperatorRegistry} from './registry.js';
import {validateOperationGraphInContext} from './validate.js';
import {compileExpression, evaluateExpression} from '../fields/scalar.js';
import type {CompiledExpression, ExpressionType, ExpressionValue} from '../fields/ast.js';
import {createCartesianMapping, type CartesianConfig} from '../geometry/data-space.js';
import {pathGeometryData, transformGeometry, type PathPoint, type PathGeometry} from '../path-geometry.js';
import {adaptiveSampleCurve, areaBetweenCurves, sampledDataPlot, type SamplingReport} from '../geometry/adaptive-sampling.js';
import type {AnchorEvaluation} from './anchors.js';

export type PlotMode='function'|'parametric'|'samples'|'area';
export interface PlotOperation {
  id:string;target:string;mode:PlotMode;space:SpaceRef;inputs:Record<string,InputRef>;
  expression?:string;xExpression?:string;yExpression?:string;lower?:string;upper?:string;mask?:string;
  domains?:[number,number][];breaks?:number[];samples?:([number,number]|null)[];
  sourceSpan?:SourceSpan;expressionSpans?:Record<string,SourceSpan>;
}
export interface PlotProgram {version:1;operations:PlotOperation[]}
export type PlotEvaluation=Readonly<Record<string,DeepReadonly<SamplingReport>>>;
export interface PreparedPlot {
  readonly operation:DeepReadonly<PlotOperation>;readonly path:string;
  readonly reads:readonly PropertyAccess[];readonly writes:readonly PropertyAccess[];readonly dependencies:readonly string[];
  apply(nodes:Map<string,Node>,time:number,parameters:Readonly<Record<string,ExpressionValue>>,
    outputs:ReadonlyMap<string,Record<string,LiteralValue>>,anchors?:AnchorEvaluation):DeepReadonly<SamplingReport>;
}
export interface PreparedPlotProgram {readonly operations:readonly PreparedPlot[]}
const defaults={xScale:0,yScale:0,logBase:10,tolerance:.5,pixelsPerBp:1,initialSegments:16,maxDepth:16,maxSamples:16384,maxSegments:8192};
const bpKeys=new Set(['width','height']);
const scalar=(key:string,fallback?:number):OperatorDefinition['inputs'][string]=>({value:{type:'scalar',unit:bpKeys.has(key)?'bp':'1'},
  ...(fallback===undefined?{required:true}:{default:{type:'scalar',unit:bpKeys.has(key)?'bp':'1',value:fallback}})});
// This private metadata adapter reuses exactly the graph input contracts; plots
// themselves remain a portable expression program rather than an operator string.
const inputDefinition:OperatorDefinition={name:'$plotInputs',version:1,spaces:['space','target'],pure:true,deterministic:true,
  inputs:{origin:{value:{type:'vec2',role:'point',space:'space'},required:true},
    ...Object.fromEntries(['width','height','xMin','xMax','yMin','yMax'].map(k=>[k,scalar(k)])),
    ...Object.fromEntries(Object.entries(defaults).map(([k,v])=>[k,scalar(k,v)])),
    mapping:{value:{type:'transform2d',from:'space',to:'target'},required:true}},outputs:{unused:{type:'scalar',unit:'1'}}};
type Obj=Record<string,any>;
const object=(v:unknown):v is Obj=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const name=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.trim()===v;
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
interface Entry {operation:DeepReadonly<PlotOperation>;path:string;expressions:Record<string,CompiledExpression>;inputs:PreparedOperationInputs;dependencies:string[]}

function inspect(input:unknown,bundle:Bundle,validatedContext=false):{diagnostics:Diagnostic[];entries:Entry[]} {
  const diagnostics=validateJsonData(input,'$.plots'),entries:Entry[]=[];
  const fail=(code:string,message:string,path:string,span?:SourceSpan,related?:Diagnostic['related'])=>
    diagnostics.push({severity:'error',code,message,path,...(span?{sourceSpan:span}:{}),...(related?{related}:{})});
  if(diagnostics.length)return {diagnostics,entries};
  if(!object(bundle)){fail('PLOT_CONTEXT','Expected a scene bundle.','$');return {diagnostics,entries};}
  if(!validatedContext){const {plots:ignored,...base}=bundle;diagnostics.push(...validateBundle(base));}
  if(bundle.version!=='0.3')fail('PLOT_BUNDLE_VERSION','Plot programs require Bundle 0.3.','$.version');
  if(diagnostics.some(d=>d.severity==='error'))return {diagnostics,entries};
  const keys=(raw:Obj,allowed:string[],path:string)=>{for(const k of Object.keys(raw))if(!allowed.includes(k))fail('PLOT_PROPERTY',`Unknown property ${k}.`,path+'.'+k);};
  if(!object(input)){fail('PLOT_PROGRAM','Expected a plot program.','$.plots');return {diagnostics,entries};}
  keys(input,['version','operations'],'$.plots');
  if(input.version!==1)fail('PLOT_VERSION','Supported plot version is 1.','$.plots.version');
  if(!Array.isArray(input.operations)||input.operations.length>256){fail('PLOT_OPERATIONS','Expected at most 256 plots.','$.plots.operations');return {diagnostics,entries};}
  const nodes=new Map(bundle.nodes.map(n=>[n.id,n])),ids=new Set<string>();
  const writers:{slots:PropertyAccess[];path:string}[]=[
    ...bundle.tracks.map((t,i)=>({slots:[{node:t.target,property:t.property}],path:`$.tracks[${i}]`})),
    ...bundle.relations.map((r,i)=>({slots:relationOutputs(r).map(property=>({node:r.target,property})),path:`$.relations[${i}]`})),
    ...(bundle.operationGraph?.bindings??[]).map((b,i)=>({slots:bindingProperties(b,nodes),path:`$.operationGraph.bindings[${i}]`})),
    ...(bundle.expressions?.bindings??[]).map((b,i)=>({slots:bindingProperties(b,nodes),path:`$.expressions.bindings[${i}]`})),
    ...(bundle.fields?.bindings??[]).flatMap((b,i)=>b.targets.map(t=>({slots:bindingProperties({target:t.target,property:b.property},nodes),path:`$.fields.bindings[${i}]`}))),
    ...(bundle.deformations?.operations??[]).map((o,i)=>({slots:deformationWrites(o.target),path:`$.deformations.operations[${i}]`})),
  ];
  const registry=createOperatorRegistry([...structuredClone(defaultOperatorRegistry.list()) as OperatorDefinition[],inputDefinition]);
  input.operations.forEach((raw:unknown,index:number)=>{
    const path=`$.plots.operations[${index}]`,before=diagnostics.length;
    if(!object(raw)){fail('PLOT_OPERATION','Expected a plot operation.',path);return;}
    keys(raw,['id','target','mode','space','inputs','expression','xExpression','yExpression','lower','upper','mask','domains','breaks','samples','sourceSpan','expressionSpans'],path);
    if(raw.sourceSpan!==undefined){const errors=validateSourceSpan(raw.sourceSpan,path+'.sourceSpan');diagnostics.push(...errors);if(errors.length)return;}
    const span=raw.sourceSpan as SourceSpan|undefined;
    if(!name(raw.id)||ids.has(raw.id)){fail('PLOT_ID','Plot IDs must be unique nonempty strings.',path+'.id',span);return;}ids.add(raw.id);
    if(!name(raw.target)||nodes.get(raw.target)?.kind!=='path'||!(nodes.get(raw.target) as PathNode)?.geometry){fail('PLOT_TARGET','Plot target must be an editable path.',path+'.target',span);return;}
    if(!['function','parametric','samples','area'].includes(raw.mode)){fail('PLOT_MODE','Expected function, parametric, samples or area.',path+'.mode',span);return;}
    const expressionNames=raw.mode==='function'?['expression']:raw.mode==='parametric'?['xExpression','yExpression']:raw.mode==='area'?['lower','upper']:[];
    for(const key of ['expression','xExpression','yExpression','lower','upper']) {
      if(expressionNames.includes(key)&&typeof raw[key]!=='string')fail('PLOT_EXPRESSION',`Missing ${key} expression.`,path+'.'+key,span);
      if(!expressionNames.includes(key)&&raw[key]!==undefined)fail('PLOT_MODE_PROPERTY',`${key} is not available in ${raw.mode} mode.`,path+'.'+key,span);
    }
    if(raw.mode==='samples'){
      for(const key of ['domains','breaks','mask'])if(raw[key]!==undefined)fail('PLOT_MODE_PROPERTY',`${key} is not available for samples.`,path+'.'+key,span);
      if(!Array.isArray(raw.samples)||raw.samples.length<2||raw.samples.length>65536||raw.samples.some((p:unknown)=>p!==null&&(!Array.isArray(p)||p.length!==2||!p.every(finite))))
        fail('PLOT_SAMPLES','Expected 2..65536 finite data pairs or null gaps.',path+'.samples',span);
    }else{
      if(raw.samples!==undefined)fail('PLOT_MODE_PROPERTY','samples belong to samples mode.',path+'.samples',span);
      if(!Array.isArray(raw.domains)||!raw.domains.length||raw.domains.length>128||raw.domains.some((d:unknown,i:number)=>!Array.isArray(d)||d.length!==2||!d.every(finite)||d[0]>=d[1]||i>0&&raw.domains[i-1][1]>d[0]))
        fail('PLOT_DOMAIN','Expected 1..128 sorted nonoverlapping increasing finite domains.',path+'.domains',span);
      if(raw.breaks!==undefined&&(!Array.isArray(raw.breaks)||raw.breaks.length>1024||raw.breaks.some((n:unknown,i:number)=>!finite(n)||i>0&&raw.breaks[i-1]>=n)))
        fail('PLOT_BREAKS','Expected at most 1024 strictly increasing finite breaks.',path+'.breaks',span);
      else if(diagnostics.length===before&&raw.breaks?.some((n:number)=>!raw.domains.some((d:number[])=>n>=d[0]&&n<=d[1])))
        fail('PLOT_BREAKS','Every break must belong to an authored domain.',path+'.breaks',span);
      if(raw.mask!==undefined){if(typeof raw.mask!=='string')fail('PLOT_MASK','Mask must be a boolean expression string.',path+'.mask',span);else expressionNames.push('mask');}
    }
    if(raw.expressionSpans!==undefined){
      if(!object(raw.expressionSpans))fail('PLOT_SOURCE','expressionSpans must be a dictionary.',path+'.expressionSpans',span);
      else for(const [key,value] of Object.entries(raw.expressionSpans)){
        if(!expressionNames.includes(key))fail('PLOT_SOURCE',`Unexpected expression source ${key}.`,path+'.expressionSpans.'+key,span);
        diagnostics.push(...validateSourceSpan(value,path+'.expressionSpans.'+key));
      }
    }
    if(!object(raw.inputs))fail('PLOT_INPUTS','Expected a typed input dictionary.',path+'.inputs',span);
    else if(Object.hasOwn(raw.inputs,'mapping'))fail('PLOT_INPUTS','mapping is derived from plot space and target.',path+'.inputs.mapping',span);
    else if(raw.mode==='samples')for(const key of ['tolerance','pixelsPerBp','initialSegments','maxDepth'])if(Object.hasOwn(raw.inputs,key))
      fail('PLOT_MODE_PROPERTY',`${key} is not available for explicit samples.`,path+'.inputs.'+key,span);
    const slots=deformationWrites(raw.target);
    for(const writer of writers)if(slots.some(a=>writer.slots.some(b=>propertiesOverlap(a,b))))
      fail('PLOT_WRITER_CONFLICT','Multiple writers overlap plot geometry.',path,span,[{message:'Earlier writer.',path:writer.path}]);
    writers.push({slots,path});
    if(diagnostics.length>before)return;
    const oldGraph=bundle.operationGraph??{version:1 as const,operations:[],bindings:[]};
    let inputId=`$plot:${index}`;while(oldGraph.operations.some(o=>o.id===inputId))inputId+='_';
    const operation:Operation={id:inputId,operator:'$plotInputs',version:1,spaces:{space:raw.space,target:{kind:'local',node:raw.target}},
      inputs:{...raw.inputs,mapping:{kind:'spaceTransform',from:raw.space,to:{kind:'local',node:raw.target}}},...(span?{sourceSpan:span}:{})};
    const syntheticPath=`$.operationGraph.operations[${oldGraph.operations.length}]`;
    const graph={...oldGraph,operations:[...oldGraph.operations,operation]};
    diagnostics.push(...validateOperationGraphInContext(graph,{...bundle,operationGraph:graph},registry).map(d=>({...d,path:d.path?.replace(syntheticPath,path)})));
    if(diagnostics.length>before)return;
    for(const [key,socket] of Object.entries(inputDefinition.inputs))if(!Object.hasOwn(operation.inputs,key)&&socket.default!==undefined)
      operation.inputs[key]={kind:'literal',value:structuredClone(socket.default)};
    const expressions:Record<string,CompiledExpression>=Object.create(null);
    const locals=raw.mode==='samples'?[]:raw.mode==='parametric'?['parameter','u']:['parameter','x'];
    for(const local of locals)if(Object.hasOwn(bundle.expressions?.parameters??{},local))fail('PLOT_PARAMETER_SHADOW',`Scene parameter ${local} conflicts with a plot local.`,path,span);
    const localType:ExpressionType={kind:'scalar',dimension:{length:0,time:0,angle:0}};
    for(const key of expressionNames)try{
      const compiled=compileExpression(raw[key],bundle.expressions?.parameters??{},raw.expressionSpans?.[key]??span,Object.fromEntries(locals.map(k=>[k,localType])));
      const t=compiled.type;
      if(key==='mask'?t.kind!=='boolean':t.kind!=='scalar'||t.dimension.length!==0||t.dimension.time!==0||t.dimension.angle!==0)
        fail('PLOT_EXPRESSION_TYPE',key==='mask'?'Mask must be boolean.':'Data expressions must be dimensionless scalars.',path+'.'+key,raw.expressionSpans?.[key]??span);
      else expressions[key]=compiled;
    }catch(error){
      const errors=error instanceof OperationValidationError?error.diagnostics:[{severity:'error' as const,code:'PLOT_EXPRESSION',message:String(error)}];
      diagnostics.push(...errors.map(d=>({...d,path:path+'.'+key,...(d.sourceSpan?{}:span?{sourceSpan:span}:{})})));
    }
    if(diagnostics.length>before)return;
    const inputs=prepareOperationInputs(operation,bundle,path,registry.list());
    const dependencies=[...new Set(flattenOperationInputs(operation.inputs).flatMap(i=>i.kind==='output'?[i.ref.operation]:[]))];
    entries.push({operation:freezeSnapshot(raw as PlotOperation),path,expressions,inputs,dependencies});
  });
  return {diagnostics,entries};
}

export function validatePlotProgram(input:unknown,bundle:Bundle):Diagnostic[]{return inspect(input,bundle).diagnostics;}
/** @internal Earlier scene programs have already been validated. */
export function validatePlotProgramInContext(input:unknown,bundle:Bundle):Diagnostic[]{return inspect(input,bundle,true).diagnostics;}
export function preparePlotProgram(input:PlotProgram,bundle:Bundle):PreparedPlotProgram {
  const checked=inspect(input,bundle);if(checked.diagnostics.some(d=>d.severity==='error'))throw new OperationValidationError(checked.diagnostics);
  const operations=checked.entries.map(({operation,path,expressions,inputs,dependencies}):PreparedPlot=>Object.freeze({
    operation,path,dependencies:Object.freeze(dependencies),reads:inputs.reads,writes:freezeSnapshot(deformationWrites(operation.target)),
    apply(nodes:Map<string,Node>,time:number,parameters:Readonly<Record<string,ExpressionValue>>,outputs:ReadonlyMap<string,Record<string,LiteralValue>>,anchors?:AnchorEvaluation){
      try{
        const values=inputs.resolve(nodes,time,parameters,outputs,anchors);
        const number=(key:string)=>(values[key] as Extract<LiteralValue,{type:'scalar'}>).value;
        const scale=(key:string):'linear'|'log'=>{const n=number(key);if(n!==0&&n!==1)throw new OperationValidationError([{severity:'error',code:'PLOT_SCALE',message:`${key} requires 0 (linear) or 1 (log).`}]);return n===0?'linear':'log';};
        const config:CartesianConfig={origin:[...(values.origin as Extract<LiteralValue,{type:'vec2'}>).value],width:number('width'),height:number('height'),
          xMin:number('xMin'),xMax:number('xMax'),yMin:number('yMin'),yMax:number('yMax'),xScale:scale('xScale'),yScale:scale('yScale'),logBase:number('logBase')};
        const mapping=createCartesianMapping(config);
        const quality={tolerance:number('tolerance'),pixelsPerBp:number('pixelsPerBp'),initialSegments:number('initialSegments'),maxDepth:number('maxDepth'),maxSamples:number('maxSamples'),maxSegments:number('maxSegments')};
        if(operation.mode==='samples'&&(!Number.isSafeInteger(quality.maxSamples)||quality.maxSamples<1||quality.maxSamples>262144||operation.samples!.length>quality.maxSamples))
          throw new OperationValidationError([{severity:'error',code:'PLOT_BUDGET',message:'Sample table exceeds its declared positive integer maxSamples budget (maximum 262144).'}]);
        const numericFailure=(error:unknown):boolean=>error instanceof OperationValidationError&&error.diagnostics.every(d=>['EXPRESSION_DOMAIN','EXPRESSION_NONFINITE'].includes(d.code))||
          ['AXIS_COORDINATE','AXIS_DOMAIN','AXIS_RANGE'].includes((error as {code?:string})?.code??'');
        const mapped=(x:number,y:number):PathPoint|null=>{try{return mapping.dataToScene(x,y);}catch(error){if(numericFailure(error))return null;throw error;}};
        const curve=(key:string)=>(u:number):PathPoint|null=>{
          const context={time,parameters:{...parameters,parameter:u,...(operation.mode==='parametric'?{u}:{x:u})}};
          try{
            if(expressions.mask&&!evaluateExpression(expressions.mask,context))return null;
            const x=operation.mode==='parametric'?evaluateExpression(expressions.xExpression,context) as number:u;
            return mapped(x,evaluateExpression(expressions[key],context) as number);
          }catch(error){if(numericFailure(error))return null;throw error;}
        };
        const options={...quality,domains:operation.domains??[],...(operation.breaks?{breaks:operation.breaks}:{})};
        const result=operation.mode==='samples'?sampledDataPlot(operation.samples!.map(p=>p===null?null:mapped(p[0],p[1])),{maxSamples:quality.maxSamples,maxSegments:quality.maxSegments}):
          operation.mode==='area'?areaBetweenCurves(curve('upper'),curve('lower'),options):adaptiveSampleCurve(curve(operation.mode==='function'?'expression':'yExpression'),options);
        const target=nodes.get(operation.target) as PathNode;
        const affine=(values.mapping as Extract<LiteralValue,{type:'transform2d'}>).value;
        target.geometry=transformGeometry(structuredClone(result.geometry) as PathGeometry,affine);target.d=pathGeometryData(target.geometry);delete target.resolvedPath;
        return freezeSnapshot(result.report);
      }catch(error){
        const diagnostics=error instanceof OperationValidationError?error.diagnostics:[{severity:'error' as const,code:(error as {code?:string})?.code??'PLOT_EVALUATION',message:error instanceof Error?error.message:String(error)}];
        throw new OperationValidationError(diagnostics.map(d=>({...d,path:d.path?.startsWith(path)?d.path:path,...(d.sourceSpan?{}:operation.sourceSpan?{sourceSpan:structuredClone(operation.sourceSpan)}:{})})));
      }
    },
  }));
  return Object.freeze({operations:Object.freeze(operations)});
}
