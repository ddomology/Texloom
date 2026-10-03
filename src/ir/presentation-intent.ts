import {validateBundle,type Bundle,type EvaluatedFrame,type Node,type Matrix,type Resource} from '../schema.js';
import {OperationValidationError,type DeepReadonly,type Diagnostic,type SourceSpan} from './operations.js';
import {validateJsonData,validateSourceSpan,freezeSnapshot} from '../operations/values.js';
import {geometryBounds,revealGeometry,sampleGeometry,PathGeometryError,type PathGeometry,type PathBounds,type PathPoint} from '../path-geometry.js';
import {worldMatrix,transformPoint,transformVector} from '../geometry.js';

export type PresentationMode='stroke'|'fill'|'glyph-outline';
interface PresentationEventBase {id:string;start:number;end:number;sourceSpan?:SourceSpan}
export interface DrawIntent extends PresentationEventBase {
  kind:'draw';target:string;mode:PresentationMode;
  /** Editable contour ID, not an inferred glyph or handwriting stroke. */
  pathId?:string;tool?:'chalk'|'none';contact?:'continuous'|'none';
}
export interface EraseIntent extends PresentationEventBase {kind:'erase';targets:string[];tool?:'eraser'|'none'}
export type PresentationEvent=DrawIntent|EraseIntent;
export interface PresentationProgram {version:1;seed:number;events:PresentationEvent[]}
export type PresentationPhase='before'|'begin'|'active'|'complete'|'held';
export type PresentationEventState=PresentationEvent&{phase:PresentationPhase;progress:number;eventSeed:number};
export interface PresentationPose {
  local:PathPoint;world:PathPoint;tangentLocal?:PathPoint;tangentWorld?:PathPoint;
  contact:boolean;contourId?:string;segmentId?:string;
}
export interface PresentationTargetState {
  target:string;state:'hidden'|'drawing'|'held'|'erasing'|'erased';
  drawEventId?:string;eraseEventId?:string;drawProgress:number;eraseProgress:number;mode?:PresentationMode;
  /** Node-local paint coordinates, including TeX x/y/scale. Includes conservative stroke padding. */
  localBounds:PathBounds;worldBounds:PathBounds;worldMatrix:Matrix;
  /** Native editable prefix in the same node-local coordinates; original geometry is untouched. */
  strokePrefix?:PathGeometry;pose?:PresentationPose;
}
export interface PresentationEvaluation {version:1;seed:number;events:PresentationEventState[];targets:PresentationTargetState[]}
export interface PreparedPresentationProgram {
  readonly program:DeepReadonly<PresentationProgram>;
  evaluate(frame:Pick<EvaluatedFrame,'time'|'nodes'|'resources'>):DeepReadonly<PresentationEvaluation>;
}
export const PRESENTATION_MAX_EVENTS=4096,PRESENTATION_MAX_TARGET_REFS=65536;
const object=(v:unknown):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
const name=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=256&&v.trim()===v;
const targets=(event:PresentationEvent):readonly string[]=>event.kind==='draw'?[event.target]:event.targets;
function inspect(input:unknown,bundle:unknown,path:string,inContext:boolean):Diagnostic[] {
  const errors=validateJsonData(input,path);
  if(!inContext)errors.push(...validateJsonData(bundle,'$'));
  if(errors.length)return errors;
  const error=(code:string,message:string,at=path,span?:SourceSpan)=>errors.push({severity:'error',code,message,path:at,...(span?{sourceSpan:span}:{})});
  if(!object(bundle)){error('PRESENTATION_CONTEXT','Expected a scene bundle.');return errors;}
  if(!inContext){const {presentation:ignored,...base}=bundle;errors.push(...validateBundle(base));if(errors.some(e=>e.severity==='error'))return errors;}
  if(!Array.isArray(bundle.nodes)||!finite(bundle.duration)||bundle.nodes.some((node:unknown)=>!object(node)||!name(node.id))){error('PRESENTATION_CONTEXT','Expected validated scene nodes and duration.');return errors;}
  if(bundle.version!=='0.3')error('PRESENTATION_VERSION','Presentation intent requires Bundle 0.3.');
  if(!object(input)||input.version!==1||!Number.isInteger(input.seed)||input.seed<0||input.seed>0xffffffff||!Array.isArray(input.events)){
    error('PRESENTATION_PROGRAM','Expected version 1, a uint32 seed and an events array.');return errors;
  }
  const keys=(v:Record<string,unknown>,allowed:string[],at:string)=>{for(const key of Object.keys(v))if(!allowed.includes(key))error('PRESENTATION_FIELD',`Unknown property ${key}.`,at+'.'+key);};
  keys(input,['version','seed','events'],path);
  if(input.events.length>PRESENTATION_MAX_EVENTS){error('PRESENTATION_BUDGET',`At most ${PRESENTATION_MAX_EVENTS} events are supported.`);return errors;}
  const nodes=new Map<string,Node>(bundle.nodes.map((node:Node)=>[node.id,node]));
  const ids=new Set<string>(),draws=new Map<string,DrawIntent>(),erases=new Map<string,EraseIntent>();let refs=0;
  for(const [index,event] of input.events.entries()){
    const at=`${path}.events[${index}]`;
    if(!object(event)||!['draw','erase'].includes(event.kind)){error('PRESENTATION_EVENT','Expected a draw or erase event.',at);continue;}
    keys(event,event.kind==='draw'?['kind','id','target','start','end','mode','pathId','tool','contact','sourceSpan']:['kind','id','targets','start','end','tool','sourceSpan'],at);
    if(event.sourceSpan!==undefined)errors.push(...validateSourceSpan(event.sourceSpan,at+'.sourceSpan'));
    if(!name(event.id)||ids.has(event.id))error('PRESENTATION_ID','Event IDs must be nonempty, unique and at most 256 characters.',at+'.id');
    else ids.add(event.id);
    if(!finite(event.start)||!finite(event.end)||event.start<0||event.end<event.start||event.end>bundle.duration)
      error('PRESENTATION_INTERVAL','Expected 0 <= start <= end <= scene duration.',at,event.sourceSpan);
    if(event.kind==='draw'){
      if(!['stroke','fill','glyph-outline'].includes(event.mode))error('PRESENTATION_MODE','Expected stroke, fill or glyph-outline.',at+'.mode');
      if(event.tool!==undefined&&!['chalk','none'].includes(event.tool))error('PRESENTATION_TOOL','Draw tool must be chalk or none.',at+'.tool');
      if(event.contact!==undefined&&!['continuous','none'].includes(event.contact))error('PRESENTATION_CONTACT','Contact must be continuous or none.',at+'.contact');
      if(event.pathId!==undefined&&(!name(event.pathId)||event.mode!=='stroke'))error('PRESENTATION_PATH','pathId is an editable contour ID for stroke mode.',at+'.pathId');
    }else{
      if(event.tool!==undefined&&!['eraser','none'].includes(event.tool))error('PRESENTATION_TOOL','Erase tool must be eraser or none.',at+'.tool');
      if(!Array.isArray(event.targets)||!event.targets.length||event.targets.length>PRESENTATION_MAX_TARGET_REFS){error('PRESENTATION_TARGET','Erase requires a bounded nonempty targets array.',at+'.targets');continue;}
    }
    const eventTargets=event.kind==='draw'?[event.target]:event.targets;
    refs+=eventTargets.length;if(refs>PRESENTATION_MAX_TARGET_REFS){error('PRESENTATION_BUDGET','Presentation target references exceed the budget.',at);return errors;}
    const unique=new Set<string>();
    for(const target of eventTargets){
      const node=nodes.get(target);
      if(!name(target)||!node||unique.has(target)){error('PRESENTATION_TARGET',`Unknown or duplicate target ${String(target)}.`,at,event.sourceSpan);continue;}
      unique.add(target);
      if(!['path','line','ellipse','point','tex'].includes(node.kind)||node.kind==='path'&&!node.geometry)
        error('PRESENTATION_GEOMETRY',`Target ${target} needs native TeX, a primitive, or editable path geometry.`,at,event.sourceSpan);
      if(event.kind==='draw'){
        if(draws.has(target))error('PRESENTATION_LIFECYCLE',`Only one draw event is supported for ${target}.`,at,event.sourceSpan);
        else draws.set(target,event as DrawIntent);
        if(event.mode==='glyph-outline'&&node.kind!=='tex'||event.mode==='fill'&&!['path','ellipse','point'].includes(node.kind)||event.mode==='stroke'&&!['path','line'].includes(node.kind))
          error('PRESENTATION_MODE',`Mode ${event.mode} is incompatible with ${node.kind}.`,at,event.sourceSpan);
        if(event.mode==='stroke'&&node.kind==='path'&&node.geometry){
          if(node.geometry.contours.length!==1||event.pathId!==undefined&&node.geometry.contours[0]?.id!==event.pathId)
            error('PRESENTATION_PATH','Stroke mode requires a single-contour target; pathId, when supplied, must match it. Split multiple contours into separate nodes.',at+'.pathId',event.sourceSpan);
        }
        if(event.pathId!==undefined&&node.kind!=='path')error('PRESENTATION_PATH','pathId is only supported on editable path nodes.',at+'.pathId');
      }else{
        if(erases.has(target))error('PRESENTATION_LIFECYCLE',`Only one erase event is supported for ${target}.`,at,event.sourceSpan);
        else erases.set(target,event as EraseIntent);
      }
    }
  }
  for(const [target,erase] of erases){const draw=draws.get(target);if(draw&&erase.start<draw.end)
    error('PRESENTATION_LIFECYCLE',`Erase ${erase.id} starts before draw ${draw.id} completes for ${target}.`,path,erase.sourceSpan);}
  return errors;
}
export function validatePresentationProgram(input:unknown,bundle:unknown,path='$.presentation'):Diagnostic[]{return inspect(input,bundle,path,false);}
/** Internal schema boundary; the base scene has already been validated. */
export function validatePresentationProgramInContext(input:unknown,bundle:Bundle,path='$.presentation'):Diagnostic[]{return inspect(input,bundle,path,true);}
export function presentationEventSeed(seed:number,id:string):number {
  let hash=(0x811c9dc5^seed)>>>0;for(let i=0;i<id.length;i++)hash=Math.imul(hash^id.charCodeAt(i),0x01000193)>>>0;return hash;
}
function phase(event:DeepReadonly<PresentationEvent>,time:number):{phase:PresentationPhase;progress:number}{
  if(time<event.start)return {phase:'before',progress:0};
  if(time===event.end)return {phase:'complete',progress:1};
  if(time>event.end)return {phase:'held',progress:1};
  if(time===event.start)return {phase:'begin',progress:0};
  return {phase:'active',progress:(time-event.start)/(event.end-event.start)};
}
function nodeGeometry(node:Node,pathId?:string):PathGeometry|undefined {
  if(node.kind==='line')return {contours:[{id:'line',start:[node.x1,node.y1],segments:[{id:'line',kind:'line',to:[node.x2,node.y2]}]}]};
  if(node.kind!=='path'||!node.geometry)return;
  if(pathId===undefined)return node.geometry;
  const contour=node.geometry.contours.find(c=>c.id===pathId);
  if(!contour)throw new PathGeometryError('PRESENTATION_PATH',`Current geometry is missing contour ${pathId}.`);
  return {contours:[contour]};
}
function inherited(node:Node,nodes:ReadonlyMap<string,Node>,property:'strokeWidth'|'miterLimit'|'lineJoin'):unknown {
  let current:Node|undefined=node;while(current){const value=current.style?.[property];if(value!==undefined)return value;current=current.parent?nodes.get(current.parent):undefined;}
}
function bounds(node:Node,resources:Record<string,Resource>,nodes:ReadonlyMap<string,Node>):PathBounds {
  let result:PathBounds;
  if(node.kind==='tex'){
    const resource=resources[node.resourceId];if(resource.kind!=='vector')throw new Error('Presentation requires a vector resource.');
    const [x,y,w,h]=resource.inkBounds,s=node.scale??1;result=[node.x+s*x,node.y+s*y,s*w,s*h];
  }else if(node.kind==='ellipse')result=[node.cx-node.rx,node.cy-node.ry,node.rx*2,node.ry*2];
  else if(node.kind==='point')result=[node.x-node.r,node.y-node.r,node.r*2,node.r*2];
  else result=geometryBounds(nodeGeometry(node)!)??[0,0,0,0];
  const width=inherited(node,nodes,'strokeWidth');
  // Explicit/inherited stroke width is padded conservatively, including miter joins.
  const padding=typeof width==='number'?width*.5*Math.max(Math.SQRT2,(inherited(node,nodes,'lineJoin')??'miter')==='miter'?(inherited(node,nodes,'miterLimit') as number??4):1):0;
  return [result[0]-padding,result[1]-padding,result[2]+padding*2,result[3]+padding*2];
}
function visible(node:Node,nodes:ReadonlyMap<string,Node>):boolean {
  let current:Node|undefined=node;while(current){if(current.visible===false||current.style?.opacity===0)return false;current=current.parent?nodes.get(current.parent):undefined;}return true;
}
function worldBounds(matrix:Matrix,b:PathBounds):PathBounds {
  const [x,y,w,h]=b,corners=[[x,y],[x+w,y],[x,y+h],[x+w,y+h]].map(p=>transformPoint(matrix,p as PathPoint));
  const xs=corners.map(p=>p[0]),ys=corners.map(p=>p[1]),minX=Math.min(...xs),minY=Math.min(...ys);
  return [minX,minY,Math.max(...xs)-minX,Math.max(...ys)-minY];
}
function direction(matrix:Matrix,tangent?:PathPoint):PathPoint|undefined {
  if(!tangent)return;
  const scale=Math.max(...matrix.slice(0,4).map(Math.abs));if(scale===0)return;
  const raw=transformVector(matrix.map((v,i)=>i<4?v/scale:v) as Matrix,tangent),length=Math.hypot(...raw);
  return length>0?[raw[0]/length,raw[1]/length]:undefined;
}
/** Pure metadata evaluation. No mutations, media playback, random state or camera application. */
export function preparePresentationProgram(input:PresentationProgram,bundle:Bundle):PreparedPresentationProgram {
  const errors=validatePresentationProgram(input,bundle);if(errors.some(e=>e.severity==='error'))throw new OperationValidationError(errors);
  const program=freezeSnapshot(input),lanes=new Map<string,{draw?:DeepReadonly<DrawIntent>;erase?:DeepReadonly<EraseIntent>}>();
  for(const event of program.events)for(const target of targets(event as PresentationEvent)){
    const lane=lanes.get(target)??{};if(event.kind==='draw')lane.draw=event;else lane.erase=event;lanes.set(target,lane);
  }
  return Object.freeze({program,evaluate(frame:Pick<EvaluatedFrame,'time'|'nodes'|'resources'>):DeepReadonly<PresentationEvaluation>{
    if(!finite(frame.time))throw new OperationValidationError([{severity:'error',code:'PRESENTATION_TIME',message:'Presentation sample time must be finite.'}]);
    const nodes=new Map(frame.nodes.map(n=>[n.id,n]));
    const events=program.events.map(event=>({...event,...phase(event,frame.time),eventSeed:presentationEventSeed(program.seed,event.id)})) as PresentationEventState[];
    const states:PresentationTargetState[]=[];
    for(const [target,lane] of lanes){
      try{
        const node=nodes.get(target)!;if(!node)throw new Error(`Missing current target ${target}.`);
        const dp=lane.draw?phase(lane.draw,frame.time):{phase:'held' as const,progress:1},ep=lane.erase?phase(lane.erase,frame.time):{phase:'before' as const,progress:0};
        const state:PresentationTargetState['state']=dp.phase==='before'?'hidden':ep.phase==='complete'||ep.phase==='held'?'erased':ep.phase==='begin'||ep.phase==='active'?'erasing':dp.phase==='begin'||dp.phase==='active'?'drawing':'held';
        const matrix=worldMatrix(target,nodes),localBounds=bounds(node,frame.resources,nodes);
        const entry:PresentationTargetState={target,state,drawProgress:dp.progress,eraseProgress:ep.progress,localBounds,worldBounds:worldBounds(matrix,localBounds),worldMatrix:matrix,
          ...(lane.draw?{drawEventId:lane.draw.id,mode:lane.draw.mode}:{}),...(lane.erase?{eraseEventId:lane.erase.id}:{})};
        if(lane.draw){
          let local:PathPoint=[localBounds[0]+localBounds[2]*dp.progress,localBounds[1]+localBounds[3]/2],tangent:PathPoint|undefined=[1,0],contourId:string|undefined,segmentId:string|undefined;
          if(lane.draw.mode==='stroke'){
            const geometry=nodeGeometry(node,lane.draw.pathId)!;
            if(geometry.contours.length!==1)throw new PathGeometryError('PRESENTATION_PATH','Current stroke geometry must have exactly one selected contour.');
            entry.strokePrefix=revealGeometry(geometry,dp.progress,'length');
            try{const sample=sampleGeometry(geometry,dp.progress,'length');local=sample.point;tangent=sample.tangent;contourId=sample.contourId;segmentId=sample.segmentId;}
            catch(error){if(error instanceof PathGeometryError&&['EMPTY_GEOMETRY','UNDEFINED_TANGENT','DEGENERATE_GEOMETRY'].includes(error.code)){
              const last=entry.strokePrefix.contours.at(-1);local=last?.segments.at(-1)?.to??last?.start??local;tangent=undefined;
            }else throw error;}
          }
          const tangentWorld=direction(matrix,tangent);
          entry.pose={local,world:transformPoint(matrix,local),...(tangent?{tangentLocal:tangent}:{}),...(tangentWorld?{tangentWorld}:{}),
            contact:state==='drawing'&&visible(node,nodes)&&lane.draw.tool!=='none'&&lane.draw.contact!=='none'&&tangentWorld!==undefined&&(lane.draw.mode==='stroke'||localBounds[2]>0&&localBounds[3]>0),
            ...(contourId?{contourId}:{}),...(segmentId?{segmentId}:{})};
        }
        const numeric=[...entry.localBounds,...entry.worldBounds,...entry.worldMatrix,...(entry.pose?[...entry.pose.local,...entry.pose.world,...(entry.pose.tangentWorld??[])]:[])];
        if(!numeric.every(Number.isFinite))throw new Error('Presentation geometry or pose is nonfinite.');
        states.push(entry);
      }catch(error){throw new OperationValidationError([{severity:'error',code:error instanceof PathGeometryError?error.code:'PRESENTATION_GEOMETRY',message:`Target ${target}: ${error instanceof Error?error.message:String(error)}`,path:'$.presentation',...((lane.draw??lane.erase)?.sourceSpan?{sourceSpan:structuredClone((lane.draw??lane.erase)!.sourceSpan!)}:{})}]);}
    }
    return freezeSnapshot({version:1,seed:program.seed,events,targets:states} as PresentationEvaluation);
  }});
}
