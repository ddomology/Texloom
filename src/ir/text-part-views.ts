import {validateBundle,type Bundle,type Node,type TexNode,type VectorResource,type PaintItem} from '../schema.js';
import {OperationValidationError,type Diagnostic,type SourceSpan,type DeepReadonly} from './operations.js';
import {validateJsonData,validateSourceSpan} from '../operations/values.js';
import {selectTextParts,type TextPartQuery} from './text-parts.js';

export interface TextPartViewRecord {
  id:string;sourceId:string;query:TextPartQuery;
  /** Recolor active path fills, preserving fill:none; opacity belongs to the view node. */
  style?:{fill?:string;opacity?:number};sourceSpan?:SourceSpan;
}
type Obj=Record<string,any>;
const object=(value:unknown):value is Obj=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const name=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=256&&value.trim()===value;

function inheritedFill(node:Node,nodes:ReadonlyMap<string,Node>):string {
  let current:Node|undefined=node;
  while(current){if(current.style?.fill!==undefined)return current.style.fill;current=current.parent?nodes.get(current.parent):undefined;}
  return '#e7eee4';
}
function recolor(items:PaintItem[],color:string,parentFill:string):void {
  for(const item of items){
    const effective=item.style?.fill??parentFill;
    if(item.kind==='group')recolor(item.children??[],color,effective);
    else item.style={...item.style,fill:effective==='none'?'none':color};
  }
}

/** Create ordinary static TeX nodes/resources using authored native placement.
 * Original metrics and full ink bounds are retained for alignment, not claimed
 * as bounds of the selected paint. No live link to the source node is added. */
export function lowerTextPartViews(bundle:Bundle,records:DeepReadonly<TextPartViewRecord[]>):Bundle {
  const diagnostics=[...validateJsonData(bundle,'$'),...validateJsonData(records,'$.textPartViews')];
  if(!diagnostics.length)diagnostics.push(...validateBundle(bundle));
  if(diagnostics.some(d=>d.severity==='error'))throw new OperationValidationError(diagnostics);
  const fail=(code:string,message:string,path:string,sourceSpan?:SourceSpan)=>diagnostics.push({severity:'error',code,message,path,...(sourceSpan?{sourceSpan}:{})});
  if(!Array.isArray(records)||records.length>256){fail('TEXT_PART_VIEW_LIMIT','Expected at most 256 semantic part views.','$.textPartViews');throw new OperationValidationError(diagnostics);}
  const result=structuredClone(bundle),sources=new Map(bundle.nodes.map(node=>[node.id,node])),ids=new Set(sources.keys());
  const resourceIds=new Set(Object.keys(bundle.resources)),locations:{nodeIndex:number;resourceId:string;sourceSpan?:SourceSpan}[]=[];
  records.forEach((input:unknown,index:number)=>{
    const path=`$.textPartViews[${index}]`,before=diagnostics.length;
    if(!object(input)){fail('TEXT_PART_VIEW','Expected a part view record.',path);return;}
    if(input.sourceSpan!==undefined){diagnostics.push(...validateSourceSpan(input.sourceSpan,path+'.sourceSpan'));if(diagnostics.length>before)return;}
    const span=input.sourceSpan as SourceSpan|undefined;
    for(const key of Object.keys(input))if(!['id','sourceId','query','style','sourceSpan'].includes(key))fail('TEXT_PART_VIEW_PROPERTY',`Unknown view field ${key}.`,path+'.'+key,span);
    if(!name(input.id)||ids.has(input.id)){fail('TEXT_PART_VIEW_ID','View IDs must be unique, trimmed strings of 1..256 characters and cannot replace a scene node.',path+'.id',span);return;}
    const resourceId=`${input.id}-parts`;
    if(resourceIds.has(resourceId)){fail('TEXT_PART_VIEW_RESOURCE',`Generated resource ${resourceId} already exists.`,path+'.id',span);return;}
    const source=name(input.sourceId)?sources.get(input.sourceId):undefined;
    if(source?.kind!=='tex'){fail('TEXT_PART_VIEW_SOURCE','sourceId must reference an existing authored TeX node.',path+'.sourceId',span);return;}
    const resource=Object.hasOwn(bundle.resources,source.resourceId)?bundle.resources[source.resourceId]:undefined;
    if(resource?.kind!=='vector'){fail('TEXT_PART_VIEW_RESOURCE','Source TeX node must reference a vector resource.',path+'.sourceId',span);return;}
    if(input.style!==undefined){
      if(!object(input.style))fail('TEXT_PART_VIEW_STYLE','Expected fill/opacity style overrides.',path+'.style',span);
      else{
        for(const key of Object.keys(input.style))if(!['fill','opacity'].includes(key))fail('TEXT_PART_VIEW_STYLE',`Unsupported style override ${key}.`,path+'.style.'+key,span);
        if(input.style.fill!==undefined&&(typeof input.style.fill!=='string'||!input.style.fill.trim().length))fail('TEXT_PART_VIEW_STYLE','Fill must be a nonempty paint string.',path+'.style.fill',span);
        if(input.style.opacity!==undefined&&(typeof input.style.opacity!=='number'||!Number.isFinite(input.style.opacity)||input.style.opacity<0||input.style.opacity>1))fail('TEXT_PART_VIEW_STYLE','Opacity must be finite and in [0,1].',path+'.style.opacity',span);
      }
    }
    if(diagnostics.length>before)return;
    try{
      const selection=selectTextParts(resource,input.query);
      const {textParts:ignoredParts,glyphs:ignoredGlyphs,...original}=structuredClone(resource);
      const provenance=object((original as Obj).provenance)?(original as Obj).provenance:{};
      const selected:VectorResource&{provenance:Record<string,unknown>}={...original,items:structuredClone(selection.items) as PaintItem[],
        capabilities:[...(original.capabilities??[]).filter(capability=>capability!=='semantic-text-parts'),'semantic-part-view'],
        provenance:{...provenance,textPartView:{originalResourceId:source.resourceId,sourceId:source.id,
          requestedIds:[...selection.requestedIds],partIds:[...selection.partIds],scope:input.query.scope,overlap:input.query.overlap,
          metricsPolicy:'source-resource',inkBoundsPolicy:'source-resource',...(span?{sourceSpan:structuredClone(span)}:{})}}};
      if(input.style?.fill!==undefined)recolor(selected.items,input.style.fill,inheritedFill(source,sources));
      const node:TexNode={...structuredClone(source),id:input.id,resourceId,
        ...(input.style?{style:{...structuredClone(source.style??{}),...input.style}}:{}),
        source:{...structuredClone(source.source??{}),textPartView:{sourceId:source.id,originalResourceId:source.resourceId,partIds:[...selection.partIds],...(span?{sourceSpan:structuredClone(span)}:{})}}};
      ids.add(input.id);resourceIds.add(resourceId);locations.push({nodeIndex:result.nodes.length,resourceId,sourceSpan:span});
      result.nodes.push(node);result.resources[resourceId]=selected;
    }catch(error){
      const errors=error instanceof OperationValidationError?error.diagnostics:[{severity:'error' as const,code:'TEXT_PART_VIEW',message:error instanceof Error?error.message:String(error)}];
      diagnostics.push(...errors.map(d=>({...d,path:path+'.query',...(d.sourceSpan?{}:span?{sourceSpan:span}:{})})));
    }
  });
  if(diagnostics.some(d=>d.severity==='error'))throw new OperationValidationError(diagnostics);
  diagnostics.push(...validateBundle(result).map(d=>{
    const location=locations.find(entry=>d.path?.startsWith(`$.nodes[${entry.nodeIndex}]`)||d.path?.startsWith(`$.resources.${entry.resourceId}`));
    return {...d,...(d.sourceSpan||!location?.sourceSpan?{}:{sourceSpan:structuredClone(location.sourceSpan)})};
  }));
  if(diagnostics.some(d=>d.severity==='error'))throw new OperationValidationError(diagnostics);
  return result;
}
