import {createGpuRenderer} from '../src/renderers/gpu/index.js';
import {createEvaluator} from '../src/evaluate.js';
import type {Bundle} from '../src/schema.js';
import type {MeshResource} from '../src/ir/mesh.js';
import {renderRawReference,type ReferenceDraw} from './gpu-reference.js';

export async function instanceQa(){
 const r=createGpuRenderer({antialias:false}),gl=r.canvas.getContext('webgl2')!;
 const read=()=>{const data=new Uint8Array(128*128*4);gl.readPixels(0,0,128,128,gl.RGBA,gl.UNSIGNED_BYTE,data);return data;};
 const hash=async(data:Uint8Array)=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',data as Uint8Array<ArrayBuffer>))].map(n=>n.toString(16).padStart(2,'0')).join('');
 const mesh:MeshResource={kind:'mesh',version:1,primitive:'triangles',units:'unit',coordinateSpace:'object',winding:'ccw',topologyRevision:'prototype',
  positions:{version:1,componentType:'float64',components:3,count:3,byteOffset:0,byteStride:24,data:[-.2,-.3,0,.2,-.3,0,0,.3,0]},
  indices:{version:1,componentType:'uint16',components:1,count:3,byteOffset:0,byteStride:2,data:[0,1,2]},bounds:{min:[-.2,-.3,0],max:[.2,.3,0]}};
 const base:Bundle={version:'0.3',units:'bp',title:'Instance GPU reference',duration:2,viewport:{width:128,height:128},camera:{x:0,y:0,zoom:1},nodes:[],tracks:[],relations:[],resources:{prototype:mesh},
  instances:{version:1,operations:[{id:'set',prototype:'prototype',units:'unit',seed:10,source:{kind:'points',points:[{id:'red',position:[-.6,0,-2]},{id:'green',position:[0,0,-2]},{id:'blue',position:[.6,0,-2]}]},
   color:['if(index == 0, 1, 0)','if(index == 1, 1, 0)','if(index == 2, 1, 0)']}]},
  space3d:{version:1,units:'unit',handedness:'right',upAxis:'z',nodes:[{kind:'instances',id:'batch',instanceSetId:'set',material:{kind:'unlit',color:'#ffffff',side:'front'}}],camera:{id:'camera',projection:{kind:'orthographic',height:2,near:1,far:5}}}};
 const source=JSON.stringify(base),records=[];
 try{
  for(const mode of ['orthographic','perspective','mixed-reflection','camera-affine','camera-reflection','camera-reflection-double','clip','backface','double','equal-depth']){
   const b=structuredClone(base),op=b.instances!.operations[0];
   if(mode==='perspective')b.space3d!.camera!.projection={kind:'perspective',fovY:Math.PI/2,near:1,far:5};
   if(mode==='mixed-reflection'||mode==='equal-depth')op.scale=['if(index == 1, -1, 1)','1','1'];
   if(mode==='camera-affine')b.space3d!.camera!.transform={translation:[.2,0,0],scale:[2,.5,1]};
   if(mode.startsWith('camera-reflection'))b.space3d!.camera!.transform={scale:[-1,1,1]};
   if(mode==='camera-reflection-double'||mode==='double')(b.space3d!.nodes[0] as any).material.side='double';
   if(mode==='clip')b.space3d!.clippingPlanes=[{normal:[1,0,0],constant:0}];
   if(mode==='backface'||mode==='double')(b.resources.prototype as MeshResource).indices.data=[0,2,1];
   if(mode==='equal-depth')op.position=['0','0','-2'];
   const f=createEvaluator(b)(0),batch=f.space3d!.instanceBatches![0],prototype=f.resources.prototype as MeshResource;
   const draws:ReferenceDraw[]=batch.instances.filter(i=>i.selected).map(i=>({positions:[...prototype.positions.data],indices:[...prototype.indices.data],
    model:[...i.worldMatrix],viewProjection:[...f.space3d!.camera!.viewProjectionMatrix!],orientation:i.orientation,side:batch.material.side,
    color:'#'+i.color.map(v=>Math.round(v*255).toString(16).padStart(2,'0')).join('')}));
   r.render(f,{width:128,height:128});const actual=read(),ref=renderRawReference(document.createElement('canvas'),draws,128,128,f.space3d!.clippingPlanes.map(p=>[...p.normal,p.constant]));
   records.push({mode,changed:actual.reduce((n,v,j)=>n+Number(v!==ref[j]),0),painted:actual.filter((v,j)=>j%4===3&&v!==0).length,stats:r.stats(),hash:await hash(actual)});
  }
  const frame=createEvaluator(base)(0);r.render(frame,{width:128,height:128});const first=await hash(read()),shared=r.stats();
  // Track actual WebGL buffers as well as our public accounting across changed counts and new prepared scenes.
  const originalCreate=gl.createBuffer.bind(gl),originalDelete=gl.deleteBuffer.bind(gl),created=new Set<WebGLBuffer>();
  gl.createBuffer=()=>{const b=originalCreate();if(b)created.add(b);return b;};
  gl.deleteBuffer=b=>{if(b)created.delete(b);originalDelete(b);};
  const empty=structuredClone(base);empty.instances!.operations[0].selection='false';r.render(createEvaluator(empty)(0),{width:128,height:128});
  const cycles=[];
  for(let i=0;i<12;i++){
   const b=structuredClone(base);b.instances!.operations[0].selection=i%2?'index == 1':'true';
   const f=createEvaluator(b)(0);r.render(f,{width:128,height:128});cycles.push({buffers:created.size,stats:r.stats()});
  }
  r.render(createEvaluator(empty)(0),{width:128,height:128});const pruned=r.stats(),buffersAfterPrune=created.size;
  r.render(frame,{width:128,height:128});const reverse=first===await hash(read());
  const edited=structuredClone(base);(edited.resources.prototype as MeshResource).positions.data=[-.1,-.15,0,.1,-.15,0,0,.15,0];(edited.resources.prototype as MeshResource).bounds={min:[-.1,-.15,0],max:[.1,.15,0]};
  r.render(createEvaluator(edited)(0),{width:128,height:128});const prototypeChanged=first!==await hash(read()),editedStats=r.stats();
  r.render(frame,{width:128,height:128});const ext=gl.getExtension('WEBGL_lose_context')!;
  const lost=new Promise<void>(yes=>r.canvas.addEventListener('webglcontextlost',()=>yes(),{once:true}));ext.loseContext();await lost;const lostStats=r.stats();
  const restored=new Promise<void>(yes=>r.canvas.addEventListener('webglcontextrestored',()=>yes(),{once:true}));await new Promise(yes=>setTimeout(yes,50));ext.restoreContext();await restored;
  r.render(frame,{width:128,height:128});const restoredSame=first===await hash(read());r.dispose();
  return {records,shared,cycles,pruned,buffersAfterPrune,reverse,prototypeChanged,editedStats,lostStats,restoredSame,disposed:r.stats(),buffersAfterDispose:created.size,sourceUnchanged:source===JSON.stringify(base)};
 }finally{r.dispose();}
}
