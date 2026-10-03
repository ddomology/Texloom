import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {prepareSampledFieldProgram,validateBakeRegistry} from '../src/operations/sampled-field.ts';
import {prepareFieldVisualizationProgram} from '../src/operations/field-visualization.ts';
import {replaceMeshPositions} from '../src/operations/field-visualization-data.ts';
import {prepareInstanceProgram} from '../src/operations/instances.ts';
import {prepareMeshAttributeProgram} from '../src/operations/mesh-attributes.ts';
import {validateExpressionProgram} from '../src/fields/program.ts';
import {prepareInlineBake,type BakeManifest,type BakeResolver} from '../src/resources/bake.ts';
import {prepareScene,prepareSceneAsync,beginPrepareScene,type PrepareSceneOptions} from '../src/runtime.ts';
import {NUMERIC_3D_PROFILE,SVG_2D_PROFILE} from '../src/capabilities.ts';
import {validateBundle,type Bundle} from '../src/schema.ts';
import {copyMeshAttribute} from '../src/ir/attributes.ts';
import {copyMeshBuffers,type MeshResource} from '../src/ir/mesh.ts';
import type {NumericBuffer} from '../src/resources/buffers.ts';

const buffer=(data:number[],components:1|3,componentType:NumericBuffer['componentType']='float64'):NumericBuffer=>({version:1,componentType,components,count:data.length/components,byteOffset:0,byteStride:components*(componentType==='float64'?8:4),data});
const mesh=():MeshResource=>({kind:'mesh',version:1,primitive:'triangles',units:'unit',coordinateSpace:'object',winding:'ccw',topologyRevision:'triangle',positions:buffer([0,0,0,2,0,0,0,1,0],3),normals:buffer([0,0,1,0,0,1,0,0,1],3),indices:buffer([0,1,2],1,'uint32'),bounds:{min:[0,0,0],max:[2,1,0]}});
function bake(float32=false):BakeManifest{
  const sampleTimes=[0,.75,2],componentType=float32?'float32':'float64',width=float32?4:8;
  return {version:1,units:'unit',timeUnit:'s',topology:{revision:'triangle',vertexCount:3,indices:[0,1,2]},sampleTimes,interpolation:'linear',outside:'clamp',seed:91,
    solver:{name:'test-affine',version:'1',parameters:{kind:'independent fixture'}},channels:[{id:'scalar',kind:'scalar',componentType,unit:'K'},{id:'vector',kind:'vector',componentType,unit:'unit/s'},{id:'position',kind:'position',componentType,unit:'unit'}],
    chunks:sampleTimes.map((time,i)=>{const values=[.1+time,.2+2*time,.3+3*time,...[0,1,2].flatMap(index=>[time,index,1]),0,0,time,2,0,2*time,0,1,time],bytes=Buffer.alloc(values.length*width);
      values.forEach((v,j)=>{if(float32)bytes.writeFloatLE(v,j*width);else bytes.writeDoubleLE(v,j*width);});
      return {id:`part-${i}`,startSample:i,sampleCount:1,byteLength:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),source:{kind:'inline' as const,data:bytes.toString('base64')}};})};
}
const bundle=(float32=false):Bundle=>({version:'0.3',title:'Baked',duration:3,units:'bp',viewport:{width:320,height:240},camera:{x:0,y:0,zoom:1},nodes:[],resources:{source:mesh()},tracks:[],relations:[],
  bakes:{data:bake(float32)},sampledFields:{version:1,operations:[{id:'sample',source:'source',resourceId:'sampled',bake:'data',units:'unit',attributes:[{channel:'scalar',name:'rawScalar'},{channel:'vector',name:'rawVector'},{channel:'position',name:'rawPosition'}],position:{channel:'position',normalPolicy:'recompute',degenerateNormalPolicy:'error'}}]},
  fieldVisualization:{version:1,operations:[{id:'field',source:'sampled',resourceId:'display',units:'unit',scalar:{attribute:'rawScalar'},vector:{attribute:'rawVector'},invalidPolicy:'error',color:{attribute:'color',stops:[{position:0,color:[0,0,1]},{position:1,color:[1,0,0]}],range:{mode:'fixed',min:0,max:8},outOfRange:'clamp',invalidColor:[0,1,0]}}]}});
const code=(run:()=>unknown,expected:string)=>assert.throws(run,(e:any)=>e.code===expected||e.diagnostics?.some((d:any)=>d.code===expected));
function external(b:Bundle):{bundle:Bundle;resolver:BakeResolver;payloads:Map<string,Buffer>}{
  const result=structuredClone(b),payloads=new Map<string,Buffer>();for(const chunk of result.bakes!.data.chunks){if(chunk.source.kind!=='inline')throw Error();payloads.set(chunk.id,Buffer.from(chunk.source.data,'base64'));chunk.source={kind:'external',uri:`samples/${chunk.id}.bin`};}
  return {bundle:result,payloads,resolver:async chunk=>payloads.get(chunk.id)!};
}

test('nonuniform baked channels become immutable raw attributes and absolute positions at a shared source time',()=>{
  const b=bundle(),before=JSON.stringify(b),runtime=prepareScene(b),frame=runtime.sample(.375),report=frame.sampledFields!.sample;
  assert.deepEqual(report.bracket,{left:0,right:1,alpha:.5,sourceTime:.375});assert.equal(report.time,.375);
  assert.deepEqual(report.provenance,{solver:b.bakes!.data.solver,seed:91});assert.equal(report.position!.normalOrigin,'recomputed');
  const expected=[.475,.95,1.425];frame.fieldVisualization!.field.scalar!.forEach((v,i)=>assert.ok(Math.abs(v!-expected[i])<1e-14));
  assert.deepEqual(frame.fieldVisualization!.field.vector,[[.375,0,1],[.375,1,1],[.375,2,1]]);
  assert.deepEqual([...copyMeshBuffers(frame.resources.sampled).positions],[0,0,.375,2,0,.75,0,1,.375]);
  assert.deepEqual([...copyMeshAttribute(frame.resources.sampled as MeshResource,'rawPosition')],[0,0,.375,2,0,.75,0,1,.375]);
  assert.ok(Object.isFrozen(report.provenance.solver.parameters));assert.ok(Object.isFrozen((frame.resources.sampled as MeshResource).attributes!.values.rawScalar.buffer.data));
  runtime.sample(2);assert.deepEqual(runtime.sample(.375),frame);assert.equal(JSON.stringify(b),before);
  assert.equal(runtime.manifest.generatedResources!.find(r=>r.id==='sampled')!.producer,'sampledFields');assert.ok(runtime.manifest.features.includes('bake.temporal.3d'));
  assert.equal(runtime.manifest.bakes![0].seed,91);assert.ok(runtime.manifest.bakes![0].chunks.every(chunk=>!('source' in chunk)));
});

test('float32 storage interpolates in float64 through selectors without a second quantization',()=>{
  const b=bundle(true),time=.2,expected=prepareInlineBake(b.bakes!.data).sample(time).channels.scalar.values;
  assert.ok(expected.some(value=>value!==Math.fround(value)));
  const frame=prepareScene(b).sample(time);assert.deepEqual([...copyMeshAttribute(frame.resources.sampled as MeshResource,'rawScalar')],expected);assert.deepEqual(frame.fieldVisualization!.field.scalar,expected);
  assert.equal((frame.resources.sampled as MeshResource).attributes!.values.rawScalar.buffer.componentType,'float64');
});

test('step exact knots, final frame, clamping and explicit outside failure remain visible in metadata',()=>{
  const b=bundle();b.bakes!.data.interpolation='step';let runtime=prepareScene(b);
  assert.deepEqual(runtime.sample(.7).fieldVisualization!.field.scalar,[.1,.2,.3]);assert.deepEqual(runtime.sample(.75).fieldVisualization!.field.scalar,[.85,1.7,2.55]);
  assert.equal(runtime.sample(3).sampledFields!.sample.bracket.sourceTime,2);assert.deepEqual(runtime.sample(3).fieldVisualization!.field.scalar,runtime.sample(2).fieldVisualization!.field.scalar);
  b.bakes!.data.outside='error';runtime=prepareScene(b);assert.throws(()=>runtime.sample(3));
});

test('each sampled mesh must match exact topology even when counts and bounds still agree',()=>{
  const b=bundle();b.meshAttributes={version:1,operations:[{id:'upstream',source:'source',resourceId:'input',units:'unit',steps:[{kind:'capture',name:'other',domain:'vertex',valueType:'scalar',expression:'x'}]}]};b.sampledFields!.operations[0].source='input';
  const sampler=prepareSampledFieldProgram(b.sampledFields!,b,{input:mesh()}),rewired=mesh();rewired.indices.data=[0,2,1];
  assert.throws(()=>sampler.sample(.5,undefined,{input:rewired}),/TOPOLOGY/);const changed=mesh();changed.topologyRevision='different';assert.throws(()=>sampler.sample(.5,undefined,{input:changed}),/TOPOLOGY/);
  assert.deepEqual(sampler.sample(.5).sampledFields.sample.bracket,{left:0,right:1,alpha:2/3,sourceTime:.5});
});

test('standalone fields, instances, attributes and expression validation consume sampled output at the current time',()=>{
  const b=bundle();b.expressions={version:1,parameters:{},bindings:[]};b.meshAttributes={version:1,operations:[]};
  b.instances={version:1,operations:[{id:'instances',source:{kind:'mesh',resourceId:'display',domain:'vertex'},prototype:'source',units:'unit',seed:0}]};
  const expected=prepareScene(b).sample(.375);
  assert.deepEqual(prepareFieldVisualizationProgram(b.fieldVisualization!,b).sample(.375).resources.display,expected.resources.display);
  assert.deepEqual(prepareInstanceProgram(b.instances!,b).sample(.375).instanceSets,expected.instanceSets);
  assert.doesNotThrow(()=>prepareMeshAttributeProgram(b.meshAttributes!,b));assert.deepEqual(validateExpressionProgram(b.expressions!,b),[]);
});

test('absolute position replacement explicitly drops or recomputes normals with conditional source fallback',()=>{
  const source=mesh();delete source.normals;const values=[0,0,0,2,0,1,0,1,0];
  const recomputed=replaceMeshPositions(source,values,{normalPolicy:'recompute',degenerateNormalPolicy:'error'});assert.equal(recomputed.normalOrigin,'recomputed');assert.ok(recomputed.mesh.normals);
  const dropped=replaceMeshPositions(mesh(),values,{normalPolicy:'drop',degenerateNormalPolicy:'source'});assert.equal(dropped.mesh.normals,undefined);assert.deepEqual(dropped.mesh.indices,source.indices);
  assert.throws(()=>replaceMeshPositions(source,Array(9).fill(0),{normalPolicy:'recompute',degenerateNormalPolicy:'source'}));
  const fallback=replaceMeshPositions(mesh(),Array(9).fill(0),{normalPolicy:'recompute',degenerateNormalPolicy:'source'});assert.deepEqual(fallback.sourceNormalFallbacks,[0,1,2]);assert.equal(fallback.normalOrigin,'recomputed-with-source-fallback');
});

test('schema rejects missing channels, duplicate attributes, downstream sources and selector type confusion',()=>{
  const changes:((b:Bundle)=>void)[]=[b=>b.sampledFields!.operations[0].attributes[0].channel='missing',b=>b.sampledFields!.operations[0].attributes[1].name='rawScalar',
    b=>b.sampledFields!.operations[0].position!.channel='vector',b=>b.sampledFields!.operations[0].source='display',b=>b.sampledFields!.operations[0].resourceId='source',
    b=>b.fieldVisualization!.operations[0].scalar={attribute:'rawVector'},b=>b.fieldVisualization!.operations[0].vector={attribute:'rawScalar'},
    b=>b.fieldVisualization!.operations[0].expressionSpans={scalar:{file:'x.tex',start:{line:1,column:1},end:{line:1,column:2}}}];
  for(const change of changes){const b=bundle();change(b);assert.ok(validateBundle(b).some(d=>d.severity==='error'));}
});

test('registry budgets bound all manifests before decoding or transport',async()=>{
  const value=bake();assert.ok(validateBakeRegistry(Object.fromEntries(Array.from({length:17},(_,i)=>[`b${i}`,value]))).some(d=>d.code==='BAKE_REGISTRY_BUDGET'));
  const large:BakeManifest={...value,topology:{revision:'large',vertexCount:65536,indices:[0,1,2]},sampleTimes:Array.from({length:32},(_,i)=>i),channels:[{id:'scalar',kind:'scalar',componentType:'float64',unit:'1'}],chunks:[{id:'all',startSample:0,sampleCount:32,byteLength:16*1024*1024,sha256:'0'.repeat(64),source:{kind:'external',uri:'all.bin'}}]};
  assert.ok(validateBakeRegistry({a:large,b:large,c:large,d:large,e:large}).some(d=>d.code==='BAKE_REGISTRY_BUDGET'));
  let calls=0;const b=bundle();b.bakes=Object.fromEntries(Array.from({length:17},(_,i)=>[`b${i}`,value]));await assert.rejects(prepareSceneAsync(b,{profile:NUMERIC_3D_PROFILE,bakeResolver:async()=>{calls++;return new Uint8Array();}}));assert.equal(calls,0);
});

test('external bake preparation is atomic, owns snapshots and captures the resolver before the first await',async()=>{
  const original=bundle(),data=external(original);let firstCalls=0,redirected=0;
  const options:PrepareSceneOptions={profile:NUMERIC_3D_PROFILE,bakeResolver:async chunk=>{firstCalls++;return data.payloads.get(chunk.id)!;}};
  const preparing=beginPrepareScene(data.bundle,options);assert.equal(preparing.state,'preparing');options.bakeResolver=async()=>{redirected++;throw Error('redirect');};
  data.bundle.bakes!.data.solver.name='mutated';const runtime=await preparing.ready;
  assert.equal(firstCalls,3);assert.equal(redirected,0);assert.equal(runtime.manifest.bakes![0].solver.name,'test-affine');assert.deepEqual(runtime.sample(.4),prepareScene(original).sample(.4));
  assert.ok(!runtime.manifest.bakes![0].chunks.some(c=>'source' in c));runtime.dispose();assert.equal(runtime.state,'disposed');assert.throws(()=>runtime.sample(0),/DISPOSED/);
});

test('pending bake hydration cancels promptly and does not publish partially ready resources',async()=>{
  const data=external(bundle()),signals:AbortSignal[]=[],controller=new AbortController();
  const preparing=beginPrepareScene(data.bundle,{profile:NUMERIC_3D_PROFILE,signal:controller.signal,bakeResolver:async(_,context)=>{signals.push(context.signal);return await new Promise<Uint8Array>(()=>{});}});
  await new Promise(resolve=>setTimeout(resolve,0));assert.equal(preparing.state,'preparing');assert.ok(signals.length>0);controller.abort();await assert.rejects(preparing.ready,/ABORTED/);
  assert.equal(preparing.state,'disposed');assert.ok(signals.every(s=>s.aborted));preparing.dispose();
});

test('unsupported profiles reject before bake transport; corrupt chunks and synchronous external preparation fail explicitly',async()=>{
  const data=external(bundle());let calls=0;await assert.rejects(prepareSceneAsync(data.bundle,{profile:SVG_2D_PROFILE,bakeResolver:async()=>{calls++;return new Uint8Array();}}));assert.equal(calls,0);
  code(()=>prepareScene(data.bundle),'BAKE_NOT_READY');const bad=beginPrepareScene(data.bundle,{profile:NUMERIC_3D_PROFILE,bakeResolver:async chunk=>new Uint8Array(chunk.byteLength)});await assert.rejects(bad.ready,/HASH/);assert.equal(bad.state,'failed');
});
