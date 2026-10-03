import type {DeepReadonly,Diagnostic} from '../ir/operations.js';
import {copyMeshBuffers,snapshotMeshResource,type MeshResource} from '../ir/mesh.js';
import type {Vec3,Quaternion,Bounds3D} from '../geometry/matrix4.js';
import type {NumericBuffer} from '../resources/buffers.js';
import {MAX_BUFFER_COMPONENTS} from '../resources/limits.js';
import {validateAssetJson} from '../resources/package.js';
import {freezeSnapshot} from './values.js';

/** RGB values are linear-sRGB components, not encoded sRGB bytes. */
export interface ColorMapStop {position:number;color:Vec3}
export interface ScalarColorOptions {
  stops:ColorMapStop[];
  range:{mode:'fixed';min:number;max:number}|{mode:'auto'};
  outOfRange:'clamp'|'mask'|'error';
  invalidColor:Vec3;
}
export interface ScalarColorMapping {
  raw:(number|null)[];
  /** Raw-data validity is independent of presentation-range masking. */
  validity:boolean[];
  mappedValidity:boolean[];
  colors:Vec3[];
  normalized:(number|null)[];
  range:{min:number;max:number}|null;
}
export interface FieldVectorOptions {up:Vec3;zeroPolicy:'hide'|'identity';lengthScale:number}
export interface OrientedFieldVector {rotation:Quaternion;magnitude:number;displayLength:number;visible:boolean}
export interface NormalDisplacementOptions {
  amplitude:number;
  normalPolicy:'drop'|'recompute';
  degenerateNormalPolicy:'error'|'source';
}
export interface DisplacedFieldMesh {
  mesh:MeshResource;
  normalOrigin:'source'|'none'|'recomputed'|'recomputed-with-source-fallback';
  sourceNormalFallbacks:number[];
}
export class FieldVisualizationError extends Error {
  readonly code:string;readonly diagnostics:DeepReadonly<Diagnostic[]>;
  constructor(diagnostics:readonly Diagnostic[]) {
    super(diagnostics.map(d=>`${d.code}: ${d.message} (${d.path??'$'})`).join('\n'));
    this.name='FieldVisualizationError';this.code=diagnostics.find(d=>d.severity==='error')?.code??'FIELD_VISUALIZATION_INVALID';
    this.diagnostics=freezeSnapshot(diagnostics);
  }
}
export const MAX_FIELD_VISUALIZATION_SAMPLES=Math.floor(MAX_BUFFER_COMPONENTS/3);
export const MAX_COLOR_MAP_STOPS=256;
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
function fail(code:string,message:string,path='$'):never {throw new FieldVisualizationError([{severity:'error',code,message,path}]);}
function data(value:unknown,path:string):void {
  const errors=validateAssetJson(value,path);if(errors.length)throw new FieldVisualizationError(errors);
}
function keys(value:unknown,allowed:readonly string[],path:string):asserts value is Record<string,unknown> {
  if(!object(value))fail('FIELD_VISUALIZATION_OPTIONS','Expected a plain data object.',path);
  for(const name of Object.keys(value))if(!allowed.includes(name))fail('FIELD_VISUALIZATION_OPTIONS',`Unsupported property ${name}.`,`${path}.${name}`);
}
function vector(value:unknown,path:string,color=false):asserts value is Vec3 {
  if(!Array.isArray(value)||value.length!==3||!value.every(finite)||color&&value.some(v=>v<0||v>1))
    fail(color?'FIELD_COLOR':'FIELD_VECTOR',color?'Expected three linear-sRGB components in [0,1].':'Expected three finite vector components.',path);
}
function rawScalars(raw:unknown,path='$.raw'):asserts raw is readonly(number|null)[] {
  data(raw,path);
  if(!Array.isArray(raw)||raw.length>MAX_FIELD_VISUALIZATION_SAMPLES)fail('FIELD_SAMPLE_BUDGET',`Expected at most ${MAX_FIELD_VISUALIZATION_SAMPLES} scalar samples.`,path);
  for(let i=0;i<raw.length;i++)if(raw[i]!==null&&!finite(raw[i]))fail('FIELD_SCALAR','Expected finite scalar samples or explicit null invalid samples.',`${path}[${i}]`);
}

/** Each call determines its own declared range. No history or cached extrema influence color. */
export function mapScalarColors(raw:readonly(number|null)[],options:DeepReadonly<ScalarColorOptions>):DeepReadonly<ScalarColorMapping> {
  rawScalars(raw);data(options,'$.options');keys(options,['stops','range','outOfRange','invalidColor'],'$.options');
  if(!Array.isArray(options.stops)||options.stops.length<2||options.stops.length>MAX_COLOR_MAP_STOPS)
    fail('FIELD_COLOR_STOPS',`Expected between 2 and ${MAX_COLOR_MAP_STOPS} colormap stops.`,'$.options.stops');
  for(let i=0;i<options.stops.length;i++){
    const stop=options.stops[i],path=`$.options.stops[${i}]`;keys(stop,['position','color'],path);
    if(!finite(stop.position)||stop.position<0||stop.position>1||i>0&&stop.position<=options.stops[i-1].position)
      fail('FIELD_COLOR_STOPS','Colormap positions must be strictly increasing in [0,1].',`${path}.position`);
    vector(stop.color,`${path}.color`,true);
  }
  if(options.stops[0].position!==0||options.stops.at(-1)!.position!==1)
    fail('FIELD_COLOR_STOPS','Colormap stops must include exact endpoints 0 and 1.','$.options.stops');
  keys(options.range,['mode','min','max'],'$.options.range');
  if(options.range.mode==='fixed'){
    if(!finite(options.range.min)||!finite(options.range.max)||options.range.min>=options.range.max)
      fail('FIELD_COLOR_RANGE','A fixed range requires finite min < max.','$.options.range');
  }else if(options.range.mode==='auto'){
    if(Object.keys(options.range).some(k=>k!=='mode'))fail('FIELD_COLOR_RANGE','Auto range has no fixed extrema.','$.options.range');
  }else fail('FIELD_COLOR_RANGE','Expected range mode fixed or auto.','$.options.range.mode');
  if(!['clamp','mask','error'].includes(options.outOfRange))fail('FIELD_COLOR_RANGE','Expected an explicit clamp, mask or error out-of-range policy.','$.options.outOfRange');
  vector(options.invalidColor,'$.options.invalidColor',true);
  let range:ScalarColorMapping['range'];
  if(options.range.mode==='fixed')range={min:options.range.min,max:options.range.max};
  else {
    let min=Infinity,max=-Infinity;for(const value of raw)if(value!==null){min=Math.min(min,value);max=Math.max(max,value);}
    range=min===Infinity?null:{min,max};
  }
  const validity=raw.map(v=>v!==null),mappedValidity:boolean[]=[],normalized:(number|null)[]=[],colors:Vec3[]=[];
  for(let i=0;i<raw.length;i++){
    const value=raw[i];let t:number|null=null;
    if(value!==null&&range!==null){
      const outside=value<range.min||value>range.max;
      if(outside&&options.outOfRange==='error')fail('FIELD_COLOR_OUT_OF_RANGE',`Sample lies outside the fixed range [${range.min}, ${range.max}].`,`$.raw[${i}]`);
      if(!outside||options.outOfRange!=='mask'){
        if(value<=range.min)t=range.min===range.max?.5:0;
        else if(value>=range.max)t=1;
        else {
          const width=range.max-range.min;
          // Halving before subtraction avoids overflow for an interval spanning both finite extremes.
          t=Number.isFinite(width)?(value-range.min)/width:(value/2-range.min/2)/(range.max/2-range.min/2);
          if(!finite(t))fail('FIELD_COLOR_RANGE','Range normalization overflowed.',`$.raw[${i}]`);
          t=Math.min(1,Math.max(0,t));
        }
      }
    }
    mappedValidity.push(t!==null);normalized.push(t);
    if(t===null){colors.push([...options.invalidColor] as Vec3);continue;}
    let right=1;while(right<options.stops.length-1&&t>options.stops[right].position)right++;
    const a=options.stops[right-1],b=options.stops[right],mix=(t-a.position)/(b.position-a.position);
    colors.push(a.color.map((v:number,k:number)=>v+(b.color[k]-v)*mix) as Vec3);
  }
  return freezeSnapshot({raw:[...raw],validity,mappedValidity,colors,normalized,range});
}

function unit(v:readonly number[]):Vec3 {
  const scale=Math.max(...v.map(Math.abs));if(scale===0)return [0,0,0];
  const normalized=v.map(x=>x/scale),length=Math.hypot(...normalized);return normalized.map(x=>x/length) as Vec3;
}
const cross=(a:readonly number[],b:readonly number[]):Vec3=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];

/** Local +X is the arrow direction; projected up is local +Z. Parallel up uses the least-aligned cardinal axis. */
export function orientFieldVector(input:DeepReadonly<Vec3>,options:DeepReadonly<FieldVectorOptions>):DeepReadonly<OrientedFieldVector> {
  data(input,'$.vector');vector(input,'$.vector');data(options,'$.options');keys(options,['up','zeroPolicy','lengthScale'],'$.options');
  vector(options.up,'$.options.up');if(options.up.every(v=>v===0))fail('FIELD_VECTOR_UP','The declared up vector must be nonzero.','$.options.up');
  if(!['hide','identity'].includes(options.zeroPolicy))fail('FIELD_VECTOR_ZERO','Expected an explicit hide or identity zero-vector policy.','$.options.zeroPolicy');
  if(!finite(options.lengthScale)||options.lengthScale<0)fail('FIELD_VECTOR_SCALE','lengthScale must be finite and nonnegative.','$.options.lengthScale');
  const magnitude=Math.hypot(...input),displayLength=magnitude*options.lengthScale;
  if(!finite(magnitude)||!finite(displayLength))fail('FIELD_VECTOR_RANGE','Vector magnitude or display length exceeds finite numeric range.');
  if(magnitude===0)return freezeSnapshot({rotation:[0,0,0,1] as Quaternion,magnitude:0,displayLength:0,visible:options.zeroPolicy==='identity'});
  const x=unit(input),up=unit(options.up);let y=cross(up,x);
  if(y.every(v=>v===0)){
    let axis=0;for(let i=1;i<3;i++)if(Math.abs(x[i])<Math.abs(x[axis]))axis=i;
    const fallback:Vec3=[0,0,0];fallback[axis]=1;y=cross(fallback,x);
  }
  y=unit(y);const z=unit(cross(x,y));
  // Columns x,y,z form a proper orthonormal basis. Pick the best-conditioned quaternion branch.
  const m00=x[0],m01=y[0],m02=z[0],m10=x[1],m11=y[1],m12=z[1],m20=x[2],m21=y[2],m22=z[2],trace=m00+m11+m22;
  let q:Quaternion;
  if(trace>0){const s=2*Math.sqrt(trace+1);q=[(m21-m12)/s,(m02-m20)/s,(m10-m01)/s,s/4];}
  else if(m00>m11&&m00>m22){const s=2*Math.sqrt(1+m00-m11-m22);q=[s/4,(m01+m10)/s,(m02+m20)/s,(m21-m12)/s];}
  else if(m11>m22){const s=2*Math.sqrt(1+m11-m00-m22);q=[(m01+m10)/s,s/4,(m12+m21)/s,(m02-m20)/s];}
  else {const s=2*Math.sqrt(1+m22-m00-m11);q=[(m02+m20)/s,(m12+m21)/s,s/4,(m10-m01)/s];}
  const length=Math.hypot(...q);q=q.map(v=>v/length) as Quaternion;
  const sign=q[3]<0||q[3]===0&&(q.find(v=>v!==0)??0)<0?-1:1;
  q=q.map(v=>v===0?0:v*sign) as Quaternion;
  return freezeSnapshot({rotation:q,magnitude,displayLength,visible:true});
}

function numericBuffer(values:number[]):NumericBuffer {
  return {version:1,componentType:'float64',components:3,count:values.length/3,byteOffset:0,byteStride:24,data:values};
}

/** Area-weighted normals use per-vertex scaled accumulators; huge finite coordinates need no overflowing areas. */
function recomputeNormals(positions:readonly number[],indices:Uint16Array|Uint32Array,source:Float32Array|Float64Array,policy:'error'|'source'):{normals:number[];fallbacks:number[]} {
  const count=positions.length/3,weights=new Float64Array(count).fill(-Infinity),sums=new Float64Array(positions.length);
  for(let face=0;face<indices.length;face+=3){
    const a=indices[face]*3,b=indices[face+1]*3,c=indices[face+2]*3;
    let ab=[0,1,2].map(k=>positions[b+k]-positions[a+k]),ac=[0,1,2].map(k=>positions[c+k]-positions[a+k]),factor=1;
    if(!ab.every(finite)||!ac.every(finite)){ab=[0,1,2].map(k=>positions[b+k]/2-positions[a+k]/2);ac=[0,1,2].map(k=>positions[c+k]/2-positions[a+k]/2);factor=2;}
    const scale=Math.max(...ab.map(Math.abs),...ac.map(Math.abs));if(scale===0)continue;
    const normal=cross(ab.map(v=>v/scale),ac.map(v=>v/scale)),length=Math.hypot(...normal);if(length===0)continue;
    const direction=normal.map(v=>v/length),weight=2*Math.log(scale)+2*Math.log(factor)+Math.log(length);
    for(let corner=0;corner<3;corner++){
      const vertex=indices[face+corner],oldWeight=weights[vertex],nextWeight=Math.max(oldWeight,weight),oldScale=Math.exp(oldWeight-nextWeight),newScale=Math.exp(weight-nextWeight);
      for(let axis=0;axis<3;axis++)sums[vertex*3+axis]=sums[vertex*3+axis]*oldScale+direction[axis]*newScale;
      weights[vertex]=nextWeight;
    }
  }
  const normals:number[]=[],fallbacks:number[]=[];
  for(let vertex=0;vertex<count;vertex++){
    const value=[sums[vertex*3],sums[vertex*3+1],sums[vertex*3+2]],length=Math.hypot(...value);
    if(!finite(length)||length===0){
      if(policy==='error')fail('FIELD_DISPLACEMENT_NORMAL','Cannot determine a nonzero area-weighted normal for this vertex.',`$.mesh.positions[${vertex}]`);
      const original=Array.from(source.subarray(vertex*3,vertex*3+3));
      if(original.length!==3||!original.every(finite)||Math.hypot(...original)===0)fail('FIELD_DISPLACEMENT_NORMAL','Explicit source fallback requires a finite nonzero original normal.',`$.mesh.normals[${vertex}]`);
      normals.push(...original);fallbacks.push(vertex);
    }else normals.push(...value.map(v=>v/length));
  }
  return {normals,fallbacks};
}

/** Displacement always reads the original object-space normals and raw scalar, never display-normalized color values. */
export function displaceMeshAlongNormals(source:DeepReadonly<MeshResource>,raw:readonly(number|null)[],options:DeepReadonly<NormalDisplacementOptions>):DeepReadonly<DisplacedFieldMesh> {
  const mesh=snapshotMeshResource(source);rawScalars(raw);data(options,'$.options');keys(options,['amplitude','normalPolicy','degenerateNormalPolicy'],'$.options');
  if(raw.length!==mesh.positions.count)fail('FIELD_SAMPLE_COUNT','One raw scalar or null is required for every source vertex.','$.raw');
  if(!finite(options.amplitude))fail('FIELD_DISPLACEMENT_AMPLITUDE','Amplitude must be finite.','$.options.amplitude');
  if(options.normalPolicy!=='drop'&&options.normalPolicy!=='recompute')fail('FIELD_DISPLACEMENT_NORMAL','Displaced normals must explicitly be dropped or recomputed.','$.options.normalPolicy');
  if(options.degenerateNormalPolicy!=='error'&&options.degenerateNormalPolicy!=='source')fail('FIELD_DISPLACEMENT_NORMAL','Expected an explicit error or source fallback policy.','$.options.degenerateNormalPolicy');
  if(options.amplitude===0)return freezeSnapshot({mesh,normalOrigin:mesh.normals?'source':'none',sourceNormalFallbacks:[]});
  const input=copyMeshBuffers(mesh);
  if(mesh.positions.count&&!input.normals)fail('FIELD_DISPLACEMENT_SOURCE_NORMAL','Normal displacement requires original vertex normals.','$.mesh.normals');
  const positions=Array.from(input.positions);let bounds:Bounds3D|null=positions.length?{min:[Infinity,Infinity,Infinity],max:[-Infinity,-Infinity,-Infinity]}:null;
  for(let vertex=0;vertex<raw.length;vertex++){
    const scalar=raw[vertex],distance=scalar===null?0:options.amplitude*scalar;
    if(!finite(distance))fail('FIELD_DISPLACEMENT_RANGE','Amplitude times raw scalar exceeds finite numeric range.',`$.raw[${vertex}]`);
    for(let axis=0;axis<3;axis++){
      const index=vertex*3+axis;if(distance!==0)positions[index]+=distance*input.normals![index];
      if(!finite(positions[index]))fail('FIELD_DISPLACEMENT_RANGE','Displaced position exceeds finite numeric range.',`$.mesh.positions[${vertex}][${axis}]`);
      bounds!.min[axis]=Math.min(bounds!.min[axis],positions[index]);bounds!.max[axis]=Math.max(bounds!.max[axis],positions[index]);
    }
  }
  const recomputed=options.normalPolicy==='recompute'?recomputeNormals(positions,input.indices,input.normals??new Float64Array(),options.degenerateNormalPolicy):undefined;
  const {normals:originalNormals,...rest}=mesh;
  const output=snapshotMeshResource({...rest,positions:numericBuffer(positions),bounds,...(recomputed?{normals:numericBuffer(recomputed.normals)}:{})});
  return freezeSnapshot({mesh:output,normalOrigin:recomputed?(recomputed.fallbacks.length?'recomputed-with-source-fallback':'recomputed'):'none',sourceNormalFallbacks:recomputed?.fallbacks??[]});
}
