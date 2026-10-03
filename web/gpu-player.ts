import {prepareScene,copyMeshBuffers,type Bundle,type EvaluatedFrame} from '../src/index.js';
import {createSceneCanvasRenderer} from '../src/renderers/scene-canvas.js';

const el=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id) as T;
const source=JSON.parse(el('gpu-data').textContent!) as Bundle;
const sourceText=JSON.stringify(source),canvas=el<HTMLCanvasElement>('scene-canvas'),ctx=canvas.getContext('2d');
if(!ctx)throw new Error('GPU_PLAYER_CANVAS: this host has no Canvas2D context for native TeX composition.');
const surface=ctx,stage=el('stage'),timeline=el<HTMLInputElement>('timeline'),playButton=el<HTMLButtonElement>('play');
const projectionSelect=el<HTMLSelectElement>('projection'),speedSelect=el<HTMLSelectElement>('speed');
const renderer=createSceneCanvasRenderer(),variants=new Map<string,ReturnType<typeof prepareScene>>();
const listenerController=new AbortController(),listenerOptions={signal:listenerController.signal};
let current=0,frame:EvaluatedFrame,playing=false,disposed=false,failed=false,raf=0,wallStart=0,sourceStart=0,speed=1;
let explicitSize:{width:number;height:number}|undefined;
let projection=source.space3d!.camera!.projection!.kind;
let resolveReady!:()=>void,rejectReady!:(error:unknown)=>void;
const ready=new Promise<void>((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
void ready.catch(()=>{});
const reduced=matchMedia('(prefers-reduced-motion: reduce)');
const capture=new URLSearchParams(location.search).get('capture')==='1';
if(capture)document.body.classList.add('capture');
const finiteTime=(time:number)=>{
  if(typeof time!=='number'||!Number.isFinite(time)||time<0||time>source.duration)throw new RangeError('GPU_PLAYER_TIME: expected source seconds within the scene duration.');
  if(disposed)throw new Error('GPU_PLAYER_DISPOSED: the player has been disposed.');
  return time;
};
const format=(value:number)=>Math.abs(value)<.00005?'0.000':value.toFixed(3);

function pause(){
  playing=false;if(raf)cancelAnimationFrame(raf);raf=0;
  playButton.textContent='Play';playButton.setAttribute('aria-label','Play');playButton.setAttribute('aria-pressed','false');
}
function failure(error:unknown){
  failed=true;pause();const message=el('error');message.hidden=false;
  message.textContent=(error instanceof Error?error.message:String(error))+' Reload this page after restoring WebGL2 support.';
  el('loading').hidden=true;playButton.disabled=true;
}
function runtime(){
  let compiled=variants.get(projection);
  if(!compiled){
    const variant=JSON.parse(sourceText) as Bundle,camera=variant.space3d!.camera!,authored=source.space3d!.camera!.projection!;
    if(authored.kind!==projection){
      camera.projection=projection==='orthographic'?{kind:'orthographic',height:5.2,near:authored.near,far:authored.far}:
        {kind:'perspective',fovY:Math.PI*40/180,near:Math.max(.1,authored.near),far:authored.far};
    }
    compiled=prepareScene(variant);variants.set(projection,compiled);
  }
  return compiled;
}
function size(){
  if(explicitSize)return explicitSize;
  const scale=Math.min(devicePixelRatio||1,2),rect=stage.getBoundingClientRect();
  return {width:Math.max(2,Math.min(4096,Math.round(rect.width*scale))),height:Math.max(2,Math.min(4096,Math.round(rect.height*scale)))};
}
function draw(time:number){
  finiteTime(time);const evaluated=runtime().sample(time),dimensions=size();
  if(canvas.width!==dimensions.width)canvas.width=dimensions.width;
  if(canvas.height!==dimensions.height)canvas.height=dimensions.height;
  // One composed renderer and one sampled frame drive the stage and capture.
  renderer.render(evaluated,surface,{...dimensions,background:'#0e241c'});
  frame=evaluated;current=time;timeline.value=String(time);el('clock').textContent=time.toFixed(2);
  el('projection-state').textContent=projection.toUpperCase();projectionSelect.value=projection;
  const anchor=evaluated.space3d?.overlays[0]?.worldPosition;
  for(const [i,axis] of ['x','y','z'].entries())el('point-'+axis).textContent=anchor?format(anchor[i]):'—';
  el('loading').hidden=true;return evaluated;
}
function seek(time:number){pause();try{return draw(time);}catch(error){failure(error);throw error;}}
function advance(now:number){
  raf=0;if(!playing||disposed)return;
  const time=Math.min(source.duration,sourceStart+(now-wallStart)/1000*speed);
  try{draw(time);}catch(error){failure(error);return;}
  if(time>=source.duration){pause();return;}raf=requestAnimationFrame(advance);
}
function play(){
  if(disposed||failed)return;
  if(current>=source.duration)draw(0);
  if(playing)return;playing=true;sourceStart=current;wallStart=performance.now();
  playButton.textContent='Pause';playButton.setAttribute('aria-label','Pause');playButton.setAttribute('aria-pressed','true');
  raf=requestAnimationFrame(advance);
}
function selectProjection(value:'perspective'|'orthographic'){
  if(value!=='perspective'&&value!=='orthographic')throw new Error('GPU_PLAYER_PROJECTION: choose perspective or orthographic.');
  pause();projection=value;return draw(current);
}
function setSize(width:number,height:number){
  if(![width,height].every(value=>Number.isSafeInteger(value)&&value>=2&&value<=4096)||width*height>16_777_216)
    throw new RangeError('GPU_PLAYER_SIZE: expected integer dimensions from 2 to 4096.');
  explicitSize={width,height};return seek(current);
}
function dispose(){
  if(disposed)return;pause();disposed=true;resize.disconnect();listenerController.abort();
  renderer.dispose();variants.clear();
}
const resize=new ResizeObserver(()=>{if(!disposed&&!failed&&frame&&!explicitSize){try{draw(current);}catch(error){failure(error);}}});
resize.observe(stage);
const api={ready,seek,render:seek,pause,play,setSize,setProjection:selectProjection,dispose,
  getFrame:()=>structuredClone(frame),
  getState:()=>({time:current,playing,projection,disposed,failed,width:canvas.width,height:canvas.height,
    renderer:'WebGL2 + native TeX Canvas',sourceUnchanged:JSON.stringify(source)===sourceText}),
  capture(time:number){const value=seek(time);return {data:canvas.toDataURL('image/png').split(',')[1],time:value.time,
    width:canvas.width,height:canvas.height,projection};},
};
declare global {interface Window {TexloomGpuPlayer:typeof api}}
window.TexloomGpuPlayer=Object.freeze(api);
// Existing offline export_video.py consumes this bridge and screenshots #stage.
// It intentionally has no SVG export: the complete frame contains GPU geometry.
(window as unknown as {texloom:unknown}).texloom=Object.freeze({bundle:JSON.parse(sourceText),ready,render:seek,getFrame:api.getFrame,pause,setSize,
  renderer:'WebGL2 + native TeX Canvas'});

playButton.disabled=true;timeline.max=String(source.duration);el('duration').textContent=source.duration.toFixed(2)+' s';
el('end-label').textContent=source.duration+' s';projectionSelect.value=projection;
const meshes=Object.values(source.resources).filter(resource=>resource.kind==='mesh');
el('mesh-count').textContent=String(meshes.length);
el('instance-count').textContent=String(source.space3d!.nodes.filter(node=>node.kind==='mesh').length);
el('triangle-count').textContent=String(source.space3d!.nodes.reduce((sum,node)=>node.kind==='mesh'?sum+copyMeshBuffers(source.resources[node.resourceId]).triangleCount:sum,0));
playButton.addEventListener('click',()=>{try{playing?pause():play();}catch(error){failure(error);}},listenerOptions);
el('restart').addEventListener('click',()=>{try{seek(0);}catch{}},listenerOptions);
timeline.addEventListener('input',()=>{try{seek(Number(timeline.value));}catch{}},listenerOptions);
projectionSelect.addEventListener('change',()=>{try{selectProjection(projectionSelect.value as typeof projection);}catch(error){failure(error);}},listenerOptions);
speedSelect.addEventListener('change',()=>{speed=Number(speedSelect.value);sourceStart=current;wallStart=performance.now();},listenerOptions);
document.addEventListener('visibilitychange',()=>{if(document.hidden)pause();},listenerOptions);
reduced.addEventListener('change',()=>{if(reduced.matches)pause();},listenerOptions);
document.addEventListener('keydown',event=>{
  if((event.target as HTMLElement)?.closest('button,input,select,textarea,a'))return;
  try{
    if(event.code==='Space'){event.preventDefault();playing?pause():play();}
    if(event.code==='ArrowLeft'||event.code==='ArrowRight'){event.preventDefault();seek(Math.max(0,Math.min(source.duration,current+(event.code==='ArrowLeft'?-1:1)/30)));}
  }catch(error){failure(error);}
},listenerOptions);
window.addEventListener('pagehide',dispose,listenerOptions);
void document.fonts.ready.then(()=>{
  if(disposed)throw new Error('GPU_PLAYER_DISPOSED: player was disposed before readiness.');
  draw(0);playButton.disabled=false;resolveReady();
}).catch(error=>{failure(error);rejectReady(error);});
