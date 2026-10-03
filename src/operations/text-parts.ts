import type {VectorResource,PaintItem} from '../schema.js';
import {OperationValidationError,type Diagnostic,type DeepReadonly} from '../ir/operations.js';
import {selectTextParts,validateTextParts,type TextPartSelection,type PaintAddress} from '../ir/text-parts.js';
import {validateJsonData,freezeSnapshot} from './values.js';

export type MathPartAnchor=[number,number]|'logical-center';
export interface MathPartMapping {source:string;target:string;mode:'replace'|'copy';sourceAnchor:MathPartAnchor;targetAnchor:MathPartAnchor}
export interface MathCorrespondenceOptions {
  approved:true;retention:'replace'|'keep-source';pairs:MathPartMapping[];unmatched:'error'|'fade';
}
export interface NativePaintPartition {items:PaintItem[];paintPaths:PaintAddress[]}
export interface PreparedMathPair {
  id:string;sourcePartId:string;targetPartId:string;mode:'replace'|'copy';sourceAnchor:[number,number];targetAnchor:[number,number];
  sourceSelection:TextPartSelection;targetSelection:TextPartSelection;sourceText?:string;targetText?:string;
}
export interface MathCorrespondenceReport {
  version:1;approved:true;retention:'replace'|'keep-source';unmatched:'error'|'fade';
  sourcePaintLeaves:number;targetPaintLeaves:number;sourceMappedPaintLeaves:number;targetMappedPaintLeaves:number;
  sourceRemainderPaintLeaves:number;targetRemainderPaintLeaves:number;
  sourceUses:{sourcePartId:string;replacePairs:string[];copyPairs:string[];paintLeaves:number}[];
  pairs:{id:string;sourcePartId:string;targetPartId:string;mode:'replace'|'copy';sourcePartIds:string[];targetPartIds:string[];
    sourcePaintLeaves:number;targetPaintLeaves:number;sourceAnchor:[number,number];targetAnchor:[number,number];
    sourceAnchorPolicy:'explicit'|'logical-center';targetAnchorPolicy:'explicit'|'logical-center'}[];
  endpointPolicy:'native-resources';
}
export interface PreparedMathCorrespondence {
  contract:'texloom-math-correspondence/1';retention:'replace'|'keep-source';unmatched:'error'|'fade';
  source:VectorResource;target:VectorResource;pairs:PreparedMathPair[];
  sourceRemainder:NativePaintPartition;targetRemainder:NativePaintPartition;report:MathCorrespondenceReport;
}
export const MATH_PART_MAX_PAIRS=256;
const MAX_LEAVES=65536,MAX_ITEMS=131072,MAX_INSTANCED_LEAVES=262144;
type Obj=Record<string,any>;
const object=(value:unknown):value is Obj=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const name=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=256&&value.trim()===value;
const addressKey=(value:readonly number[])=>value.join('/');
function fail(code:string,message:string,path:string,related?:Diagnostic['related']):never {
  throw new OperationValidationError([{severity:'error',code,message,path,...(related?{related}:{})}]);
}
function keys(value:Obj,allowed:string[],path:string):void {
  for(const key of Object.keys(value))if(!allowed.includes(key))fail('MATH_PART_PROPERTY',`Unknown field ${key}.`,path+'.'+key);
}
interface Inventory {addresses:PaintAddress[];opacityScopes:{path:string;leaves:string[]}[]}
function inventory(resource:DeepReadonly<VectorResource>,side:string):Inventory {
  const addresses:PaintAddress[]=[],opacityScopes:Inventory['opacityScopes']=[];let items=0;
  const visit=(children:DeepReadonly<PaintItem[]>,prefix:PaintAddress):string[]=>{
    const all:string[]=[];
    for(const [index,item] of children.entries()){
      if(++items>MAX_ITEMS)fail('MATH_PART_LIMIT','Native paint inventory exceeds 131072 items.',side+'.items');
      const address=[...prefix,index];let leaves:string[];
      if(item.kind==='path'){
        if(addresses.length>=MAX_LEAVES)fail('MATH_PART_LIMIT','Native paint inventory exceeds 65536 leaves.',side+'.items');
        addresses.push(address);leaves=[addressKey(address)];
      }else leaves=visit(item.children??[],address);
      if(item.style?.opacity!==undefined&&item.style.opacity!==1&&leaves.length)
        opacityScopes.push({path:side+'.items/'+addressKey(address),leaves});
      all.push(...leaves);
    }
    return all;
  };
  visit(resource.items,[]);return {addresses,opacityScopes};
}
function partition(resource:DeepReadonly<VectorResource>,addresses:PaintAddress[]):NativePaintPartition {
  const included=new Set(addresses.map(addressKey)),prefixes=new Set(addresses.flatMap(address=>address.map((_,i)=>addressKey(address.slice(0,i+1)))));
  const prune=(items:DeepReadonly<PaintItem[]>,prefix:PaintAddress):PaintItem[]=>items.flatMap((item,index)=>{
    const address=[...prefix,index],key=addressKey(address);if(!prefixes.has(key))return [];
    if(item.kind==='path')return included.has(key)?[structuredClone(item) as PaintItem]:[];
    return [{...structuredClone(item),children:prune(item.children??[],address)} as PaintItem];
  });
  return {items:prune(resource.items,[]),paintPaths:structuredClone(addresses)};
}
function sourceText(resource:DeepReadonly<VectorResource>,id:string):string|undefined {
  const range=resource.textParts?.parts.find(part=>part.id===id)?.sourceRange;
  return range&&resource.sourceTex!==undefined?Array.from(resource.sourceTex).slice(range.start,range.end).join(''):undefined;
}
function anchor(input:unknown,selection:DeepReadonly<TextPartSelection>,id:string,path:string):[number,number] {
  if(input==='logical-center'){
    const box=selection.parts.find(part=>part.id===id)?.logicalBox;
    if(!box)fail('MATH_PART_ANCHOR',`Part ${id} has no measured logicalBox; supply an explicit resource-local [x,y] anchor.`,path);
    const result:[number,number]=[box[0]+box[2]/2,box[1]+box[3]/2];
    if(!result.every(Number.isFinite))fail('MATH_PART_ANCHOR','Measured logical center exceeds finite coordinates.',path);
    return result;
  }
  if(!Array.isArray(input)||input.length!==2||!input.every(value=>typeof value==='number'&&Number.isFinite(value)))
    fail('MATH_PART_ANCHOR','Anchor requires explicit finite resource-local [x,y] coordinates or logical-center.',path);
  return [...input] as [number,number];
}

/** Author-approved native paint correspondence. No glyph-index or text matching.
 * Original resources are exact endpoint snapshots; partitions keep native local
 * coordinates, clipping and paint trees. Their bounds are never guessed. */
export function prepareMathCorrespondence(source:DeepReadonly<VectorResource>,target:DeepReadonly<VectorResource>,options:DeepReadonly<MathCorrespondenceOptions>):DeepReadonly<PreparedMathCorrespondence> {
  const dataErrors=[...validateJsonData(source,'$.source'),...validateJsonData(target,'$.target'),...validateJsonData(options,'$.correspondence')];
  if(dataErrors.length)throw new OperationValidationError(dataErrors);
  if(!object(options))fail('MATH_PART_OPTIONS','Expected an explicit correspondence configuration.','$.correspondence');
  keys(options,['approved','retention','pairs','unmatched'],'$.correspondence');
  if(options.approved!==true)fail('MATH_PART_APPROVAL','Correspondence must be explicitly approved by the author.','$.correspondence.approved');
  if(!['replace','keep-source'].includes(options.retention))fail('MATH_PART_RETENTION','Expected replace or keep-source retention.','$.correspondence.retention');
  if(!['error','fade'].includes(options.unmatched))fail('MATH_PART_UNMATCHED','Unmatched native paint requires error or fade.','$.correspondence.unmatched');
  if(!Array.isArray(options.pairs)||options.pairs.length>MATH_PART_MAX_PAIRS)fail('MATH_PART_LIMIT','Expected at most 256 explicit pairs.','$.correspondence.pairs');
  for(const [side,resource] of [['source',source],['target',target]] as const){
    if(!object(resource))fail('MATH_PART_RESOURCE','Expected a vector resource.',`$.${side}`);
    const errors=validateTextParts(resource.textParts??{version:1,parts:[]},resource,`$.${side}.textParts`);
    if(errors.length)throw new OperationValidationError(errors);
  }
  const sourceInventory=inventory(source,'$.source'),targetInventory=inventory(target,'$.target');
  const sourceOwners=new Map<string,string>(),targetOwners=new Map<string,string>(),targetIds=new Set<string>();
  const sourceSelections=new Map<string,DeepReadonly<TextPartSelection>>(),targetSelections=new Map<string,DeepReadonly<TextPartSelection>>();
  const pairs:PreparedMathPair[]=[],pairReports:MathCorrespondenceReport['pairs']=[],uses=new Map<string,MathCorrespondenceReport['sourceUses'][number]>();
  let instancedLeaves=0;
  const selection=(resource:DeepReadonly<VectorResource>,id:string,cache:Map<string,DeepReadonly<TextPartSelection>>,path:string):DeepReadonly<TextPartSelection>=>{
    let selected=cache.get(id);
    if(!selected){
      try{selected=selectTextParts({...resource,textParts:resource.textParts??{version:1,parts:[]}},{ids:[id],scope:'descendants',overlap:'error'});}
      catch(error){if(error instanceof OperationValidationError)throw new OperationValidationError(error.diagnostics.map(d=>({...d,path})));throw error;}
      cache.set(id,selected);
    }
    return selected;
  };
  for(const [index,raw] of options.pairs.entries()){
    const path=`$.correspondence.pairs[${index}]`;
    if(!object(raw))fail('MATH_PART_PAIR','Expected an explicit part pair.',path);
    keys(raw,['source','target','mode','sourceAnchor','targetAnchor'],path);
    if(!name(raw.source)||!name(raw.target))fail('MATH_PART_ID','Pairs require authored source and target part IDs.',path);
    if(!['replace','copy'].includes(raw.mode))fail('MATH_PART_MODE','Pair mode must be replace or copy.',path+'.mode');
    if(targetIds.has(raw.target))fail('MATH_PART_TARGET_REUSE',`Target part ${raw.target} is already assigned.`,path+'.target');
    targetIds.add(raw.target);
    const from=selection(source,raw.source,sourceSelections,path+'.source'),to=selection(target,raw.target,targetSelections,path+'.target');
    instancedLeaves+=from.paintPaths.length+to.paintPaths.length;
    if(instancedLeaves>MAX_INSTANCED_LEAVES)fail('MATH_PART_LIMIT','Mapped native paint exceeds 262144 instanced leaves.',path);
    for(const [side,selected,owners,id] of [['source',from,sourceOwners,raw.source],['target',to,targetOwners,raw.target]] as const){
      for(const address of selected.paintPaths){
        const key=addressKey(address),owner=owners.get(key);
        if(owner!==undefined&&owner!==id)fail('MATH_PART_OVERLAP',`${side} parts ${owner} and ${id} overlap native paint leaf ${key}; use disjoint authored parts.`,path+'.'+side);
        owners.set(key,id);
      }
    }
    const id=`math-pair-${index}`,sourceAnchor=anchor(raw.sourceAnchor,from,raw.source,path+'.sourceAnchor'),targetAnchor=anchor(raw.targetAnchor,to,raw.target,path+'.targetAnchor');
    const before=sourceText(source,raw.source),after=sourceText(target,raw.target);
    pairs.push({id,sourcePartId:raw.source,targetPartId:raw.target,mode:raw.mode,sourceAnchor,targetAnchor,
      sourceSelection:from as TextPartSelection,targetSelection:to as TextPartSelection,...(before===undefined?{}:{sourceText:before}),...(after===undefined?{}:{targetText:after})});
    const use=uses.get(raw.source)??{sourcePartId:raw.source,replacePairs:[],copyPairs:[],paintLeaves:from.paintPaths.length};
    (raw.mode==='replace'?use.replacePairs:use.copyPairs).push(id);uses.set(raw.source,use);
    pairReports.push({id,sourcePartId:raw.source,targetPartId:raw.target,mode:raw.mode,sourcePartIds:[...from.partIds],targetPartIds:[...to.partIds],
      sourcePaintLeaves:from.paintPaths.length,targetPaintLeaves:to.paintPaths.length,sourceAnchor,targetAnchor,
      sourceAnchorPolicy:raw.sourceAnchor==='logical-center'?'logical-center':'explicit',targetAnchorPolicy:raw.targetAnchor==='logical-center'?'logical-center':'explicit'});
  }
  for(const use of uses.values())if(options.retention==='replace'?use.replacePairs.length!==1:use.replacePairs.length!==0)
    fail('MATH_PART_COPY_POLICY',options.retention==='replace'?`Source part ${use.sourcePartId} requires exactly one replace pair; additional uses must be copy.`:
      `keep-source retention permits only copy pairs for ${use.sourcePartId}.`,'$.correspondence.pairs');
  const sourceRemaining=sourceInventory.addresses.filter(address=>!sourceOwners.has(addressKey(address))),targetRemaining=targetInventory.addresses.filter(address=>!targetOwners.has(addressKey(address)));
  if(options.unmatched==='error'&&(sourceRemaining.length||targetRemaining.length))
    fail('MATH_PART_UNMATCHED',`Unmatched native paint: ${sourceRemaining.length} source leaves and ${targetRemaining.length} target leaves, including unmarked paint. Use fade or map complete coverage.`,'$.correspondence.unmatched');
  for(const [native,owners] of [[sourceInventory,sourceOwners],[targetInventory,targetOwners]] as const){
    for(const scope of native.opacityScopes){
      const partitions=new Set(scope.leaves.map(key=>owners.has(key)?'part:'+owners.get(key):'remainder'));
      if(partitions.size>1)fail('MATH_PART_OPACITY_PARTITION','A native isolated opacity scope crosses mapped/remainder partitions; mark and move the whole scope together.',scope.path);
    }
  }
  return freezeSnapshot({contract:'texloom-math-correspondence/1',retention:options.retention,unmatched:options.unmatched,source,target,pairs,
    sourceRemainder:partition(source,sourceRemaining),targetRemainder:partition(target,targetRemaining),
    report:{version:1,approved:true,retention:options.retention,unmatched:options.unmatched,
      sourcePaintLeaves:sourceInventory.addresses.length,targetPaintLeaves:targetInventory.addresses.length,
      sourceMappedPaintLeaves:sourceOwners.size,targetMappedPaintLeaves:targetOwners.size,
      sourceRemainderPaintLeaves:sourceRemaining.length,targetRemainderPaintLeaves:targetRemaining.length,
      sourceUses:[...uses.values()],pairs:pairReports,endpointPolicy:'native-resources'}} as PreparedMathCorrespondence);
}
