import {validateBundle,type VectorResource,type PaintItem,type Matrix,type Style,type Clip} from '../schema.js';
import {OperationValidationError,type Diagnostic,type DeepReadonly,type SourceSpan} from './operations.js';
import {validateJsonData,validateSourceSpan,freezeSnapshot} from '../operations/values.js';
import {identityMatrix,multiplyMatrix} from '../geometry.js';
import type {PathBounds} from '../path-geometry.js';

/** Index into resource.items, then into each group's children. Not a glyph ID. */
export type PaintAddress=number[];
export interface TextPart {
  id:string;parent?:string;role?:string;
  /** End-exclusive Unicode-code-point offsets into resource.sourceTex. */
  sourceRange?:{start:number;end:number};sourceSpan?:SourceSpan;
  /** Direct ownership only. Nested parts own their own paint leaves. */
  paintPaths:PaintAddress[];
  /** Measured TeX logical box in resource-local bp; never inferred from ink. */
  logicalBox?:PathBounds;
}
export interface TextParts {version:1;parts:TextPart[]}
export interface TextPartQuery {
  ids:string[];scope:'exact'|'descendants';overlap:'error'|'ancestor-wins';
}
export interface TextPartPaintAncestor {
  paintPath:PaintAddress;transform?:Matrix;style?:Style;clip?:Clip&{transform?:Matrix};
}
export interface TextPartPaintLeaf {
  partId:string;paintPath:PaintAddress;item:PaintItem;ancestors:TextPartPaintAncestor[];
  /** Accumulated paint-tree transform into resource-local bp. */
  transform:Matrix;
}
export interface TextPartSelection {
  requestedIds:string[];partIds:string[];parts:TextPart[];paintPaths:PaintAddress[];
  /** Pruned original tree. Ancestor clipping and isolated opacity remain intact. */
  items:PaintItem[];leaves:TextPartPaintLeaf[];
}
export const TEXT_PART_MAX_PARTS=4096,TEXT_PART_MAX_PAINT_PATHS=65536,TEXT_PART_MAX_DEPTH=64;
type Obj=Record<string,any>;
type PartResource=VectorResource&{textParts?:TextParts};
const object=(value:unknown):value is Obj=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const name=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=256&&value.trim()===value;
const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value);
const addressKey=(address:readonly number[])=>address.join('/');
interface Checked {diagnostics:Diagnostic[];parts:TextPart[];resource?:PartResource}

function inspect(input:unknown,resource:unknown,path:string,inContext:boolean):Checked {
  const diagnostics=validateJsonData(input,path),parts:TextPart[]=[];
  const fail=(code:string,message:string,location=path,span?:SourceSpan)=>diagnostics.push({severity:'error',code,message,path:location,...(span?{sourceSpan:span}:{})});
  if(!inContext)diagnostics.push(...validateJsonData(resource,'$.resource'));
  if(diagnostics.length)return {diagnostics,parts};
  if(!object(resource)||resource.kind!=='vector'||!Array.isArray(resource.items)){
    fail('TEXT_PART_RESOURCE','Semantic parts require a vector resource.');return {diagnostics,parts};
  }
  if(!inContext){
    const {textParts:ignored,...native}=resource;
    diagnostics.push(...validateBundle({version:'0.3',title:'Text part validation',duration:0,units:'bp',viewport:{width:1,height:1},camera:{x:0,y:0,zoom:1},
      resources:{text:native},nodes:[],tracks:[],relations:[]}).map(d=>({...d,path:d.path?.replace('$.resources.text','$.resource')})));
    if(diagnostics.length)return {diagnostics,parts};
  }
  const context=resource as PartResource;
  const keys=(value:Obj,allowed:string[],at:string)=>{for(const key of Object.keys(value))if(!allowed.includes(key))fail('TEXT_PART_PROPERTY',`Unknown field ${key}.`,at+'.'+key);};
  if(!object(input)){fail('TEXT_PARTS','Expected semantic text parts metadata.');return {diagnostics,parts};}
  keys(input,['version','parts'],path);
  if(input.version!==1)fail('TEXT_PART_VERSION','Supported text parts version is 1.',path+'.version');
  if(!Array.isArray(input.parts)||input.parts.length>TEXT_PART_MAX_PARTS){fail('TEXT_PART_LIMIT','Expected at most 4096 text parts.',path+'.parts');return {diagnostics,parts};}
  const byId=new Map<string,{part:TextPart;path:string}>(),paintOwners=new Map<string,string>();
  const sourceLength=typeof resource.sourceTex==='string'?Array.from(resource.sourceTex).length:undefined;
  let totalAddresses=0;
  for(const [index,raw] of input.parts.entries()){
    const at=`${path}.parts[${index}]`,before=diagnostics.length;
    if(!object(raw)){fail('TEXT_PART','Expected a semantic part.',at);continue;}
    keys(raw,['id','parent','role','sourceRange','sourceSpan','paintPaths','logicalBox'],at);
    if(!name(raw.id)||byId.has(raw.id)){fail('TEXT_PART_ID','Part IDs must be unique, trimmed strings of 1..256 characters.',at+'.id');continue;}
    if(raw.sourceSpan!==undefined)diagnostics.push(...validateSourceSpan(raw.sourceSpan,at+'.sourceSpan'));
    const span=diagnostics.length===before?raw.sourceSpan as SourceSpan|undefined:undefined;
    if(raw.parent!==undefined&&!name(raw.parent))fail('TEXT_PART_PARENT','Expected a parent part ID.',at+'.parent',span);
    if(raw.role!==undefined&&!name(raw.role))fail('TEXT_PART_ROLE','Role must be a nonempty trimmed string of at most 256 characters.',at+'.role',span);
    if(raw.sourceRange===undefined&&raw.sourceSpan===undefined)fail('TEXT_PART_SOURCE','A part requires a sourceRange or an explicit sourceSpan.',at,span);
    if(raw.sourceRange!==undefined){
      const range=raw.sourceRange;
      if(!object(range))fail('TEXT_PART_SOURCE_RANGE','Expected end-exclusive source offsets.',at+'.sourceRange',span);
      else{
        keys(range,['start','end'],at+'.sourceRange');
        if(sourceLength===undefined||!Number.isSafeInteger(range.start)||!Number.isSafeInteger(range.end)||range.start<0||range.end<range.start||range.end>sourceLength)
          fail('TEXT_PART_SOURCE_RANGE','Range must lie within sourceTex Unicode-code-point offsets.',at+'.sourceRange',span);
      }
    }
    if(raw.logicalBox!==undefined&&(!Array.isArray(raw.logicalBox)||raw.logicalBox.length!==4||!raw.logicalBox.every(finite)||raw.logicalBox[2]<0||raw.logicalBox[3]<0))
      fail('TEXT_PART_LOGICAL_BOX','Logical box requires finite [x,y,width,height] with nonnegative dimensions.',at+'.logicalBox',span);
    if(!Array.isArray(raw.paintPaths)||raw.paintPaths.length>TEXT_PART_MAX_PAINT_PATHS){fail('TEXT_PART_PAINT','Expected an array of at most 65536 paint leaf addresses.',at+'.paintPaths',span);continue;}
    totalAddresses+=raw.paintPaths.length;
    if(totalAddresses>TEXT_PART_MAX_PAINT_PATHS){fail('TEXT_PART_LIMIT','Part ownership exceeds 65536 paint addresses.',at+'.paintPaths',span);break;}
    raw.paintPaths.forEach((address:unknown,j:number)=>{
      const location=`${at}.paintPaths[${j}]`;
      if(!Array.isArray(address)||!address.length||address.length>TEXT_PART_MAX_DEPTH||!address.every(n=>Number.isSafeInteger(n)&&n>=0)){
        fail('TEXT_PART_PAINT','An address requires 1..64 nonnegative integer indices.',location,span);return;
      }
      let items:PaintItem[]=context.items,found:PaintItem|undefined;
      for(let level=0;level<address.length;level++){
        found=items[address[level]];
        if(!found||(level<address.length-1&&(found.kind!=='group'||!found.children))){found=undefined;break;}
        if(level<address.length-1)items=found.children!;
      }
      if(found?.kind!=='path'){fail('TEXT_PART_PAINT','Address must resolve to a path leaf in the original paint tree.',location,span);return;}
      const key=addressKey(address),owner=paintOwners.get(key);
      if(owner!==undefined)fail('TEXT_PART_PAINT_OWNER',`Paint leaf already belongs directly to ${owner}; ancestors select it through descendants.`,location,span);
      else paintOwners.set(key,raw.id);
    });
    if(diagnostics.length===before){const part=raw as TextPart;parts.push(part);byId.set(part.id,{part,path:at});}
  }
  if(diagnostics.length)return {diagnostics,parts};
  for(const {part,path:at} of byId.values()){
    const chain=new Set<string>([part.id]);let current=part;
    while(current.parent!==undefined){
      const parent=byId.get(current.parent)?.part;
      if(!parent){fail('TEXT_PART_PARENT',`Unknown parent ${current.parent}.`,at+'.parent',part.sourceSpan);break;}
      if(chain.has(parent.id)){fail('TEXT_PART_CYCLE','Semantic part parents must form an acyclic hierarchy.',at+'.parent',part.sourceSpan);break;}
      chain.add(parent.id);
      if(chain.size>TEXT_PART_MAX_DEPTH){fail('TEXT_PART_LIMIT','Semantic nesting exceeds 64 parts.',at+'.parent',part.sourceSpan);break;}
      if(current.sourceRange&&parent.sourceRange&&(current.sourceRange.start<parent.sourceRange.start||current.sourceRange.end>parent.sourceRange.end)){
        fail('TEXT_PART_SOURCE_NESTING','Child sourceRange must be contained in its parent sourceRange.',at+'.sourceRange',part.sourceSpan);break;
      }
      current=parent;
    }
  }
  return {diagnostics,parts,resource:context};
}

export function validateTextParts(input:unknown,resource:unknown,path='$.textParts'):Diagnostic[]{return inspect(input,resource,path,false).diagnostics;}
/** @internal Native vector paint and resource data have already been validated. */
export function validateTextPartsInContext(input:unknown,resource:VectorResource,path='$.textParts'):Diagnostic[]{return inspect(input,resource,path,true).diagnostics;}

/** Select original native paint without rebasing glyphs or recomputing TeX layout. */
export function selectTextParts(resource:DeepReadonly<PartResource>,query:DeepReadonly<TextPartQuery>):DeepReadonly<TextPartSelection>{
  const dataErrors=[...validateJsonData(resource,'$.resource'),...validateJsonData(query,'$.query')];
  if(dataErrors.length)throw new OperationValidationError(dataErrors);
  if(!object(resource))throw new OperationValidationError([{severity:'error',code:'TEXT_PART_RESOURCE',message:'Semantic parts require a vector resource.',path:'$.resource'}]);
  const checked=inspect(resource.textParts,resource,'$.textParts',false),diagnostics=checked.diagnostics;
  const fail=(code:string,message:string,path='$.query')=>diagnostics.push({severity:'error',code,message,path});
  if(!object(query)){fail('TEXT_PART_QUERY','Expected a selection query.');throw new OperationValidationError(diagnostics);}
  for(const key of Object.keys(query))if(!['ids','scope','overlap'].includes(key))fail('TEXT_PART_QUERY',`Unknown query field ${key}.`);
  if(!Array.isArray(query.ids)||query.ids.length>TEXT_PART_MAX_PARTS||!query.ids.every(name)||new Set(query.ids).size!==query.ids.length)
    fail('TEXT_PART_QUERY','ids must contain at most 4096 distinct authored IDs.');
  if(!['exact','descendants'].includes(query.scope))fail('TEXT_PART_QUERY','scope must be exact or descendants.');
  if(!['error','ancestor-wins'].includes(query.overlap))fail('TEXT_PART_QUERY','overlap must be error or ancestor-wins.');
  if(diagnostics.length)throw new OperationValidationError(diagnostics);
  const byId=new Map(checked.parts.map(part=>[part.id,part]));
  for(const id of query.ids)if(!byId.has(id))fail('TEXT_PART_UNKNOWN',`Unknown semantic part ${id}.`);
  if(diagnostics.length)throw new OperationValidationError(diagnostics);
  const ancestorOf=(ancestor:string,descendant:string):boolean=>{
    let current=byId.get(descendant)!;while(current.parent){if(current.parent===ancestor)return true;current=byId.get(current.parent)!;}return false;
  };
  let roots=[...query.ids];
  if(query.scope==='descendants'){
    const overlaps=roots.filter(id=>roots.some(other=>other!==id&&ancestorOf(other,id)));
    if(overlaps.length&&query.overlap==='error'){fail('TEXT_PART_OVERLAP',`Ancestor and descendant selections overlap: ${overlaps.join(', ')}.`);throw new OperationValidationError(diagnostics);}
    roots=roots.filter(id=>!overlaps.includes(id));
  }
  const parts=checked.parts.filter(part=>roots.includes(part.id)||query.scope==='descendants'&&roots.some(id=>ancestorOf(id,part.id)));
  const owners=new Map(parts.flatMap(part=>part.paintPaths.map(address=>[addressKey(address),part.id] as const)));
  const prefixes=new Set(parts.flatMap(part=>part.paintPaths.flatMap(address=>address.map((_,i)=>addressKey(address.slice(0,i+1))))));
  const leaves:TextPartPaintLeaf[]=[];
  const prune=(items:PaintItem[],prefix:PaintAddress,ancestors:TextPartPaintAncestor[],parentTransform:Matrix):PaintItem[]=>items.flatMap((item,index):PaintItem[]=>{
    const address=[...prefix,index];if(!prefixes.has(addressKey(address)))return [];
    const transform=multiplyMatrix(parentTransform,item.transform??identityMatrix());
    if(!transform.every(Number.isFinite))throw new OperationValidationError([{severity:'error',code:'TEXT_PART_TRANSFORM',message:'Accumulated paint transform is not finite.',path:'$.resource.items'}]);
    if(item.kind==='path'){
      const partId=owners.get(addressKey(address));if(partId===undefined)return [];
      leaves.push({partId,paintPath:address,item,ancestors,transform});return [item];
    }
    const context:TextPartPaintAncestor={paintPath:address,...(item.transform?{transform:item.transform}:{}),...(item.style?{style:item.style}:{}),...(item.clip?{clip:item.clip}:{})};
    const children=prune(item.children??[],address,[...ancestors,context],transform);
    return children.length?[{...item,children}]:[];
  });
  const items=prune(checked.resource!.items,[],[],identityMatrix());
  return freezeSnapshot({requestedIds:[...query.ids],partIds:parts.map(part=>part.id),parts,paintPaths:leaves.map(leaf=>leaf.paintPath),items,leaves});
}
