import {validateBundle,type Bundle} from '../schema.js';
import {freezeSnapshot} from '../operations/values.js';
import type {DeepReadonly,Diagnostic} from '../ir/operations.js';
import {validateMeshResource,type MeshResource} from '../ir/mesh.js';
import {validateInstanceSet3D,type InstanceSet3D} from '../ir/instances.js';
import {validateSpace3D,type Space3D,type SceneNode3D} from '../ir/scene3d.js';
import {validateAssetJson} from './package.js';
import {prepareInlineBake,validateBakeManifest,type BakeManifest} from './bake.js';
import {sha256BakeBytes} from './bake-hash.js';
import {validateBakeRegistry,sampledFieldValidationResources,type SampledFieldProgram} from '../operations/sampled-field.js';

export interface BlenderFileIdentity {path:string;sha256:string}
export interface BlenderObjectReport {
  key:string;sourceObject:string;sourceData:string;isInstance:boolean;parent:string|null;persistentId:number[];
  resourceId:string;nodeId:string|null;setId:string|null;instanceId:string|null;
  originalVertices:number;evaluatedVertices:number;outputVertices:number;modifiers:{name:string;type:string}[];
  geometry:'converted'|'baked';transform:'preserved-matrix'|'baked-trs';
  normalPolicy:'preserved-corner'|'recomputed-triangle';material:string;
}
export interface BlenderConversionReport {
  config:{materialPolicy:'error'|'fallback';normalPolicy:'corner-static-triangle-recomputed-bake';
    triangulation:'evaluated-loop-triangles';interpolation:'linear';chunkFrames:8;seed:3801;blenderBuildHash:string};
  configSha256:string;
  counts:{objects:number;resources:number;instanceSets:number;instances:number;bakes:number;vertices:number;triangles:number;bakeBytes:number};
  objects:BlenderObjectReport[];preserved:string[];converted:string[];baked:string[];
  unsupported:{code:string;subject:string;message:string}[];
}
/** Evaluated results only: this manifest cannot execute Blender or a node graph. */
export interface BlenderManifest {
  version:1;profile:'blender-evaluated/1';
  producer:{name:'Blender';version:'4.5.9';script:BlenderFileIdentity};
  source:{blend:BlenderFileIdentity;scene:string};
  coordinates:{units:'m';handedness:'right';upAxis:'z';metersPerBlenderUnit:number};
  time:{unit:'s';duration:number;sampleTimes:number[];fps:number;frameStart:number};
  resources:Record<string,MeshResource>;instanceSets:Record<string,InstanceSet3D>;
  bakes?:Record<string,BakeManifest>;sampledFields?:SampledFieldProgram;space3d:Space3D;
  report:BlenderConversionReport;
}
export interface BlenderImportReport {
  scope:string;rootId:string;producer:BlenderManifest['producer'];source:BlenderManifest['source'];
  coordinates:BlenderManifest['coordinates'];time:BlenderManifest['time'];conversion:BlenderConversionReport;
  mappings:{resources:Record<string,string>;bakes:Record<string,string>;operations:Record<string,string>;nodes:Record<string,string>;
    instances:{batchId:string;setId:string;elementId:string;nodeId:string;prototypeResourceId:string}[]};
  representation:'mesh children sharing prototype resources';
  /** Authored display override; the verified producer conversion is unchanged. */
  presentation?:BlenderPresentation;
}
export interface BlenderBundleFragment {
  duration:number;rootId:string;resources:Record<string,MeshResource>;bakes?:Record<string,BakeManifest>;
  sampledFields?:SampledFieldProgram;space3d:Space3D;report:BlenderImportReport;
}
export interface BlenderPresentation {wireframe:boolean}
export interface BlenderImport {id:string;manifest:unknown;presentation?:BlenderPresentation}
export class BlenderManifestError extends Error {
  readonly code:string;readonly diagnostics:DeepReadonly<Diagnostic[]>;
  constructor(diagnostics:readonly Diagnostic[]){
    super(diagnostics.map(d=>`${d.code}: ${d.message} (${d.path??'$'})`).join('\n'));
    this.name='BlenderManifestError';this.code=diagnostics[0]?.code??'BLENDER_INVALID';this.diagnostics=freezeSnapshot(diagnostics);
  }
}
const object=(v:unknown):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
const id=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(v)&&!['__proto__','constructor','prototype'].includes(v);
const label=(v:unknown,max=512):v is string=>typeof v==='string'&&v.trim().length>0&&v.length<=max&&!/[\u0000-\u001f]/.test(v);
const hash=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v);
const integer=(v:unknown,min=0,max=1_000_000):v is number=>Number.isSafeInteger(v)&&(v as number)>=min&&(v as number)<=max;
const portablePath=(v:unknown):v is string=>label(v,2048)&&!v.includes('\\')&&!v.includes(':')&&!v.startsWith('/')&&v.split('/').every(p=>p!==''&&p!=='.'&&p!=='..');
const plainClone=<T>(v:T):T=>structuredClone(v);
const identityBundle=(fragment:{resources:Record<string,MeshResource>;space3d:Space3D;bakes?:Record<string,BakeManifest>;sampledFields?:SampledFieldProgram},duration:number):Bundle=>
  ({version:'0.3',title:'Blender import validation',duration,units:'bp',viewport:{width:1,height:1},camera:{x:0,y:0,zoom:1},nodes:[],tracks:[],relations:[],...fragment});
/** Defined canonical bytes for the small ASCII/integer config record, including LF. */
export function blenderConfigSha256(config:BlenderConversionReport['config']):string{
  const ordered=Object.fromEntries(Object.keys(config).sort().map(k=>[k,(config as unknown as Record<string,unknown>)[k]]));
  return sha256BakeBytes(new TextEncoder().encode(JSON.stringify(ordered)+'\n'));
}

export function validateBlenderManifest(input:unknown,path='$.blender'):Diagnostic[]{
  const out=validateAssetJson(input,path);if(out.length)return out;
  const fail=(code:string,message:string,where=path)=>out.push({severity:'error' as const,code,message,path:where});
  let stringUnits=0;const stack:unknown[]=[input];
  while(stack.length){const value=stack.pop();if(typeof value==='string')stringUnits+=value.length;else if(Array.isArray(value))for(const child of value)stack.push(child);else if(object(value))for(const [key,child] of Object.entries(value)){stringUnits+=key.length;stack.push(child);}
    if(stringUnits>96*1024*1024){fail('BLENDER_JSON_BUDGET','String payload exceeds 96 Mi UTF-16 code units.');return out;}}
  const shape=(v:unknown,required:string[],optional:string[],where:string):v is Record<string,any>=>{
    if(!object(v)){fail('BLENDER_SHAPE','Expected a plain object.',where);return false;}
    for(const k of required)if(!Object.hasOwn(v,k))fail('BLENDER_PROPERTY',`Missing ${k}.`,where+'.'+k);
    for(const k of Object.keys(v))if(!required.includes(k)&&!optional.includes(k))fail('BLENDER_PROPERTY',`Unsupported ${k}.`,where+'.'+k);
    return true;
  };
  const file=(v:unknown,where:string)=>{if(shape(v,['path','sha256'],[],where)&&(!portablePath(v.path)||!hash(v.sha256)))fail('BLENDER_SOURCE','Expected a portable relative source path and lowercase SHA-256.',where);};
  if(!shape(input,['version','profile','producer','source','coordinates','time','resources','instanceSets','space3d','report'],['bakes','sampledFields'],path))return out;
  if(input.version!==1||input.profile!=='blender-evaluated/1')fail('BLENDER_VERSION','Expected version 1 and profile blender-evaluated/1.');
  if(shape(input.producer,['name','version','script'],[],path+'.producer')){
    if(input.producer.name!=='Blender'||input.producer.version!=='4.5.9')fail('BLENDER_PRODUCER','This profile requires Blender 4.5.9.',path+'.producer');
    file(input.producer.script,path+'.producer.script');
  }
  if(shape(input.source,['blend','scene'],[],path+'.source')){
    file(input.source.blend,path+'.source.blend');if(!label(input.source.scene))fail('BLENDER_SOURCE','Expected a source scene name.',path+'.source.scene');
    if(object(input.source.blend)&&typeof input.source.blend.path==='string'&&!input.source.blend.path.endsWith('.blend'))fail('BLENDER_SOURCE','Source must identify a .blend file.',path+'.source.blend.path');
  }
  if(shape(input.coordinates,['units','handedness','upAxis','metersPerBlenderUnit'],[],path+'.coordinates')){
    const c=input.coordinates;if(c.units!=='m'||c.handedness!=='right'||c.upAxis!=='z'||!finite(c.metersPerBlenderUnit)||c.metersPerBlenderUnit<=0)
      fail('BLENDER_COORDINATES','Expected explicit right-handed Z-up metres and positive Blender unit scale.',path+'.coordinates');
  }
  if(shape(input.time,['unit','duration','sampleTimes','fps','frameStart'],[],path+'.time')){
    const t=input.time;if(t.unit!=='s'||!finite(t.duration)||t.duration<0||!finite(t.fps)||t.fps<=0||!finite(t.frameStart))fail('BLENDER_TIME','Expected seconds, nonnegative duration, positive fps and finite frame origin.',path+'.time');
    if(!Array.isArray(t.sampleTimes)||t.sampleTimes.length<1||t.sampleTimes.length>4096||t.sampleTimes.some((v:unknown,i:number)=>!finite(v)||v<0||v>t.duration||i>0&&v<=t.sampleTimes[i-1])||t.sampleTimes[0]!==0||t.sampleTimes.at(-1)!==t.duration)
      fail('BLENDER_TIME','Sample times must increase from zero through the declared duration.',path+'.time.sampleTimes');
  }
  if(!object(input.resources)||Object.keys(input.resources).length>64)fail('BLENDER_RESOURCE_BUDGET','Expected at most 64 mesh resources.',path+'.resources');
  if(!object(input.instanceSets)||Object.keys(input.instanceSets).length>64)fail('BLENDER_INSTANCE_BUDGET','Expected at most 64 shared instance sets.',path+'.instanceSets');
  if(!shape(input.space3d,['version','units','handedness','upAxis','nodes'],['tracks'],path+'.space3d'))return out;
  if(input.space3d.units!=='m'||input.space3d.handedness!=='right'||input.space3d.upAxis!=='z'||input.space3d.version!==1||!Array.isArray(input.space3d.nodes))fail('BLENDER_SPACE','Expected native metre-space nodes; camera and overlays belong to the authored scene.',path+'.space3d');
  if(out.length)return out;
  let vertices=0,triangles=0,instances=0;
  for(const [name,resource] of Object.entries(input.resources)){
    if(!id(name))fail('BLENDER_ID','Local resource IDs require a safe ASCII name of at most 64 characters.',path+'.resources.'+name);
    out.push(...validateMeshResource(resource,path+'.resources.'+name));
    if(object(resource)){
      if(resource.units!=='m')fail('BLENDER_UNITS','All imported resources must already be converted to metres.',path+'.resources.'+name+'.units');
      if(object(resource.positions)&&integer(resource.positions.count))vertices+=resource.positions.count;
      if(object(resource.indices)&&integer(resource.indices.count))triangles+=resource.indices.count/3;
    }
  }
  if(vertices>65536||triangles>87381)fail('BLENDER_MESH_BUDGET','Aggregate geometry exceeds 65536 vertices or 262143 triangle indices.');
  out.push(...validateBakeRegistry(input.bakes,path+'.bakes'));
  if(input.bakes!==undefined&&!object(input.bakes))return out;
  for(const [name,bake] of Object.entries(input.bakes??{})){
    if(!id(name))fail('BLENDER_ID','Bake IDs require safe local names.',path+'.bakes.'+name);
    if(!object(bake))continue;
    if(bake.units!=='m'||JSON.stringify(bake.sampleTimes)!==JSON.stringify(input.time.sampleTimes)||bake.interpolation!=='linear'||bake.outside!=='clamp')fail('BLENDER_BAKE_TIME','Bakes must use the declared metre chart and exact shared sample clock.',path+'.bakes.'+name);
    if(!Array.isArray(bake.channels)||bake.channels.length!==1||bake.channels[0]?.kind!=='position'||bake.channels[0]?.unit!=='m')fail('BLENDER_BAKE_CHANNEL','This profile imports only absolute position bake channels.',path+'.bakes.'+name);
    if(!Array.isArray(bake.chunks)||bake.chunks.some((c:any)=>c?.source?.kind!=='inline'))fail('BLENDER_BAKE_SOURCE','Blender manifests embed verified inline bake payloads.',path+'.bakes.'+name);
    const solver=bake.solver;
    if(!object(solver)||solver.name!=='Blender evaluated dependency graph'||solver.version!=='4.5.9'||!object(solver.parameters)||Object.keys(solver.parameters).length!==3||solver.parameters.sourceBlendSha256!==input.source.blend.sha256||solver.parameters.normalPolicy!=='recomputed-triangle'||solver.parameters.topologyPolicy!=='fixed-exact-corner-incidence'||bake.seed!==3801)
      fail('BLENDER_BAKE_PROVENANCE','Bake solver/source identity must match this evaluated Blender profile.',path+'.bakes.'+name+'.solver');
    if(Array.isArray(bake.chunks)&&bake.chunks.some((c:any,i:number)=>!object(c)||c.startSample!==i*8||c.sampleCount!==Math.min(8,input.time.sampleTimes.length-i*8)))fail('BLENDER_BAKE_LAYOUT','Chunk layout must agree with the declared eight-frame export config.',path+'.bakes.'+name+'.chunks');
  }
  if(input.sampledFields!==undefined){
    if(!shape(input.sampledFields,['version','operations'],[],path+'.sampledFields')||!Array.isArray(input.sampledFields.operations))return out;
    for(const [i,op] of input.sampledFields.operations.entries()){
      const at=path+`.sampledFields.operations[${i}]`;
      if(!object(op)||!['id','source','resourceId','bake'].every(k=>id(op[k])))fail('BLENDER_ID','Sampled operation references require safe local names.',at);
      else if(!Object.hasOwn(input.resources,op.source)||!Object.hasOwn(input.bakes??{},op.bake))fail('BLENDER_DEPENDENCY','Position bakes must reference a declared base mesh and bake.',at);
      else out.push(...validateBakeManifest(input.bakes[op.bake],input.resources[op.source],at+'.bake'));
      if(!object(op)||op.units!=='m'||!Array.isArray(op.attributes)||op.attributes.length!==0||op.position?.normalPolicy!=='recompute'||op.position?.degenerateNormalPolicy!=='error')fail('BLENDER_SAMPLED_FIELD','Expected absolute positions with recomputed triangle normals and explicit error policy.',at);
    }
  }
  if(out.length)return out;
  const manifest=input as unknown as BlenderManifest;
  const virtual=sampledFieldValidationResources(manifest.sampledFields,manifest.resources,manifest.bakes);
  for(const [name,set] of Object.entries(manifest.instanceSets)){
    if(!id(name))fail('BLENDER_ID','Instance set IDs require safe local names.',path+'.instanceSets.'+name);
    const prototype=object(set)&&id(set.prototypeResourceId)?virtual[set.prototypeResourceId]:undefined;
    if(!prototype||prototype.kind!=='mesh')fail('BLENDER_DEPENDENCY','Instance prototypes must resolve inside the manifest.',path+'.instanceSets.'+name);
    out.push(...validateInstanceSet3D(set,prototype?.kind==='mesh'?prototype:undefined,path+'.instanceSets.'+name));
    if(Array.isArray(set?.instances)){instances+=set.instances.length;for(const row of set.instances){
      if(!object(row))continue;
      if(!id(row.id))fail('BLENDER_ID','Instance element IDs require safe local names.',path+'.instanceSets.'+name);
      if(Array.isArray(row.color)&&row.color.some(v=>v!==1))fail('BLENDER_INSTANCE_COLOR','This material subset requires white instance tint; color belongs to the batch material.',path+'.instanceSets.'+name);
    }}
  }
  if(instances>4096)fail('BLENDER_INSTANCE_BUDGET','At most 4096 instance records across all sets.');
  for(const node of manifest.space3d.nodes){
    if(!object(node)||!id(node.id)||node.parent!==undefined&&!id(node.parent)||!['group','mesh','instances'].includes(node.kind))fail('BLENDER_NODE','Expected group, mesh or instance nodes with safe local IDs.',path+'.space3d.nodes');
    if(object(node)&&node.kind==='mesh'&&!id(node.resourceId)||object(node)&&node.kind==='instances'&&!id(node.instanceSetId))fail('BLENDER_ID','Node references require safe local IDs.',path+'.space3d.nodes');
  }
  out.push(...validateSpace3D(manifest.space3d,virtual,path+'.space3d',{duration:manifest.time.duration},manifest.instanceSets));
  if(out.length)return out;
  for(const track of manifest.space3d.tracks??[])if(JSON.stringify(track.keys.map(k=>k[0]))!==JSON.stringify(manifest.time.sampleTimes)||track.interpolation!=='linear')
    fail('BLENDER_TRACK_TIME','Transform tracks must use the same explicit sample clock and linear interpolation.',path+'.space3d.tracks');
  if(out.length)return out;
  validateReport(manifest,path,out);
  if(out.length)return out;
  // Full IR validation catches generated-resource collisions and sampled-field
  // contracts, while the separate inline sampler authenticates actual bytes.
  const lowered=lowerValidated(manifest,'validation');
  out.push(...validateBundle(identityBundle(lowered,manifest.time.duration)));
  if(out.length)return out;
  for(const bake of Object.values(manifest.bakes??{}))try{prepareInlineBake(bake);}catch(cause){
    const e=cause as {diagnostics?:readonly Diagnostic[];message?:string};out.push(...e.diagnostics??[{severity:'error',code:'BLENDER_BAKE_PAYLOAD',message:e.message??String(cause),path:path+'.bakes'}]);
  }
  return out;
}

function validateReport(m:BlenderManifest,path:string,out:Diagnostic[]):void{
  const fail=(message:string,where=path+'.report')=>out.push({severity:'error',code:'BLENDER_REPORT',message,path:where});
  const shape=(v:unknown,fields:string[])=>object(v)&&Object.keys(v).length===fields.length&&fields.every(k=>Object.hasOwn(v,k));
  const r=m.report;
  if(!shape(r,['config','configSha256','counts','objects','preserved','converted','baked','unsupported'])){fail('Expected the complete conversion report.');return;}
  if(!shape(r.config,['materialPolicy','normalPolicy','triangulation','interpolation','chunkFrames','seed','blenderBuildHash'])){fail('Expected a complete producer config.');return;}
  const c=r.config;
  if(!['error','fallback'].includes(c.materialPolicy)||c.normalPolicy!=='corner-static-triangle-recomputed-bake'||c.triangulation!=='evaluated-loop-triangles'||c.interpolation!=='linear'||c.chunkFrames!==8||c.seed!==3801||!label(c.blenderBuildHash,64)||!/^[A-Za-z0-9._-]+$/.test(c.blenderBuildHash))fail('Unsupported producer configuration.');
  if(!hash(r.configSha256)||r.configSha256!==blenderConfigSha256(c))fail('Configuration hash mismatch.');
  if(!shape(r.counts,['objects','resources','instanceSets','instances','bakes','vertices','triangles','bakeBytes'])||Object.values(r.counts).some(v=>!integer(v,0,64*1024*1024))){fail('Expected bounded integer report counts.');return;}
  if(!Array.isArray(r.objects)||r.objects.length>4096){fail('At most 4096 evaluated mesh records.');return;}
  const expected={objects:r.objects.length,resources:Object.keys(m.resources).length,instanceSets:Object.keys(m.instanceSets).length,
    instances:Object.values(m.instanceSets).reduce((n,s)=>n+s.instances.length,0),bakes:Object.keys(m.bakes??{}).length,
    vertices:Object.values(m.resources).reduce((n,x)=>n+x.positions.count,0),triangles:Object.values(m.resources).reduce((n,x)=>n+x.indices.count/3,0),
    bakeBytes:Object.values(m.bakes??{}).reduce((n,b)=>n+b.chunks.reduce((sum,c)=>sum+c.byteLength,0),0)};
  if(Object.entries(expected).some(([k,v])=>r.counts[k as keyof typeof expected]!==v))fail('Report counts disagree with exported geometry and bakes.');
  for(const key of ['preserved','converted','baked'] as const)if(!Array.isArray(r[key])||r[key].length>4096||r[key].some(v=>!label(v,2048)))fail(`Expected bounded ${key} descriptions.`);
  if(!Array.isArray(r.unsupported)||r.unsupported.length>4096)fail('Expected bounded unsupported-feature diagnostics.');
  else for(const row of r.unsupported)if(!shape(row,['code','subject','message'])||!label(row.code,128)||!label(row.subject)||!label(row.message,2048))fail('Malformed unsupported-feature diagnostic.');
  if(c.materialPolicy==='error'&&Array.isArray(r.unsupported)&&r.unsupported.length)fail('Error policy cannot publish unsupported-feature fallbacks.');
  const nodes=new Map(m.space3d.nodes.map(n=>[n.id,n])),ops=new Map((m.sampledFields?.operations??[]).map(o=>[o.resourceId,o]));
  const keys=new Set<string>(),coveredNodes=new Set<string>(),coveredElements=new Set<string>();
  for(const row of r.objects){
    if(!shape(row,['key','sourceObject','sourceData','isInstance','parent','persistentId','resourceId','nodeId','setId','instanceId','originalVertices','evaluatedVertices','outputVertices','modifiers','geometry','transform','normalPolicy','material'])){fail('Malformed evaluated object record.');continue;}
    if(!id(row.key)||keys.has(row.key)||!label(row.sourceObject)||!label(row.sourceData)||typeof row.isInstance!=='boolean'||row.parent!==null&&!label(row.parent)||!Array.isArray(row.persistentId)||row.persistentId.length>16||row.persistentId.some(v=>!integer(v,-2147483648,2147483647)))fail('Invalid object identity or source identity.');else keys.add(row.key);
    if(![row.originalVertices,row.evaluatedVertices,row.outputVertices].every(v=>integer(v,0,262144)))fail('Invalid reported vertex count.');
    if(!Array.isArray(row.modifiers)||row.modifiers.length>256||row.modifiers.some(v=>!shape(v,['name','type'])||!label(v.name)||!label(v.type,128)))fail('Invalid modifier inventory.');
    if(!id(row.resourceId)||!['converted','baked'].includes(row.geometry)||!['preserved-matrix','baked-trs'].includes(row.transform)||!['preserved-corner','recomputed-triangle'].includes(row.normalPolicy)||typeof row.material!=='string'||!/^#[0-9a-fA-F]{6}$/.test(row.material))fail('Invalid conversion decisions.');
    const op=ops.get(row.resourceId),mesh=m.resources[op?.source??row.resourceId];
    if(!mesh||mesh.positions.count!==row.outputVertices)fail('Object output resource or vertex count differs.');
    if((row.geometry==='baked')!==!!op||(row.normalPolicy==='recomputed-triangle')!==!!op)fail('Geometry and normal decisions disagree with position bakes.');
    if(row.setId===null){
      const node=typeof row.nodeId==='string'?nodes.get(row.nodeId):undefined;
      if(!id(row.nodeId)||coveredNodes.has(row.nodeId)||!node||node.kind!=='mesh'||node.resourceId!==row.resourceId||row.setId!==null||row.instanceId!==null)fail('Object node mapping is invalid.');
      else {coveredNodes.add(row.nodeId);const animated=m.space3d.tracks?.some(t=>t.target===node.id)??false;if((row.transform==='baked-trs')!==animated)fail('Transform decision differs from exported tracks.');
        if(node.material?.color!==row.material)fail('Reported material differs from the rendered node.');}
    }else{
      const set=typeof row.setId==='string'?m.instanceSets[row.setId]:undefined;
      const key=`${row.setId}/${row.instanceId}`;
      if(!id(row.setId)||!id(row.instanceId)||!set||set.prototypeResourceId!==row.resourceId||!set.instances.some(i=>i.id===row.instanceId)||coveredElements.has(key)||row.transform!=='preserved-matrix')fail('Object instance mapping is invalid.');else coveredElements.add(key);
      const batches=m.space3d.nodes.filter(n=>n.kind==='instances'&&n.instanceSetId===row.setId);
      if(batches.length!==1||batches[0].kind!=='instances'||batches[0].material?.color!==row.material)fail('Each reported set must have exactly one batch with matching material.');
      if(row.nodeId!==null&&(!id(row.nodeId)||batches[0]?.id!==row.nodeId))fail('Instance nodeId must name its declared batch.');
    }
  }
  for(const node of m.space3d.nodes)if(node.kind==='mesh'&&!coveredNodes.has(node.id))fail('Report omits an exported mesh node.');
  for(const [setId,set] of Object.entries(m.instanceSets))for(const row of set.instances)if(!coveredElements.has(`${setId}/${row.id}`))fail('Report omits an exported instance element.');
  const usedResources=new Set(r.objects.filter(object).map(o=>ops.get(o.resourceId)?.source??o.resourceId));
  if(Object.keys(m.resources).some(id=>!usedResources.has(id)))fail('Report leaves an unaccounted geometry resource.');
  if(Object.keys(m.bakes??{}).some(id=>!(m.sampledFields?.operations.some(o=>o.bake===id))))fail('Report leaves an unused bake.');
}

function lowerValidated(m:BlenderManifest,scope:string):BlenderBundleFragment{
  const resourceMap:Record<string,string>={},bakeMap:Record<string,string>={},opMap:Record<string,string>={},nodeMap:Record<string,string>={};
  for(const id of Object.keys(m.resources))resourceMap[id]=`${scope}:mesh:${id}`;
  for(const op of m.sampledFields?.operations??[]){resourceMap[op.resourceId]=`${scope}:mesh:${op.resourceId}`;opMap[op.id]=`${scope}:sample:${op.id}`;}
  for(const id of Object.keys(m.bakes??{}))bakeMap[id]=`${scope}:bake:${id}`;
  for(const node of m.space3d.nodes)nodeMap[node.id]=`${scope}:node:${node.id}`;
  const nodes:SceneNode3D[]=[{kind:'group',id:scope}],instanceMappings:BlenderImportReport['mappings']['instances']=[];
  for(const original of m.space3d.nodes){
    const parent=original.parent?nodeMap[original.parent]:scope,nodeId=nodeMap[original.id];
    if(original.kind==='instances'){
      nodes.push({kind:'group',id:nodeId,parent,...(original.transform?{transform:plainClone(original.transform)}:{})});
      const set=m.instanceSets[original.instanceSetId];
      for(const record of set.instances){
        const id=`${scope}:instance:${original.id}:${record.id}`;
        // The supported Blender subset uses the batch material, so record RGB
        // tint must be white (validated below in normal input validation).
        nodes.push({kind:'mesh',id,parent:nodeId,resourceId:resourceMap[set.prototypeResourceId],
          ...(record.transform?{transform:plainClone(record.transform)}:{}),
          visible:original.visible!==false&&record.selected!==false,
          ...(original.material?{material:plainClone(original.material)}:{})});
        instanceMappings.push({batchId:original.id,setId:original.instanceSetId,elementId:record.id,nodeId:id,prototypeResourceId:resourceMap[set.prototypeResourceId]});
      }
    }else if(original.kind==='mesh')nodes.push({...plainClone(original),id:nodeId,parent,resourceId:resourceMap[original.resourceId]});
    else nodes.push({...plainClone(original),id:nodeId,parent});
  }
  return {duration:m.time.duration,rootId:scope,
    resources:Object.fromEntries(Object.entries(m.resources).map(([id,r])=>[resourceMap[id],plainClone(r)])),
    ...(m.bakes?{bakes:Object.fromEntries(Object.entries(m.bakes).map(([id,b])=>[bakeMap[id],plainClone(b)]))}:{}),
    ...(m.sampledFields?{sampledFields:{version:1,operations:m.sampledFields.operations.map(o=>({...plainClone(o),id:opMap[o.id],source:resourceMap[o.source],resourceId:resourceMap[o.resourceId],bake:bakeMap[o.bake]}))}}:{}),
    space3d:{version:1,units:'m',handedness:'right',upAxis:'z',nodes,
      ...(m.space3d.tracks?{tracks:m.space3d.tracks.map(t=>({...plainClone(t),target:nodeMap[t.target]}))}:{})},
    report:{scope,rootId:scope,producer:plainClone(m.producer),source:plainClone(m.source),coordinates:plainClone(m.coordinates),time:plainClone(m.time),conversion:plainClone(m.report),
      mappings:{resources:resourceMap,bakes:bakeMap,operations:opMap,nodes:nodeMap,instances:instanceMappings},representation:'mesh children sharing prototype resources'}};
}

export function snapshotBlenderManifest(input:unknown):DeepReadonly<BlenderManifest>{
  const diagnostics=validateBlenderManifest(input);if(diagnostics.length)throw new BlenderManifestError(diagnostics);
  return freezeSnapshot(input as BlenderManifest);
}
export function lowerBlenderManifest(input:unknown,options:{scope:string}):DeepReadonly<BlenderBundleFragment>{
  const diagnostics=validateAssetJson(options,'$.options');
  if(diagnostics.length)throw new BlenderManifestError(diagnostics);
  if(!object(options)||Object.keys(options).some(k=>k!=='scope')||!id(options.scope))throw new BlenderManifestError([{severity:'error',code:'BLENDER_SCOPE',message:'Expected a safe ASCII scope of at most 64 characters.',path:'$.options.scope'}]);
  const errors=validateBlenderManifest(input);if(errors.length)throw new BlenderManifestError(errors);
  return freezeSnapshot(lowerValidated(input as BlenderManifest,options.scope));
}

/** Merge detached imports atomically. Existing authored groups provide placement. */
export function mergeBlenderManifests(input:unknown,imports:readonly BlenderImport[]):DeepReadonly<{bundle:Bundle;reports:BlenderImportReport[]}>{
  const errors=[...validateAssetJson(input,'$.bundle'),...validateAssetJson(imports,'$.imports')];
  const fail=(message:string,path:string):never=>{throw new BlenderManifestError([{severity:'error',code:'BLENDER_MERGE',message,path}]);};
  if(errors.length)throw new BlenderManifestError(errors);
  if(!object(input)||!object(input.resources)||!finite(input.duration)||input.duration<0)fail('Expected a native bundle with resource dictionary and duration.','$.bundle');
  if(object(input)){
    if(input.provenance!==undefined&&!object(input.provenance))fail('Expected object provenance.','$.bundle.provenance');
    if(input.bakes!==undefined&&!object(input.bakes))fail('Expected a bake dictionary.','$.bundle.bakes');
    if(input.sampledFields!==undefined&&(!object(input.sampledFields)||input.sampledFields.version!==1||!Array.isArray(input.sampledFields.operations)))fail('Expected a sampled field program.','$.bundle.sampledFields');
  }
  if(!Array.isArray(imports)||imports.length>16)fail('At most 16 Blender imports per scene.','$.imports');
  const bundle=plainClone(input) as unknown as Bundle,reports:BlenderImportReport[]=[],scopes=new Set<string>();
  if(imports.length)bundle.version='0.3';
  for(const [index,entry] of imports.entries()){
    if(!object(entry)||Object.keys(entry).some(k=>!['id','manifest','presentation'].includes(k))||!id(entry.id)||!Object.hasOwn(entry,'manifest')||scopes.has(entry.id))fail('Expected unique safe import IDs and manifests.',`$.imports[${index}]`);scopes.add(entry.id);
    if(Object.hasOwn(entry,'presentation')&&(!object(entry.presentation)||Object.keys(entry.presentation).length!==1||typeof entry.presentation.wireframe!=='boolean'))
      fail('Presentation requires exactly one boolean wireframe property.',`$.imports[${index}].presentation`);
    const fragment=plainClone(lowerBlenderManifest(entry.manifest,{scope:entry.id})) as BlenderBundleFragment;
    if(entry.presentation!==undefined){
      for(const node of fragment.space3d.nodes)if(node.kind==='mesh')node.material={kind:'unlit',color:'#d4d9e2',...node.material,wireframe:entry.presentation.wireframe};
      fragment.report.presentation=plainClone(entry.presentation);
    }
    if(fragment.duration>bundle.duration)fail('Imported sample duration exceeds the authored scene.','$.bundle.duration');
    if(bundle.space3d&&(!object(bundle.space3d)||bundle.space3d.units!==fragment.space3d.units||bundle.space3d.handedness!=='right'||bundle.space3d.upAxis!=='z'||!Array.isArray(bundle.space3d.nodes)))fail('Authored and imported 3D units/basis must match.','$.bundle.space3d');
    for(const key of Object.keys(fragment.resources))if(Object.hasOwn(bundle.resources,key))fail(`Resource collision: ${key}.`,'$.bundle.resources');
    Object.assign(bundle.resources,fragment.resources);
    if(fragment.bakes){bundle.bakes??={};for(const [key,bake] of Object.entries(fragment.bakes)){if(Object.hasOwn(bundle.bakes,key))fail(`Bake collision: ${key}.`,'$.bundle.bakes');bundle.bakes[key]=bake;}}
    if(fragment.sampledFields){bundle.sampledFields??={version:1,operations:[]};if(!Array.isArray(bundle.sampledFields.operations))fail('Malformed authored sampledFields.','$.bundle.sampledFields');
      for(const op of fragment.sampledFields.operations){if(bundle.sampledFields.operations.some(o=>o.id===op.id))fail(`Sampled-operation collision: ${op.id}.`,'$.bundle.sampledFields');bundle.sampledFields.operations.push(op);}}
    bundle.space3d??={version:1,units:'m',handedness:'right',upAxis:'z',nodes:[]};
    const existing=new Map(bundle.space3d.nodes.map(n=>[n.id,n]));
    for(const node of fragment.space3d.nodes){const previous=existing.get(node.id);if(previous){if(node.id!==fragment.rootId||previous.kind!=='group')fail(`Spatial node collision: ${node.id}.`,'$.bundle.space3d.nodes');}else bundle.space3d.nodes.push(node);}
    if(fragment.space3d.tracks?.length){bundle.space3d.tracks??=[];bundle.space3d.tracks.push(...fragment.space3d.tracks);}
    reports.push(fragment.report);
  }
  bundle.provenance??={};if(Object.hasOwn(bundle.provenance,'blenderImports'))fail('Blender import provenance already exists.','$.bundle.provenance.blenderImports');
  bundle.provenance.blenderImports=reports;
  const diagnostics=validateBundle(bundle);if(diagnostics.length)throw new BlenderManifestError(diagnostics);
  return freezeSnapshot({bundle,reports});
}
