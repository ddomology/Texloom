import {validateBundle,type Bundle,type Resource} from '../schema.js';
import {OperationValidationError,type Diagnostic,type SourceSpan,type DeepReadonly} from '../ir/operations.js';
import {snapshotMeshResource,copyMeshBuffers,type MeshResource,type MeshUnit} from '../ir/mesh.js';
import {attachMeshAttributes,attributeComponents,type MeshAttribute} from '../ir/attributes.js';
import {snapshotInstanceSet3D,type InstanceSet3D} from '../ir/instances.js';
import type {Vec3} from '../geometry/matrix4.js';
import type {NumericBuffer} from '../resources/buffers.js';
import {validateAssetJson} from '../resources/package.js';
import {compileExpression,evaluateExpression} from '../fields/scalar.js';
import {prepareParameterResolver} from '../fields/program.js';
import type {CompiledExpression,ExpressionValue,ExpressionType} from '../fields/ast.js';
import {freezeSnapshot,validateSourceSpan} from './values.js';
import {prepareSurfaceProgram,surfaceValidationResources} from './surface.js';
import {curveValidationResources} from './curve3d.js';
import {prepareMeshAttributeProgram,meshAttributeValidationResources} from './mesh-attributes.js';
import {mapScalarColors,orientFieldVector,displaceMeshAlongNormals,type ScalarColorOptions} from './field-visualization-data.js';

export interface FieldVisualizationOperation {
  id:string;source:string;resourceId:string;units:MeshUnit;
  scalar?:string;vector?:[string,string,string];mask?:string;invalidPolicy:'error'|'mask';
  color?:ScalarColorOptions & {attribute:string};
  displacement?:{amplitude:string;normalPolicy:'drop'|'recompute';degenerateNormalPolicy:'error'|'source'};
  arrows?:{instanceSetId:string;prototype:string;up:Vec3;lengthScale:string;zeroPolicy:'hide'|'identity';color?:Vec3};
  sourceSpan?:SourceSpan;expressionSpans?:{scalar?:SourceSpan;vector?:SourceSpan[];mask?:SourceSpan;amplitude?:SourceSpan;lengthScale?:SourceSpan};
}
export interface FieldVisualizationProgram {version:1;operations:FieldVisualizationOperation[]}
export interface FieldVisualizationEvaluation {
  [id:string]:{source:string;resourceId:string;topologyRevision:string;domain:'vertex';
    scalar?:(number|null)[];vector?:(Vec3|null)[];validity:boolean[];mappedValidity:boolean[];range:{min:number;max:number}|null;
    sourceNormals?:NumericBuffer;displayNormals?:NumericBuffer;normalOrigin:'source'|'none'|'recomputed'|'recomputed-with-source-fallback';
    sourceNormalFallbacks:number[];amplitude?:number;lengthScale?:number;instanceSetId?:string};
}
export interface FieldVisualizationSample {
  resources:Readonly<Record<string,DeepReadonly<MeshResource>>>;
  instanceSets:Readonly<Record<string,DeepReadonly<InstanceSet3D>>>;
  fieldVisualization:DeepReadonly<FieldVisualizationEvaluation>;
}
export interface PreparedFieldVisualizationProgram {
  resourceIds:readonly string[];baseResources:FieldVisualizationSample['resources'];baseInstanceSets:FieldVisualizationSample['instanceSets'];
  sample(time:number,parameters?:Readonly<Record<string,ExpressionValue>>,generatedResources?:Readonly<Record<string,DeepReadonly<Resource>>>):FieldVisualizationSample;
}
export const FIELD_VISUALIZATION_MAX_OPERATIONS=16,FIELD_VISUALIZATION_MAX_VERTICES=65536,FIELD_VISUALIZATION_MAX_ARROWS=4096;
const object=(v:unknown):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const name=(v:unknown,max=512):v is string=>typeof v==='string'&&v.length>0&&v.length<=max&&v.trim()===v;
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
const attributeName=(v:unknown):v is string=>name(v)&&/^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(v)&&!['__proto__','constructor','prototype'].includes(v);
const units=['unit','m','cm','mm'];
const locals=['x','y','z','nx','ny','nz','index'];
const scalarType:ExpressionType={kind:'scalar',dimension:{length:0,time:0,angle:0}};
const localTypes=Object.fromEntries(locals.map(k=>[k,scalarType]));
const hasErrors=(ds:readonly Diagnostic[])=>ds.some(d=>d.severity==='error');
const buffer=(components:1|2|3,data:number[]):NumericBuffer=>({version:1,componentType:'float64',components,count:data.length/components,byteOffset:0,byteStride:components*8,data});
type Fields={scalar?:CompiledExpression;vector?:CompiledExpression[];mask?:CompiledExpression;amplitude?:CompiledExpression;lengthScale?:CompiledExpression};
interface Entry {operation:DeepReadonly<FieldVisualizationOperation>;path:string;expressions:Fields;needsNormals:boolean}
export interface FieldVisualizationResourceDeclaration {id:string;source:string;resourceId:string;units:MeshUnit;instanceSetId?:string;prototype?:string}
/** Dependency inventory only; not a substitute for hydrated semantic validation. */
export function fieldVisualizationResourceDeclarations(input:unknown):FieldVisualizationResourceDeclaration[]{
  if(input===undefined||validateAssetJson(input,'$.fieldVisualization').length||!object(input)||input.version!==1||!Array.isArray(input.operations)||input.operations.length>FIELD_VISUALIZATION_MAX_OPERATIONS)return [];
  return input.operations.filter((o:unknown)=>object(o)&&name(o.id,256)&&name(o.source)&&name(o.resourceId)&&units.includes(o.units)&&
    (o.arrows===undefined||object(o.arrows)&&name(o.arrows.instanceSetId,256)&&name(o.arrows.prototype))).map((o:FieldVisualizationOperation)=>({id:o.id,source:o.source,resourceId:o.resourceId,units:o.units,
      ...(o.arrows?{instanceSetId:o.arrows.instanceSetId,prototype:o.arrows.prototype}:{})}));
}
/** @internal Validation-only instance references. */
export function fieldVisualizationValidationSets(input:unknown):Record<string,InstanceSet3D>{
  const sets:Record<string,InstanceSet3D>=Object.create(null);
  for(const d of fieldVisualizationResourceDeclarations(input))if(d.instanceSetId&&d.prototype)sets[d.instanceSetId]={version:1,prototypeResourceId:d.prototype,units:d.units,instances:[]};
  return sets;
}
/** @internal Empty typed attributes for downstream references, never frame data. */
export function fieldVisualizationValidationResources(input:unknown,resources:Record<string,Resource>):Record<string,Resource>{
  const result={...resources};
  for(const d of fieldVisualizationResourceDeclarations(input)){
    if(Object.hasOwn(result,d.resourceId))continue;
    const source=result[d.source],o=(input as FieldVisualizationProgram).operations.find(o=>o.id===d.id),values:Record<string,Pick<MeshAttribute,'domain'|'valueType'>>=Object.create(null);
    if(source?.kind==='mesh')for(const [n,a] of Object.entries(source.attributes?.values??{}))values[n]={domain:a.domain,valueType:a.valueType};
    if(attributeName(o?.color?.attribute))values[o!.color!.attribute]={domain:'vertex',valueType:'color'};
    const revision='field-visualization-validation-only';
    const mesh:MeshResource={kind:'mesh',version:1,primitive:'triangles',units:d.units,coordinateSpace:'object',winding:'ccw',topologyRevision:revision,bounds:null,positions:buffer(3,[]),
      indices:{version:1,componentType:'uint32',components:1,count:0,byteOffset:0,byteStride:4,data:[]},
      attributes:{version:1,topology:{revision,vertexCount:0,indices:[]},values:Object.fromEntries(Object.entries(values).map(([n,a])=>[n,{...a,buffer:buffer(attributeComponents(a.valueType),[])}]))}};
    Object.defineProperty(result,d.resourceId,{value:mesh,enumerable:true,configurable:true});
  }return result;
}
function upstreamResources(bundle:Bundle):Record<string,Resource>{return meshAttributeValidationResources(bundle.meshAttributes,curveValidationResources(bundle.curves3d,surfaceValidationResources(bundle.surfaces,bundle.resources)));}
function located(cause:unknown,path:string,span?:DeepReadonly<SourceSpan>):OperationValidationError{
  const ds=(cause as {diagnostics?:readonly Diagnostic[]})?.diagnostics??[{severity:'error' as const,code:'FIELD_VISUALIZATION_EVALUATION',message:String(cause)}];
  return new OperationValidationError(ds.map(d=>({...d,path:d.path?.startsWith('$.fieldVisualization')?d.path:path,...(d.sourceSpan?{}:span?{sourceSpan:structuredClone(span)}:{})})));
}
function fail(code:string,message:string):never{throw new OperationValidationError([{severity:'error',code,message}]);}
/** Topology identity is independent of values, time, displacement and playback order. */
function fieldElementPrefix(operation:string,source:string,revision:string):string{
  const text=JSON.stringify([operation,source,revision]);let hash=2166136261;
  for(let i=0;i<text.length;i++)hash=Math.imul(hash^text.charCodeAt(i),16777619);
  return `field:${operation}:${(hash>>>0).toString(16).padStart(8,'0')}`;
}
function readsNormals(expression:CompiledExpression):boolean{
  const visit=(value:unknown):boolean=>object(value)?value.kind==='identifier'&&['nx','ny','nz'].includes(value.name)||Object.values(value).some(visit):Array.isArray(value)&&value.some(visit);
  return visit(expression.ast);
}
function inspect(input:unknown,bundle:Bundle,inContext=false):{diagnostics:Diagnostic[];entries:Entry[]}{
  const diagnostics=validateAssetJson(input,'$.fieldVisualization'),entries:Entry[]=[];
  const error=(code:string,message:string,path:string,sourceSpan?:SourceSpan)=>diagnostics.push({severity:'error',code,message,path,...(sourceSpan?{sourceSpan}:{})});
  const result=()=>({diagnostics,entries});
  if(hasErrors(diagnostics))return result();if(!object(bundle)){error('FIELD_VISUALIZATION_CONTEXT','Expected a scene bundle.','$');return result();}
  if(!inContext){diagnostics.push(...validateAssetJson(bundle));if(hasErrors(diagnostics))return result();diagnostics.push(...validateBundle({...bundle,fieldVisualization:input as FieldVisualizationProgram}));}
  if(!object(bundle.resources)){error('FIELD_VISUALIZATION_CONTEXT','Expected authored resources.','$.resources');return result();}
  if(bundle.version!=='0.3')error('FIELD_VISUALIZATION_VERSION','Field visualization requires Bundle 0.3.','$.version');
  if(hasErrors(diagnostics))return result();
  const keys=(v:Record<string,unknown>,allowed:readonly string[],path:string)=>{for(const k of Object.keys(v))if(!allowed.includes(k))error('FIELD_VISUALIZATION_PROPERTY',`Unknown property ${k}.`,path+'.'+k);};
  if(!object(input)){error('FIELD_VISUALIZATION_PROGRAM','Expected a versioned field visualization program.','$.fieldVisualization');return result();}
  keys(input,['version','operations'],'$.fieldVisualization');if(input.version!==1)error('FIELD_VISUALIZATION_VERSION','Supported program version is 1.','$.fieldVisualization.version');
  if(!Array.isArray(input.operations)||input.operations.length>FIELD_VISUALIZATION_MAX_OPERATIONS){error('FIELD_VISUALIZATION_BUDGET','Expected at most 16 field operations.','$.fieldVisualization.operations');return result();}
  const available=upstreamResources(bundle),outputs=new Set(Object.keys(available)),ids=new Set<string>(),setIds=new Set<string>();let vertexCount=0,arrowCount=0;
  for(const [i,raw] of input.operations.entries()){
    const path=`$.fieldVisualization.operations[${i}]`,before=diagnostics.length;
    if(!object(raw)){error('FIELD_VISUALIZATION_OPERATION','Expected an operation.',path);continue;}
    keys(raw,['id','source','resourceId','units','scalar','vector','mask','invalidPolicy','color','displacement','arrows','sourceSpan','expressionSpans'],path);
    if(raw.sourceSpan!==undefined)diagnostics.push(...validateSourceSpan(raw.sourceSpan,path+'.sourceSpan'));const span=raw.sourceSpan as SourceSpan|undefined;
    if(!name(raw.id,256)||ids.has(raw.id))error('FIELD_VISUALIZATION_ID','Operation IDs must be unique and nonempty.',path+'.id',span);else ids.add(raw.id);
    if(!name(raw.resourceId)||outputs.has(raw.resourceId))error('FIELD_VISUALIZATION_RESOURCE','Display resource IDs must be new and unique.',path+'.resourceId',span);else outputs.add(raw.resourceId);
    const source=name(raw.source)&&Object.hasOwn(available,raw.source)?available[raw.source]:undefined;
    if(source?.kind!=='mesh')error('FIELD_VISUALIZATION_SOURCE','Source must be a mesh from an earlier phase or field operation; no forward references.',path+'.source',span);
    if(!units.includes(raw.units)||source?.kind==='mesh'&&source.units!==raw.units)error('FIELD_VISUALIZATION_UNITS','Explicit units must match the source and arrow prototype.',path+'.units',span);
    if(source?.kind==='mesh')vertexCount+=source.positions.count;
    if(raw.scalar===undefined&&raw.vector===undefined)error('FIELD_VISUALIZATION_FIELDS','Declare a scalar and/or vector field.',path,span);
    if(!['error','mask'].includes(raw.invalidPolicy))error('FIELD_VISUALIZATION_INVALID','Declare invalidPolicy error or mask.',path+'.invalidPolicy',span);
    for(const local of locals)if(Object.hasOwn(bundle.expressions?.parameters??{},local))error('FIELD_VISUALIZATION_PARAMETER_SHADOW',`Scene parameter ${local} conflicts with a field local.`,path,span);
    if(raw.color!==undefined){
      if(!object(raw.color))error('FIELD_VISUALIZATION_COLOR','Expected explicit color mapping.',path+'.color',span);
      else {keys(raw.color,['attribute','stops','range','outOfRange','invalidColor'],path+'.color');
        if(raw.scalar===undefined)error('FIELD_VISUALIZATION_COLOR','Color mapping requires a scalar field.',path+'.color',span);
        if(!attributeName(raw.color.attribute)||source?.kind==='mesh'&&Object.hasOwn(source.attributes?.values??{},raw.color.attribute))error('FIELD_VISUALIZATION_ATTRIBUTE','Color requires a new safe attribute name.',path+'.color.attribute',span);
        try{const {attribute:ignored,...options}=raw.color;mapScalarColors([],options as ScalarColorOptions);}catch(cause){diagnostics.push(...located(cause,path+'.color',span).diagnostics);}
      }
    }
    if(raw.displacement!==undefined){
      if(!object(raw.displacement))error('FIELD_VISUALIZATION_DISPLACEMENT','Expected explicit displacement options.',path+'.displacement',span);
      else {keys(raw.displacement,['amplitude','normalPolicy','degenerateNormalPolicy'],path+'.displacement');
        if(raw.scalar===undefined)error('FIELD_VISUALIZATION_DISPLACEMENT','Normal displacement requires a scalar field.',path+'.displacement',span);
        if(!['drop','recompute'].includes(raw.displacement.normalPolicy)||!['error','source'].includes(raw.displacement.degenerateNormalPolicy))error('FIELD_VISUALIZATION_NORMALS','Declare normalPolicy drop or recompute and degenerateNormalPolicy error or source.',path+'.displacement',span);
      }
    }
    if(raw.arrows!==undefined){
      if(!object(raw.arrows))error('FIELD_VISUALIZATION_ARROWS','Expected explicit arrow options.',path+'.arrows',span);
      else {keys(raw.arrows,['instanceSetId','prototype','up','lengthScale','zeroPolicy','color'],path+'.arrows');
        if(raw.vector===undefined)error('FIELD_VISUALIZATION_ARROWS','Arrows require a vector field.',path+'.arrows',span);
        if(!name(raw.arrows.instanceSetId,256)||setIds.has(raw.arrows.instanceSetId)||(Array.isArray(bundle.instances?.operations)?bundle.instances.operations:[]).some(o=>object(o)&&o.id===raw.arrows.instanceSetId))error('FIELD_VISUALIZATION_INSTANCE_ID','Arrow set IDs must be unique across field and generic instances.',path+'.arrows.instanceSetId',span);else setIds.add(raw.arrows.instanceSetId);
        const prototype=name(raw.arrows.prototype)&&Object.hasOwn(available,raw.arrows.prototype)?available[raw.arrows.prototype]:undefined;
        if(prototype?.kind!=='mesh'||prototype.units!==raw.units)error('FIELD_VISUALIZATION_PROTOTYPE','Arrow prototype must be an earlier mesh in matching units.',path+'.arrows.prototype',span);
        if(raw.arrows.color!==undefined&&(!Array.isArray(raw.arrows.color)||raw.arrows.color.length!==3||!raw.arrows.color.every((n:unknown)=>finite(n)&&n>=0&&n<=1)))error('FIELD_VISUALIZATION_COLOR','Arrow color requires linear RGB components in [0,1].',path+'.arrows.color',span);
        try{orientFieldVector([1,0,0],{up:raw.arrows.up,zeroPolicy:raw.arrows.zeroPolicy,lengthScale:1});}catch(cause){diagnostics.push(...located(cause,path+'.arrows',span).diagnostics);}
        if(source?.kind==='mesh')arrowCount+=source.positions.count;
      }
    }
    const expressions:Fields={};
    if(raw.expressionSpans!==undefined){if(!object(raw.expressionSpans))error('FIELD_VISUALIZATION_SPAN','Expected grouped source spans.',path+'.expressionSpans',span);else keys(raw.expressionSpans,['scalar','vector','mask','amplitude','lengthScale'],path+'.expressionSpans');}
    const texts={scalar:raw.scalar,vector:raw.vector,mask:raw.mask,amplitude:raw.displacement?.amplitude,lengthScale:raw.arrows?.lengthScale};
    for(const key of ['scalar','vector','mask','amplitude','lengthScale'] as const){
      const text=texts[key],spans=raw.expressionSpans?.[key],count=key==='vector'?3:1;
      if(spans!==undefined){if(text===undefined)error('FIELD_VISUALIZATION_SPAN','A source span requires its expression.',path+'.expressionSpans.'+key,span);
        const list=key==='vector'?spans:[spans];if(!Array.isArray(list)||list.length!==count)error('FIELD_VISUALIZATION_SPAN','Source span shape must match the expression.',path+'.expressionSpans.'+key,span);else list.forEach((s:unknown,j:number)=>diagnostics.push(...validateSourceSpan(s,`${path}.expressionSpans.${key}[${j}]`)));}
      if(text===undefined){if(key==='amplitude'&&raw.displacement!==undefined||key==='lengthScale'&&raw.arrows!==undefined)error('FIELD_VISUALIZATION_EXPRESSION','Expected an explicit uniform scalar expression.',path+'.'+key,span);continue;}
      const values=key==='vector'?text:[text];if(!Array.isArray(values)||values.length!==count||values.some(t=>typeof t!=='string')){error('FIELD_VISUALIZATION_EXPRESSION','Expression shape must match the field.',path+'.'+key,span);continue;}
      const compiled:CompiledExpression[]=[];
      for(const [j,value] of values.entries())try{const source=key==='vector'?spans?.[j]:spans,e=compileExpression(value,bundle.expressions?.parameters??{},source??span,key==='amplitude'||key==='lengthScale'?{}:localTypes);
        if(key==='mask'?e.type.kind!=='boolean':e.type.kind!=='scalar'||Object.values(e.type.dimension).some(v=>v!==0))error('FIELD_VISUALIZATION_EXPRESSION_TYPE',key==='mask'?'Mask requires a boolean.':'Field components require dimensionless scalars in the declared mesh units.',`${path}.${key}[${j}]`,source??span);
        compiled.push(e);
      }catch(cause){diagnostics.push(...located(cause,`${path}.${key}[${j}]`,span).diagnostics);}
      if(key==='vector')expressions.vector=compiled;else expressions[key]=compiled[0];
    }
    if(diagnostics.length===before){const needsNormals=raw.displacement!==undefined||Object.values(expressions).flatMap(e=>Array.isArray(e)?e:[e]).some(e=>readsNormals(e!));
      entries.push({operation:freezeSnapshot(raw as FieldVisualizationOperation),path,expressions,needsNormals});
      const virtual=fieldVisualizationValidationResources({version:1,operations:[raw]},available);Object.defineProperty(available,raw.resourceId,{value:virtual[raw.resourceId],enumerable:true,configurable:true});}
  }
  if(vertexCount>FIELD_VISUALIZATION_MAX_VERTICES)error('FIELD_VISUALIZATION_BUDGET','At most 65536 field vertices across the program.','$.fieldVisualization.operations');
  if(arrowCount>FIELD_VISUALIZATION_MAX_ARROWS)error('FIELD_VISUALIZATION_BUDGET','At most 4096 field arrows across the program.','$.fieldVisualization.operations');
  return result();
}
export function validateFieldVisualizationProgram(input:unknown,bundle:Bundle):Diagnostic[]{return inspect(input,bundle).diagnostics;}
/** @internal JSON and parameter declarations were already checked. */
export function validateFieldVisualizationProgramInContext(input:unknown,bundle:Bundle):Diagnostic[]{return inspect(input,bundle,true).diagnostics;}
/** Pure absolute-time sampling. Renderers consume these fields and never re-evaluate them. */
export function prepareFieldVisualizationProgram(input:FieldVisualizationProgram,bundle:Bundle,generatedResources?:Readonly<Record<string,DeepReadonly<Resource>>>):PreparedFieldVisualizationProgram{
  const {diagnostics,entries}=inspect(input,bundle);if(hasErrors(diagnostics))throw new OperationValidationError(diagnostics);
  const resolve=prepareParameterResolver(bundle.expressions?.parameters??{}),authored=freezeSnapshot(bundle.resources);
  const supplied=(value:unknown):Readonly<Record<string,DeepReadonly<Resource>>>=>{const ds=validateAssetJson(value,'$.generatedResources');if(hasErrors(ds))throw new OperationValidationError(ds);if(!object(value))fail('FIELD_VISUALIZATION_CONTEXT','Expected a generated resource dictionary.');return value as Readonly<Record<string,DeepReadonly<Resource>>>;};
  const defaults=freezeSnapshot(supplied(generatedResources??{})),surfaces=generatedResources===undefined&&bundle.surfaces?prepareSurfaceProgram(bundle.surfaces,bundle):undefined;
  const attributes=generatedResources===undefined&&bundle.meshAttributes?prepareMeshAttributeProgram(bundle.meshAttributes,bundle,{...surfaces?.baseResources}):undefined;
  const sample=(time:number,overrides?:Readonly<Record<string,ExpressionValue>>,generated?:Readonly<Record<string,DeepReadonly<Resource>>>):FieldVisualizationSample=>{
    if(!Number.isFinite(time))throw new RangeError('Field visualization time must be finite.');const parameters=resolve(overrides);
    const surface=generated===undefined?surfaces?.sample(time,overrides):undefined;
    const current=generated===undefined?{...defaults,...surface?.resources,...attributes?.sample(time,overrides,surface?.resources??{}).resources}:supplied(generated);
    const resources:Record<string,DeepReadonly<MeshResource>>=Object.create(null),sets:Record<string,DeepReadonly<InstanceSet3D>>=Object.create(null),reports:FieldVisualizationEvaluation=Object.create(null);let vertices=0,arrows=0;
    const mesh=(id:string,unit:MeshUnit)=>{const value=Object.hasOwn(resources,id)?resources[id]:Object.hasOwn(authored,id)?authored[id]:current[id];if(value?.kind!=='mesh'||value.units!==unit)fail('FIELD_VISUALIZATION_RESOURCE','Supply the declared source/prototype mesh in matching units.');return snapshotMeshResource(value);};
    for(const {operation:o,path,expressions:e,needsNormals} of entries)try{
      const source=mesh(o.source,o.units);vertices+=source.positions.count;if(vertices>FIELD_VISUALIZATION_MAX_VERTICES)fail('FIELD_VISUALIZATION_BUDGET','More than 65536 field vertices.');
      if(needsNormals&&!source.normals)fail('FIELD_VISUALIZATION_NORMALS','Normal displacement or normal locals require explicit source normals.');
      const geometry=copyMeshBuffers(source),rawScalar:(number|null)[]=[],rawVector:(Vec3|null)[]=[],validity:boolean[]=[];
      const evaluate=(expression:CompiledExpression,values:Readonly<Record<string,ExpressionValue>>,key:keyof Fields,index?:number):ExpressionValue=>{try{return evaluateExpression(expression,{time,parameters:values});}catch(cause){throw located(cause,`${path}.${key}${index===undefined?'':`[${index}]`}`,key==='vector'?o.expressionSpans?.vector?.[index??0]??o.sourceSpan:o.expressionSpans?.[key]??o.sourceSpan);}};
      const amplitude=e.amplitude?evaluate(e.amplitude,parameters,'amplitude') as number:undefined,lengthScale=e.lengthScale?evaluate(e.lengthScale,parameters,'lengthScale') as number:undefined;
      if(lengthScale!==undefined&&lengthScale<0)fail('FIELD_VISUALIZATION_SCALE','Arrow length scale must be nonnegative.');
      for(let i=0;i<source.positions.count;i++){
        const offset=i*3,values={...parameters,x:geometry.positions[offset],y:geometry.positions[offset+1],z:geometry.positions[offset+2],nx:geometry.normals?.[offset]??0,ny:geometry.normals?.[offset+1]??0,nz:geometry.normals?.[offset+2]??0,index:i};
        let valid=true,s:number|null=null,v:Vec3|null=null;
        try{valid=e.mask?evaluate(e.mask,values,'mask') as boolean:true;if(valid){if(e.scalar)s=evaluate(e.scalar,values,'scalar') as number;if(e.vector)v=e.vector.map((expression,j)=>evaluate(expression,values,'vector',j)) as Vec3;}}
        catch(cause){if(o.invalidPolicy==='error')throw cause;valid=false;s=null;v=null;}
        validity.push(valid);if(e.scalar)rawScalar.push(valid?s:null);if(e.vector)rawVector.push(valid?v:null);
      }
      const color=o.color?mapScalarColors(rawScalar,(({attribute:ignored,...options})=>options)(o.color)):undefined,mappedValidity=color?[...color.mappedValidity]:[...validity];
      let display=source,normalOrigin:FieldVisualizationEvaluation[string]['normalOrigin']=source.normals?'source':'none',sourceNormalFallbacks:number[]=[];
      if(o.displacement){const result=displaceMeshAlongNormals(source,rawScalar,{amplitude:amplitude!,normalPolicy:o.displacement.normalPolicy,degenerateNormalPolicy:o.displacement.degenerateNormalPolicy});display=result.mesh;normalOrigin=result.normalOrigin;sourceNormalFallbacks=[...result.sourceNormalFallbacks];}
      if(o.color&&color)display=attachMeshAttributes(display,{[o.color.attribute]:{domain:'vertex',valueType:'color',buffer:buffer(3,color.colors.flatMap(c=>[...c]))}});
      resources[o.resourceId]=display;
      if(o.arrows){arrows+=source.positions.count;if(arrows>FIELD_VISUALIZATION_MAX_ARROWS)fail('FIELD_VISUALIZATION_BUDGET','More than 4096 field arrows.');const prototype=mesh(o.arrows.prototype,o.units),displayPositions=copyMeshBuffers(display).positions,prefix=fieldElementPrefix(o.id,o.source,source.topologyRevision);
        const instances=rawVector.map((vector,index)=>{const orientation=orientFieldVector((vector??[0,0,0]) as Vec3,{up:o.arrows!.up as Vec3,zeroPolicy:o.arrows!.zeroPolicy,lengthScale:lengthScale!});
          return {id:`${prefix}:${index}`,transform:{translation:Array.from(displayPositions.slice(index*3,index*3+3)) as Vec3,rotation:[...orientation.rotation] as [number,number,number,number],scale:[orientation.displayLength,1,1] as Vec3},
            color:[...(o.arrows!.color??color?.colors[index]??[1,1,1])] as Vec3,selected:validity[index]&&mappedValidity[index]&&orientation.visible};});
        sets[o.arrows.instanceSetId]=snapshotInstanceSet3D({version:1,prototypeResourceId:o.arrows.prototype,units:o.units,instances},prototype);
      }
      reports[o.id]={source:o.source,resourceId:o.resourceId,topologyRevision:source.topologyRevision,domain:'vertex',...(e.scalar?{scalar:rawScalar}:{}),...(e.vector?{vector:rawVector}:{}),validity,mappedValidity,range:color?.range??null,
        ...(source.normals?{sourceNormals:source.normals as NumericBuffer}:{}),...(display.normals?{displayNormals:display.normals as NumericBuffer}:{}),normalOrigin,sourceNormalFallbacks,
        ...(amplitude!==undefined?{amplitude}:{}),...(lengthScale!==undefined?{lengthScale}:{}),...(o.arrows?{instanceSetId:o.arrows.instanceSetId}:{})};
    }catch(cause){throw located(cause,path,o.sourceSpan);}
    return Object.freeze({resources:Object.freeze(resources),instanceSets:Object.freeze(sets),fieldVisualization:freezeSnapshot(reports)});
  };
  const base=sample(0);return Object.freeze({resourceIds:Object.freeze(entries.map(e=>e.operation.resourceId)),baseResources:base.resources,baseInstanceSets:base.instanceSets,sample});
}
