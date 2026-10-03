import type {DeepReadonly} from '../ir/operations.js';
import {snapshotMeshResource,copyMeshBuffers,type MeshResource} from '../ir/mesh.js';
import {snapshotInstanceSet3D,InstanceSetError,type InstanceSet3D,type InstanceSelection} from '../ir/instances.js';
import {attributeComponents,MAX_MESH_ATTRIBUTES,MAX_MESH_ATTRIBUTE_COMPONENTS,type MeshAttribute} from '../ir/attributes.js';
import {composeTransform3D,normalMatrix3D,orientationMatrix4,transformPoint3D,transformNormal3D,type Bounds3D} from '../geometry/matrix4.js';
import type {NumericBuffer} from '../resources/buffers.js';
import {MAX_BUFFER_COMPONENTS} from '../resources/limits.js';
import {validateAssetJson} from '../resources/package.js';
import {freezeSnapshot} from './values.js';

export interface RealizeMeshOptions {
  topologyRevision:string;
  selection?:InstanceSelection;
  normalPolicy:'transform'|'drop';
  instanceColorAttribute?:string;
  instanceSelectionAttribute?:string;
  maxVertices?:number;
  maxBytes?:number;
}
export interface RealizedInstanceRange {id:string;vertexStart:number;vertexCount:number;faceStart:number;faceCount:number;reflected:boolean;selected:boolean}
export interface RealizedInstanceMesh {
  mesh:DeepReadonly<MeshResource>;
  report:{instances:number;vertices:number;triangles:number;bufferBytes:number;reflectedInstances:number;normalPolicy:'transform'|'drop';selection:InstanceSelection};
  ranges:readonly DeepReadonly<RealizedInstanceRange>[];
}

export const MAX_REALIZED_VERTICES=Math.floor(MAX_BUFFER_COMPONENTS/3);
export const MAX_REALIZED_BYTES=64*1024*1024;
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const validName=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z_][A-Za-z0-9_.:-]{0,511}$/.test(v)&&!['__proto__','constructor','prototype'].includes(v);
function fail(code:string,message:string,path='$.options'):never{throw new InstanceSetError([{severity:'error',code,message,path}]);}
function policy(value:unknown):InstanceSelection{
  if(value!==undefined&&value!=='selected'&&value!=='all')fail('INSTANCE_SELECTION','Expected selected or all.');
  return value===undefined?'selected':value as InstanceSelection;
}
function buffer(values:number[],components:1|2|3,componentType:'float64'|'uint32'='float64'):NumericBuffer{
  return {version:1,componentType,components,count:values.length/components,byteOffset:0,byteStride:components*(componentType==='float64'?8:4),data:values};
}

/** Opaque deterministic identity, not a content/security hash. Exact captured index snapshots remain authoritative. */
export function derivedInstanceTopologyRevision(set:DeepReadonly<InstanceSet3D>,prototype:DeepReadonly<MeshResource>,selection:InstanceSelection='selected'):string{
  const selected=policy(selection),checked=snapshotInstanceSet3D(set,prototype),mesh=snapshotMeshResource(prototype),owned=copyMeshBuffers(mesh);
  const source=JSON.stringify([checked.prototypeResourceId,mesh.topologyRevision,mesh.positions.count,Array.from(owned.indices),
    checked.instances.filter(i=>selected==='all'||i.selected!==false).map(i=>[i.id,orientationMatrix4(composeTransform3D(i.transform))<0])]);
  let a=2166136261,b=0x9e3779b9;
  for(let i=0;i<source.length;i++){const c=source.charCodeAt(i);a=Math.imul(a^c,16777619)>>>0;b=Math.imul(b^c,2246822519)>>>0;}
  return `instances:${a.toString(16).padStart(8,'0')}${b.toString(16).padStart(8,'0')}`;
}

/** Realization allocates new object-space geometry. Generic named vectors remain data, never implicit normals. */
export function realizeMeshInstances(set:DeepReadonly<InstanceSet3D>,prototype:DeepReadonly<MeshResource>,options:RealizeMeshOptions):DeepReadonly<RealizedInstanceMesh>{
  const diagnostics=validateAssetJson(options,'$.options');if(diagnostics.some(d=>d.severity==='error'))throw new InstanceSetError(diagnostics);
  if(!object(options))fail('INSTANCE_OPTIONS','Expected explicit realization options.');
  for(const key of Object.keys(options))if(!['topologyRevision','selection','normalPolicy','instanceColorAttribute','instanceSelectionAttribute','maxVertices','maxBytes'].includes(key))fail('INSTANCE_OPTIONS',`Unsupported realization option ${key}.`);
  if(typeof options.topologyRevision!=='string'||!options.topologyRevision.trim()||options.topologyRevision.length>512)fail('INSTANCE_REVISION','Expected a nonblank topology revision of at most 512 characters.');
  if(options.normalPolicy!=='transform'&&options.normalPolicy!=='drop')fail('INSTANCE_NORMAL_POLICY','normalPolicy must explicitly be transform or drop.');
  const selection=policy(options.selection);
  for(const key of ['instanceColorAttribute','instanceSelectionAttribute'] as const)if(options[key]!==undefined&&!validName(options[key]))fail('INSTANCE_ATTRIBUTE_NAME','Expected a safe literal promoted attribute name.',`$.options.${key}`);
  for(const [key,limit] of [['maxVertices',MAX_REALIZED_VERTICES],['maxBytes',MAX_REALIZED_BYTES]] as const){
    const value=options[key];if(value!==undefined&&(!Number.isSafeInteger(value)||value<1||value>limit))fail('INSTANCE_BUDGET',`${key} must be an integer from 1 to ${limit}.`,`$.options.${key}`);
  }
  const checked=snapshotInstanceSet3D(set,prototype),mesh=snapshotMeshResource(prototype);
  const records=checked.instances.filter(instance=>selection==='all'||instance.selected!==false),count=records.length;
  const vertices=mesh.positions.count*count,indexCount=mesh.indices.count*count,triangles=indexCount/3;
  if(vertices>(options.maxVertices??MAX_REALIZED_VERTICES)||indexCount>MAX_BUFFER_COMPONENTS)fail('INSTANCE_BUDGET','Realized vertex or index count exceeds the explicit buffer budget.');
  const sourceAttributes=Object.entries(mesh.attributes?.values??{});
  const outputNames=new Set(sourceAttributes.map(([name])=>name));
  for(const name of [options.instanceColorAttribute,options.instanceSelectionAttribute])if(name!==undefined){
    if(outputNames.has(name))fail('INSTANCE_ATTRIBUTE_CONFLICT',`Attribute ${name} already exists; realization never overwrites captures.`);
    outputNames.add(name);
  }
  if(outputNames.size>MAX_MESH_ATTRIBUTES)fail('INSTANCE_BUDGET',`Realization exceeds ${MAX_MESH_ATTRIBUTES} named attributes.`);
  const attrComponents=sourceAttributes.reduce((sum,[,a])=>sum+a.buffer.count*a.buffer.components*count,0)+(options.instanceColorAttribute?vertices*3:0)+(options.instanceSelectionAttribute?vertices:0);
  if(attrComponents>MAX_MESH_ATTRIBUTE_COMPONENTS)fail('INSTANCE_BUDGET','Realized attribute components exceed the collection budget.');
  const hasNormals=mesh.normals!==undefined&&options.normalPolicy==='transform';
  // Numeric payload bytes include the independent topology index snapshot when attributes exist.
  const bufferBytes=vertices*3*8+indexCount*4+(hasNormals?vertices*3*8:0)+attrComponents*8+(outputNames.size?indexCount*4:0);
  if(bufferBytes>(options.maxBytes??MAX_REALIZED_BYTES))fail('INSTANCE_BUDGET','Realized numeric payload exceeds maxBytes.');
  const transforms=records.map(instance=>{
    const matrix=composeTransform3D(instance.transform),reflected=orientationMatrix4(matrix)<0;
    // Diagnose singular inverse-transpose requests before allocating output arrays.
    if(hasNormals&&mesh.positions.count)normalMatrix3D(matrix);
    return {matrix,reflected};
  });
  const input=copyMeshBuffers(mesh),positions=new Array<number>(vertices*3),indices=new Array<number>(indexCount),normals=hasNormals?new Array<number>(vertices*3):undefined;
  const attributes:Record<string,MeshAttribute>={};
  for(const [name,attribute] of sourceAttributes)attributes[name]={domain:attribute.domain,valueType:attribute.valueType,buffer:buffer(new Array<number>(attribute.buffer.count*attribute.buffer.components*count),attributeComponents(attribute.valueType))};
  if(options.instanceColorAttribute)attributes[options.instanceColorAttribute]={domain:'vertex',valueType:'color',buffer:buffer(new Array<number>(vertices*3),3)};
  if(options.instanceSelectionAttribute)attributes[options.instanceSelectionAttribute]={domain:'vertex',valueType:'scalar',buffer:buffer(new Array<number>(vertices),1)};
  const ranges:RealizedInstanceRange[]=[],bounds:Bounds3D|null=vertices?{min:[Infinity,Infinity,Infinity],max:[-Infinity,-Infinity,-Infinity]}:null;
  records.forEach((instance,instanceIndex)=>{
    const {matrix,reflected}=transforms[instanceIndex],vertexStart=instanceIndex*mesh.positions.count,faceStart=instanceIndex*mesh.indices.count/3;
    for(let vertex=0;vertex<mesh.positions.count;vertex++){
      const offset=vertex*3,out=(vertexStart+vertex)*3;
      const point=transformPoint3D(matrix,[input.positions[offset],input.positions[offset+1],input.positions[offset+2]]);
      for(let axis=0;axis<3;axis++){positions[out+axis]=point[axis];bounds!.min[axis]=Math.min(bounds!.min[axis],point[axis]);bounds!.max[axis]=Math.max(bounds!.max[axis],point[axis]);}
      if(normals){const normal=transformNormal3D(matrix,[input.normals![offset],input.normals![offset+1],input.normals![offset+2]]);for(let axis=0;axis<3;axis++)normals[out+axis]=normal[axis];}
      if(options.instanceColorAttribute)for(let axis=0;axis<3;axis++)attributes[options.instanceColorAttribute].buffer.data[out+axis]=instance.color?.[axis]??1;
      if(options.instanceSelectionAttribute)attributes[options.instanceSelectionAttribute].buffer.data[vertexStart+vertex]=instance.selected===false?0:1;
    }
    for(let corner=0;corner<mesh.indices.count;corner++){
      const original=reflected&&corner%3!==0?corner+(corner%3===1?1:-1):corner;
      indices[instanceIndex*mesh.indices.count+corner]=input.indices[original]+vertexStart;
    }
    for(const [name,attribute] of sourceAttributes){
      const source=input.attributes![name].values,destination=attributes[name].buffer.data,components=attribute.buffer.components;
      for(let element=0;element<attribute.buffer.count;element++){
        const original=attribute.domain==='corner'&&reflected&&element%3!==0?element+(element%3===1?1:-1):element;
        for(let component=0;component<components;component++)destination[(instanceIndex*attribute.buffer.count+element)*components+component]=source[original*components+component];
      }
    }
    ranges.push({id:instance.id,vertexStart,vertexCount:mesh.positions.count,faceStart,faceCount:mesh.indices.count/3,reflected,selected:instance.selected!==false});
  });
  const result:MeshResource={kind:'mesh',version:1,primitive:'triangles',units:mesh.units,coordinateSpace:'object',winding:'ccw',topologyRevision:options.topologyRevision,
    positions:buffer(positions,3),indices:buffer(indices,1,'uint32'),bounds,
    ...(normals?{normals:buffer(normals,3)}:{}),
    ...(outputNames.size?{attributes:{version:1 as const,topology:{revision:options.topologyRevision,vertexCount:vertices,indices:[...indices]},values:attributes}}:{}),
    provenance:{realization:{prototypeResourceId:checked.prototypeResourceId,prototypeTopologyRevision:mesh.topologyRevision,selection,normalPolicy:options.normalPolicy}}};
  return freezeSnapshot({mesh:snapshotMeshResource(result),report:{instances:count,vertices,triangles,bufferBytes,reflectedInstances:transforms.filter(t=>t.reflected).length,normalPolicy:options.normalPolicy,selection},ranges});
}
