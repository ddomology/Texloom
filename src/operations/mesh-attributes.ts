import {validateBundle,type Bundle,type Resource} from '../schema.js';
import {OperationValidationError,type Diagnostic,type SourceSpan,type DeepReadonly} from '../ir/operations.js';
import {snapshotMeshResource,type MeshResource,type MeshUnit} from '../ir/mesh.js';
import {attachMeshAttributes,attributeComponents,MAX_MESH_ATTRIBUTES,MAX_MESH_ATTRIBUTE_COMPONENTS,
  type AttributeDomain,type AttributeValueType,type MeshAttribute} from '../ir/attributes.js';
import {createMeshFieldContext} from '../fields/mesh-context.js';
import {transferMeshAttribute,type MeshDomainTransferOptions} from './domain-transfer.js';
import type {NumericBuffer} from '../resources/buffers.js';
import {compileExpression,evaluateExpression} from '../fields/scalar.js';
import {prepareParameterResolver} from '../fields/program.js';
import type {ExpressionType,ExpressionValue,CompiledExpression} from '../fields/ast.js';
import {freezeSnapshot,validateJsonData,validateSourceSpan} from './values.js';
import {prepareSurfaceProgram,surfaceResourceDeclarations,surfaceValidationResources} from './surface.js';
import {curveResourceDeclarations,curveValidationResources} from './curve3d.js';
import {validateAssetJson} from '../resources/package.js';

interface StepSource {sourceSpan?:SourceSpan}
export interface CaptureMeshAttributeStep extends StepSource {
  kind:'capture';name:string;domain:AttributeDomain;valueType:AttributeValueType;
  expression:string|string[];expressionSpans?:SourceSpan[];
}
export interface TransferMeshAttributeStep extends StepSource {
  kind:'transfer';source:string;name:string;domain:AttributeDomain;
  method:MeshDomainTransferOptions['method'];orphan?:MeshDomainTransferOptions['orphan'];zeroArea?:MeshDomainTransferOptions['zeroArea'];
}
export interface SetMeshPositionStep extends StepSource {
  kind:'set-position';expression:[string,string,string];normalPolicy:'drop';expressionSpans?:SourceSpan[];
}
export type MeshAttributeStep=CaptureMeshAttributeStep|TransferMeshAttributeStep|SetMeshPositionStep;
export interface MeshAttributeOperation {id:string;source:string;resourceId:string;units:MeshUnit;steps:MeshAttributeStep[];sourceSpan?:SourceSpan}
export interface MeshAttributeProgram {version:1;operations:MeshAttributeOperation[]}
export interface MeshAttributeEvaluation {
  [id:string]:{source:string;resourceId:string;steps:{kind:MeshAttributeStep['kind'];name?:string;domain?:AttributeDomain;elements:number}[];attributes:string[]};
}
export interface MeshAttributeSample {resources:Readonly<Record<string,DeepReadonly<MeshResource>>>;meshAttributes:DeepReadonly<MeshAttributeEvaluation>}
export interface PreparedMeshAttributeProgram {
  resourceIds:readonly string[];baseResources:MeshAttributeSample['resources'];
  sample(time:number,parameters?:Readonly<Record<string,ExpressionValue>>,generatedResources?:Readonly<Record<string,DeepReadonly<Resource>>>):MeshAttributeSample;
}
export const MESH_ATTRIBUTE_MAX_OPERATIONS=16,MESH_ATTRIBUTE_MAX_STEPS=32,MESH_ATTRIBUTE_MAX_TOTAL_STEPS=128,MESH_ATTRIBUTE_MAX_EVALUATIONS=1_048_576;
const object=(v:unknown):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const name=(v:unknown,max=512):v is string=>typeof v==='string'&&v.length>0&&v.length<=max&&v.trim()===v;
const attributeName=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z_][A-Za-z0-9_.:-]{0,511}$/.test(v)&&!['__proto__','constructor','prototype'].includes(v);
const hasErrors=(ds:readonly Diagnostic[])=>ds.some(d=>d.severity==='error');
const domains=['vertex','face','corner'],types=['scalar','vec2','vec3','color'];
const locals=['x','y','z','ox','oy','oz','index'];
const scalar:ExpressionType={kind:'scalar',dimension:{length:0,time:0,angle:0}};
const localTypes=Object.fromEntries(locals.map(key=>[key,scalar]));
const buffer=(components:1|2|3,data:number[]):NumericBuffer=>({version:1,componentType:'float64',components,count:data.length/components,byteOffset:0,byteStride:components*8,data});
interface PreparedStep {step:DeepReadonly<MeshAttributeStep>;path:string;expressions?:CompiledExpression[]}
interface Entry {operation:DeepReadonly<MeshAttributeOperation>;path:string;steps:PreparedStep[]}

/** Lightweight package inventory. Full validation requires a hydrated mesh context. */
export function meshAttributeResourceDeclarations(input:unknown):{source:string;resourceId:string;units:MeshUnit}[]{
  if(input===undefined||validateJsonData(input,'$.meshAttributes').length||!object(input)||input.version!==1||!Array.isArray(input.operations)||input.operations.length>MESH_ATTRIBUTE_MAX_OPERATIONS)return [];
  return input.operations.filter((o:unknown)=>object(o)&&name(o.source)&&name(o.resourceId)&&['unit','m','cm','mm'].includes(o.units)).map((o:MeshAttributeOperation)=>({source:o.source,resourceId:o.resourceId,units:o.units}));
}
function emptyMesh(units:MeshUnit,values:Record<string,Pick<MeshAttribute,'domain'|'valueType'>>={}):MeshResource {
  const revision='attribute-validation-only';
  return {kind:'mesh',version:1,primitive:'triangles',units,coordinateSpace:'object',winding:'ccw',topologyRevision:revision,bounds:null,
    positions:buffer(3,[]),indices:{version:1,componentType:'uint32',components:1,count:0,byteOffset:0,byteStride:4,data:[]},
    attributes:{version:1,topology:{revision,vertexCount:0,indices:[]},values:Object.fromEntries(Object.entries(values).map(([n,a])=>[n,{domain:a.domain,valueType:a.valueType,buffer:buffer(attributeComponents(a.valueType),[])}]))}};
}
/** @internal Empty typed metadata for material/reference validation only. Never published as a frame resource. */
export function meshAttributeValidationResources(input:unknown,resources:Record<string,Resource>):Record<string,Resource>{
  const result={...resources};if(!meshAttributeResourceDeclarations(input).length)return result;
  for(const raw of (input as MeshAttributeProgram).operations){
    if(!object(raw)||!name(raw.resourceId)||!name(raw.source)||!['unit','m','cm','mm'].includes(raw.units)||Object.hasOwn(result,raw.resourceId))continue;
    const source=result[raw.source],values:Record<string,Pick<MeshAttribute,'domain'|'valueType'>>=Object.create(null);
    if(source?.kind==='mesh')for(const [key,value] of Object.entries(source.attributes?.values??{}))values[key]={domain:value.domain,valueType:value.valueType};
    if(Array.isArray(raw.steps))for(const s of raw.steps.slice(0,MESH_ATTRIBUTE_MAX_STEPS) as unknown[])if(object(s)&&attributeName(s.name)&&domains.includes(s.domain)){
      if(s.kind==='capture'&&types.includes(s.valueType))values[s.name]={domain:s.domain,valueType:s.valueType};
      if(s.kind==='transfer'&&typeof s.source==='string'&&Object.hasOwn(values,s.source))values[s.name]={domain:s.domain,valueType:values[s.source].valueType};
    }
    Object.defineProperty(result,raw.resourceId,{enumerable:true,configurable:true,value:emptyMesh(raw.units,values)});
  }return result;
}
function inspect(input:unknown,bundle:Bundle,inContext=false):{diagnostics:Diagnostic[];entries:Entry[]}{
  const diagnostics=validateJsonData(input,'$.meshAttributes'),entries:Entry[]=[];
  const error=(code:string,message:string,path:string,sourceSpan?:SourceSpan)=>diagnostics.push({severity:'error',code,message,path,...(sourceSpan?{sourceSpan}:{})});
  const result=()=>({diagnostics,entries});
  if(hasErrors(diagnostics))return result();if(!object(bundle)){error('MESH_ATTRIBUTE_CONTEXT','Expected a scene bundle.','$');return result();}
  if(!inContext){diagnostics.push(...validateJsonData(bundle));if(hasErrors(diagnostics))return result();}
  if(!object(bundle.resources)){error('MESH_ATTRIBUTE_CONTEXT','Expected an authored resource dictionary.','$.resources');return result();}
  const upstream=curveValidationResources(bundle.curves3d,surfaceValidationResources(bundle.surfaces,bundle.resources));
  if(!inContext){const {meshAttributes:ignored,...base}=bundle,virtual=meshAttributeValidationResources(input,upstream),derived=Object.fromEntries(meshAttributeResourceDeclarations(input).filter(o=>!Object.hasOwn(bundle.resources,o.resourceId)).map(o=>[o.resourceId,virtual[o.resourceId]]));
    diagnostics.push(...validateBundle({...base,resources:{...base.resources,...derived}}));}
  if(bundle.version!=='0.3')error('MESH_ATTRIBUTE_VERSION','Mesh attribute programs require Bundle 0.3.','$.version');
  if(hasErrors(diagnostics))return result();
  const keys=(v:Record<string,unknown>,allowed:readonly string[],path:string)=>{for(const k of Object.keys(v))if(!allowed.includes(k))error('MESH_ATTRIBUTE_PROPERTY',`Unknown property ${k}.`,path+'.'+k);};
  if(!object(input)){error('MESH_ATTRIBUTE_PROGRAM','Expected a versioned attribute program.','$.meshAttributes');return result();}
  keys(input,['version','operations'],'$.meshAttributes');if(input.version!==1)error('MESH_ATTRIBUTE_VERSION','Supported program version is 1.','$.meshAttributes.version');
  if(!Array.isArray(input.operations)||input.operations.length>MESH_ATTRIBUTE_MAX_OPERATIONS){error('MESH_ATTRIBUTE_BUDGET','Expected at most 16 operations.','$.meshAttributes.operations');return result();}
  const available={...upstream},ids=new Set<string>(),outputs=new Set([...Object.keys(bundle.resources),...surfaceResourceDeclarations(bundle.surfaces).map(o=>o.resourceId),...curveResourceDeclarations(bundle.curves3d).map(o=>o.resourceId)]);let totalSteps=0;
  input.operations.forEach((raw:unknown,index:number)=>{
    const path=`$.meshAttributes.operations[${index}]`,before=diagnostics.length;
    if(!object(raw)){error('MESH_ATTRIBUTE_OPERATION','Expected an operation.',path);return;}
    keys(raw,['id','source','resourceId','units','steps','sourceSpan'],path);
    if(raw.sourceSpan!==undefined)diagnostics.push(...validateSourceSpan(raw.sourceSpan,path+'.sourceSpan'));const span=raw.sourceSpan as SourceSpan|undefined;
    if(!name(raw.id,256)||ids.has(raw.id))error('MESH_ATTRIBUTE_ID','Operation IDs must be unique, nonempty and at most 256 characters.',path+'.id',span);else ids.add(raw.id);
    if(!name(raw.resourceId)||outputs.has(raw.resourceId))error('MESH_ATTRIBUTE_RESOURCE','Output resource IDs must be unique and cannot replace another resource.',path+'.resourceId',span);else outputs.add(raw.resourceId);
    const source=name(raw.source)&&Object.hasOwn(available,raw.source)?available[raw.source]:undefined;
    if(source?.kind!=='mesh')error('MESH_ATTRIBUTE_SOURCE','Source must be an authored mesh, generated surface, or earlier attribute output; forward references and curves are unsupported.',path+'.source',span);
    if(!['unit','m','cm','mm'].includes(raw.units)||source?.kind==='mesh'&&raw.units!==source.units)error('MESH_ATTRIBUTE_UNITS','Explicit operation units must match the source mesh.',path+'.units',span);
    if(!Array.isArray(raw.steps)||raw.steps.length===0||raw.steps.length>MESH_ATTRIBUTE_MAX_STEPS){error('MESH_ATTRIBUTE_BUDGET','Expected 1–32 ordered steps.',path+'.steps',span);return;}
    totalSteps+=raw.steps.length;
    for(const local of locals)if(Object.hasOwn(bundle.expressions?.parameters??{},local))error('MESH_ATTRIBUTE_PARAMETER_SHADOW',`Scene parameter ${local} conflicts with a mesh local.`,path,span);
    if(diagnostics.slice(before).some(d=>d.severity==='error'))return;
    let metadata:DeepReadonly<MeshResource>=emptyMesh(raw.units,(source as MeshResource).attributes?.values);const steps:PreparedStep[]=[];
    raw.steps.forEach((s:unknown,j:number)=>{
      const at=`${path}.steps[${j}]`,start=diagnostics.length;if(!object(s)){error('MESH_ATTRIBUTE_STEP','Expected a step.',at,span);return;}
      const allowed=s.kind==='capture'?['kind','name','domain','valueType','expression','expressionSpans','sourceSpan']:s.kind==='transfer'?['kind','source','name','domain','method','orphan','zeroArea','sourceSpan']:s.kind==='set-position'?['kind','expression','expressionSpans','normalPolicy','sourceSpan']:[];
      if(!allowed.length){error('MESH_ATTRIBUTE_STEP','Expected capture, transfer or set-position.',at,span);return;}keys(s,allowed,at);
      if(s.sourceSpan!==undefined)diagnostics.push(...validateSourceSpan(s.sourceSpan,at+'.sourceSpan'));const stepSpan=s.sourceSpan??span;
      if(s.kind!=='set-position'&&(!attributeName(s.name)||Object.hasOwn(metadata.attributes!.values,s.name)))error('MESH_ATTRIBUTE_NAME','A capture or transfer requires a new safe attribute name.',at+'.name',stepSpan);
      if(s.kind!=='set-position'&&!domains.includes(s.domain))error('MESH_ATTRIBUTE_DOMAIN','Expected vertex, face or corner.',at+'.domain',stepSpan);
      if(s.kind==='capture'&&!types.includes(s.valueType))error('MESH_ATTRIBUTE_TYPE','Expected scalar, vec2, vec3 or color.',at+'.valueType',stepSpan);
      if(s.kind==='set-position'&&s.normalPolicy!=='drop')error('MESH_ATTRIBUTE_NORMALS','Position updates require explicit normalPolicy:drop.',at+'.normalPolicy',stepSpan);
      let expressions:CompiledExpression[]|undefined;
      if(s.kind!=='transfer'){
        const count=s.kind==='set-position'?3:types.includes(s.valueType)?attributeComponents(s.valueType):0;
        const values=s.kind==='capture'&&s.valueType==='scalar'?[s.expression]:s.expression;
        if(!Array.isArray(values)||values.length!==count||values.some(v=>typeof v!=='string'))error('MESH_ATTRIBUTE_EXPRESSION','Expression shape must match the declared scalar/vector type.',at+'.expression',stepSpan);
        if(s.expressionSpans!==undefined){if(!Array.isArray(s.expressionSpans)||s.expressionSpans.length!==count)error('MESH_ATTRIBUTE_SOURCE','Expected one source span per scalar expression.',at+'.expressionSpans',stepSpan);else s.expressionSpans.forEach((p:unknown,k:number)=>diagnostics.push(...validateSourceSpan(p,`${at}.expressionSpans[${k}]`)));}
        if(diagnostics.length===start)expressions=values.map((text:string,k:number)=>{try{const compiled=compileExpression(text,bundle.expressions?.parameters??{},s.expressionSpans?.[k]??stepSpan,localTypes);
          if(compiled.type.kind!=='scalar'||Object.values(compiled.type.dimension).some(v=>v!==0))error('MESH_ATTRIBUTE_EXPRESSION_TYPE','Mesh expressions require dimensionless scalar components in the declared mesh units.',`${at}.expression[${k}]`,s.expressionSpans?.[k]??stepSpan);
          return compiled;
        }catch(cause){diagnostics.push(...located(cause,`${at}.expression[${k}]`,s.expressionSpans?.[k]??stepSpan).diagnostics);return undefined;}}) as CompiledExpression[];
      }
      if(diagnostics.length!==start)return;
      try{if(s.kind==='capture')metadata=attachMeshAttributes(metadata,{[s.name]:{domain:s.domain,valueType:s.valueType,buffer:buffer(attributeComponents(s.valueType),[])}});
        else if(s.kind==='transfer'){const attribute=transferMeshAttribute(metadata,s.source,{to:s.domain,method:s.method,...(s.orphan!==undefined?{orphan:s.orphan}:{}),...(s.zeroArea!==undefined?{zeroArea:s.zeroArea}:{})});metadata=attachMeshAttributes(metadata,{[s.name]:attribute});}
        if(Object.keys(metadata.attributes!.values).length>MAX_MESH_ATTRIBUTES)error('MESH_ATTRIBUTE_BUDGET','Too many named attributes.',at,stepSpan);
      }catch(cause){diagnostics.push(...located(cause,at,stepSpan).diagnostics);}
      if(diagnostics.length===start)steps.push({step:freezeSnapshot(s as MeshAttributeStep),path:at,...(expressions?{expressions}:{})});
    });
    if(diagnostics.length===before){entries.push({operation:freezeSnapshot(raw as MeshAttributeOperation),path,steps});Object.defineProperty(available,raw.resourceId,{value:metadata as MeshResource,enumerable:true,configurable:true});}
  });
  if(totalSteps>MESH_ATTRIBUTE_MAX_TOTAL_STEPS)error('MESH_ATTRIBUTE_BUDGET','At most 128 steps are supported across the program.','$.meshAttributes.operations');
  return result();
}
export function validateMeshAttributeProgram(input:unknown,bundle:Bundle):Diagnostic[]{return inspect(input,bundle).diagnostics;}
/** @internal Base JSON and parameter declarations have already been validated. */
export function validateMeshAttributeProgramInContext(input:unknown,bundle:Bundle):Diagnostic[]{return inspect(input,bundle,true).diagnostics;}
function located(cause:unknown,path:string,span?:DeepReadonly<SourceSpan>):OperationValidationError{
  const diagnostics=(cause as {diagnostics?:readonly Diagnostic[]})?.diagnostics??[{severity:'error' as const,code:'MESH_ATTRIBUTE_EVALUATION',message:String(cause)}];
  return new OperationValidationError(diagnostics.map(d=>({...d,path:d.path?.startsWith('$.meshAttributes')?d.path:path,...(d.sourceSpan?{}:span?{sourceSpan:structuredClone(span)}:{})})));
}
function fail(code:string,message:string):never{throw new OperationValidationError([{severity:'error',code,message}]);}
/** Evaluate ordered captures/transfers at each absolute sample; position changes preserve captured topology. */
export function prepareMeshAttributeProgram(input:MeshAttributeProgram,bundle:Bundle,generatedResources?:Readonly<Record<string,DeepReadonly<Resource>>>):PreparedMeshAttributeProgram{
  const {diagnostics,entries}=inspect(input,bundle);if(hasErrors(diagnostics))throw new OperationValidationError(diagnostics);
  const resolve=prepareParameterResolver(bundle.expressions?.parameters??{}),authored=freezeSnapshot(bundle.resources);
  const supplied=(value:unknown):Readonly<Record<string,DeepReadonly<Resource>>>=>{
    const ds=validateAssetJson(value,'$.generatedResources');if(hasErrors(ds))throw new OperationValidationError(ds);
    if(!object(value))throw new OperationValidationError([{severity:'error',code:'MESH_ATTRIBUTE_CONTEXT',message:'Expected a generated resource dictionary.',path:'$.generatedResources'}]);
    return value as Readonly<Record<string,DeepReadonly<Resource>>>;
  };
  const defaults=freezeSnapshot(supplied(generatedResources??{}));
  const upstream=generatedResources===undefined&&bundle.surfaces?prepareSurfaceProgram(bundle.surfaces,bundle):undefined;
  const sample=(time:number,overrides?:Readonly<Record<string,ExpressionValue>>,generated?:Readonly<Record<string,DeepReadonly<Resource>>>):MeshAttributeSample=>{
    if(!Number.isFinite(time))throw new RangeError('Attribute sample time must be finite.');const parameters=resolve(overrides);
    const currentInputs=generated===undefined?(upstream?.sample(time,overrides).resources??defaults):supplied(generated);
    const resources:Record<string,DeepReadonly<MeshResource>>=Object.create(null),reports:MeshAttributeEvaluation=Object.create(null);let work=0;
    for(const entry of entries){const o=entry.operation;try{
      const inputResource=Object.hasOwn(resources,o.source)?resources[o.source]:Object.hasOwn(authored,o.source)?authored[o.source]:currentInputs[o.source];
      if(inputResource?.kind!=='mesh'||inputResource.units!==o.units)fail('MESH_ATTRIBUTE_SOURCE','Supply the declared source mesh in matching units.');
      const original=snapshotMeshResource(inputResource);let current=original;const steps:MeshAttributeEvaluation[string]['steps']=[];
      for(const prepared of entry.steps){const s=prepared.step,span=s.sourceSpan??o.sourceSpan;try{
        if(s.kind==='transfer'){
          const sourceAttribute=current.attributes?.values[s.source],count=s.domain==='vertex'?current.positions.count:s.domain==='face'?current.indices.count/3:current.indices.count;
          if(!sourceAttribute)fail('ATTRIBUTE_MISSING','The requested source attribute is absent from the current mesh.');
          work+=count*attributeComponents(sourceAttribute.valueType);if(work>MESH_ATTRIBUTE_MAX_EVALUATIONS)fail('MESH_ATTRIBUTE_BUDGET','More than 1048576 evaluated components.');
          const attribute=transferMeshAttribute(current,s.source,{to:s.domain,method:s.method,...(s.orphan!==undefined?{orphan:s.orphan}:{}),...(s.zeroArea!==undefined?{zeroArea:s.zeroArea}:{})});
          current=attachMeshAttributes(current,{[s.name]:attribute});steps.push({kind:s.kind,name:s.name,domain:s.domain,elements:attribute.buffer.count});continue;
        }
        const domain=s.kind==='capture'?s.domain:'vertex',components=s.kind==='capture'?attributeComponents(s.valueType):3;
        const count=domain==='vertex'?current.positions.count:domain==='face'?current.indices.count/3:current.indices.count;
        work+=count*components;if(work>MESH_ATTRIBUTE_MAX_EVALUATIONS||count*components>MAX_MESH_ATTRIBUTE_COMPONENTS)fail('MESH_ATTRIBUTE_BUDGET','Evaluated component budget exceeded.');
        const context=createMeshFieldContext(original,current,domain,time),data:number[]=[];
        for(const element of context.elements){const [x,y,z]=element.position,[ox,oy,oz]=element.originalPosition,values={...parameters,x,y,z,ox,oy,oz,index:element.index};
          prepared.expressions!.forEach((expression,k)=>{try{data.push(evaluateExpression(expression,{time,parameters:values}) as number);}catch(cause){throw located(cause,`${prepared.path}.expression[${k}]`,s.expressionSpans?.[k]??span);}});
        }
        if(s.kind==='capture'){current=attachMeshAttributes(current,{[s.name]:{domain:s.domain,valueType:s.valueType,buffer:buffer(components,data)}});steps.push({kind:s.kind,name:s.name,domain:s.domain,elements:count});}
        else {const {normals:ignored,...rest}=current;let bounds:MeshResource['bounds']=null;
          if(data.length){bounds={min:[Infinity,Infinity,Infinity],max:[-Infinity,-Infinity,-Infinity]};data.forEach((n,i)=>{bounds!.min[i%3]=Math.min(bounds!.min[i%3],n);bounds!.max[i%3]=Math.max(bounds!.max[i%3],n);});}
          current=snapshotMeshResource({...rest,positions:buffer(3,data),bounds});steps.push({kind:s.kind,elements:count});}
      }catch(cause){throw located(cause,prepared.path,span);}}
      resources[o.resourceId]=current;reports[o.id]={source:o.source,resourceId:o.resourceId,steps,attributes:Object.keys(current.attributes?.values??{})};
    }catch(cause){throw located(cause,entry.path,o.sourceSpan);}}
    return Object.freeze({resources:Object.freeze(resources),meshAttributes:freezeSnapshot(reports)});
  };
  const base=sample(0);return Object.freeze({resourceIds:Object.freeze(entries.map(e=>e.operation.resourceId)),baseResources:base.resources,sample});
}
