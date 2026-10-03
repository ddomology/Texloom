import {beginPrepareScene,createAssetStore,SVG_2D_PROFILE,type ScenePackage,type AssetResolver,type PreparedSceneRuntime} from '../src/index.js';
import {renderSvg} from '../src/render-svg.js';

declare global {interface Window {texloomAssets:any}}
const scenePackage:ScenePackage=JSON.parse(document.getElementById('asset-package')!.textContent!);
const byteMap:Record<string,string>=JSON.parse(document.getElementById('asset-bytes')!.textContent!);
const slow=document.getElementById('slow-load') as HTMLInputElement;
const local=location.protocol==='file:';
const capture=new URLSearchParams(location.search).has('capture');
if(capture)slow.checked=false;
let loads=0,deliveredBytes=0;
const abort=()=>new DOMException('Preparation was canceled.','AbortError');
function delay(milliseconds:number,signal:AbortSignal){return new Promise<void>((resolve,reject)=>{
  if(signal.aborted){reject(abort());return;}
  const cancel=()=>{clearTimeout(timer);reject(abort());};
  const timer=setTimeout(()=>{signal.removeEventListener('abort',cancel);resolve();},milliseconds);
  signal.addEventListener('abort',cancel,{once:true});
});}
const resolver:AssetResolver=async(entry,{signal})=>{
  if(entry.source.kind!=='external')throw new Error('Only external sources need the host resolver.');
  loads++;refresh();if(slow.checked)await delay(850,signal);
  const {uri,byteRange}=entry.source;let bytes:Uint8Array;
  if(local){
    const encoded=byteMap[uri];if(encoded===undefined)throw new Error('Missing offline package bytes.');
    bytes=Uint8Array.from(atob(encoded),character=>character.charCodeAt(0));
    if(byteRange)bytes=bytes.slice(byteRange.offset,byteRange.offset+byteRange.length);
  }else{
    const url=new URL(uri,new URL('package/scene.json',location.href));
    const response=await fetch(url,{signal,headers:byteRange?{Range:`bytes=${byteRange.offset}-${byteRange.offset+byteRange.length-1}`}:{}});
    if(!response.ok)throw new Error(`Asset request failed (${response.status}).`);
    bytes=new Uint8Array(await response.arrayBuffer());
    if(byteRange){
      if(response.status===206){
        const match=/^bytes (\d+)-(\d+)\/(?:\d+|\*)$/.exec(response.headers.get('Content-Range')??'');
        if(!match||Number(match[1])!==byteRange.offset||Number(match[2])!==byteRange.offset+byteRange.length-1)
          throw new Error('The server returned an unexpected byte range.');
      }else if(response.status===200)bytes=bytes.slice(byteRange.offset,byteRange.offset+byteRange.length);
      else throw new Error('The server did not return a supported range response.');
    }else if(response.status===206)throw new Error('Unexpected partial response for a complete resource.');
  }
  if(signal.aborted)throw abort();deliveredBytes+=bytes.byteLength;return bytes;
};
let store=createAssetStore({resolver});
type Panel={id:number;generation:number;handle?:ReturnType<typeof beginPrepareScene>;runtime?:PreparedSceneRuntime;
  state:string;time:number;phase:number;playing:boolean;wall:number;origin:number};
const panels:Panel[]=[0,1].map(id=>({id,generation:0,state:'Not loaded',time:2,phase:id*Math.PI/2,playing:false,wall:0,origin:0}));
const element=(id:number,name:string)=>document.getElementById(`${name}-${id}`)!;
function refresh(){
  const stats=store.stats();document.getElementById('resource-count')!.textContent=String(stats.ready);
  document.getElementById('lease-count')!.textContent=String(stats.leases);document.getElementById('load-count')!.textContent=String(loads);
  for(const p of panels){
    element(p.id,'state').textContent=p.state;
    const ready=p.state==='Ready',loading=p.state==='Loading';
    for(const name of ['play','time','phase','dispose','reload'])
      (element(p.id,name) as HTMLButtonElement|HTMLInputElement).disabled=!ready;
    (element(p.id,'cancel') as HTMLButtonElement).disabled=!loading;
    (element(p.id,'load') as HTMLButtonElement).disabled=loading||ready;
    element(p.id,'play').textContent=p.playing?'Pause':'Play';
  }
}
function placeholder(p:Panel,text:string){const message=document.createElement('p');message.textContent=text;element(p.id,'stage').replaceChildren(message);}
function draw(id:number,time=panels[id].time,phase=panels[id].phase){
  const p=panels[id];if(!p.runtime||p.runtime.state!=='ready')throw new Error('This view is not ready.');
  const frame=p.runtime.sample(time,{phase});p.time=frame.time;p.phase=phase;
  element(id,'stage').innerHTML=renderSvg(frame,{idPrefix:`asset-view-${id}`});
  (element(id,'time') as HTMLInputElement).value=String(p.time);element(id,'clock').textContent=`${p.time.toFixed(2)} s`;
  (element(id,'phase') as HTMLInputElement).value=String(phase);element(id,'phase-value').textContent=`${phase.toFixed(2)} rad`;
  return frame;
}
function release(id:number,canceled=false){
  const p=panels[id];p.generation++;p.playing=false;p.handle?.dispose();p.runtime?.dispose();p.handle=undefined;p.runtime=undefined;
  p.state=canceled?'Canceled':'Released';placeholder(p,canceled?'Loading canceled. You can load this view again.':'This view has released its scene. Load it again to continue.');
  element(id,'message').textContent=canceled?'The other view continues independently.':'Shared resources remain available while another view uses them.';refresh();
}
async function load(id:number){
  const p=panels[id];p.generation++;const generation=p.generation;p.playing=false;p.handle?.dispose();p.runtime?.dispose();p.runtime=undefined;
  p.state='Loading';element(id,'message').textContent='Preparing the native artwork and scene…';placeholder(p,'Loading the mathematical scene…');
  const handle=beginPrepareScene(scenePackage,{assetStore:store,profile:SVG_2D_PROFILE});p.handle=handle;refresh();
  try{
    const runtime=await handle.ready;
    if(p.generation!==generation){runtime.dispose();return;}
    p.runtime=runtime;p.state='Ready';element(id,'message').textContent='Ready. Time and phase affect this view only.';
    draw(id);refresh();
  }catch(error){
    if(p.generation!==generation)return;
    p.state='Failed';element(id,'message').textContent=error instanceof Error?error.message:String(error);
    placeholder(p,'This scene could not be prepared.');refresh();
  }
}
async function reset(){
  panels.forEach(p=>release(p.id));store.dispose();store=createAssetStore({resolver});loads=0;deliveredBytes=0;refresh();
  await Promise.all(panels.map(p=>load(p.id)));
}
for(const p of panels){
  element(p.id,'load').onclick=()=>void load(p.id);element(p.id,'reload').onclick=()=>void load(p.id);
  element(p.id,'cancel').onclick=()=>release(p.id,true);element(p.id,'dispose').onclick=()=>release(p.id);
  element(p.id,'time').oninput=()=>{p.playing=false;draw(p.id,Number((element(p.id,'time') as HTMLInputElement).value));refresh();};
  element(p.id,'phase').oninput=()=>{p.playing=false;draw(p.id,p.time,Number((element(p.id,'phase') as HTMLInputElement).value));refresh();};
  element(p.id,'play').onclick=()=>{if(p.playing)p.playing=false;else{
    if(p.time>=scenePackage.scene.duration)draw(p.id,0);p.origin=p.time;p.wall=performance.now();p.playing=true;
  }refresh();};
}
document.getElementById('reset')!.onclick=()=>void reset();
document.getElementById('delivery-mode')!.textContent=local
  ?'Offline file preview: a host resolver reads an embedded byte map of the same external package. Browser file fetching is not used.'
  :'HTTP preview: the host resolver fetches the hash-addressed files beside the external manifest. Both views share one asset store.';
function tick(now:number){for(const p of panels)if(p.playing&&p.runtime?.state==='ready'){
  draw(p.id,p.origin+(now-p.wall)/1000);if(p.time>=scenePackage.scene.duration){p.playing=false;refresh();}
}requestAnimationFrame(tick);}
const preparationReady=Promise.all(panels.map(p=>load(p.id)));
window.texloomAssets={ready:preparationReady,preparationReady,package:scenePackage,panels,
  get store(){return store;},snapshot:()=>({stats:store.stats(),loads,deliveredBytes,
    panels:panels.map(p=>({state:p.state,time:p.time,phase:p.phase,generation:p.generation}))}),
  load,cancel:(id:number)=>release(id,true),dispose:(id:number)=>release(id),reset,draw,
  frame:(id:number)=>panels[id].runtime?.sample(panels[id].time,{phase:panels[id].phase}),
  setSlow:(enabled:boolean)=>{slow.checked=enabled;},delivery:local?'embedded-host-resolver':'http-fetch'};
// The standard frame exporter exercises this prepared package runtime, not a
// second inline evaluator. The interactive page remains the same artifact.
if(capture){
  const stage=document.createElement('div');stage.id='stage';document.body.append(stage);
  (document.querySelector('main') as HTMLElement).style.display='none';
  Object.assign(stage.style,{position:'fixed',inset:'0',background:'#0a1720'});
  (window as any).texloom={bundle:{duration:scenePackage.scene.duration,viewport:scenePackage.scene.viewport},
    ready:preparationReady,render:async(time:number)=>{
      await preparationReady;draw(0,time,0);draw(1,time,Math.PI/2);
      stage.innerHTML=element(0,'stage').innerHTML;
    }};
}
requestAnimationFrame(tick);
window.addEventListener('pagehide',()=>{panels.forEach(p=>{p.handle?.dispose();p.runtime?.dispose();});store.dispose();});
