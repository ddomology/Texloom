import {createGpuRenderer,type GpuRenderer} from '../src/renderers/gpu/index.js';
import {createEvaluator} from '../src/evaluate.js';
import type {Bundle,EvaluatedFrame} from '../src/schema.js';
import type {MeshResource} from '../src/ir/mesh.js';
import {renderRawReference,type ReferenceDraw} from './gpu-reference.js';

function resource(z=-2,extent=.5):MeshResource {
 const data=[-extent,-extent,z,extent,-extent,z,0,extent,z];
 return {kind:'mesh',version:1,primitive:'triangles',units:'unit',coordinateSpace:'object',winding:'ccw',topologyRevision:'triangle-1',
 positions:{version:1,componentType:'float64',components:3,count:3,byteOffset:0,byteStride:24,data},
 indices:{version:1,componentType:'uint16',components:1,count:3,byteOffset:0,byteStride:2,data:[0,1,2]},bounds:{min:[-extent,-extent,z],max:[extent,extent,z]}};
}
function fixture(mode='orthographic'):Bundle {
 const bundle:Bundle={version:'0.3',title:'GPU fixture',duration:2,units:'bp',viewport:{width:128,height:128},camera:{x:0,y:0,zoom:1},
  nodes:[],tracks:[],relations:[],resources:{triangle:resource()},space3d:{version:1,units:'unit',handedness:'right',upAxis:'z',
   nodes:[{id:'near',kind:'mesh',resourceId:'triangle',material:{kind:'unlit',color:'#ff0000',side:'front'}}],
   camera:{id:'camera',projection:{kind:'orthographic',height:2,near:1,far:5}}}};
 if(mode==='perspective')bundle.space3d!.camera!.projection={kind:'perspective',fovY:Math.PI/2,near:1,far:5};
 if(mode==='depth'){bundle.resources.behind=resource(-4,.8);bundle.space3d!.nodes.push({id:'behind',kind:'mesh',resourceId:'behind',material:{kind:'unlit',color:'#0000ff',side:'front'}});}
 if(mode==='reflection')bundle.space3d!.nodes[0].transform={scale:[-1,1,1]};
 if(mode==='double'){
  (bundle.resources.triangle as MeshResource).indices.data=[0,2,1];
  (bundle.space3d!.nodes[0] as any).material.side='double';
 }
 if(mode==='backface')(bundle.resources.triangle as MeshResource).indices.data=[0,2,1];
 if(mode==='clip')bundle.space3d!.clippingPlanes=[{normal:[1,0,0],constant:0}];
 if(mode==='camera-affine')bundle.space3d!.camera!.transform={translation:[.2,0,0],scale:[2,.5,1]};
 if(mode==='camera-reflection'||mode==='camera-reflection-double'){
  bundle.space3d!.camera!.transform={scale:[-1,1,1]};
  if(mode==='camera-reflection-double')(bundle.space3d!.nodes[0] as any).material.side='double';
 }
 return bundle;
}
const frame=(mode?:string)=>createEvaluator(fixture(mode))(0);
const pixels=(renderer:GpuRenderer)=>{
 const gl=renderer.canvas.getContext('webgl2')!,a=new Uint8Array(renderer.canvas.width*renderer.canvas.height*4);
 gl.readPixels(0,0,renderer.canvas.width,renderer.canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,a);return a;
};
const pixel=(a:Uint8Array,x:number,y:number,width=128)=>[...a.slice((y*width+x)*4,(y*width+x)*4+4)];
function referenceDraws(f:EvaluatedFrame):ReferenceDraw[]{return f.space3d!.instances.filter(i=>i.visible).map(i=>{
 const r=f.resources[i.resourceId] as MeshResource;
 return {positions:[...r.positions.data],indices:[...r.indices.data],model:[...i.worldMatrix],viewProjection:[...f.space3d!.camera!.viewProjectionMatrix!],
   color:i.material.color,side:i.material.side,orientation:i.orientation};
});}
function errorCode(run:()=>unknown):string {try{run();return 'NO_ERROR';}catch(e){return (e as {code?:string}).code??String(e);}}
async function hash(bytes:Uint8Array):Promise<string>{return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes as Uint8Array<ArrayBuffer>))].map(n=>n.toString(16).padStart(2,'0')).join('');}
function withRenderer<T>(run:(r:GpuRenderer)=>T):T {const r=createGpuRenderer({antialias:false});try{return run(r);}finally{r.dispose();}}

(window as any).gpuQa={fixture,
 parity(mode:string){return withRenderer(r=>{
  const input=fixture(mode),before=JSON.stringify(input),f=createEvaluator(input)(0);r.render(f,{width:128,height:128});
  const actual=pixels(r),reference=renderRawReference(document.createElement('canvas'),referenceDraws(f),128,128,f.space3d!.clippingPlanes.map(p=>[...p.normal,p.constant]));
  let changed=0,max=0,total=0,count=0,minX=128,maxX=-1,minY=128,maxY=-1;
  for(let i=0;i<actual.length;i++){const d=Math.abs(actual[i]-reference[i]);if(d)changed++;max=Math.max(max,d);total+=d;}
  for(let y=0;y<128;y++)for(let x=0;x<128;x++)if(actual[(y*128+x)*4+3]){count++;minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);}
  return {mode,changedChannels:changed,maximumChannelDifference:max,meanChannelDifference:total/actual.length,paintedPixels:count,bounds:[minX,minY,maxX,maxY],
   center:pixel(actual,64,64),left:pixel(actual,48,48),right:pixel(actual,80,48),sourceUnchanged:JSON.stringify(input)===before,stats:r.stats()};
 });},
 async history(){const r=createGpuRenderer({antialias:false});try{
  const bundle=fixture(),frames=[-.2,0,.2].map(x=>{const b=structuredClone(bundle);b.space3d!.nodes[0].transform={translation:[x,0,0]};return createEvaluator(b)(0);});
  const hashes=[];for(const f of frames){r.render(f,{width:128,height:128});hashes.push(await hash(pixels(r)));}
  const checks=[];for(const index of [2,0,1,0,2,1]){r.render(frames[index],{width:128,height:128});checks.push(hashes[index]===await hash(pixels(r)));}
  r.render(frames[1],{width:96,height:64});const dimensions=[r.canvas.width,r.canvas.height];
  r.render(frames[1],{width:128,height:128});return {hashes,checks,dimensions,restoredSizeSame:hashes[1]===await hash(pixels(r))};
 }finally{r.dispose();}},
 async ownership(){const r=createGpuRenderer({antialias:false});try{
  const bundle=fixture();bundle.space3d!.nodes.push({id:'second',kind:'mesh',resourceId:'triangle',transform:{translation:[.2,0,0]}});
  const evaluate=createEvaluator(bundle),first=evaluate(0),source=JSON.stringify(first.resources);r.render(first,{width:128,height:128});
  const shared=r.stats(),firstHash=await hash(pixels(r));r.render(evaluate(1),{width:128,height:128});const same=r.stats();
  const changed=fixture();changed.resources.triangle=resource(-2,.25);r.render(createEvaluator(changed)(0),{width:128,height:128});
  const replacement=r.stats(),different=firstHash!==await hash(pixels(r));
  changed.space3d!.nodes=[];r.render(createEvaluator(changed)(0),{width:128,height:128});const empty=r.stats();
  r.dispose();return {shared,same,replacement,different,empty,disposed:r.stats(),sourceUnchanged:JSON.stringify(first.resources)===source,afterDispose:errorCode(()=>r.render(first,{width:128,height:128}))};
 }finally{r.dispose();}},
 errors(){return withRenderer(r=>{
  const source=fixture();delete source.space3d!.camera!.projection;
  const unavailable=document.createElement('canvas');unavailable.getContext=(()=>null) as any;
  const mutable=structuredClone(frame());
  const invalid=fixture();invalid.resources.triangle=resource();(invalid.resources.triangle as MeshResource).positions.data[0]=-1e100;
  (invalid.resources.triangle as MeshResource).bounds!.min[0]=-1e100;
  return {projection:errorCode(()=>r.render(createEvaluator(source)(0),{width:128,height:128})),
   dimensions:errorCode(()=>r.render(frame(),{width:10000,height:2})),color:errorCode(()=>r.render(frame(),{width:128,height:128,background:'red'})),
   unavailable:errorCode(()=>createGpuRenderer({canvas:unavailable})),mutable:errorCode(()=>r.render(mutable,{width:128,height:128})),
   precision:errorCode(()=>r.render(createEvaluator(invalid)(0),{width:128,height:128}))};
 });},
 async context(){const r=createGpuRenderer({antialias:false});try{
  const f=frame();r.render(f,{width:128,height:128});const before=await hash(pixels(r)),extension=r.canvas.getContext('webgl2')!.getExtension('WEBGL_lose_context');
  if(!extension)throw Error('CONTEXT_LOSS_EXTENSION_UNAVAILABLE');
  const lost=new Promise<void>(resolve=>r.canvas.addEventListener('webglcontextlost',()=>resolve(),{once:true}));extension.loseContext();await lost;
  const stateLost=r.state,error=errorCode(()=>r.render(f,{width:128,height:128})),lostStats=r.stats();
  const restored=new Promise<void>(resolve=>r.canvas.addEventListener('webglcontextrestored',()=>resolve(),{once:true}));
  await new Promise(resolve=>setTimeout(resolve,50));extension.restoreContext();await restored;
  r.render(f,{width:128,height:128});return {stateLost,error,lostStats,stateRestored:r.state,samePixels:before===await hash(pixels(r)),restored:r.stats()};
 }finally{r.dispose();}},
};
