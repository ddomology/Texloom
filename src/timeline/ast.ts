import type {Track,TrackValue,Node} from '../schema.js';
import type {CorrespondenceOptions} from '../geometry/correspondence.js';
import type {MorphProgram} from './morph.js';
import type {Diagnostic,SourceSpan} from '../ir/operations.js';
import {validateJsonData,validateSourceSpan} from '../operations/values.js';

export type Easing='linear'|'smooth'|'step';
interface Source {id?:string;sourceSpan?:SourceSpan}
export type TimelineNode=Source & (
  {kind:'sequence'|'parallel';children:TimelineNode[]} |
  {kind:'stagger';children:TimelineNode[];lag:number} |
  {kind:'wait';duration:number} | {kind:'cue';name:string} |
  {kind:'tween';target:string;property:string;duration:number;from?:TrackValue;to:TrackValue;easing?:Easing} |
  {kind:'set';target:string;property:string;value:TrackValue} |
  {kind:'morph';id:string;source:string;destination:string;duration:number;easing?:Easing;correspondence:CorrespondenceOptions} |
  {kind:'clone';id:string;source:string} |
  {kind:'enter'|'exit';target:string;duration:number;easing?:Easing;mode?:'fade'|'create'});
export interface TimelineProgram {version:1;origin?:number;root:TimelineNode}
export interface TimelineCue {name:string;time:number;sourceSpan?:SourceSpan}
export interface TimelineClip {id:string;kind:'tween'|'set';target:string;property:string;start:number;end:number;sourceSpan?:SourceSpan}
export interface TimelineMetadata {version:1;origin:number;end:number;duration:number;cues:TimelineCue[];clips:TimelineClip[]}
export interface CompiledTimeline {tracks:Track[];cues:TimelineCue[];clips:TimelineClip[];origin:number;end:number;duration:number;
  generatedNodes?:Node[];morphs?:MorphProgram}
export const TIMELINE_MAX_DEPTH=32,TIMELINE_MAX_NODES=4096;

/** The runtime only receives schedule metadata, never an authoring AST. */
export function validateTimelineMetadata(value:unknown,sceneDuration:number):Diagnostic[]{
  const diagnostics=validateJsonData(value,'$.timeline');if(diagnostics.length)return diagnostics;
  const object=(v:unknown):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
  const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
  const name=(v:unknown):v is string=>typeof v==='string'&&v.trim()===v&&v.length>0;
  const fail=(message:string,path:string)=>diagnostics.push({severity:'error',code:'TIMELINE_METADATA',message,path});
  const keys=(v:Record<string,any>,allowed:string[],path:string)=>{for(const key of Object.keys(v))if(!allowed.includes(key))fail(`Unknown metadata field ${key}.`,path+'.'+key);};
  if(!object(value)){fail('Expected timeline metadata.','$.timeline');return diagnostics;}
  keys(value,['version','origin','end','duration','cues','clips'],'$.timeline');
  if(value.version!==1)fail('Expected timeline metadata version 1.','$.timeline.version');
  if(!finite(value.origin)||value.origin<0||!finite(value.end)||value.end<value.origin||value.end>sceneDuration||!finite(value.duration)||value.duration!==value.end-value.origin)
    fail('Timeline extent must stay within the scene duration.','$.timeline');
  for(const key of ['cues','clips'])if(!Array.isArray(value[key])||value[key].length>TIMELINE_MAX_NODES)fail(`Expected at most ${TIMELINE_MAX_NODES} ${key}.`,'$.timeline.'+key);
  const names=new Set<string>(),ids=new Set<string>();
  if(Array.isArray(value.cues))value.cues.forEach((cue:unknown,i:number)=>{
    const path=`$.timeline.cues[${i}]`;if(!object(cue)){fail('Expected a cue.',path);return;}
    keys(cue,['name','time','sourceSpan'],path);
    if(!name(cue.name)||names.has(cue.name))fail('Cue names must be unique nonempty strings.',path+'.name');else names.add(cue.name);
    if(!finite(cue.time)||cue.time<value.origin||cue.time>value.end)fail('Cue must be inside the inclusive timeline extent.',path+'.time');
    if(cue.sourceSpan!==undefined)diagnostics.push(...validateSourceSpan(cue.sourceSpan,path+'.sourceSpan'));
  });
  if(Array.isArray(value.clips))value.clips.forEach((clip:unknown,i:number)=>{
    const path=`$.timeline.clips[${i}]`;if(!object(clip)){fail('Expected a clip.',path);return;}
    keys(clip,['id','kind','target','property','start','end','sourceSpan'],path);
    if(!name(clip.id)||ids.has(clip.id))fail('Clip IDs must be unique nonempty strings.',path+'.id');else ids.add(clip.id);
    if(!['tween','set'].includes(clip.kind)||!name(clip.target)||!name(clip.property))fail('Expected a named tween/set target and property.',path);
    if(!finite(clip.start)||!finite(clip.end)||clip.start<value.origin||clip.end<clip.start||clip.end>value.end||clip.kind==='set'&&clip.end!==clip.start)
      fail('Clip intervals must stay within the timeline extent; sets have zero duration.',path);
    if(clip.sourceSpan!==undefined)diagnostics.push(...validateSourceSpan(clip.sourceSpan,path+'.sourceSpan'));
  });
  return diagnostics;
}
