import {prepareScene, SVG_2D_PROFILE, CANVAS_2D_PROFILE, type Bundle} from '../src/index.js';
import {renderSvg} from '../src/render-svg.js';
import {renderCanvas} from '../src/render-canvas.js';
import {createChalkspaceCanvasLayer} from '../adapters/chalkspace-canvas.js';

declare global {interface Window {ChalkBoardSurface:any; texloomDual:any;}}
const bundle:Bundle=JSON.parse(document.getElementById('scene-data')!.textContent!);
const runtime=prepareScene(bundle);
runtime.require(SVG_2D_PROFILE);runtime.require(CANVAS_2D_PROFILE);
const canvas=document.getElementById('board') as HTMLCanvasElement;
const ctx=canvas.getContext('2d')!;
const board=window.ChalkBoardSurface.create({background:'#1e342e',seed:2409});
const layer=createChalkspaceCanvasLayer({x:0,y:.55,width:14});
const slider=document.getElementById('time') as HTMLInputElement;
const play=document.getElementById('play') as HTMLButtonElement;
let time=0,playing=false,wallStart=0,sourceStart=0;
slider.max=String(runtime.manifest.duration);
document.getElementById('title')!.textContent=bundle.title;
function draw(t:number){
  const frame=runtime.sample(t);time=frame.time;
  document.getElementById('svg')!.innerHTML=renderSvg(frame,{idPrefix:'web-demo'});
  const view={frameWidth:16,frameHeight:9,cameraY:4.5};
  board.draw(ctx,view.cameraY,canvas.width/view.frameWidth,view.frameWidth,view.frameHeight);
  layer.draw(frame,ctx,view);
  slider.value=String(time);document.getElementById('clock')!.textContent=`${time.toFixed(2)} / ${runtime.manifest.duration.toFixed(2)} s`;
  return frame;
}
function pause(){playing=false;play.textContent='재생';}
slider.oninput=()=>{pause();draw(Number(slider.value));};
play.onclick=()=>{if(playing){pause();return;}if(time>=runtime.manifest.duration)draw(0);
  playing=true;wallStart=performance.now();sourceStart=time;play.textContent='일시 정지';};
function tick(now:number){if(playing){draw(sourceStart+(now-wallStart)/1000);if(time>=runtime.manifest.duration)pause();}requestAnimationFrame(tick);}
window.texloomDual={runtime,draw:(t:number)=>{pause();return draw(t);},renderSvg,renderCanvas,prepareScene,
  layer,canvas,ready:true};
draw(0);requestAnimationFrame(tick);
