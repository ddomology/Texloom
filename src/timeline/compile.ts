import {assertBundle,propertySpec,type Bundle,type Track,type TrackValue,type Node} from '../schema.js';
import {OperationValidationError,type SourceSpan,type Diagnostic,type DeepReadonly} from '../ir/operations.js';
import {validateJsonData,validateSourceSpan,freezeSnapshot} from '../operations/values.js';
import {geometryPointSlot} from '../path-contract.js';
import {prepareExecutionPlan} from '../operations/plan.js';
import type {TimelineProgram,TimelineCue,TimelineClip,CompiledTimeline,Easing} from './ast.js';
import {TIMELINE_MAX_DEPTH,TIMELINE_MAX_NODES} from './ast.js';
import {materializeTimeline} from './materialize.js';

type Obj=Record<string,any>;
const object=(v:unknown):v is Obj=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
const named=(v:unknown):v is string=>typeof v==='string'&&v.trim()===v&&v.length>0;
interface Ancestor {path:string;kind:string;index:number}
interface Action extends TimelineClip {to:TrackValue;from?:TrackValue;easing:Easing;path:string;ancestry:Ancestor[];order:number}
function fail(code:string,message:string,path:string,sourceSpan?:SourceSpan,related?:Diagnostic['related']):never {
  throw new OperationValidationError([{severity:'error',code,message,path,...(sourceSpan?{sourceSpan}:{}),...(related?{related}:{})}]);
}
function add(a:number,b:number,path:string,span?:SourceSpan):number {
  const result=a+b;
  if(!Number.isFinite(result))fail('TIMELINE_TIME','Schedule arithmetic exceeded finite seconds.',path,span);
  if(b>0&&result<=a)fail('TIMELINE_PRECISION','Positive duration is not representable at this start time.',path,span);
  return result;
}
function checkValue(value:unknown,target:Node|Bundle['camera'],property:string,path:string,span?:SourceSpan):asserts value is TrackValue {
  const spec=propertySpec('kind'in target?target.kind:'camera',property);
  if(!spec)fail('TIMELINE_PROPERTY',`Property ${property} is not a numeric animation property.`,path,span);
  if(spec.size?(!Array.isArray(value)||value.length!==spec.size||!value.every(finite)):
    (!finite(value)||spec.min!==undefined&&value<spec.min||spec.strictMin!==undefined&&value<=spec.strictMin||spec.max!==undefined&&value>spec.max))
    fail('TIMELINE_VALUE',`Value does not satisfy the shape or bounds of ${property}.`,path,span);
  if(property.startsWith('geometry.')&&(!('kind'in target)||target.kind!=='path'||!geometryPointSlot(target.geometry,property)))
    fail('TIMELINE_TARGET','Geometry property must name an existing path control.',path,span);
  if(property==='reveal'&&(!('kind'in target)||target.kind!=='path'||!target.geometry))
    fail('TIMELINE_TARGET','Reveal requires an editable path.',path,span);
}
function baseValue(target:Node|Bundle['camera'],property:string):TrackValue|undefined {
  if(property.startsWith('geometry.')&&'kind'in target&&target.kind==='path')return geometryPointSlot(target.geometry,property)?.get();
  const parts=property.split('.'),record=target as unknown as Obj;
  const actual=parts.length===1?record[property]:record[parts[0]]?.[parts[1]];
  if(actual!==undefined)return actual;
  const defaults:Record<string,TrackValue>={'transform.translate':[0,0],'transform.scale':[1,1],'transform.rotate':0,'style.opacity':1};
  if(Object.hasOwn(defaults,property))return defaults[property];
  if('kind'in target){
    if(target.kind==='point'&&['phase','progress'].includes(property))return 0;
    if(target.kind==='path'&&property==='reveal')return 1;
    if(target.kind==='tex'&&property==='scale')return 1;
  }else if(property==='rotation')return 0;
  // Paint properties other than opacity may inherit from ancestors. An absent
  // value is deliberately not replaced with an invented local paint default.
  return;
}
function orderedBefore(a:Action,b:Action):boolean {
  for(let i=0;i<Math.min(a.ancestry.length,b.ancestry.length);i++){
    const x=a.ancestry[i],y=b.ancestry[i];
    if(x.path!==y.path)return false;
    if(x.index!==y.index)return x.kind==='sequence'&&x.index<y.index;
  }
  return false;
}
function conflict(a:Action,b:Action):boolean {
  const az=a.start===a.end,bz=b.start===b.end;
  if(!az&&!bz)return Math.max(a.start,b.start)<Math.min(a.end,b.end);
  if(az&&bz)return a.start===b.start&&!orderedBefore(a,b)&&!orderedBefore(b,a);
  const zero=az?a:b,tween=az?b:a;
  if(zero.start>tween.start&&zero.start<tween.end)return true;
  return zero.start===tween.start&&!orderedBefore(zero,tween);
}

/** Compile bounded authoring structure to one right-continuous numeric track
 * per property. The source program and input scene are never mutated. */
export function compileTimeline(program:TimelineProgram,bundle:Bundle):DeepReadonly<CompiledTimeline> {
  assertBundle(bundle);
  if(bundle.version!=='0.3')fail('TIMELINE_VERSION','Timeline compilation requires Bundle 0.3.','$.version');
  if(bundle.timeline!==undefined)fail('TIMELINE_PRESENT','This scene already contains a compiled timeline.','$.timeline');
  const errors=validateJsonData(program,'$.timelineProgram');if(errors.length)throw new OperationValidationError(errors);
  if(!object(program))fail('TIMELINE_PROGRAM','Expected a timeline program.','$.timelineProgram');
  const keys=(raw:Obj,allowed:string[],path:string,span?:SourceSpan)=>{for(const key of Object.keys(raw))if(!allowed.includes(key))fail('TIMELINE_PROPERTY',`Unknown property ${key}.`,path+'.'+key,span);};
  keys(program,['version','origin','root'],'$.timelineProgram');
  if(program.version!==1)fail('TIMELINE_VERSION','Supported authoring version is 1.','$.timelineProgram.version');
  const materialized=materializeTimeline(program,bundle);
  program=materialized.program;bundle=materialized.bundle;
  assertBundle(bundle);
  const origin=program.origin===undefined?0:program.origin;if(!finite(origin)||origin<0||origin>bundle.duration)fail('TIMELINE_TIME','Origin must stay within scene duration.','$.timelineProgram.origin');
  const actions:Action[]=[],cues:TimelineCue[]=[],ids=new Set<string>(),names=new Set<string>(),nodes=new Map(bundle.nodes.map(n=>[n.id,n]));
  let count=0,order=0;
  const duration=(value:unknown,path:string,span?:SourceSpan):number=>{
    if(!finite(value)||value<0)fail('TIMELINE_TIME','Expected finite nonnegative seconds.',path,span);return value;
  };
  const visit=(raw:unknown,start:number,path:string,ancestry:Ancestor[],depth:number):number=>{
    if(++count>TIMELINE_MAX_NODES||depth>TIMELINE_MAX_DEPTH)fail('TIMELINE_LIMIT',`Timeline allows ${TIMELINE_MAX_NODES} nodes and depth ${TIMELINE_MAX_DEPTH}.`,path);
    if(!object(raw))fail('TIMELINE_NODE','Expected a timeline node.',path);
    if(raw.sourceSpan!==undefined){const e=validateSourceSpan(raw.sourceSpan,path+'.sourceSpan');if(e.length)throw new OperationValidationError(e);}
    const span=raw.sourceSpan as SourceSpan|undefined;
    if(raw.id!==undefined){if(!named(raw.id)||ids.has(raw.id))fail('TIMELINE_NODE','Node IDs must be unique nonempty strings.',path+'.id',span);ids.add(raw.id);}
    const common=['kind','id','sourceSpan'];
    if(['sequence','parallel','stagger'].includes(raw.kind)){
      keys(raw,[...common,'children',...(raw.kind==='stagger'?['lag']:[])],path,span);
      if(!Array.isArray(raw.children)||raw.children.length>TIMELINE_MAX_NODES)fail('TIMELINE_NODE','Group children must be a bounded array.',path+'.children',span);
      const lag=raw.kind==='stagger'?duration(raw.lag,path+'.lag',span):0;
      let groupEnd=start,lastOffset=-1,lastStart=-Infinity;
      raw.children.forEach((child:unknown,index:number)=>{
        const offset=raw.kind==='stagger'?index*lag:0;
        if(!finite(offset)||raw.kind==='stagger'&&lag>0&&index>0&&offset<=lastOffset)fail('TIMELINE_PRECISION','Stagger offsets must remain finite and distinguishable.',path,span);
        lastOffset=offset;
        const childStart=raw.kind==='sequence'?groupEnd:add(start,offset,path,span);
        if(raw.kind==='stagger'&&lag>0&&index>0&&childStart<=lastStart)fail('TIMELINE_PRECISION','Positive stagger lag must produce distinct absolute start times.',path,span);
        lastStart=childStart;
        const childEnd=visit(child,childStart,`${path}.children[${index}]`,[...ancestry,{path,kind:raw.kind,index}],depth+1);
        groupEnd=raw.kind==='sequence'?childEnd:Math.max(groupEnd,childEnd);
      });
      // Carry the realized absolute end through nested groups. Re-adding a
      // separately rounded duration would create spurious one-ULP overlaps.
      return groupEnd;
    }
    if(raw.kind==='wait'){
      keys(raw,[...common,'duration'],path,span);const value=duration(raw.duration,path+'.duration',span);return add(start,value,path,span);
    }
    if(raw.kind==='cue'){
      keys(raw,[...common,'name'],path,span);
      if(!named(raw.name)||names.has(raw.name))fail('TIMELINE_CUE','Cue names must be unique nonempty strings.',path+'.name',span);
      names.add(raw.name);cues.push({name:raw.name,time:start,...(span?{sourceSpan:span}:{})});return start;
    }
    if(raw.kind!=='tween'&&raw.kind!=='set')fail('TIMELINE_NODE',`Unknown timeline kind ${String(raw.kind)}.`,path+'.kind',span);
    keys(raw,[...common,'target','property',...(raw.kind==='tween'?['duration','from','to','easing']:['value'])],path,span);
    if(!named(raw.target)||!named(raw.property))fail('TIMELINE_TARGET','Expected a target and property.',path,span);
    const target=raw.target==='$camera'?bundle.camera:nodes.get(raw.target);if(!target)fail('TIMELINE_TARGET',`Missing target ${raw.target}.`,path+'.target',span);
    const length=raw.kind==='set'?0:duration(raw.duration,path+'.duration',span),to=raw.kind==='set'?raw.value:raw.to;
    checkValue(to,target,raw.property,path+(raw.kind==='set'?'.value':'.to'),span);
    if(raw.from!==undefined)checkValue(raw.from,target,raw.property,path+'.from',span);
    const easing=raw.easing===undefined?'linear':raw.easing;if(!['linear','smooth','step'].includes(easing))fail('TIMELINE_VALUE','Supported easing is linear, smooth or step.',path+'.easing',span);
    const end=add(start,length,path,span),id=raw.id??`clip:${path}`;
    actions.push({id,kind:length===0?'set':'tween',target:raw.target,property:raw.property,start,end,to:structuredClone(to),
      ...(raw.from===undefined?{}:{from:structuredClone(raw.from)}),easing,path,ancestry,order:order++,...(span?{sourceSpan:span}:{})});
    return end;
  };
  const end=visit(program.root,origin,'$.timelineProgram.root',[],1),length=end-origin;
  if(end>bundle.duration)fail('TIMELINE_TIME',`Timeline ends at ${end}s beyond scene duration ${bundle.duration}s.`,'$.timelineProgram');
  const generatedIds=new Set<string>();for(const a of actions){if(generatedIds.has(a.id))fail('TIMELINE_NODE',`Duplicate clip ID ${a.id}.`,a.path,a.sourceSpan);generatedIds.add(a.id);}
  const lanes=new Map<string,Action[]>();
  for(const action of actions){const key=JSON.stringify([action.target,action.property]);lanes.set(key,[...(lanes.get(key)??[]),action]);}
  const tracks:Track[]=[];
  for(const lane of lanes.values()){
    lane.sort((a,b)=>a.start-b.start||a.order-b.order);
    for(let i=0;i<lane.length;i++)for(let j=i+1;j<lane.length&&lane[j].start<=lane[i].end;j++)if(conflict(lane[i],lane[j])){
      const a=lane[i],b=lane[j];
      fail('TIMELINE_CONFLICT',`${a.target}.${a.property} has conflicting ownership [${a.start},${a.end}) and [${b.start},${b.end}).`,b.path,b.sourceSpan,
        [{message:`Earlier owner [${a.start},${a.end}).`,path:a.path,...(a.sourceSpan?{sourceSpan:a.sourceSpan}:{})}]);
    }
    const first=lane[0],target=first.target==='$camera'?bundle.camera:nodes.get(first.target)!;
    let held=baseValue(target,first.property)??first.from;
    if(held===undefined)fail('TIMELINE_BASE',`No local starting value for ${first.target}.${first.property}; provide an explicit from.`,first.path,first.sourceSpan);
    checkValue(held,target,first.property,first.path,first.sourceSpan);held=structuredClone(held);
    interface Key {time:number;value:TrackValue;left:TrackValue;easing:Easing}
    const points=new Map<number,Key>();
    const put=(time:number,value:TrackValue,left:TrackValue,easing:Easing='step')=>{
      const previous=points.get(time);points.set(time,{time,value:structuredClone(value),left:structuredClone(previous?.left??left),easing});
    };
    put(0,held,held);
    for(const action of lane){
      if(action.kind==='set'){put(action.start,action.to,held);held=structuredClone(action.to);continue;}
      const from=action.from??held;
      put(action.start,from,held,action.easing);put(action.end,action.to,action.to);held=structuredClone(action.to);
    }
    const ordered=[...points.values()].sort((a,b)=>a.time-b.time);
    tracks.push({target:first.target,property:first.property,keys:ordered.map(p=>[p.time,p.value]),
      segmentEasings:ordered.slice(0,-1).map(p=>p.easing),leftValues:ordered.map((p,i)=>i===0||JSON.stringify(p.left)===JSON.stringify(p.value)?null:p.left),
      ...(first.sourceSpan?{sourceSpan:structuredClone(first.sourceSpan)}:{})});
  }
  const clips:TimelineClip[]=actions.map(({id,kind,target,property,start,end,sourceSpan})=>({id,kind,target,property,start,end,...(sourceSpan?{sourceSpan}:{} )}));
  cues.sort((a,b)=>a.time-b.time);
  const result={tracks,cues,clips,origin,end,duration:length,
    ...(materialized.generatedNodes.length?{generatedNodes:materialized.generatedNodes}:{}),
    ...(materialized.morphs?{morphs:materialized.morphs}:{})};
  // Existing bindings and legacy tracks keep their whole-scene ownership.
  const candidate={...bundle,tracks:[...bundle.tracks,...tracks]};
  try{assertBundle(candidate);prepareExecutionPlan(candidate);}catch(error){
    const diagnostics=(error as {diagnostics?:Diagnostic[]})?.diagnostics;if(!diagnostics)throw error;
    const trackAt=(path?:string):Track|undefined=>{const match=path?.match(/^\$\.tracks\[(\d+)\]/);return match?candidate.tracks[Number(match[1])]:undefined;};
    throw new OperationValidationError(diagnostics.map(d=>{
      const track=trackAt(d.path),span=d.sourceSpan??track?.sourceSpan;
      const related=(d.related??[]).map(r=>({...r,...(r.sourceSpan?{}:trackAt(r.path)?.sourceSpan?{sourceSpan:trackAt(r.path)!.sourceSpan}:{})}));
      // The legacy track validator reports the other owner in its message.
      // Recover those explicit paths without changing its native error code.
      for(const match of d.message.matchAll(/\$\.tracks\[\d+\]/g))if(match[0]!==d.path&&!related.some(r=>r.path===match[0])){
        const previous=trackAt(match[0]);related.push({message:'Other track writer.',path:match[0],...(previous?.sourceSpan?{sourceSpan:previous.sourceSpan}:{})});
      }
      return {...d,...(span?{sourceSpan:structuredClone(span)}:{}),...(related.length?{related}:{})};
    }));
  }
  return freezeSnapshot(result);
}

/** A lowered bundle is portable: web, video and Chalkspace read identical
 * numeric tracks. Cues are immutable metadata, never callback instructions. */
export function lowerTimeline(program:TimelineProgram,bundle:Bundle):Bundle {
  const compiled=compileTimeline(program,bundle),result=structuredClone(bundle);
  if(compiled.generatedNodes)result.nodes.push(...structuredClone(compiled.generatedNodes) as Node[]);
  if(compiled.morphs)result.morphs=structuredClone(compiled.morphs) as Bundle['morphs'];
  result.tracks.push(...structuredClone(compiled.tracks) as Track[]);
  result.timeline={version:1,origin:compiled.origin,end:compiled.end,duration:compiled.duration,cues:structuredClone(compiled.cues) as TimelineCue[],clips:structuredClone(compiled.clips) as TimelineClip[]};
  assertBundle(result);prepareExecutionPlan(result);return result;
}
