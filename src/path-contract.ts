import type {PathGeometry, PathPoint} from './path-geometry.js';

const obj=(x:unknown):x is Record<string,any>=>typeof x==='object'&&x!==null&&!Array.isArray(x);
const point=(x:unknown)=>Array.isArray(x)&&x.length===2&&x.every(v=>typeof v==='number'&&Number.isFinite(v));
export function validatePathGeometry(value:unknown):{path:string;message:string}[]{
  const errors:{path:string;message:string}[]=[];
  const fail=(path:string,message:string)=>errors.push({path,message});
  if(!obj(value)||!Array.isArray(value.contours)){fail('','Expected a contours array.');return errors;}
  const ids=new Set<string>();
  value.contours.forEach((c:unknown,i:number)=>{
    const p=`.contours[${i}]`;
    if(!obj(c)){fail(p,'Expected a contour.');return;}
    if(typeof c.id!=='string'||!c.id||c.id.includes('.')||ids.has(c.id))fail(p+'.id','Contour IDs must be unique nonempty strings without dots.');
    ids.add(c.id);
    if(!point(c.start))fail(p+'.start','Expected a finite [x,y] start.');
    if(c.closed!==undefined&&typeof c.closed!=='boolean')fail(p+'.closed','closed must be boolean.');
    if(!Array.isArray(c.segments)){fail(p+'.segments','Expected segment array.');return;}
    const segments=new Set<string>();
    c.segments.forEach((s:unknown,j:number)=>{
      const sp=`${p}.segments[${j}]`;
      if(!obj(s)){fail(sp,'Expected a line or cubic segment.');return;}
      if(typeof s.id!=='string'||!s.id||s.id.includes('.')||segments.has(s.id))fail(sp+'.id','Segment IDs must be unique within a contour and have no dots.');
      if(c.closed&&s.id===`${c.id}:close`)fail(sp+'.id','This ID is reserved for the implicit closing edge of a closed contour.');
      segments.add(s.id);
      if(!['line','cubic'].includes(s.kind))fail(sp+'.kind','Expected line or cubic.');
      if(!point(s.to))fail(sp+'.to','Expected a finite [x,y] endpoint.');
      if(s.kind==='cubic')for(const key of ['c1','c2'])if(!point(s[key]))fail(sp+'.'+key,'Expected a finite [x,y] control point.');
      if(s.kind==='line'&&(s.c1!==undefined||s.c2!==undefined))fail(sp,'Line segments cannot carry cubic controls.');
    });
  });
  return errors;
}
export function parseGeometryProperty(property:unknown):{contour:string;segment?:string;key:'start'|'to'|'c1'|'c2'}|undefined{
  if(typeof property!=='string')return;
  const parts=property.split('.');
  if(parts[0]!=='geometry'||!parts[1])return;
  if(parts.length===3&&parts[2]==='start')return {contour:parts[1],key:'start'};
  if(parts.length===4&&parts[2]&&['to','c1','c2'].includes(parts[3]))return {contour:parts[1],segment:parts[2],key:parts[3] as 'to'|'c1'|'c2'};
}
export function geometryPointSlot(geometry:PathGeometry|undefined,property:string):{get():PathPoint;set(value:PathPoint):void}|undefined{
  const parsed=parseGeometryProperty(property);
  if(!parsed||!geometry||!Array.isArray(geometry.contours))return;
  const contour=geometry.contours.find(c=>c?.id===parsed.contour);
  if(!contour)return;
  if(parsed.key==='start')return {get:()=>contour.start,set:value=>{contour.start=value;}};
  if(!Array.isArray(contour.segments))return;
  const segment=contour.segments.find(s=>s?.id===parsed.segment);
  if(!segment)return;
  if(parsed.key==='to')return {get:()=>segment.to,set:value=>{segment.to=value;}};
  if(segment.kind!=='cubic')return;
  const key=parsed.key;
  return {get:()=>segment[key],set:value=>{segment[key]=value;}};
}
