import type {EvaluatedFrame, Resource, TexNode} from '../schema.js';
import {renderCanvas,canvasBackground,type CanvasOptions} from '../render-canvas.js';
import {createGpuRenderer} from './gpu/index.js';

/** Host-owned composition: GPU mesh pass, document ink, then projected native TeX.
 * The 2D camera applies to document ink only. Overlay positions are already in
 * viewport bp, so they use an identity 2D camera and never get projected twice. */
export function createSceneCanvasRenderer(){
  let gpu:ReturnType<typeof createGpuRenderer>|undefined,disposed=false;
  let lastResources:EvaluatedFrame['resources']|undefined;
  let inkResources:Record<string,Resource>={};
  return {
    render(frame:EvaluatedFrame,ctx:CanvasRenderingContext2D,options:CanvasOptions={}):void {
      if(disposed)throw new Error('SCENE_RENDERER_DISPOSED: renderer has been disposed.');
      if(!frame.space3d){renderCanvas(frame,ctx,options);return;}
      const width=options.width??ctx.canvas.width,height=options.height??ctx.canvas.height;
      if(![width,height,frame.viewport.width,frame.viewport.height].every(x=>Number.isFinite(x)&&x>0)||width>4096||height>4096)
        throw new Error('SCENE_RENDER_SIZE: expected positive finite dimensions up to 4096 pixels for GPU composition.');
      const scale=Math.min(width/frame.viewport.width,height/frame.viewport.height);
      const background=canvasBackground(ctx,options.background??'#0b1715');
      const fittedWidth=frame.viewport.width*scale,fittedHeight=frame.viewport.height*scale;
      const x=(width-fittedWidth)/2,y=(height-fittedHeight)/2;
      gpu??=createGpuRenderer();
      // Finish GPU work before touching host pixels. A lost context must not
      // publish a successful but empty composite or silently use a stale frame.
      gpu.render(frame,{width:Math.max(1,Math.ceil(fittedWidth)),height:Math.max(1,Math.ceil(fittedHeight)),background:'transparent'});
      if(lastResources!==frame.resources){
        inkResources=Object.fromEntries(Object.entries(frame.resources).filter(([,r])=>r.kind!=='mesh'));
        lastResources=frame.resources;
      }
      const {space3d,...base}=frame;
      const ink:EvaluatedFrame={...base,resources:inkResources};
      ctx.save();
      try{
        ctx.resetTransform();ctx.globalAlpha=1;ctx.globalCompositeOperation='source-over';
        ctx.shadowColor='transparent';ctx.shadowBlur=0;ctx.filter='none';
        if(options.clear!==false)ctx.clearRect(0,0,width,height);
        if(background!=='transparent'){ctx.fillStyle=background;ctx.fillRect(0,0,width,height);}
        ctx.drawImage(gpu.canvas,x,y,fittedWidth,fittedHeight);
        renderCanvas(ink,ctx,{...options,width,height,background:'transparent',clear:false});
        const nodes:TexNode[]=space3d.overlays.filter(o=>o.visible&&o.position!==null).map(o=>({
          id:o.id,kind:'tex',resourceId:o.resourceId,x:o.position![0],y:o.position![1],scale:o.scale,style:{fill:o.color},
        }));
        if(nodes.length)renderCanvas({...ink,nodes,camera:{x:0,y:0,zoom:1}},ctx,
          {width,height,clear:false,background:'transparent',createSurface:options.createSurface});
      }finally{ctx.restore();}
    },
    dispose(){if(disposed)return;disposed=true;gpu?.dispose();gpu=undefined;lastResources=undefined;inkResources={};},
  };
}
