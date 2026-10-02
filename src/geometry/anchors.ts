import {OperationValidationError,type DeepReadonly} from '../ir/operations.js';
import {anchorNames,type AnchorName,type AnchorProvider,type AnchorQuery,type TextMetrics} from '../ir/text.js';
import type {PathBounds,PathPoint} from '../path-geometry.js';
import {primitiveBounds,validatePrimitive,type Primitive2D} from './primitives.js';
import {freezeSnapshot,validateJsonData} from '../operations/values.js';
export {anchorNames};
export type {AnchorName,AnchorProvider,AnchorQuery,TextMetrics};

export interface TextAnchorOptions {innerSep?:[number,number];outerSep?:[number,number];revision?:string}
export interface MeasuredAnchorOptions {logicalBounds?:PathBounds;inkBounds?:PathBounds;revision?:string}
const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value);
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const named=(value:unknown):value is AnchorName=>typeof value==='string'&&(anchorNames as readonly string[]).includes(value);
function fail(code:string,message:string,path='$.anchor'):never {throw new OperationValidationError([{severity:'error',code,message,path}]);}
function json(value:unknown,path:string):void {const errors=validateJsonData(value,path);if(errors.length)throw new OperationValidationError(errors);}
function keys(value:Record<string,unknown>,allowed:readonly string[],path:string):void {
  for(const key of Object.keys(value))if(!allowed.includes(key))fail('ANCHOR_FIELD',`Unknown anchor field ${key}.`,`${path}.${key}`);
}
function tuple(value:unknown,path:string):asserts value is [number,number] {
  if(!Array.isArray(value)||value.length!==2||!value.every(finite))fail('ANCHOR_METRICS','Expected a finite [x,y] pair.',path);
}
function checked(point:PathPoint):PathPoint {
  if(!point.every(Number.isFinite))fail('ANCHOR_NONFINITE','Anchor coordinates are not finitely representable.');return point;
}
function bounds(value:unknown,path:string):asserts value is PathBounds {
  if(!Array.isArray(value)||value.length!==4||!value.every(finite)||value[2]<0||value[3]<0)
    fail('ANCHOR_METRICS','Expected finite [minX,minY,width,height] with nonnegative extents.',path);
  checked([value[0]+value[2],value[1]+value[3]]);
}
function separation(value:unknown,path:string):[number,number] {
  tuple(value,path);if(value.some(component=>component<0))fail('ANCHOR_METRICS','Separation must be nonnegative.',path);return [...value];
}
function padded(box:readonly number[],sep:readonly number[]):PathBounds {
  const result:PathBounds=[box[0]-sep[0],box[1]-sep[1],box[2]+2*sep[0],box[3]+2*sep[1]];
  bounds(result,'$.anchor.anchorBounds');return result;
}
function optionObject(value:unknown,allowed:readonly string[],path:string):asserts value is Record<string,unknown> {
  json(value,path);if(!object(value))fail('ANCHOR_METRICS','Expected an anchor options object.',path);keys(value,allowed,path);
  if(value.revision!==undefined&&typeof value.revision!=='string')fail('ANCHOR_METRICS','Revision seed must be a string.',path+'.revision');
}
// Arrays with explicit field order provide a deterministic, collision-free identity.
const revision=(data:unknown)=>'texloom-anchor/1:'+JSON.stringify(data);

export function createShapeAnchorProvider(primitive:DeepReadonly<Primitive2D>,outerSep:readonly [number,number]=[0,0]):DeepReadonly<AnchorProvider> {
  const errors=validatePrimitive(primitive);if(errors.length)throw new OperationValidationError(errors);
  if(primitive.kind==='arc'||primitive.kind==='polyline')fail('ANCHOR_UNSUPPORTED','Shape anchors require a closed circle, ellipse, rectangle, or rounded rectangle.');
  json(outerSep,'$.anchor.outerSep');const sep=separation(outerSep,'$.anchor.outerSep'),logicalBounds=primitiveBounds(primitive),anchorBounds=padded(logicalBounds,sep);
  const shape=primitive.kind==='circle'?['circle',...primitive.center,primitive.radius]:primitive.kind==='ellipse'?['ellipse',...primitive.center,primitive.rx,primitive.ry]:
    [primitive.kind,...primitive.origin,primitive.width,primitive.height,...(primitive.kind==='roundedRectangle'?[primitive.cornerRadius]:[])];
  return freezeSnapshot({kind:'shape',primitive,logicalBounds,inkBounds:[...logicalBounds],anchorBounds,outerSep:sep,
    revision:revision(['shape',shape,sep])}) as DeepReadonly<AnchorProvider>;
}

/** Ink bounds never determine text layout or its baseline. Padding affects
 * compass/border anchors, while base anchors refer to the unpadded TeX box. */
export function createTextAnchorProvider(metrics:DeepReadonly<TextMetrics>,inkBounds:readonly [number,number,number,number],options:DeepReadonly<TextAnchorOptions>={}):DeepReadonly<AnchorProvider> {
  json(metrics,'$.anchor.metrics');if(!object(metrics))fail('ANCHOR_METRICS','Expected TeX width, height and depth.');
  keys(metrics,['width','height','depth'],'$.anchor.metrics');
  if(!finite(metrics.width)||!finite(metrics.height)||!finite(metrics.depth)||metrics.width<0||!Number.isFinite(metrics.height+metrics.depth)||metrics.height+metrics.depth<0)
    fail('ANCHOR_METRICS','TeX width and total height must be finite and nonnegative.','$.anchor.metrics');
  json(inkBounds,'$.anchor.inkBounds');bounds(inkBounds,'$.anchor.inkBounds');optionObject(options,['innerSep','outerSep','revision'],'$.anchor.options');
  const innerSep=separation(options.innerSep??[0,0],'$.anchor.options.innerSep'),outerSep=separation(options.outerSep??[0,0],'$.anchor.options.outerSep');
  const logicalBounds:PathBounds=[0,-metrics.height,metrics.width,metrics.height+metrics.depth],sep=checked([innerSep[0]+outerSep[0],innerSep[1]+outerSep[1]]),anchorBounds=padded(logicalBounds,sep);
  return freezeSnapshot({kind:'text',metrics,logicalBounds,inkBounds:[...inkBounds],anchorBounds,innerSep,outerSep,
    revision:revision(['text',options.revision??null,[metrics.width,metrics.height,metrics.depth],[...inkBounds],innerSep,outerSep])}) as DeepReadonly<AnchorProvider>;
}

/** Exact PGF measurements are authoritative; no border is inferred from ink. */
export function createMeasuredAnchorProvider(anchors:DeepReadonly<Partial<Record<AnchorName,PathPoint>>>,options:DeepReadonly<MeasuredAnchorOptions>={}):DeepReadonly<AnchorProvider> {
  json(anchors,'$.anchor.anchors');if(!object(anchors)||!Object.keys(anchors).length)fail('ANCHOR_METRICS','At least one measured anchor is required.');
  for(const [name,point] of Object.entries(anchors)) {if(!named(name))fail('ANCHOR_NAME',`Unsupported anchor name ${name}.`);tuple(point,`$.anchor.anchors.${name}`);}
  optionObject(options,['logicalBounds','inkBounds','revision'],'$.anchor.options');
  if(options.logicalBounds!==undefined)bounds(options.logicalBounds,'$.anchor.options.logicalBounds');
  if(options.inkBounds!==undefined)bounds(options.inkBounds,'$.anchor.options.inkBounds');
  return freezeSnapshot({kind:'measured',anchors,...(options.logicalBounds===undefined?{}:{logicalBounds:options.logicalBounds}),
    ...(options.inkBounds===undefined?{}:{inkBounds:options.inkBounds}),
    revision:revision(['measured',options.revision??null,anchorNames.filter(name=>Object.hasOwn(anchors,name)).map(name=>[name,anchors[name]]),
      options.logicalBounds??null,options.inkBounds??null])}) as DeepReadonly<AnchorProvider>;
}

function rectangleBorder(hx:number,hy:number,direction:PathPoint):PathPoint {
  const [dx,dy]=direction,t=Math.min(dx===0?Infinity:hx/Math.abs(dx),dy===0?Infinity:hy/Math.abs(dy));
  return checked([dx*t,dy*t]);
}
function ellipseBorder(rx:number,ry:number,direction:PathPoint):PathPoint {
  const [dx,dy]=direction;if(dx===0)return [0,Math.sign(dy)*ry];if(dy===0)return [Math.sign(dx)*rx,0];
  const ax=Math.log(Math.abs(dx)),ay=Math.log(Math.abs(dy)),lx=ax-Math.log(rx),ly=ay-Math.log(ry),scale=Math.max(lx,ly);
  const length=Math.hypot(Math.exp(lx-scale),Math.exp(ly-scale));
  return checked([Math.sign(dx)*Math.exp(ax-scale)/length,Math.sign(dy)*Math.exp(ay-scale)/length]);
}
function roundedBorder(hx:number,hy:number,rx:number,ry:number,direction:PathPoint):PathPoint {
  const endpoint=rectangleBorder(hx,hy,direction),x=Math.abs(endpoint[0]),y=Math.abs(endpoint[1]),cx=hx-rx,cy=hy-ry;
  if(rx===0||ry===0||x<=cx||y<=cy)return endpoint;
  // Solve the corner ellipse along the portion of the ray inside its quadrant.
  // All normalized coordinates lie in [0,1], avoiding large-radius squares.
  const enter=Math.max(cx/x,cy/y),clamp=(v:number)=>Math.max(0,Math.min(1,v));
  const a=[clamp((enter*x-cx)/rx),clamp((enter*y-cy)/ry)],b=[clamp((x-cx)/rx),clamp((y-cy)/ry)],d=[b[0]-a[0],b[1]-a[1]];
  const A=d[0]*d[0]+d[1]*d[1],B=2*(a[0]*d[0]+a[1]*d[1]),C=a[0]*a[0]+a[1]*a[1]-1;
  const u=C>=0?0:A===0?1:(-2*C)/(B+Math.sqrt(Math.max(0,B*B-4*A*C))),t=enter+(1-enter)*Math.min(1,u);
  return checked([endpoint[0]*t,endpoint[1]*t]);
}
const compass:Partial<Record<AnchorName,[number,number]>>={center:[0,0],north:[0,-1],'north east':[1,-1],east:[1,0],
  'south east':[1,1],south:[0,1],'south west':[-1,1],west:[-1,0],'north west':[-1,-1]};

/** All directions are provider-local vectors, with north in negative y.
 * Ellipse named diagonals use PGF's 45-degree parametric convention. */
export function anchorPosition(provider:DeepReadonly<AnchorProvider>,query:DeepReadonly<AnchorQuery>):PathPoint {
  json(query,'$.anchor.query');if(!object(query))fail('ANCHOR_QUERY','Expected a named or border query.');
  if(query.kind==='named') {keys(query,['kind','name'],'$.anchor.query');if(!named(query.name))fail('ANCHOR_NAME','Unsupported named anchor.','$.anchor.query.name');}
  else if(query.kind==='border') {keys(query,['kind','direction'],'$.anchor.query');tuple(query.direction,'$.anchor.query.direction');}
  else fail('ANCHOR_QUERY','Expected a named or border query.');
  if(provider.kind==='measured') {
    if(query.kind==='border')fail('ANCHOR_UNSUPPORTED','Measured anchors have no inferred border geometry.');
    const point=provider.anchors[query.name];if(!point)fail('ANCHOR_UNSUPPORTED',`Anchor ${query.name} was not measured.`);return checked([...point]);
  }
  const [x,y,w,h]=provider.anchorBounds,hx=w/2,hy=h/2,center:PathPoint=checked([x+hx,y+hy]);
  if(query.kind==='named'&&(query.name==='base'||query.name==='base west'||query.name==='base east')) {
    if(provider.kind!=='text')fail('ANCHOR_UNSUPPORTED','Baseline anchors require TeX text metrics or measured anchors.');
    return [query.name==='base west'?0:query.name==='base east'?provider.metrics.width:provider.metrics.width/2,0];
  }
  const ellipse=provider.kind==='shape'&&(provider.primitive.kind==='circle'||provider.primitive.kind==='ellipse');
  const rounded=provider.kind==='shape'&&provider.primitive.kind==='roundedRectangle';
  const rx=rounded?provider.primitive.cornerRadius+provider.outerSep[0]:0,ry=rounded?provider.primitive.cornerRadius+provider.outerSep[1]:0;
  let offset:PathPoint;
  if(query.kind==='named') {
    const direction=compass[query.name];if(!direction)fail('ANCHOR_UNSUPPORTED','The mid anchor requires an explicit font measurement.');
    const diagonal=direction[0]!==0&&direction[1]!==0;
    offset=[direction[0]*hx,direction[1]*hy];
    if(diagonal&&ellipse)offset=[offset[0]*Math.SQRT1_2,offset[1]*Math.SQRT1_2];
    else if(diagonal&&rounded)offset=[direction[0]*(hx-rx+rx*Math.SQRT1_2),direction[1]*(hy-ry+ry*Math.SQRT1_2)];
  } else {
    const scale=Math.max(Math.abs(query.direction[0]),Math.abs(query.direction[1]));
    if(scale===0)fail('ANCHOR_DIRECTION','Border direction must be nonzero.','$.anchor.query.direction');
    const direction:PathPoint=[query.direction[0]/scale,query.direction[1]/scale];
    offset=ellipse?ellipseBorder(hx,hy,direction):rounded?roundedBorder(hx,hy,rx,ry,direction):rectangleBorder(hx,hy,direction);
  }
  return checked([center[0]+offset[0],center[1]+offset[1]]);
}
