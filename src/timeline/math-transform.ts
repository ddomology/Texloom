import {validateBundle,type Bundle,type Node,type TexNode,type GroupNode,type VectorResource,type PaintItem} from '../schema.js';
import {OperationValidationError,type Diagnostic,type SourceSpan,type DeepReadonly} from '../ir/operations.js';
import {validateJsonData,validateSourceSpan,freezeSnapshot} from '../operations/values.js';
import {prepareMathCorrespondence,type MathCorrespondenceOptions,type PreparedMathCorrespondence,type PreparedMathPair} from '../operations/text-parts.js';
import type {PropertyAccess} from '../operations/properties.js';

export interface MathTransformOptions extends MathCorrespondenceOptions {labels:{source:string;target:string}}
export interface MathTransformOperation {id:string;instance:string;source:string;destination:string;correspondence:MathTransformOptions;sourceSpan?:SourceSpan}
export interface MathTransformProgram {version:1;operations:MathTransformOperation[]}
export interface MathTransformReport {progress:number;state:'source'|'transition'|'target';active:boolean;sourceText:string;targetText:string;description:string;retention:'replace'|'keep-source'}
export type MathTransformEvaluation=Readonly<Record<string,DeepReadonly<MathTransformReport>>>;
export interface PreparedMathTransform {operation:DeepReadonly<MathTransformOperation>;path:string;reads:readonly PropertyAccess[];writes:readonly PropertyAccess[];apply(nodes:Map<string,Node>):DeepReadonly<MathTransformReport>}
type Obj=Record<string,any>;
const object=(v:unknown):v is Obj=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const name=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=256&&v.trim()===v;
const canonical=(value:any):string=>JSON.stringify(value,(_key,v)=>object(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
function fail(message:string,path='$',span?:SourceSpan,code='MATH_TRANSFORM'):never {
  throw new OperationValidationError([{severity:'error',code,message,path,...(span?{sourceSpan:span}:{})}]);
}
function nativeResource(bundle:Bundle,node:TexNode):VectorResource {
  const r=Object.hasOwn(bundle.resources,node.resourceId)?bundle.resources[node.resourceId]:undefined;
  if(r?.kind!=='vector')fail('Math endpoints require native vector resources.');return r;
}
export function mathTransformNames(id:string,count:number){return {
  source:`${id}:source`,target:`${id}:target`,sourceRest:`${id}:source-rest`,targetRest:`${id}:target-rest`,
  pairs:Array.from({length:count},(_,i)=>({source:`${id}:pair:${i}:source`,target:`${id}:pair:${i}:target`})),
};}
interface Built {nodes:Node[];resources:Record<string,VectorResource>;prepared:DeepReadonly<PreparedMathCorrespondence>;source:TexNode;target:TexNode;opacity:number}
/** Produce normal native-paint nodes. The endpoints are hidden authored templates. */
export function createMathTransformInstance(operation:MathTransformOperation,bundle:Bundle):Built {
  const errors=validateJsonData(operation,'$.mathTransform');if(errors.length)throw new OperationValidationError(errors);
  if(!object(operation))fail('Expected a math transition declaration.');
  for(const key of Object.keys(operation))if(!['id','instance','source','destination','correspondence','sourceSpan'].includes(key))fail(`Unknown transition field ${key}.`);
  if(operation.sourceSpan){const d=validateSourceSpan(operation.sourceSpan,'$.mathTransform.sourceSpan');if(d.length)throw new OperationValidationError(d);}
  if(!name(operation.id)||operation.id!==operation.instance||operation.id==='$camera')fail('A math transition requires a unique ID equal to its instance.');
  const source=bundle.nodes.find(n=>n.id===operation.source),target=bundle.nodes.find(n=>n.id===operation.destination);
  if(source?.kind!=='tex'||target?.kind!=='tex'||source.id===target.id||source.visible!==false||target.visible!==false)
    fail('Source and destination must be distinct hidden authored TeX templates (visible:false).');
  if(!same(source.parent,target.parent)||!same(source.transform,target.transform)||!same(source.clip,target.clip))
    fail('Math endpoints must share parent, transform and clip; x/y/scale may differ.');
  const opacity=source.style?.opacity??1;
  if(opacity!==(target.style?.opacity??1))fail('Endpoint opacity must agree so its shared compositing scope can be preserved.');
  if(!object(operation.correspondence))fail('Expected explicit math correspondence.');
  const {labels,...options}=operation.correspondence;
  if(!object(labels)||Object.keys(labels).some(k=>!['source','target'].includes(k))||!(['source','target'] as const).every(k=>typeof labels[k]==='string'&&labels[k].trim().length>0&&labels[k].length<=4096))
    fail('Provide nonempty plain-language labels.source and labels.target (at most 4096 characters).');
  const a=nativeResource(bundle,source),b=nativeResource(bundle,target),prepared=prepareMathCorrespondence(a,b,options);
  const names=mathTransformNames(operation.id,prepared.pairs.length),resources:Record<string,VectorResource>={};
  const group:GroupNode={id:operation.id,kind:'group',mathProgress:0,visible:true,style:{opacity:0},
    ...(source.parent===undefined?{}:{parent:source.parent}),...(source.transform?{transform:structuredClone(source.transform)}:{}),
    ...(source.clip?{clip:structuredClone(source.clip)}:{}),source:{mathTransform:{source:source.id,destination:target.id}}};
  const nodes:Node[]=[group];
  if(prepared.retention==='keep-source')for(const role of ['retained','moving'])
    nodes.push({id:operation.id+':'+role,kind:'group',parent:operation.id,style:{opacity}});
  const add=(id:string,template:TexNode,resource:VectorResource,items?:DeepReadonly<PaintItem[]>):void=>{
    let resourceId=template.resourceId;
    if(items!==undefined){
      resourceId=id+':art';const {textParts:unused,glyphs:oldGlyphs,...rest}=structuredClone(resource);
      resources[resourceId]={...rest,items:structuredClone(items) as PaintItem[],capabilities:['math-transform-selection'],
        provenance:{mathTransform:{instance:operation.id,sourceResource:template.resourceId,metricsPolicy:'source-resource',inkBoundsPolicy:'source-resource'}}} as VectorResource;
    }
    const parent=prepared.retention==='keep-source'?operation.id+(id===names.source?':retained':':moving'):operation.id;
    const node:TexNode={...structuredClone(template),id,parent,resourceId,visible:true,style:{...template.style,opacity:0},source:{mathTransform:{instance:operation.id}}};
    delete node.transform;delete node.clip;nodes.push(node);
  };
  add(names.source,source,a);add(names.target,target,b);
  add(names.sourceRest,source,a,prepared.sourceRemainder.items);add(names.targetRest,target,b,prepared.targetRemainder.items);
  prepared.pairs.forEach((pair,i)=>{add(names.pairs[i].source,source,a,pair.sourceSelection.items);add(names.pairs[i].target,target,b,pair.targetSelection.items);});
  return {nodes,resources,prepared,source:structuredClone(source),target:structuredClone(target),opacity:prepared.retention==='keep-source'?1:opacity};
}
/** Conservative equality: identical native outlines and anchor-relative placement.
 * Clip/opacity scopes use crossfade unless exactly absent. No string matching. */
function samePaint(pair:DeepReadonly<PreparedMathPair>,source:TexNode,target:TexNode):boolean {
  const a=pair.sourceSelection.leaves,b=pair.targetSelection.leaves;
  if(a.length!==b.length||!same(source.style,target.style))return false;
  return a.every((leaf,i)=>{
    const other=b[i];if(leaf.item.d!==other.item.d||leaf.item.clip||other.item.clip)return false;
    if([...leaf.ancestors,...other.ancestors].some(p=>p.clip||p.style?.opacity!==undefined&&p.style.opacity!==1))return false;
    const style=(entry:typeof leaf)=>Object.assign({},...entry.ancestors.map(p=>p.style??{}),entry.item.style??{});
    if(!same(style(leaf),style(other)))return false;
    return leaf.transform.every((v,k)=>Math.abs((v-(k===4?pair.sourceAnchor[0]:k===5?pair.sourceAnchor[1]:0))-
      (other.transform[k]-(k===4?pair.targetAnchor[0]:k===5?pair.targetAnchor[1]:0)))<=2e-6);
  });
}
function visibleReads(id:string,nodes:ReadonlyMap<string,Node>):PropertyAccess[]{
  const result:PropertyAccess[]=[],seen=new Set<string>();let node=nodes.get(id);
  while(node&&!seen.has(node.id)){seen.add(node.id);result.push({node:node.id,property:'visible'},{node:node.id,property:'style.opacity'});node=node.parent?nodes.get(node.parent):undefined;}return result;
}
function isVisible(id:string,nodes:ReadonlyMap<string,Node>):boolean {
  let node=nodes.get(id);const seen=new Set<string>();
  while(node&&!seen.has(node.id)){seen.add(node.id);if(node.visible===false||(node.style?.opacity??1)<=0)return false;node=node.parent?nodes.get(node.parent):undefined;}return true;
}
interface Entry {operation:MathTransformOperation;path:string;built:Built}
function inspect(input:unknown,bundle:Bundle,inContext=false):{diagnostics:Diagnostic[];entries:Entry[]} {
  const diagnostics=validateJsonData(input,'$.mathTransforms'),entries:Entry[]=[];
  if(!object(bundle)){diagnostics.push({severity:'error',code:'MATH_TRANSFORM_CONTEXT',message:'Expected a scene bundle.',path:'$'});return {diagnostics,entries};}
  if(diagnostics.length)return {diagnostics,entries};
  if(bundle.version!=='0.3'){diagnostics.push({severity:'error',code:'MATH_TRANSFORM_VERSION',message:'Math transforms require Bundle 0.3.',path:'$.version'});return {diagnostics,entries};}
  if(!inContext){const {mathTransforms:ignored,...base}=bundle;diagnostics.push(...validateBundle(base));}
  if(diagnostics.some(d=>d.severity==='error'))return {diagnostics,entries};
  if(!object(input)||input.version!==1||Object.keys(input).some(k=>!['version','operations'].includes(k))||!Array.isArray(input.operations)||input.operations.length>128){
    diagnostics.push({severity:'error',code:'MATH_TRANSFORM_PROGRAM',message:'Expected version 1 with at most 128 math transforms.',path:'$.mathTransforms'});return {diagnostics,entries};
  }
  const ids=new Set<string>(),nodes=new Map(bundle.nodes.map(n=>[n.id,n]));
  input.operations.forEach((op:unknown,i:number)=>{
    const path=`$.mathTransforms.operations[${i}]`;
    try{
      const built=createMathTransformInstance(op as MathTransformOperation,bundle),operation=op as MathTransformOperation;
      if(ids.has(operation.id))fail('Duplicate math transform ID.',path);ids.add(operation.id);
      const instance=nodes.get(operation.instance);
      if(instance?.kind!=='group'||!Number.isFinite(instance.mathProgress)||instance.mathProgress!<0||instance.mathProgress!>1)fail('Instance group requires mathProgress in [0,1].',path);
      if(Object.keys(instance.style??{}).some(key=>key!=='opacity'))fail('Instance painting is controlled by native endpoints; only opacity may be overridden.',path);
      const expected=built.nodes[0];
      for(const key of ['parent','transform','clip','visible'])if(!same((instance as unknown as Obj)[key],(expected as unknown as Obj)[key]))fail(`Instance ${key} differs from authored context.`,path);
      for(const child of built.nodes.slice(1))if(!same(nodes.get(child.id),child))fail(`Generated helper ${child.id} does not match native selection; regenerate it.`,path);
      for(const [id,resource] of Object.entries(built.resources))if(!same(bundle.resources[id],resource))fail(`Generated selection resource ${id} does not match native paint.`,path);
      entries.push({operation,path,built});
    }catch(error){const ds=error instanceof OperationValidationError?error.diagnostics:[{severity:'error' as const,code:'MATH_TRANSFORM',message:String(error)}];
      diagnostics.push(...ds.map(d=>({...d,path,...(d.sourceSpan?{}:object(op)&&op.sourceSpan?{sourceSpan:op.sourceSpan}:{})})));}
  });return {diagnostics,entries};
}
export function validateMathTransformProgram(input:unknown,bundle:Bundle):Diagnostic[]{return inspect(input,bundle).diagnostics;}
export function validateMathTransformProgramInContext(input:unknown,bundle:Bundle):Diagnostic[]{return inspect(input,bundle,true).diagnostics;}
export function prepareMathTransformProgram(input:MathTransformProgram,bundle:Bundle):{operations:readonly PreparedMathTransform[]}{
  const checked=inspect(input,bundle);if(checked.diagnostics.some(d=>d.severity==='error'))throw new OperationValidationError(checked.diagnostics);
  const nodes=new Map(bundle.nodes.map(n=>[n.id,n]));
  return {operations:checked.entries.map(({operation,path,built}):PreparedMathTransform=>{
    const {prepared,source,target}=built,names=mathTransformNames(operation.id,prepared.pairs.length),samePairs=prepared.pairs.map(p=>samePaint(p,source,target));
    const helpers=built.nodes.filter(n=>n.kind==='tex').map(n=>n.id);
    // Internal paint, transforms and visibility are reserved even when held
    // constant; external animation belongs on the public instance container.
    const writes=[...built.nodes.slice(1).flatMap(n=>['x','y','scale','style','transform','visible'].map(property=>({node:n.id,property}))),
      ...['fill','stroke','strokeWidth','fillOpacity','strokeOpacity','dash','lineCap','lineJoin','fillRule','miterLimit']
        .map(key=>({node:operation.instance,property:'style.'+key}))];
    return {operation:freezeSnapshot(operation),path,reads:[{node:operation.instance,property:'mathProgress'},...visibleReads(operation.instance,nodes)],writes,
      apply(frameNodes){
        const p=(frameNodes.get(operation.instance) as GroupNode).mathProgress!;
        if(!Number.isFinite(p)||p<0||p>1)fail('Math progress must stay in [0,1].',path,operation.sourceSpan);
        const node=(id:string)=>frameNodes.get(id) as TexNode;
        const alpha=(id:string,value:number)=>{const n=node(id);n.style={...n.style,opacity:value};};
        helpers.forEach(id=>alpha(id,0));
        if(p===0)alpha(names.source,1);
        else if(p===1){alpha(names.target,1);if(prepared.retention==='keep-source')alpha(names.source,1);}
        else {
          if(prepared.retention==='keep-source')alpha(names.source,1);else alpha(names.sourceRest,1-p);
          alpha(names.targetRest,p);
          prepared.pairs.forEach((pair,i)=>{
            const s=source.scale??1,t=target.scale??1,scale=(1-p)*s+p*t;
            const a=[source.x+s*pair.sourceAnchor[0],source.y+s*pair.sourceAnchor[1]],b=[target.x+t*pair.targetAnchor[0],target.y+t*pair.targetAnchor[1]];
            const at=[(1-p)*a[0]+p*b[0],(1-p)*a[1]+p*b[1]];
            for(const [id,anchor] of [[names.pairs[i].source,pair.sourceAnchor],[names.pairs[i].target,pair.targetAnchor]] as const){
              const n=node(id);n.x=at[0]-scale*anchor[0];n.y=at[1]-scale*anchor[1];n.scale=scale;
              if(![n.x,n.y,n.scale].every(Number.isFinite))fail('Interpolated anchor placement is not finite.',path,operation.sourceSpan);
            }
            const strength=pair.mode==='copy'?p:1;
            alpha(names.pairs[i].source,strength*(samePairs[i]?1:1-p));alpha(names.pairs[i].target,samePairs[i]?0:strength*p);
          });
        }
        const state=p===0?'source':p===1?'target':'transition',labels=operation.correspondence.labels;
        const description=state==='source'?labels.source:state==='transition'?`Transforming ${labels.source} into ${labels.target}.`:
          prepared.retention==='keep-source'?`${labels.source}; copied to ${labels.target}.`:labels.target;
        return freezeSnapshot({progress:p,state,active:isVisible(operation.instance,frameNodes)&&
          (prepared.retention!=='keep-source'||(source.style?.opacity??1)>0),sourceText:labels.source,targetText:labels.target,description,retention:prepared.retention});
      }};
  })};
}
