import type {DeepReadonly,Diagnostic} from '../ir/operations.js';
import type {MeshResource,MeshUnit} from '../ir/mesh.js';
import {snapshotMeshResource} from '../ir/mesh.js';
import type {NumericBuffer} from '../resources/buffers.js';
import {validateAssetJson} from '../resources/package.js';
import {freezeSnapshot} from '../operations/values.js';
import type {Vec3,Bounds3D} from './matrix4.js';

export type SurfaceSeam='open'|'weld'|'duplicate';
export type SurfaceBoundary='u-min'|'u-max'|'v-min'|'v-max';
export interface ParametricSurfaceOptions {
  units:MeshUnit;domain:{u:[number,number];v:[number,number]};segments:{u:number;v:number};
  seams?:{u?:SurfaceSeam;v?:SurfaceSeam};collapsedBoundaries?:SurfaceBoundary[];
  normals:{kind:'analytic'|'finite-difference'};orientation?:'uv'|'vu';seamTolerance?:number;
}
export type SurfacePosition=(u:number,v:number)=>readonly [number,number,number];
export type SurfaceDerivatives=(u:number,v:number)=>{dU:readonly [number,number,number];dV:readonly [number,number,number]};
export interface SurfaceAttributes {uv:DeepReadonly<NumericBuffer>;basePositions:DeepReadonly<NumericBuffer>}
export interface SurfaceReport {
  vertices:number;triangles:number;gridSamples:number;positionEvaluations:number;derivativeEvaluations:number;
  omittedTriangles:number;collapsedVertices:readonly number[];
  normals:{kind:'analytic'|'finite-difference';regularVertices:number;collapsedVertices:number;collapsedPolicy:'incident-face-average'};
}
export interface SurfaceSample {mesh:DeepReadonly<MeshResource>;attributes:DeepReadonly<SurfaceAttributes>;report:DeepReadonly<SurfaceReport>}
interface ResolvedOptions extends ParametricSurfaceOptions {
  seams:{u:SurfaceSeam;v:SurfaceSeam};collapsedBoundaries:SurfaceBoundary[];orientation:'uv'|'vu';seamTolerance:number;
}
export interface PreparedParametricSurface {
  contract:'texloom-parametric-surface/1';options:ResolvedOptions;topologyRevision:string;
  attributes:SurfaceAttributes;baseMesh:DeepReadonly<MeshResource>;indices:NumericBuffer;
  gridToVertex:number[];vertexGridIndices:number[];collapsedVertices:number[];omittedTriangles:number;
}
export const MAX_SURFACE_CELLS=32768,MAX_SURFACE_VERTICES=65536,MAX_SURFACE_EVALUATIONS=1_000_000;
export class ParametricSurfaceError extends Error {
  readonly diagnostics:DeepReadonly<Diagnostic[]>;
  constructor(readonly code:string,message:string,path='$.surface'){
    super(`${code}: ${message}`);this.name='ParametricSurfaceError';
    this.diagnostics=freezeSnapshot([{severity:'error' as const,code,message,path}]);
  }
}
const object=(v:unknown):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
const fail=(code:string,message:string,path?:string):never=>{throw new ParametricSurfaceError(code,message,path);};
const boundaries:SurfaceBoundary[]=['u-min','u-max','v-min','v-max'];
const preparedObjects=new WeakSet<object>();
const gridParameter=(options:DeepReadonly<ParametricSurfaceOptions>,axis:'u'|'v',i:number)=>i===options.segments[axis]
  ?options.domain[axis][1]:options.domain[axis][0]+(options.domain[axis][1]-options.domain[axis][0])*(i/options.segments[axis]);

export function validateParametricSurfaceOptions(input:unknown,path='$.surface'):Diagnostic[]{
  const out=validateAssetJson(input,path);if(out.length)return out;
  const error=(code:string,message:string,at=path)=>out.push({severity:'error',code,message,path:at});
  const keys=(value:Record<string,unknown>,allowed:string[],at:string)=>{
    for(const key of Object.keys(value))if(!allowed.includes(key))error('SURFACE_OPTIONS',`Unknown property ${key}.`,`${at}.${key}`);
  };
  if(!object(input)){error('SURFACE_OPTIONS','Expected surface options.');return out;}
  keys(input,['units','domain','segments','seams','collapsedBoundaries','normals','orientation','seamTolerance'],path);
  if(!['unit','m','cm','mm'].includes(input.units))error('SURFACE_UNITS','Expected explicit unit, m, cm or mm.',path+'.units');
  if(!object(input.domain)||!object(input.segments)){error('SURFACE_GRID','Expected u/v domains and segment counts.');return out;}
  keys(input.domain,['u','v'],path+'.domain');keys(input.segments,['u','v'],path+'.segments');
  for(const axis of ['u','v'] as const){
    const d=input.domain[axis],n=input.segments[axis];
    if(!Array.isArray(d)||d.length!==2||!d.every(finite)||!(d[1]>d[0])||!Number.isFinite(d[1]-d[0]))
      error('SURFACE_DOMAIN','Domains must have two finite increasing endpoints and finite length.',path+'.domain.'+axis);
    if(!Number.isSafeInteger(n)||n<1||n>MAX_SURFACE_CELLS)error('SURFACE_GRID','Segment counts must be bounded positive integers.',path+'.segments.'+axis);
  }
  if(input.seams!==undefined){
    if(!object(input.seams))error('SURFACE_SEAM','Expected a u/v seam policy.',path+'.seams');
    else{keys(input.seams,['u','v'],path+'.seams');for(const axis of ['u','v'])
      if(input.seams[axis]!==undefined&&!['open','weld','duplicate'].includes(input.seams[axis]))error('SURFACE_SEAM','Expected open, weld or duplicate.',path+'.seams.'+axis);}
  }
  const collapse=input.collapsedBoundaries===undefined?[]:input.collapsedBoundaries;
  if(!Array.isArray(collapse)||collapse.some((b:unknown)=>!boundaries.includes(b as SurfaceBoundary))||new Set(collapse).size!==collapse.length)
    error('SURFACE_COLLAPSE','Collapsed boundaries must be unique named grid boundaries.',path+'.collapsedBoundaries');
  else{
    if(collapse.some((b:string)=>b.startsWith('u'))&&collapse.some((b:string)=>b.startsWith('v')))
      error('SURFACE_COLLAPSE','Collapsed boundaries are supported on one parameter axis at a time.');
    for(const axis of ['u','v'] as const)if(collapse.some((b:string)=>b.startsWith(axis))){
      if(input.seams?.[axis]!==undefined&&input.seams[axis]!=='open')error('SURFACE_COLLAPSE','A collapsed boundary axis must be open.');
      if(collapse.includes(axis+'-min')&&collapse.includes(axis+'-max')&&input.segments[axis]<2)
        error('SURFACE_COLLAPSE','Two collapsed ends require at least two segments between them.');
    }
  }
  if(!object(input.normals)||!['analytic','finite-difference'].includes(input.normals.kind))error('SURFACE_NORMALS','Expected analytic or finite-difference normals.',path+'.normals');
  else keys(input.normals,['kind'],path+'.normals');
  if(input.orientation!==undefined&&!['uv','vu'].includes(input.orientation))error('SURFACE_ORIENTATION','Expected uv or vu.',path+'.orientation');
  if(input.seamTolerance!==undefined&&(!finite(input.seamTolerance)||input.seamTolerance<0))error('SURFACE_TOLERANCE','Seam tolerance must be finite and nonnegative.',path+'.seamTolerance');
  if(out.length)return out;
  if(input.segments.u*input.segments.v>MAX_SURFACE_CELLS||(input.segments.u+1)*(input.segments.v+1)>MAX_SURFACE_VERTICES)
    error('SURFACE_BUDGET',`At most ${MAX_SURFACE_CELLS} cells and ${MAX_SURFACE_VERTICES} grid vertices are supported.`);
  for(const axis of ['u','v'] as const){
    if((input.seams?.[axis]??'open')!=='open'&&input.segments[axis]<3)error('SURFACE_SEAM','Periodic axes require at least three segments.');
    const [a,b]=input.domain[axis],step=(b-a)/input.segments[axis];
    if(!(a+step>a)||!(b-step<b))error('SURFACE_PRECISION','Grid spacing must advance both domain endpoints.',path+'.domain.'+axis);
    let previous=a;for(let i=1;i<=input.segments[axis];i++){
      const next=gridParameter(input as ParametricSurfaceOptions,axis,i);
      if(!(next>previous)){error('SURFACE_PRECISION','Grid coordinates must be strictly increasing.',path+'.domain.'+axis);break;}previous=next;
    }
    if(input.normals.kind==='finite-difference'){
      const h=(b-a)*1e-5;if(!(a+h>a)||!(b-h<b))error('SURFACE_PRECISION','Finite-difference spacing does not advance the parameter domain.',path+'.domain.'+axis);
    }
  }
  return out;
}
const numeric=(data:number[],components:1|2|3,type:NumericBuffer['componentType']='float64'):NumericBuffer=>({
  version:1,componentType:type,components,count:data.length/components,byteOffset:0,byteStride:components*(type==='uint16'?2:type==='float64'?8:4),data});
function vec(value:unknown,label:string):Vec3{
  if(!Array.isArray(value)||value.length!==3||!value.every(finite))fail('SURFACE_NONFINITE',`${label} must return three finite coordinates.`);
  const coordinates=value as number[];return [coordinates[0],coordinates[1],coordinates[2]];
}
function direction(a:readonly number[],b:readonly number[]):Vec3{
  const sa=Math.max(...a.map(Math.abs)),sb=Math.max(...b.map(Math.abs));
  if(!(sa>0)||!(sb>0))fail('SURFACE_NORMAL','Regular parameter derivatives must be nonzero.');
  const x=a.map(n=>n/sa),y=b.map(n=>n/sb),cross:Vec3=[x[1]*y[2]-x[2]*y[1],x[2]*y[0]-x[0]*y[2],x[0]*y[1]-x[1]*y[0]];
  const length=Math.hypot(...cross);
  if(!(length>0)||!Number.isFinite(length)){
    // Independent normalization can underflow a small but independent component.
    // Recover a representable raw cross before declaring the derivatives singular.
    const raw:Vec3=[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]],scale=Math.max(...raw.map(Math.abs));
    if(raw.every(Number.isFinite)&&scale>0){const scaled=raw.map(n=>n/scale),norm=Math.hypot(...scaled);return scaled.map(n=>n/norm) as Vec3;}
    fail('SURFACE_NORMAL','Regular parameter derivatives must be linearly independent.');
  }
  return cross.map(n=>n/length) as Vec3;
}
function edge(a:readonly number[],b:readonly number[]):Vec3{
  let delta=b.map((n,i)=>n-a[i]);if(!delta.every(Number.isFinite))delta=b.map((n,i)=>n/2-a[i]/2);
  return delta as Vec3;
}
const distance=(a:readonly number[],b:readonly number[])=>Math.hypot(...a.map((n,i)=>n-b[i]));
const at=(a:readonly number[],i:number)=>a.slice(i*3,i*3+3) as Vec3;
type Topology=Omit<PreparedParametricSurface,'baseMesh'|'attributes'> & {uv:NumericBuffer};
function topology(options:ResolvedOptions):Topology{
  const nu=options.segments.u,nv=options.segments.v,width=nu+1,count=width*(nv+1),parents=Array.from({length:count},(_,i)=>i);
  const find=(i:number):number=>{while(parents[i]!==i){parents[i]=parents[parents[i]];i=parents[i];}return i;};
  const join=(a:number,b:number)=>{a=find(a);b=find(b);parents[Math.max(a,b)]=Math.min(a,b);};
  if(options.seams.u==='weld')for(let j=0;j<=nv;j++)join(j*width,j*width+nu);
  if(options.seams.v==='weld')for(let i=0;i<=nu;i++)join(i,nv*width+i);
  const boundaryIndices=(b:SurfaceBoundary):number[]=>b[0]==='u'?Array.from({length:nv+1},(_,j)=>j*width+(b==='u-min'?0:nu)):
    Array.from({length:nu+1},(_,i)=>(b==='v-min'?0:nv*width)+i);
  const collapsedGrid:number[]=[];
  for(const b of options.collapsedBoundaries){const row=boundaryIndices(b);for(const i of row)join(row[0],i);collapsedGrid.push(row[0]);}
  const vertexGridIndices:number[]=[],gridToVertex:number[]=[],roots=new Map<number,number>(),uv:number[]=[];
  for(let g=0;g<count;g++){
    const root=find(g);if(!roots.has(root)){roots.set(root,roots.size);vertexGridIndices.push(g);
      const i=g%width,j=Math.floor(g/width);uv.push(gridParameter(options,'u',i),gridParameter(options,'v',j));}
    gridToVertex.push(roots.get(root)!);
  }
  const collapsedVertices=[...new Set(collapsedGrid.map(g=>gridToVertex[g]))],indices:number[]=[];let omittedTriangles=0;
  for(let j=0;j<nv;j++)for(let i=0;i<nu;i++){
    const a=gridToVertex[j*width+i],b=gridToVertex[j*width+i+1],c=gridToVertex[(j+1)*width+i+1],d=gridToVertex[(j+1)*width+i];
    for(const triangle of [[a,b,c],[a,c,d]]){
      if(new Set(triangle).size<3){omittedTriangles++;continue;}
      if(options.orientation==='vu')[triangle[1],triangle[2]]=[triangle[2],triangle[1]];
      indices.push(...triangle);
    }
  }
  if(indices.length===0)fail('SURFACE_TOPOLOGY','The declared grid has no noncollapsed triangles.');
  const topologyRevision=`surface/1:${nu}x${nv}:${options.seams.u},${options.seams.v}:${options.collapsedBoundaries.join(',')}:${options.orientation}`;
  return {contract:'texloom-parametric-surface/1',options,topologyRevision,uv:numeric(uv,2),
    indices:numeric(indices,1,vertexGridIndices.length<=65536?'uint16':'uint32'),gridToVertex,vertexGridIndices,collapsedVertices,omittedTriangles};
}
function evaluate(top:DeepReadonly<Topology>,position:SurfacePosition,derivatives:SurfaceDerivatives|undefined,captured?:DeepReadonly<SurfaceAttributes>):DeepReadonly<SurfaceSample>{
  if(typeof position!=='function'||top.options.normals.kind==='analytic'&&typeof derivatives!=='function')fail('SURFACE_CALLBACK','Position and requested analytic derivatives must be functions.');
  const o=top.options,nu=o.segments.u,nv=o.segments.v,width=nu+1,grid:Vec3[]=[],normals:number[]=[],positions:number[]=[];
  let positionEvaluations=0,derivativeEvaluations=0;
  const sample=(u:number,v:number):Vec3=>{if(++positionEvaluations>MAX_SURFACE_EVALUATIONS)fail('SURFACE_BUDGET','Position evaluation budget exceeded.');
    if(!Number.isFinite(u)||!Number.isFinite(v))fail('SURFACE_PRECISION','Parameter arithmetic must remain finite before calling the position evaluator.');
    return vec(position(u,v),`position(${u},${v})`);};
  const parameter=(axis:'u'|'v',i:number)=>gridParameter(o,axis,i);
  for(let j=0;j<=nv;j++)for(let i=0;i<=nu;i++)grid.push(sample(parameter('u',i),parameter('v',j)));
  const coincide=(a:number,b:number,kind:string)=>{if(distance(grid[a],grid[b])>o.seamTolerance)fail(kind,'Declared seam or collapsed boundary positions do not coincide within seamTolerance.');};
  if(o.seams.u!=='open')for(let j=0;j<=nv;j++)coincide(j*width,j*width+nu,'SURFACE_SEAM');
  if(o.seams.v!=='open')for(let i=0;i<=nu;i++)coincide(i,nv*width+i,'SURFACE_SEAM');
  for(const boundary of o.collapsedBoundaries){
    const list=boundary[0]==='u'?Array.from({length:nv+1},(_,j)=>j*width+(boundary==='u-min'?0:nu)):
      Array.from({length:nu+1},(_,i)=>(boundary==='v-min'?0:nv*width)+i);
    for(const g of list)coincide(list[0],g,'SURFACE_COLLAPSE');
    for(const g of list)grid[g]=grid[list[0]];
  }
  // Both seam policies have exactly coincident position copies after their authored endpoints pass validation.
  if(o.seams.u!=='open')for(let j=0;j<=nv;j++)grid[j*width+nu]=grid[j*width];
  if(o.seams.v!=='open')for(let i=0;i<=nu;i++)grid[nv*width+i]=grid[i];
  for(const g of top.vertexGridIndices)positions.push(...grid[g]);
  const collapsed=new Set(top.collapsedVertices),poleSums=new Map<number,Vec3>(top.collapsedVertices.map(i=>[i,[0,0,0]]));
  for(let t=0;t<top.indices.data.length;t+=3){
    const ids=top.indices.data.slice(t,t+3),a=at(positions,ids[0]),b=at(positions,ids[1]),c=at(positions,ids[2]);
    let normal:Vec3;try{normal=direction(edge(a,b),edge(a,c));}catch(error){
      if(error instanceof ParametricSurfaceError)fail('SURFACE_DEGENERATE',`Triangle ${t/3} unexpectedly degenerates; no dynamic triangle removal is allowed.`);throw error;
    }
    for(const id of ids)if(collapsed.has(id)){const sum=poleSums.get(id)!;normal.forEach((n,k)=>sum[k]+=n);}
  }
  const normalCache=new Map<number,Vec3>();
  const regularNormal=(g:number):Vec3=>{
    if(normalCache.has(g))return normalCache.get(g)!;
    const u=parameter('u',g%width),v=parameter('v',Math.floor(g/width));let dU:Vec3,dV:Vec3;
    if(o.normals.kind==='analytic'){
      derivativeEvaluations++;const result=derivatives!(u,v);
      if(!object(result))fail('SURFACE_NORMAL','Analytic derivatives require dU and dV.');
      dU=vec(result.dU,'dU');dV=vec(result.dV,'dV');
    }else{
      const difference=(axis:'u'|'v'):Vec3=>{
        const [a,b]=o.domain[axis],value=axis==='u'?u:v,h=(b-a)*1e-5;
        let low:number,high:number;
        if(o.seams[axis]==='open'){low=Math.max(a,value-h);high=Math.min(b,value+h);}
        else{low=value-a<h?b-(h-(value-a)):value-h;high=b-value<h?a+(h-(b-value)):value+h;}
        if(low===high||(low===value&&high===value))fail('SURFACE_PRECISION','Finite-difference samples do not advance the parameter.');
        return axis==='u'?edge(sample(low,v),sample(high,v)):edge(sample(u,low),sample(u,high));
      };
      dU=difference('u');dV=difference('v');
    }
    const n=direction(dU,dV).map(x=>o.orientation==='vu'?-x:x) as Vec3;normalCache.set(g,n);return n;
  };
  for(let i=0;i<top.vertexGridIndices.length;i++){
    if(collapsed.has(i)){const sum=poleSums.get(i)!,length=Math.hypot(...sum);if(!(length>0))fail('SURFACE_NORMAL','Incident pole faces have no nonzero average normal.');normals.push(...sum.map(x=>x/length));}
    else normals.push(...regularNormal(top.vertexGridIndices[i]));
  }
  // Welding also identifies normals; a crease needs explicit duplicate vertices.
  for(let g=0;g<top.gridToVertex.length;g++){
    const vertex=top.gridToVertex[g];if(collapsed.has(vertex)||g===top.vertexGridIndices[vertex])continue;
    if(distance(regularNormal(g),at(normals,vertex))>1e-6)fail('SURFACE_SEAM_NORMAL','Welded seam normals disagree; use duplicate seams for an authored crease.');
  }
  const bounds:Bounds3D={min:[Infinity,Infinity,Infinity],max:[-Infinity,-Infinity,-Infinity]};
  positions.forEach((value,i)=>{bounds.min[i%3]=Math.min(bounds.min[i%3],value);bounds.max[i%3]=Math.max(bounds.max[i%3],value);});
  const attributes:DeepReadonly<SurfaceAttributes>=captured??{uv:top.uv,basePositions:numeric(positions,3)};
  const report:SurfaceReport={vertices:positions.length/3,triangles:top.indices.count/3,gridSamples:grid.length,positionEvaluations,derivativeEvaluations,
    omittedTriangles:top.omittedTriangles,collapsedVertices:[...top.collapsedVertices],normals:{kind:o.normals.kind,
      regularVertices:positions.length/3-top.collapsedVertices.length,collapsedVertices:top.collapsedVertices.length,collapsedPolicy:'incident-face-average'}};
  const mesh=snapshotMeshResource({kind:'mesh',version:1,primitive:'triangles',units:o.units,coordinateSpace:'object',winding:'ccw',
    topologyRevision:top.topologyRevision,positions:numeric(positions,3),indices:top.indices,normals:numeric(normals,3),bounds,
    provenance:{parametricSurface:{version:1,domain:o.domain,segments:o.segments,seams:o.seams,collapsedBoundaries:o.collapsedBoundaries,
      orientation:o.orientation,seamTolerance:o.seamTolerance,uv:attributes.uv,basePositions:attributes.basePositions,normals:report.normals}}});
  return freezeSnapshot({mesh,attributes,report} as SurfaceSample);
}

export function prepareParametricSurface(options:ParametricSurfaceOptions,position:SurfacePosition,derivatives?:SurfaceDerivatives):DeepReadonly<PreparedParametricSurface>{
  const diagnostics=validateParametricSurfaceOptions(options);if(diagnostics.length)throw new ParametricSurfaceError(diagnostics[0].code,diagnostics[0].message,diagnostics[0].path);
  const o:ResolvedOptions={...structuredClone(options),seams:{u:options.seams?.u??'open',v:options.seams?.v??'open'},
    collapsedBoundaries:[...(options.collapsedBoundaries??[])].sort() as SurfaceBoundary[],orientation:options.orientation??'uv',seamTolerance:options.seamTolerance??1e-9};
  const top=topology(o),initial=evaluate(top,position,derivatives);
  const prepared=freezeSnapshot({...top,attributes:initial.attributes,baseMesh:initial.mesh} as PreparedParametricSurface);
  preparedObjects.add(prepared);return prepared;
}
export function sampleParametricSurface(prepared:DeepReadonly<PreparedParametricSurface>,position:SurfacePosition,derivatives?:SurfaceDerivatives):DeepReadonly<SurfaceSample>{
  if(!preparedObjects.has(prepared))fail('SURFACE_PREPARED','Expected an immutable object returned by prepareParametricSurface.');
  return evaluate({...prepared,uv:prepared.attributes.uv},position,derivatives,prepared.attributes);
}
