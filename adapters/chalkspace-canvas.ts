import type {EvaluatedFrame} from '../src/schema.js';
import {renderCanvas} from '../src/render-canvas.js';
import type {BoardPlacement} from './chalkspace.js';
export * from './chalkspace-lecture.js';

export interface BoardView {
  frameWidth: number;
  frameHeight: number;
  /** Absolute board-world y coordinate at the viewport center. */
  cameraY: number;
}
export interface BoardScreenRect {x: number; y: number; width: number; height: number}

/** Scene placement is x=center and y=top, in board-world units. */
export function boardScreenRect(viewport: {width: number; height: number}, placement: BoardPlacement,
  view: BoardView, pixelWidth: number): BoardScreenRect {
  if (![viewport.width,viewport.height,placement.width,view.frameWidth,view.frameHeight,pixelWidth].every(v=>Number.isFinite(v)&&v>0) ||
      ![placement.x,placement.y,view.cameraY].every(Number.isFinite)) throw new Error('BOARD_PLACEMENT: invalid dimensions or camera.');
  const zoom=pixelWidth/view.frameWidth, width=placement.width*zoom;
  return {x:(placement.x-placement.width/2+view.frameWidth/2)*zoom,
    y:(placement.y-view.cameraY+view.frameHeight/2)*zoom,
    width,height:width*viewport.height/viewport.width};
}

/**
 * Native Canvas presentation of an already sampled frame on a host board.
 * Host owns its clock, board material, clip, layer order, erasure and audio.
 * This adapter applies no chalk stroke inference or arbitrary recoloring.
 */
export function createChalkspaceCanvasLayer(placement: BoardPlacement) {
  const placed={...placement};
  let buffer: HTMLCanvasElement | undefined;
  const opacitySurfaces: CanvasRenderingContext2D[]=[];
  let surfaceIndex=0;
  let disposed=false;
  const surface=(w:number,h:number):CanvasRenderingContext2D=>{
    const index=surfaceIndex++;
    if(!opacitySurfaces[index]) {
      const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;
      const ctx=canvas.getContext('2d');if(!ctx)throw new Error('Canvas 2D unavailable');
      opacitySurfaces[index]=ctx;
    }
    return opacitySurfaces[index];
  };
  return {draw(frame:EvaluatedFrame,ctx:CanvasRenderingContext2D,view:BoardView):BoardScreenRect {
    if(disposed)throw new Error('BOARD_DISPOSED: layer has been disposed.');
    const rect=boardScreenRect(frame.viewport,placed,view,ctx.canvas.width);
    // Current Chalkspace host has a fixed 16:9 board viewport. Avoid silently
    // stretching when the caller provides a different camera/canvas aspect.
    if(Math.abs(ctx.canvas.height-ctx.canvas.width*view.frameHeight/view.frameWidth)>1)
      throw new Error('BOARD_ASPECT: canvas and board viewport must have the same aspect ratio.');
    const width=Math.max(1,Math.ceil(rect.width)),height=Math.max(1,Math.ceil(rect.height));
    if(width>8192||height>8192)throw new Error('BOARD_SURFACE_BUDGET: layer exceeds 8192 backing pixels per dimension.');
    buffer??=document.createElement('canvas');
    if(buffer.width!==width)buffer.width=width;if(buffer.height!==height)buffer.height=height;
    const layer=buffer.getContext('2d');if(!layer)throw new Error('Canvas 2D unavailable');
    surfaceIndex=0;
    renderCanvas(frame,layer,{background:'transparent',createSurface:surface});
    ctx.save();
    try {ctx.resetTransform();ctx.globalCompositeOperation='source-over';ctx.globalAlpha=1;
      ctx.shadowColor='transparent';ctx.shadowBlur=0;ctx.filter='none';
      ctx.drawImage(buffer,rect.x,rect.y,rect.width,rect.height);
    } finally {ctx.restore();}
    return rect;
  },dispose(){
    if(disposed)return;disposed=true;
    if(buffer){buffer.width=0;buffer.height=0;buffer=undefined;}
    for(const surface of opacitySurfaces){surface.canvas.width=0;surface.canvas.height=0;}
    opacitySurfaces.length=0;
  }};
}
