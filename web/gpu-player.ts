import {prepareScene,type Bundle,type EvaluatedFrame} from '../src/index.js';
import {createSceneCanvasRenderer} from '../src/renderers/scene-canvas.js';

const el=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id) as T;
const source=JSON.parse(el('gpu-data').textContent!) as Bundle;
const sourceText=JSON.stringify(source),canvas=el<HTMLCanvasElement>('scene-canvas'),ctx=canvas.getContext('2d');
if(!ctx)throw new Error('GPU_PLAYER_CANVAS: this host has no Canvas2D context for native TeX composition.');
const surface=ctx,stage=el('stage'),timeline=el<HTMLInputElement>('timeline'),playButton=el<HTMLButtonElement>('play');
const projectionSelect=el<HTMLSelectElement>('projection'),speedSelect=el<HTMLSelectElement>('speed');
const renderer=createSceneCanvasRenderer(),variants=new Map<string,ReturnType<typeof prepareScene>>();
const parameters:Record<string,number>=Object.create(null);
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
  finiteTime(time);const evaluated=runtime().sample(time,parameters),dimensions=size();
  if(canvas.width!==dimensions.width)canvas.width=dimensions.width;
  if(canvas.height!==dimensions.height)canvas.height=dimensions.height;
  // One composed renderer and one sampled frame drive the stage and capture.
  renderer.render(evaluated,surface,{...dimensions,background:'#0e241c'});
  frame=evaluated;current=time;timeline.value=String(time);el('clock').textContent=time.toFixed(2);
  el('projection-state').textContent=projection.toUpperCase();projectionSelect.value=projection;
  const anchor=evaluated.space3d?.overlays[0]?.worldPosition;
  for(const [i,axis] of ['x','y','z'].entries())el('point-'+axis).textContent=anchor?format(anchor[i]):'—';
  // Generated surface resources exist in the sampled frame, not in the source table.
  const instances=evaluated.space3d?.instances??[],meshIds=new Set(instances.map(node=>node.resourceId));
  el('mesh-count').textContent=String(meshIds.size);
  el('instance-count').textContent=String(instances.length);
  el('triangle-count').textContent=String(instances.reduce((sum,node)=>{
    const resource=evaluated.resources[node.resourceId];
    return sum+(resource.kind==='mesh'?resource.indices.count/3:0);
  },0));
  const curves=evaluated.space3d?.curves??[];
  el('curve-fact').hidden=curves.length===0;el('curve-count').textContent=String(curves.length);
  el('segment-fact').hidden=curves.length===0;el('segment-count').textContent=String(curves.reduce((sum,node)=>{
    const resource=evaluated.resources[node.resourceId];
    return sum+(resource.kind==='curve3d'?Math.max(0,resource.positions.count-1):0);
  },0));
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
function setParameter(name:string,value:number){
  const definition=source.expressions?.parameters[name];
  if(!definition||definition.type!=='scalar'||!Number.isFinite(value)||
    definition.min!==undefined&&value<definition.min||definition.max!==undefined&&value>definition.max)
    throw new RangeError('GPU_PLAYER_PARAMETER: expected an authored scalar parameter within its bounds.');
  parameters[name]=value;const control=parameterControls.get(name);
  if(control){control.input.value=String(value);control.output.textContent=format(value);}
  return seek(current);
}
function dispose(){
  if(disposed)return;pause();disposed=true;resize.disconnect();listenerController.abort();
  renderer.dispose();variants.clear();
}
const resize=new ResizeObserver(()=>{if(!disposed&&!failed&&frame&&!explicitSize){try{draw(current);}catch(error){failure(error);}}});
resize.observe(stage);
const api={ready,seek,render:seek,pause,play,setSize,setProjection:selectProjection,setParameter,dispose,
  getFrame:()=>structuredClone(frame),
  getState:()=>({time:current,playing,projection,disposed,failed,width:canvas.width,height:canvas.height,
    renderer:'WebGL2 + native TeX Canvas',parameters:{...parameters},sourceUnchanged:JSON.stringify(source)===sourceText}),
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
el('point-label').textContent=source.space3d?.overlays?.[0]?.id??'—';
const parameterControls=new Map<string,{input:HTMLInputElement;output:HTMLOutputElement}>();
const parameterPanel=el('parameter-controls');
for(const [name,definition] of Object.entries(source.expressions?.parameters??{})){
  if(definition.type!=='scalar'||typeof definition.default!=='number'||definition.min===undefined||definition.max===undefined||definition.min>=definition.max)continue;
  const row=document.createElement('div'),label=document.createElement('label'),input=document.createElement('input'),output=document.createElement('output');
  const id='parameter-'+parameterControls.size;input.id=id;input.type='range';input.min=String(definition.min);input.max=String(definition.max);
  input.step=String((definition.max-definition.min)/200);input.value=String(definition.default);
  label.htmlFor=id;label.textContent=name;output.htmlFor.add(id);output.textContent=format(definition.default);
  row.className='parameter-control';row.append(label,output,input);parameterPanel.append(row);
  parameterControls.set(name,{input,output});parameters[name]=definition.default;
  input.addEventListener('input',()=>{try{setParameter(name,Number(input.value));}catch(error){failure(error);}},listenerOptions);
}
parameterPanel.hidden=parameterControls.size===0;
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
