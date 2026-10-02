import {PathGeometryError,type PathBounds,type PathPoint} from '../path-geometry.js';
import type {DeepReadonly} from '../ir/operations.js';

/** Measured local bounds in bp; baseline is a local y coordinate, with y increasing downwards. */
export interface LayoutBox {bounds:PathBounds;baseline:number}
export type BoxList=(LayoutBox|null)[];
/** Positions are translations of the original local boxes, never replacement bounds. */
export interface BoxLayoutResult {positions:PathPoint[];bounds:PathBounds;rows:number;columns:number}
export type BoxAlignment='start'|'center'|'end'|'baseline';
export interface MatrixBoxOptions {
  origin?:PathPoint;columns?:number;gapX?:number;gapY?:number;
  alignX?:Exclude<BoxAlignment,'baseline'>;alignY?:BoxAlignment;
  maxWidth?:number;maxHeight?:number;overflow?:'allow'|'error';
}
export interface DistributeBoxOptions {
  origin?:PathPoint;axis?:'x'|'y';gap?:number;crossGap?:number;align?:BoxAlignment;
  maxWidth?:number;maxHeight?:number;overflow?:'allow'|'error'|'wrap';
}
export interface AlignBoxOptions {axis?:'x'|'y';align?:BoxAlignment;at?:number}
export interface FitBoxOptions {paddingX?:number;paddingY?:number}
export const MAX_BOX_SLOTS=4096;
const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value);
const obj=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function fail(code:string,message:string):never {throw new PathGeometryError(code,message);}
function json(value:unknown,ancestors=new Set<object>(),depth=0):void {
  if(value===null||typeof value==='string'||typeof value==='boolean'||finite(value))return;
  if(depth>32||typeof value!=='object'||ancestors.has(value))fail('BOX_DATA','Expected finite, acyclic JSON data.');
  const prototype=Object.getPrototypeOf(value),array=Array.isArray(value);
  if(array?prototype!==Array.prototype:prototype!==Object.prototype&&prototype!==null)fail('BOX_DATA','Only plain JSON data is supported.');
  if(Object.getOwnPropertySymbols(value).length)fail('BOX_DATA','Symbol keys are unsupported.');
  const descriptors=Object.getOwnPropertyDescriptors(value);ancestors.add(value);
  if(array&&value.length>MAX_BOX_SLOTS)fail('BOX_BUDGET',`At most ${MAX_BOX_SLOTS} box slots are supported.`);
  if(array)for(let i=0;i<value.length;i++)if(!Object.hasOwn(descriptors,String(i)))fail('BOX_DATA','Sparse arrays are unsupported.');
  for(const [name,descriptor] of Object.entries(descriptors)) {
    if(array&&name==='length')continue;
    if(!descriptor.enumerable||!Object.hasOwn(descriptor,'value')||array&&!/^(0|[1-9]\d*)$/.test(name))fail('BOX_DATA','Expected ordinary enumerable JSON properties.');
    json(descriptor.value,ancestors,depth+1);
  }
  ancestors.delete(value);
}
function keys(value:Record<string,unknown>,allowed:readonly string[]):void {
  if(Object.keys(value).some(key=>!allowed.includes(key)))fail('BOX_OPTIONS','Unknown box layout property.');
}
function frozen<T>(value:T):DeepReadonly<T> {
  const snapshot=structuredClone(value),freeze=(v:any):void=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}};
  json(snapshot);freeze(snapshot);return snapshot as DeepReadonly<T>;
}
function point(value:unknown):value is PathPoint {return Array.isArray(value)&&value.length===2&&value.every(finite);}
export function assertBoxList(value:unknown):asserts value is BoxList {
  json(value);if(!Array.isArray(value))fail('BOX_DATA','Expected an array of measured boxes or null slots.');
  for(const item of value) {
    if(item===null)continue;
    if(!obj(item)||!Array.isArray(item.bounds)||item.bounds.length!==4||!item.bounds.every(finite)||item.bounds[2]<0||item.bounds[3]<0||!finite(item.baseline))
      fail('BOX_DATA','Boxes require finite [x, y, width, height] bounds, nonnegative dimensions and a finite baseline.');
    keys(item,['bounds','baseline']);
    if(!finite(item.bounds[0]+item.bounds[2])||!finite(item.bounds[1]+item.bounds[3])||!finite(item.baseline-item.bounds[1])||!finite(item.bounds[1]+item.bounds[3]-item.baseline))
      fail('BOX_RANGE','Measured box edges or baseline distances exceed the finite numeric range.');
  }
}
function boxes(value:DeepReadonly<BoxList>):BoxList {assertBoxList(value);return structuredClone(value);}
function options(value:unknown,allowed:readonly string[]):Record<string,unknown> {
  json(value);if(!obj(value))fail('BOX_OPTIONS','Expected a plain box layout options object.');keys(value,allowed);return value;
}
function nonnegative(value:unknown,name:string):number {
  if(!finite(value)||value<0)fail('BOX_OPTIONS',`${name} must be finite and nonnegative.`);return value;
}
function oneOf<T extends string>(value:unknown,allowed:readonly T[],name:string):T {
  if(!allowed.includes(value as T))fail('BOX_OPTIONS',`Invalid ${name}.`);return value as T;
}
function origin(value:unknown):PathPoint {if(!point(value))fail('BOX_OPTIONS','origin must be a finite [x, y] pair.');return [...value];}
const option=(v:Record<string,unknown>,key:string,fallback:unknown):unknown=>Object.hasOwn(v,key)?v[key]:fallback;
export function normalizeMatrixBoxOptions(value:DeepReadonly<MatrixBoxOptions>={}):Required<MatrixBoxOptions> {
  const v=options(value,['origin','columns','gapX','gapY','alignX','alignY','maxWidth','maxHeight','overflow']),columns=option(v,'columns',1);
  if(!Number.isInteger(columns)||Number(columns)<1||Number(columns)>MAX_BOX_SLOTS)fail('BOX_OPTIONS',`columns must be an integer from 1 to ${MAX_BOX_SLOTS}.`);
  return {origin:origin(option(v,'origin',[0,0])),columns:Number(columns),gapX:nonnegative(option(v,'gapX',20),'gapX'),gapY:nonnegative(option(v,'gapY',20),'gapY'),
    alignX:oneOf(option(v,'alignX','center'),['start','center','end'],'alignX'),alignY:oneOf(option(v,'alignY','baseline'),['baseline','start','center','end'],'alignY'),
    maxWidth:nonnegative(option(v,'maxWidth',0),'maxWidth'),maxHeight:nonnegative(option(v,'maxHeight',0),'maxHeight'),overflow:oneOf(option(v,'overflow','allow'),['allow','error'],'overflow')};
}
export function normalizeDistributeBoxOptions(value:DeepReadonly<DistributeBoxOptions>={}):Required<DistributeBoxOptions> {
  const v=options(value,['origin','axis','gap','crossGap','align','maxWidth','maxHeight','overflow']);
  const result:Required<DistributeBoxOptions>={origin:origin(option(v,'origin',[0,0])),axis:oneOf(option(v,'axis','x'),['x','y'],'axis'),gap:nonnegative(option(v,'gap',20),'gap'),
    crossGap:nonnegative(option(v,'crossGap',20),'crossGap'),align:oneOf(option(v,'align','center'),['start','center','end','baseline'],'align'),
    maxWidth:nonnegative(option(v,'maxWidth',0),'maxWidth'),maxHeight:nonnegative(option(v,'maxHeight',0),'maxHeight'),overflow:oneOf(option(v,'overflow','allow'),['allow','error','wrap'],'overflow')};
  if(result.axis==='y'&&result.align==='baseline')fail('BOX_OPTIONS','Baseline distribution is supported only on axis x.');
  if(result.overflow==='wrap'&&(result.axis==='x'?result.maxWidth:result.maxHeight)<=0)fail('BOX_OPTIONS','Wrapping requires a positive extent on the distribution axis.');
  return result;
}
export function normalizeAlignBoxOptions(value:DeepReadonly<AlignBoxOptions>={}):Required<AlignBoxOptions> {
  const v=options(value,['axis','align','at']);
  const result:Required<AlignBoxOptions>={axis:oneOf(option(v,'axis','x'),['x','y'],'axis'),align:oneOf(option(v,'align','center'),['start','center','end','baseline'],'align'),at:option(v,'at',0) as number};
  if(!finite(result.at))fail('BOX_OPTIONS','at must be finite.');
  if(result.axis==='x'&&result.align==='baseline')fail('BOX_OPTIONS','Baseline alignment is supported only on axis y.');
  return result;
}
export function normalizeFitBoxOptions(value:DeepReadonly<FitBoxOptions>={}):Required<FitBoxOptions> {
  const v=options(value,['paddingX','paddingY']);return {paddingX:nonnegative(option(v,'paddingX',0),'paddingX'),paddingY:nonnegative(option(v,'paddingY',0),'paddingY')};
}
function positions(value:DeepReadonly<PathPoint[]>,count:number):PathPoint[] {
  json(value);if(!Array.isArray(value)||value.length!==count||!value.every(point))fail('BOX_POSITIONS','Expected one finite [x, y] translation per box slot.');
  return structuredClone(value) as PathPoint[];
}
function numeric(value:number):number {if(!finite(value))fail('BOX_RANGE','Layout arithmetic exceeded the finite numeric range.');return value;}
function exceeds(extent:number,limit:number):boolean {return limit>0&&extent>limit&&extent-limit>Number.EPSILON*8*Math.max(Math.abs(extent),Math.abs(limit));}
function checkOverflow(bounds:PathBounds,maxWidth:number,maxHeight:number):void {
  if(exceeds(bounds[2],maxWidth)||exceeds(bounds[3],maxHeight))fail('BOX_OVERFLOW','Measured boxes exceed the requested layout extent; boxes are never scaled.');
}
function shift(alignment:Exclude<BoxAlignment,'baseline'>,available:number,size:number):number {
  return alignment==='start'?0:alignment==='end'?available-size:(available-size)/2;
}
function baselineMetrics(items:LayoutBox[]):{offsets:number[];height:number} {
  if(!items.length)return {offsets:[],height:0};
  // Cancel the shared baseline first: a huge baseline outside an otherwise small box
  // must not erase its height through (baseline-top)+(bottom-baseline) cancellation.
  const deltas=items.map(item=>numeric(item.baseline-items[0].baseline));
  const tops=items.map((item,index)=>numeric(item.bounds[1]-deltas[index]));
  const minTop=Math.min(...tops),maxBottom=Math.max(...items.map((item,index)=>numeric(tops[index]+item.bounds[3])));
  return {offsets:deltas.map(delta=>numeric(-minTop-delta)),height:numeric(maxBottom-minTop)};
}
function envelope(origin:PathPoint,width:number,height:number):PathBounds {
  numeric(width);numeric(height);numeric(origin[0]+width);numeric(origin[1]+height);return [...origin,width,height];
}
/** Fixed row-major cells. Even empty allocated rows/columns retain their inter-cell gaps. */
export function matrixBoxLayout(input:DeepReadonly<BoxList>,options:DeepReadonly<MatrixBoxOptions>={}):DeepReadonly<BoxLayoutResult> {
  const source=boxes(input),o=normalizeMatrixBoxOptions(options),rows=Math.ceil(source.length/o.columns);
  if(!rows)return frozen({positions:[],bounds:[...o.origin,0,0],rows:0,columns:o.columns} as BoxLayoutResult);
  const widths=Array<number>(o.columns).fill(0),heights=Array<number>(rows).fill(0),baselineOffsets=Array<number>(source.length).fill(0);
  source.forEach((box,index)=>{if(box)widths[index%o.columns]=Math.max(widths[index%o.columns],box.bounds[2]);});
  for(let row=0;row<rows;row++) {
    const items=source.slice(row*o.columns,(row+1)*o.columns).filter((box):box is LayoutBox=>box!==null);
    if(o.alignY==='baseline'){
      const metrics=baselineMetrics(items);heights[row]=metrics.height;let i=0;
      for(let index=row*o.columns;index<Math.min(source.length,(row+1)*o.columns);index++)if(source[index])baselineOffsets[index]=metrics.offsets[i++];
    }
    else heights[row]=Math.max(0,...items.map(box=>box.bounds[3]));
  }
  const left:number[]=[],top:number[]=[];let width=0,height=0;
  widths.forEach((size,i)=>{left.push(width);width=numeric(width+size+(i===widths.length-1?0:o.gapX));});
  heights.forEach((size,i)=>{top.push(height);height=numeric(height+size+(i===heights.length-1?0:o.gapY));});
  const result:BoxLayoutResult={positions:source.map((box,index)=>{
    const col=index%o.columns,row=Math.floor(index/o.columns),x=o.origin[0]+left[col],y=o.origin[1]+top[row];
    if(!box)return [numeric(x),numeric(y)];
    return [numeric(x+shift(o.alignX,widths[col],box.bounds[2])-box.bounds[0]),numeric(y+(o.alignY==='baseline'?baselineOffsets[index]:shift(o.alignY,heights[row],box.bounds[3])-box.bounds[1]))];
  }),bounds:envelope(o.origin,width,height),rows,columns:o.columns};
  if(o.overflow==='error')checkOverflow(result.bounds,o.maxWidth,o.maxHeight);return frozen(result);
}
/** Stable one-dimensional packing; wrap starts a new line/column before the first overflowing item. */
export function distributeBoxLayout(input:DeepReadonly<BoxList>,options:DeepReadonly<DistributeBoxOptions>={}):DeepReadonly<BoxLayoutResult> {
  const source=boxes(input),o=normalizeDistributeBoxOptions(options),primary=o.axis==='x'?0:1,cross=1-primary;
  const limit=primary===0?o.maxWidth:o.maxHeight,lines:number[][]=[];let line:number[]=[],used=0;
  source.forEach((box,index)=>{
    if(!box)return;const size=box.bounds[primary+2];
    if(o.overflow==='wrap'&&exceeds(size,limit))fail('BOX_OVERFLOW','A box exceeds the wrapping extent; boxes are never scaled.');
    const next=numeric(used+(line.length?o.gap:0)+size);
    if(o.overflow==='wrap'&&line.length&&exceeds(next,limit)){lines.push(line);line=[];used=0;}
    used=numeric(used+(line.length?o.gap:0)+size);line.push(index);
  });
  if(line.length)lines.push(line);
  const resultPositions:PathPoint[]=source.map(()=>[...o.origin]),sizes:number[]=[],crossSizes:number[]=[],baselineOffsets:number[][]=[];
  for(const indices of lines) {
    const items=indices.map(index=>source[index]!);sizes.push(numeric(items.reduce((sum,box)=>sum+box.bounds[primary+2],0)+Math.max(0,items.length-1)*o.gap));
    const metrics=o.align==='baseline'?baselineMetrics(items):undefined;
    crossSizes.push(metrics?.height??Math.max(0,...items.map(box=>box.bounds[cross+2])));baselineOffsets.push(metrics?.offsets??[]);
  }
  let crossPosition=0;
  lines.forEach((indices,lineIndex)=>{
    let primaryPosition=0;
    indices.forEach((index,itemIndex)=>{
      const box=source[index]!,position:PathPoint=[0,0];
      position[primary]=numeric(o.origin[primary]+primaryPosition-box.bounds[primary]);
      position[cross]=numeric(o.origin[cross]+crossPosition+(o.align==='baseline'?baselineOffsets[lineIndex][itemIndex]:shift(o.align,crossSizes[lineIndex],box.bounds[cross+2])-box.bounds[cross]));
      resultPositions[index]=position;if(itemIndex!==indices.length-1)primaryPosition=numeric(primaryPosition+box.bounds[primary+2]+o.gap);
    });
    crossPosition=numeric(crossPosition+crossSizes[lineIndex]+(lineIndex===lines.length-1?0:o.crossGap));
  });
  const primaryExtent=Math.max(0,...sizes),dimensions:PathPoint=primary===0?[primaryExtent,crossPosition]:[crossPosition,primaryExtent];
  const result:BoxLayoutResult={positions:resultPositions,bounds:envelope(o.origin,...dimensions),
    rows:primary===0?lines.length:Math.max(0,...lines.map(l=>l.length)),columns:primary===0?Math.max(0,...lines.map(l=>l.length)):lines.length};
  if(o.overflow!=='allow')checkOverflow(result.bounds,o.maxWidth,o.maxHeight);return frozen(result);
}
function union(source:BoxList,translations:PathPoint[],paddingX:number,paddingY:number):PathBounds {
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  source.forEach((box,index)=>{
    if(!box)return;const [x,y,w,h]=box.bounds,left=numeric(x+translations[index][0]),top=numeric(y+translations[index][1]);
    minX=Math.min(minX,left);minY=Math.min(minY,top);maxX=Math.max(maxX,numeric(left+w));maxY=Math.max(maxY,numeric(top+h));
  });
  if(minX===Infinity)return [0,0,0,0];
  return envelope([numeric(minX-paddingX),numeric(minY-paddingY)],numeric(maxX-minX+2*paddingX),numeric(maxY-minY+2*paddingY));
}
/** Union of translated measured boxes. Null slots do not contribute; an empty union has zero padding. */
export function fitBoxBounds(input:DeepReadonly<BoxList>,translations:DeepReadonly<PathPoint[]>,options:DeepReadonly<FitBoxOptions>={}):DeepReadonly<PathBounds> {
  const source=boxes(input),p=positions(translations,source.length),o=normalizeFitBoxOptions(options);return frozen(union(source,p,o.paddingX,o.paddingY));
}
/** Align one local edge/centre/baseline to at, preserving the other translation component. No grid is implied. */
export function alignBoxLayout(input:DeepReadonly<BoxList>,translations:DeepReadonly<PathPoint[]>,options:DeepReadonly<AlignBoxOptions>={}):DeepReadonly<BoxLayoutResult> {
  const source=boxes(input),p=positions(translations,source.length),o=normalizeAlignBoxOptions(options),axis=o.axis==='x'?0:1;
  source.forEach((box,index)=>{if(box){const offset=o.align==='baseline'?box.baseline:box.bounds[axis]+(o.align==='start'?0:o.align==='end'?box.bounds[axis+2]:box.bounds[axis+2]/2);p[index][axis]=numeric(o.at-offset);}});
  return frozen({positions:p,bounds:union(source,p,0,0),rows:0,columns:0});
}
