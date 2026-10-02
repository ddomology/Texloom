import {PathGeometryError, type PathContour, type PathGeometry, type PathPoint} from '../path-geometry.js';
import type {DeepReadonly} from '../ir/operations.js';

/** Data coordinates are dimensionless, y-up. Only origin, dimensions and tickSize use scene bp. */
export interface CartesianConfig {
  origin:PathPoint; width:number; height:number;
  xMin:number; xMax:number; yMin:number; yMax:number;
  xScale?:'linear'|'log'; yScale?:'linear'|'log'; logBase?:number;
  /** Linear data units, or exponent increments for logarithmic axes. */
  xStep?:number; yStep?:number; tickSize?:number; maxTicks?:number;
}
export interface TickFormatOptions {notation?:'decimal'|'scientific';precision?:number}
export interface CartesianAxes {
  xAxis:PathGeometry; yAxis:PathGeometry; ticks:PathGeometry; grid:PathGeometry;
  /** Numeric values before any display rounding. */
  xTicks:number[]; yTicks:number[];
}
export interface CartesianMapping {
  dataToScene(x:number,y:number):PathPoint;
  /** Returned pair contains dimensionless mathematical data, not scene bp. */
  sceneToData(point:DeepReadonly<PathPoint>):PathPoint;
}
export const MAX_AXIS_TICKS=4096;
export type AxisErrorCode='AXIS_OPTIONS'|'AXIS_DOMAIN'|'AXIS_PRECISION'|'AXIS_RANGE'|'AXIS_BUDGET'|'AXIS_COORDINATE'|'AXIS_FORMAT'|'AXIS_LABEL_DUPLICATE';
type AxisScale='linear'|'log';
interface Axis {min:number;max:number;scale:AxisScale;low:number;high:number;span:number;step:number}
interface Normalized {origin:PathPoint;width:number;height:number;x:Axis;y:Axis;logBase:number;tickSize:number;maxTicks:number}
const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value);
function fail(code:AxisErrorCode,message:string):never {throw new PathGeometryError(code,message);}
function fallback<T>(value:T|undefined,defaultValue:T):T {return value===undefined?defaultValue:value;}
function numeric(value:number):number {
  if(!finite(value))fail('AXIS_RANGE','Axis arithmetic exceeded the finite numeric range.');
  return Object.is(value,-0)?0:value;
}
function plain(value:unknown,keys:readonly string[]):asserts value is Record<string,unknown> {
  if(value===null||typeof value!=='object'||Array.isArray(value))fail('AXIS_OPTIONS','Expected an ordinary options object.');
  const proto=Object.getPrototypeOf(value);
  if(proto!==null&&proto!==Object.prototype||Object.getOwnPropertySymbols(value).length)fail('AXIS_OPTIONS','Expected plain axis options.');
  for(const [key,d] of Object.entries(Object.getOwnPropertyDescriptors(value)))
    if(!keys.includes(key)||!d.enumerable||!Object.hasOwn(d,'value'))fail('AXIS_OPTIONS',`Unsupported axis property ${key}.`);
}
function point(value:unknown):asserts value is PathPoint {
  if(!Array.isArray(value)||value.length!==2||Object.getPrototypeOf(value)!==Array.prototype||Object.getOwnPropertySymbols(value).length)
    fail('AXIS_OPTIONS','Expected a finite coordinate pair.');
  const descriptors=Object.getOwnPropertyDescriptors(value);
  if(Object.keys(descriptors).some(key=>!['0','1','length'].includes(key))||!['0','1'].every(key=>descriptors[key]?.enumerable&&Object.hasOwn(descriptors[key],'value')&&finite(descriptors[key].value)))
    fail('AXIS_OPTIONS','Expected an ordinary finite coordinate pair.');
}
function positive(value:unknown,name:string):number {
  if(!finite(value)||value<=0)fail('AXIS_OPTIONS',`${name} must be finite and positive.`);return value;
}
function axis(min:unknown,max:unknown,scale:unknown,step:unknown,name:string):Axis {
  if(!finite(min)||!finite(max)||max<=min)fail('AXIS_DOMAIN',`${name} requires a finite strictly increasing domain.`);
  if(scale!=='linear'&&scale!=='log')fail('AXIS_OPTIONS',`Unsupported ${name} scale.`);
  if(scale==='log'&&min<=0)fail('AXIS_DOMAIN',`Logarithmic ${name} requires a positive domain.`);
  const low=scale==='log'?Math.log(min):min,high=scale==='log'?Math.log(max):max,span=numeric(high-low);
  if(span<=0)fail('AXIS_PRECISION',`${name} domain is indistinguishable at floating point precision.`);
  return {min,max,scale,low,high,span,step:positive(step,`${name} step`)};
}
function normalize(config:DeepReadonly<CartesianConfig>):Normalized {
  plain(config,['origin','width','height','xMin','xMax','yMin','yMax','xScale','yScale','logBase','xStep','yStep','tickSize','maxTicks']);
  point(config.origin);
  const width=positive(config.width,'width'),height=positive(config.height,'height');
  const logBase=fallback(config.logBase,10),tickSize=fallback(config.tickSize,6),maxTicks=fallback(config.maxTicks,512);
  if(!finite(logBase)||logBase<=1)fail('AXIS_OPTIONS','logBase must be finite and greater than one.');
  if(!finite(tickSize)||tickSize<0)fail('AXIS_OPTIONS','tickSize must be finite and nonnegative.');
  if(!Number.isInteger(maxTicks)||maxTicks<1||maxTicks>MAX_AXIS_TICKS)fail('AXIS_BUDGET',`maxTicks must be an integer from 1 to ${MAX_AXIS_TICKS}.`);
  const origin:PathPoint=[...config.origin];
  if(numeric(origin[0]+width)<=origin[0]||numeric(origin[1]+height)<=origin[1])
    fail('AXIS_PRECISION','Axis dimensions must remain distinguishable at the scene origin.');
  return {origin,width,height,logBase,tickSize,maxTicks,
    x:axis(config.xMin,config.xMax,fallback(config.xScale,'linear'),fallback(config.xStep,1),'x'),
    y:axis(config.yMin,config.yMax,fallback(config.yScale,'linear'),fallback(config.yStep,1),'y')};
}
function freeze<T>(value:T):T {
  if(value!==null&&typeof value==='object'){for(const item of Object.values(value))freeze(item);Object.freeze(value);}return value;
}
function forward(a:Axis,value:number):number {
  if(!finite(value))fail('AXIS_COORDINATE','Data coordinates must be finite.');
  if(a.scale==='log'&&value<=0)fail('AXIS_DOMAIN','Logarithmic data coordinates must be positive.');
  if(value===a.min)return 0;if(value===a.max)return 1;
  return numeric(((a.scale==='log'?Math.log(value):value)-a.low)/a.span);
}
function inverse(a:Axis,ratio:number):number {
  if(ratio===0)return a.min;if(ratio===1)return a.max;
  const value=numeric(a.low+numeric(a.span*ratio));
  const result=numeric(a.scale==='log'?Math.exp(value):value);
  if(a.scale==='log'&&result<=0)fail('AXIS_RANGE','Inverse logarithmic mapping underflowed the positive numeric range.');
  return result;
}
function map(c:Normalized,x:number,y:number):PathPoint {
  return freeze([numeric(c.origin[0]+numeric(c.width*forward(c.x,x))),numeric(c.origin[1]+numeric(c.height*(1-forward(c.y,y))))]);
}
/** No clamping: finite out-of-domain coordinates extrapolate, while invalid logarithmic inputs fail. */
export function createCartesianMapping(config:DeepReadonly<CartesianConfig>):CartesianMapping {
  const c=normalize(config);
  return Object.freeze({dataToScene:(x:number,y:number):PathPoint=>map(c,x,y),sceneToData:(p:DeepReadonly<PathPoint>):PathPoint=>{
    point(p);
    return freeze([inverse(c.x,numeric((p[0]-c.origin[0])/c.width)),inverse(c.y,numeric(1-(p[1]-c.origin[1])/c.height))]);
  }});
}
/** Only cancel a few floating point ulps; never collapse a material fraction of a tick. */
function integerSnap(value:number):number {
  const nearest=Math.round(value),tolerance=Math.min(1e-7,8*Number.EPSILON*Math.max(1,Math.abs(value)));
  // A very small, nonzero quotient is not accumulated floating point error at zero.
  if(nearest===0)return value;
  return Math.abs(value-nearest)<=tolerance?nearest:value;
}
function ticks(a:Axis,c:Normalized,budget:number):number[] {
  const log=Math.log(c.logBase),low=a.scale==='log'?a.low/log:a.low,high=a.scale==='log'?a.high/log:a.high;
  const lowIndex=numeric(low/a.step),highIndex=numeric(high/a.step);
  if(low!==0&&lowIndex===0||high!==0&&highIndex===0)fail('AXIS_PRECISION','Tick lattice indices underflow floating point precision.');
  const first=Math.ceil(integerSnap(lowIndex)),last=Math.floor(integerSnap(highIndex));
  if(!Number.isSafeInteger(first)||!Number.isSafeInteger(last))fail('AXIS_PRECISION','Tick lattice indices exceed exact integer precision.');
  const count=Math.max(0,last-first+1);
  if(count>budget)fail('AXIS_BUDGET',`Axis ticks exceed the total maxTicks budget of ${c.maxTicks}.`);
  const result:number[]=[];
  for(let offset=0;offset<count;offset++) {
    const lattice=numeric((first+offset)*a.step),value=numeric(a.scale==='log'?Math.pow(c.logBase,lattice):lattice);
    if(a.scale==='log'&&value<=0)fail('AXIS_RANGE','A logarithmic tick underflowed the positive numeric range.');
    // A rounded product just outside the boundary may represent the boundary tick.
    // Retain the lattice value: the display formatter must never alter numeric tick data.
    if(result.length&&value<=result[result.length-1])fail('AXIS_PRECISION','Adjacent ticks collapse at floating point precision.');
    result.push(value);
  }
  return result;
}
function bothTicks(c:Normalized):{x:number[];y:number[]} {
  const x=ticks(c.x,c,c.maxTicks),y=ticks(c.y,c,c.maxTicks-x.length);return {x,y};
}
const crossing=(a:Axis):number=>a.scale==='log'?a.min:Math.max(a.min,Math.min(a.max,0));
function line(id:string,start:PathPoint,end:PathPoint):PathContour {
  return {id,start,segments:[{kind:'line',id:'line',to:end}]};
}
/** Geometry contains scene bp only. Renderers consume ordinary paths without knowing data domains. */
export function createCartesianAxes(config:DeepReadonly<CartesianConfig>):DeepReadonly<CartesianAxes> {
  const c=normalize(config),values=bothTicks(c),crossX=crossing(c.x),crossY=crossing(c.y),half=c.tickSize/2;
  const tickContours:PathContour[]=[],gridContours:PathContour[]=[];
  values.x.forEach((value,index)=>{
    const [x,y]=map(c,value,crossY),id=`x-${index}`;
    if(c.tickSize)tickContours.push(line(id,[x,numeric(y-half)],[x,numeric(y+half)]));
    gridContours.push(line(id,[x,c.origin[1]],[x,numeric(c.origin[1]+c.height)]));
  });
  values.y.forEach((value,index)=>{
    const [x,y]=map(c,crossX,value),id=`y-${index}`;
    if(c.tickSize)tickContours.push(line(id,[numeric(x-half),y],[numeric(x+half),y]));
    gridContours.push(line(id,[c.origin[0],y],[numeric(c.origin[0]+c.width),y]));
  });
  return freeze({xAxis:{contours:[line('x-axis',map(c,c.x.min,crossY),map(c,c.x.max,crossY))]},
    yAxis:{contours:[line('y-axis',map(c,crossX,c.y.min),map(c,crossX,c.y.max))]},
    ticks:{contours:tickContours},grid:{contours:gridContours},xTicks:values.x,yTicks:values.y});
}
function inRange(a:Axis,value:number):boolean {
  // Products such as -3 * .1 may land one ulp below an authored -.3 boundary.
  // Compare in data units, with no unit-sized tolerance near zero. Also cap the
  // tolerance relative to the domain so narrow domains cannot admit a material
  // out-of-range point merely because their absolute coordinates are large.
  const tolerance=(boundary:number):number=>Math.min(
    8*Number.EPSILON*Math.max(Math.abs(value),Math.abs(boundary)),(a.max-a.min)*1e-12);
  return (value>=a.min||a.min-value<=tolerance(a.min))&&(value<=a.max||value-a.max<=tolerance(a.max));
}
function onTicks(value:number,values:number[],a:Axis,c:Normalized):boolean {
  if(!values.length)return false;
  const scaled=a.scale==='log'?Math.log(value)/Math.log(c.logBase):value,quotient=scaled/a.step;
  const index=integerSnap(quotient);
  if(!Number.isSafeInteger(index))return false;
  const first=a.scale==='log'?Math.log(values[0])/Math.log(c.logBase)/a.step:values[0]/a.step;
  const last=a.scale==='log'?Math.log(values[values.length-1])/Math.log(c.logBase)/a.step:values[values.length-1]/a.step;
  return index>=Math.round(first)&&index<=Math.round(last);
}
/** Axis labels sit at the axis crossing; the caller applies typography-aware anchors and padding. */
export function cartesianLabelPosition(config:DeepReadonly<CartesianConfig>,x:number,y:number,axisName:'point'|'x'|'y',respectTicks=true):{position:PathPoint;visible:boolean} {
  const c=normalize(config);
  if(!['point','x','y'].includes(axisName)||typeof respectTicks!=='boolean')fail('AXIS_OPTIONS','Invalid axis label profile.');
  if(!finite(x)||!finite(y))fail('AXIS_COORDINATE','Data coordinates must be finite.');
  if(axisName==='point')return freeze({position:map(c,x,y),visible:inRange(c.x,x)&&inRange(c.y,y)});
  const a=axisName==='x'?c.x:c.y,value=axisName==='x'?x:y;
  const values=respectTicks?bothTicks(c):undefined;
  return freeze({position:axisName==='x'?map(c,x,crossing(c.y)):map(c,crossing(c.x),y),
    visible:inRange(a,value)&&(!values||onTicks(value,axisName==='x'?values.x:values.y,a,c))});
}
function formatOptions(options:DeepReadonly<TickFormatOptions>):Required<TickFormatOptions> {
  plain(options,['notation','precision']);const notation=fallback(options.notation,'decimal'),precision=fallback(options.precision,6);
  if(!['decimal','scientific'].includes(notation)||!Number.isInteger(precision)||precision<0||precision>12)
    fail('AXIS_FORMAT','Tick formatting requires decimal/scientific notation and integer precision from 0 to 12.');
  return {notation,precision};
}
function trimFraction(value:string):string {return value.includes('.')?value.replace(/0+$/,'').replace(/\.$/,''):value;}
function decimal(value:number,precision:number):string {
  const fixed=value.toFixed(precision);
  if(!fixed.includes('e'))return trimFraction(fixed);
  // ECMAScript toFixed emits exponent notation for |value| >= 1e21.
  const [coefficient,exponent]=fixed.split('e'),negative=coefficient.startsWith('-'),digits=coefficient.replace(/[-.]/g,''),places=Number(exponent)+1;
  return `${negative?'-':''}${digits}${'0'.repeat(places-digits.length)}`;
}
/** Formatting never changes the numeric position of a tick. */
export function formatTick(value:number,options:DeepReadonly<TickFormatOptions>={}):string {
  if(!finite(value))fail('AXIS_FORMAT','Tick values must be finite.');
  const o=formatOptions(options),clean=Object.is(value,-0)?0:value;
  if(o.notation==='decimal') {const result=decimal(clean,o.precision);return /^-0(?:\.0*)?$/.test(result)?'0':result;}
  const [coefficient,exponent]=clean.toExponential(o.precision).split('e');
  return `${trimFraction(coefficient)}e${Number(exponent)>=0?'+':''}${Number(exponent)}`;
}
export function formatTickLabels(values:readonly number[],options:DeepReadonly<TickFormatOptions>={}):string[] {
  formatOptions(options);
  if(!Array.isArray(values)||values.length>MAX_AXIS_TICKS)fail('AXIS_BUDGET',`A tick label catalog supports at most ${MAX_AXIS_TICKS} entries.`);
  if(Object.getPrototypeOf(values)!==Array.prototype||Object.getOwnPropertySymbols(values).length)fail('AXIS_FORMAT','Expected an ordinary array of finite tick values.');
  const descriptors=Object.getOwnPropertyDescriptors(values);
  for(const [key,d] of Object.entries(descriptors))if(key!=='length'&&(!/^(0|[1-9]\d*)$/.test(key)||!d.enumerable||!Object.hasOwn(d,'value')))
    fail('AXIS_FORMAT','Tick catalogs require ordinary numeric entries.');
  const seen=new Map<string,number>(),labels:string[]=[];
  for(const value of values) {
    const label=formatTick(value,options);
    if(seen.has(label)&&seen.get(label)!==value)fail('AXIS_LABEL_DUPLICATE',`Distinct tick values have the same label ${label}; increase precision.`);
    seen.set(label,value);labels.push(label);
  }
  return freeze(labels);
}
