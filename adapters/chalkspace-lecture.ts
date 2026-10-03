import {BundleValidationError, type Bundle, type EvaluatedFrame, type Node, type Matrix} from '../src/schema.js';
import type {NativeNodePainter} from '../src/render-canvas.js';
import {beginPrepareScene, bindSceneClip, type ScenePreparation, type SceneManifest,
  type SceneClip, type ClipTiming, type ClipSample, type ClipDescription} from '../src/runtime.js';
import {CANVAS_2D_PROFILE} from '../src/capabilities.js';
import {createAssetStore} from '../src/resources/store.js';
import {validateAssetJson, sha256Bytes, type ScenePackage} from '../src/resources/package.js';
import {freezeSnapshot} from '../src/operations/values.js';
import type {DeepReadonly} from '../src/ir/operations.js';
import type {BoardPlacement} from './chalkspace.js';
import {createChalkspaceCanvasLayer,boardScreenRect,boardProjectionMatrix, type BoardView, type BoardScreenRect} from './chalkspace-canvas.js';
export {boardProjectionMatrix,boardScreenRect,scenePointToBoard} from './chalkspace-canvas.js';

export interface ChalkspaceLectureClip {id:string; scene:string; timing:ClipTiming; placement:BoardPlacement}
export interface ChalkspaceLecture {
  contract:'texloom-lecture/1'; scenes:Record<string,Bundle|ScenePackage>; clips:ChalkspaceLectureClip[];
}
export interface ChalkspaceLectureSample extends ClipSample {id:string; scene:string}
export interface ChalkspaceLectureDescription extends ClipDescription {id:string; scene:string}
export interface ChalkspaceLectureDrawState {
  id:string; scene:string; sourceTime:number; phase:ClipSample['phase']; visible:boolean; rect?:BoardScreenRect;
}
export interface LecturePaintContext {
  clipId:string;scene:string;frame:EvaluatedFrame;rect:BoardScreenRect;projection:Matrix;
  placement:BoardPlacement;timing:Readonly<Required<ClipTiming>>;
}
export interface LectureDrawOptions {
  paintNode?:(node:Node,ctx:CanvasRenderingContext2D,drawNative:NativeNodePainter,context:LecturePaintContext)=>void;
}
export interface LectureIntentInterval {
  clipId:string;scene:string;eventId:string;kind:'write'|'erase';seed:number;
  hostStart:number;hostEnd:number;sourceStart:number;sourceEnd:number;originalStart:number;originalEnd:number;
  tool:'chalk'|'eraser'|'none';contact:'continuous'|'none';
}
export interface ChalkspaceLectureManifest {
  contract:'texloom-lecture-runtime/1'; revision:string; scenes:Record<string,SceneManifest>;
  clips:{id:string;scene:string;timing:Required<ClipTiming>;placement:BoardPlacement}[];
}
export interface ChalkspaceLectureRuntime {
  readonly state:'ready'|'disposed'; readonly manifest:DeepReadonly<ChalkspaceLectureManifest>;
  readonly revision:string;
  /** Clock metadata only; does not evaluate any scene geometry. */
  describe(hostSeconds:number):ChalkspaceLectureDescription[];
  sample(hostSeconds:number):ChalkspaceLectureSample[];
  draw(ctx:CanvasRenderingContext2D,hostSeconds:number,view:BoardView,options?:LectureDrawOptions):ChalkspaceLectureDrawState[];
  intentSchedule():LectureIntentInterval[];
  /** Exact identity including source content, clock state and host quality tag. */
  frameKey(hostSeconds:number,quality?:string):string|null;
  dispose():void;
}
function fail(message:string):never {throw new Error(`LECTURE_INPUT: ${message}`);}
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const keys=(value:Record<string,unknown>,allowed:string[])=>{
  if(Object.keys(value).some(key=>!allowed.includes(key)))fail('Unknown field.');
};
const id=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
// Only called after bounded plain-JSON validation. Property order is irrelevant;
// array order and signed zero are content and must survive the fingerprint.
function canonical(value:unknown):string {
  if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;
  if(object(value))return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return typeof value==='number'&&Object.is(value,-0)?'-0':JSON.stringify(value)!;
}
function snapshot(input:unknown):ChalkspaceLecture {
  const errors=validateAssetJson(input);if(errors.length)throw new BundleValidationError(errors);
  if(!object(input))fail('Expected a lecture object.');
  keys(input,['contract','scenes','clips']);
  if(input.contract!=='texloom-lecture/1'||!object(input.scenes)||!Array.isArray(input.clips))fail('Invalid lecture contract.');
  const scenes=input.scenes as Record<string,unknown>, clips=input.clips as unknown[];
  if(Object.keys(scenes).length>64||clips.length>128)fail('At most 64 scenes and 128 clips are supported.');
  for(const [name,scene] of Object.entries(scenes)) {
    if(!id(name)||!object(scene))fail('Invalid scene ID or scene object.');
    if(scene.contract==='texloom-package/1') {
      const assets=scene.assets;
      if(!object(assets)||!Array.isArray(assets.entries))fail('Invalid asset manifest.');
      for(const entry of assets.entries as unknown[]) {
        if(!object(entry)||!object(entry.source)||entry.source.kind!=='inline')fail('Lecture packages must contain inline resources; bundle local assets before publication.');
      }
    }
  }
  const seen=new Set<string>();
  for(const clip of clips) {
    if(!object(clip))fail('Expected a clip object.');
    keys(clip,['id','scene','timing','placement']);
    if(!id(clip.id)||seen.has(clip.id)||!id(clip.scene)||!Object.hasOwn(scenes,clip.scene))fail('Clip IDs must be unique and reference an existing scene.');
    seen.add(clip.id);
    if(!object(clip.timing)||!object(clip.placement))fail('Clip timing and placement are required.');
    keys(clip.timing,['start','sourceStart','rate','duration','before','after']);
    keys(clip.placement,['x','y','width']);
    for(const key of ['x','y','width'])if(typeof clip.placement[key]!=='number'||!Number.isFinite(clip.placement[key]))fail('Placement must use finite board-world units.');
    if((clip.placement.width as number)<=0)fail('Placement width must be positive.');
  }
  return structuredClone(input) as unknown as ChalkspaceLecture;
}

/** No clock, DOM attachment, network transport or partially ready publication.
 * The host owns the writing-area clip and foreground tools. */
export async function prepareChalkspaceLecture(input:unknown,options:{signal?:AbortSignal}={}):Promise<ChalkspaceLectureRuntime> {
  if(!options||typeof options!=='object'||Array.isArray(options))fail('Expected preparation options.');
  const data=snapshot(input), externalSignal=options.signal;
  if(externalSignal!==undefined&&!(externalSignal instanceof AbortSignal))fail('Expected AbortSignal.');
  const controller=new AbortController(),store=createAssetStore();
  const preparations:ScenePreparation[]=[];
  let disposed=false;
  let entries:{declaration:ChalkspaceLectureClip;clip:SceneClip;layer:ReturnType<typeof createChalkspaceCanvasLayer>}[]=[];
  const dispose=()=>{
    if(disposed)return;disposed=true;controller.abort();
    externalSignal?.removeEventListener('abort',dispose);
    for(const preparation of preparations)preparation.dispose();preparations.length=0;
    for(const entry of entries)entry.layer.dispose();entries=[];store.dispose();
  };
  externalSignal?.addEventListener('abort',dispose,{once:true});
  if(externalSignal?.aborted)dispose();
  const live=(time?:number)=>{
    if(disposed)throw new Error('LECTURE_DISPOSED: lecture resources have been released.');
    if(time!==undefined&&!Number.isFinite(time))throw new Error('CLIP_TIME: expected finite absolute host seconds.');
  };
  try {
    live();
    const revision=await sha256Bytes(new TextEncoder().encode(canonical(data)));
    live();
    const prepared=await Promise.all(Object.entries(data.scenes).map(async([name,scene])=>{
      const loading=beginPrepareScene(scene,{assetStore:store,profile:CANVAS_2D_PROFILE,signal:controller.signal});
      preparations.push(loading);return [name,await loading.ready] as const;
    }));
    live();const scenes=new Map(prepared);
    entries=data.clips.map(declaration=>({declaration,clip:bindSceneClip(scenes.get(declaration.scene)!,declaration.timing),
      layer:createChalkspaceCanvasLayer(declaration.placement)}));
    const manifest=freezeSnapshot({contract:'texloom-lecture-runtime/1' as const,revision,
      scenes:Object.fromEntries(prepared.map(([name,scene])=>[name,scene.manifest])),
      clips:entries.map(({declaration,clip})=>({...declaration,timing:clip.timing}))});
    const sample=(hostSeconds:number):ChalkspaceLectureSample[]=>{
      live(hostSeconds);return entries.map(({declaration,clip})=>({id:declaration.id,scene:declaration.scene,...clip.sample(hostSeconds)}));
    };
    const describe=(hostSeconds:number):ChalkspaceLectureDescription[]=>{
      live(hostSeconds);return entries.map(({declaration,clip})=>({id:declaration.id,scene:declaration.scene,...clip.describe(hostSeconds)}));
    };
    const schedule:LectureIntentInterval[]=[];
    for(const {declaration,clip} of entries){
      const input=data.scenes[declaration.scene],scene='contract' in input?input.scene:input;
      for(const event of scene.presentation?.events??[]){
        const interval=clip.mapInterval(event.start,event.end);if(!interval)continue;
        schedule.push({clipId:declaration.id,scene:declaration.scene,eventId:event.id,
          kind:event.kind==='draw'?'write':'erase',seed:scene.presentation!.seed,...interval,
          originalStart:event.start,originalEnd:event.end,tool:event.tool??(event.kind==='draw'?'chalk':'eraser'),
          contact:event.kind==='draw'?(event.contact??'continuous'):'continuous'});
      }
    }
    return Object.freeze({manifest,revision,get state(){return disposed?'disposed' as const:'ready' as const;},describe,sample,
      intentSchedule(){live();return structuredClone(schedule);},
      draw(ctx:CanvasRenderingContext2D,hostSeconds:number,view:BoardView,options:LectureDrawOptions={}){
        if(options.paintNode!==undefined&&typeof options.paintNode!=='function')fail('paintNode must be a function.');
        return sample(hostSeconds).map(({frame,hostTime:_hostTime,...state},index)=>{
          if(!frame)return state;
          const entry=entries[index],placement=entry.declaration.placement;
          const context:LecturePaintContext={clipId:state.id,scene:state.scene,frame,placement,timing:entry.clip.timing,
            rect:boardScreenRect(frame.viewport,placement,view,ctx.canvas.width),
            projection:boardProjectionMatrix(frame,placement,view,ctx.canvas.width)};
          return {...state,rect:entry.layer.draw(frame,ctx,view,{paintNode:options.paintNode?
            (node,canvas,drawNative)=>options.paintNode!(node,canvas,drawNative,context):undefined})};
        });
      },
      frameKey(hostSeconds:number,quality=''){
        live(hostSeconds);
        if(typeof quality!=='string')fail('Frame quality must be a string.');
        return canonical(['texloom-lecture-frame/1',revision,quality,describe(hostSeconds).map(state=>[
          state.id,state.scene,state.phase,state.visible,state.sourceTime,state.phase==='active'?state.hostTime:null,
        ])]);
      },dispose,
    });
  }catch(error){dispose();throw error;}
}
