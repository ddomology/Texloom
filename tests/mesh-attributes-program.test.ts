import test from 'node:test';
import assert from 'node:assert/strict';
import {createEvaluator,prepareScene,validateBundle,validateMeshAttributeProgram,prepareMeshAttributeProgram,
  validateExpressionProgram,validateSurfaceProgram,validateCurveProgram3D,copyMeshAttribute,sceneFeatures,
  checkCapabilities,GPU_3D_PROFILE,CANVAS_2D_PROFILE,meshAttributeResourceDeclarations,
  type Bundle,type MeshResource,type MeshAttributeOperation} from '../src/index.ts';

function mesh():MeshResource{return {kind:'mesh',version:1,primitive:'triangles',units:'unit',coordinateSpace:'object',winding:'ccw',topologyRevision:'square-v1',
  positions:{version:1,componentType:'float64',components:3,count:4,byteOffset:0,byteStride:24,data:[0,0,0,2,0,0,0,2,2,2,2,2]},
  indices:{version:1,componentType:'uint16',components:1,count:6,byteOffset:0,byteStride:2,data:[0,1,2,1,3,2]},
  normals:{version:1,componentType:'float64',components:3,count:4,byteOffset:0,byteStride:24,data:[0,0,1,0,0,1,0,0,1,0,0,1]},bounds:{min:[0,0,0],max:[2,2,2]}};}
function operation():MeshAttributeOperation{return {id:'capture',source:'source',resourceId:'captured',units:'unit',steps:[
  {kind:'capture',name:'height',domain:'vertex',valueType:'scalar',expression:'z'},
  {kind:'capture',name:'originalPosition',domain:'vertex',valueType:'vec3',expression:['x','y','z']},
  {kind:'capture',name:'color',domain:'vertex',valueType:'color',expression:['x/2','y/2','z/2']},
  {kind:'set-position',expression:['x*factor','y','z+time / 1s'],normalPolicy:'drop'},
  {kind:'capture',name:'movedHeight',domain:'vertex',valueType:'scalar',expression:'z'},
  {kind:'capture',name:'sourceHeight',domain:'vertex',valueType:'scalar',expression:'oz'},
  {kind:'transfer',source:'height',name:'meanHeight',domain:'face',method:'mean'},
]};}
function scene():Bundle{return {version:'0.3',units:'bp',title:'Captured attributes',duration:4,viewport:{width:200,height:100},camera:{x:0,y:0,zoom:1},nodes:[],tracks:[],relations:[],resources:{source:mesh()},
  expressions:{version:1,parameters:{factor:{type:'scalar',unit:'1',default:1,min:.5,max:3}},bindings:[]},
  meshAttributes:{version:1,operations:[operation(),{id:'average',source:'captured',resourceId:'flat',units:'unit',steps:[{kind:'transfer',source:'color',name:'faceColor',domain:'face',method:'mean'}]}]},
  space3d:{version:1,units:'unit',handedness:'right',upAxis:'z',nodes:[{kind:'mesh',id:'mesh',resourceId:'flat',transform:{translation:[1,2,-10]},material:{kind:'unlit',color:'#ffffff',colorAttribute:'faceColor'}}],camera:{id:'camera',projection:{kind:'orthographic',height:10,near:.1,far:100}}}};}
const errors=(b:Bundle)=>validateBundle(b).filter(d=>d.severity==='error');
const resource=(frame:ReturnType<ReturnType<typeof createEvaluator>>,id='flat')=>frame.resources[id] as MeshResource;

test('capture then position update retains original values, topology and source, with fresh bounds and explicit normal removal',()=>{
  const b=scene(),original=structuredClone(b);assert.deepEqual(errors(b),[]);const sample=createEvaluator(b),f=sample(2,{factor:2}),out=resource(f);
  assert.deepEqual(Array.from(copyMeshAttribute(out,'height')),[0,0,2,2]);assert.deepEqual(Array.from(copyMeshAttribute(out,'sourceHeight')),[0,0,2,2]);
  assert.deepEqual(Array.from(copyMeshAttribute(out,'originalPosition')),mesh().positions.data);assert.deepEqual(Array.from(copyMeshAttribute(out,'movedHeight')),[2,2,4,4]);
  assert.deepEqual(Array.from(copyMeshAttribute(out,'meanHeight')),[2/3,4/3]);assert.deepEqual(out.positions.data,[0,0,2,4,0,2,0,2,4,4,2,4]);
  assert.deepEqual(out.bounds,{min:[0,0,2],max:[4,2,4]});assert.deepEqual(f.space3d!.instances[0].worldBounds,{min:[1,2,-8],max:[5,4,-6]});assert.equal(out.normals,undefined);
  assert.deepEqual(out.attributes!.topology,{revision:'square-v1',vertexCount:4,indices:[0,1,2,1,3,2]});assert.deepEqual(out.indices,mesh().indices);
  assert.deepEqual(b,original);assert.notDeepEqual(out.positions.data,mesh().positions.data);assert.ok(Object.isFrozen(out.attributes!.values.height.buffer.data));
  assert.deepEqual(f.meshAttributes!.average.attributes,['height','originalPosition','color','movedHeight','sourceHeight','meanHeight','faceColor']);
  assert.deepEqual(sample(100),sample(4));assert.deepEqual(sample(-1),sample(0));
});

test('explicit face/corner contexts and transfers never infer domains from matching array lengths',()=>{
  const b=scene();b.meshAttributes!.operations=[{id:'domains',source:'source',resourceId:'flat',units:'unit',steps:[
    {kind:'capture',name:'centroid',domain:'face',valueType:'vec3',expression:['x','y','z']},
    {kind:'capture',name:'corner',domain:'corner',valueType:'scalar',expression:'index'},
    {kind:'capture',name:'uv',domain:'vertex',valueType:'vec2',expression:['x','y']},
    {kind:'capture',name:'faceColor',domain:'face',valueType:'color',expression:['index','0','1-index']},
    {kind:'transfer',source:'corner',name:'cornerMean',domain:'face',method:'mean'},
    {kind:'transfer',source:'faceColor',name:'promoted',domain:'corner',method:'promote'},
    {kind:'transfer',source:'faceColor',name:'weighted',domain:'vertex',method:'area-weighted'},
  ]}];
  const out=resource(createEvaluator(b)(0));assert.deepEqual(Array.from(copyMeshAttribute(out,'centroid')),[2/3,2/3,2/3,4/3,4/3,4/3]);
  Array.from(copyMeshAttribute(out,'cornerMean')).forEach((n,i)=>assert.ok(Math.abs(n-[1,4][i])<1e-14));assert.deepEqual(Array.from(copyMeshAttribute(out,'uv')),[0,0,2,0,0,2,2,2]);
  assert.deepEqual(Array.from(copyMeshAttribute(out,'promoted')),[0,0,1,0,0,1,0,0,1,1,0,0,1,0,0,1,0,0]);
});

test('ordered input snapshots and reverse seeking have no capture history',()=>{
  const b=scene(),prepared=prepareMeshAttributeProgram(b.meshAttributes!,b),sample=createEvaluator(b),expected=sample(1.25,{factor:2});
  b.meshAttributes!.operations[0].steps=[];(b.resources.source as MeshResource).positions.data[0]=100;b.expressions!.parameters.factor.default=3;
  assert.deepEqual(prepared.sample(1.25,{factor:2}).resources.flat,resource(expected));
  for(const t of [4,0,2.9,.1,3,1,0])sample(t,{factor:1});assert.deepEqual(sample(1.25,{factor:2}),expected);
  assert.throws(()=>prepared.sample(NaN),/finite/);for(const parameters of [{factor:0},{factor:true},{unknown:1}] as Record<string,number|boolean>[])assert.throws(()=>prepared.sample(0,parameters),/EXPRESSION_PARAMETER/);
});

test('generated surfaces, curves and captured outputs coexist and direct upstream sampling matches the evaluator',()=>{
  const b=scene();delete b.resources.source;
  b.surfaces={version:1,operations:[{id:'sheet',resourceId:'source',units:'unit',domain:{u:[0,1],v:[0,1]},segments:{u:2,v:2},position:['u','v','time / 4s'],normals:{kind:'analytic',dU:['1','0','0'],dV:['0','1','0']}}]};
  b.curves3d={version:1,operations:[{id:'line',resourceId:'line',units:'unit',domain:[0,1],segments:3,position:['u','0','0'],frame:{seed:{kind:'up',up:[0,1,0]}}}],followers:[]};
  b.space3d!.nodes.push({kind:'curve',id:'line',resourceId:'line'});
  for(const ds of [errors(b),validateMeshAttributeProgram(b.meshAttributes,b),validateSurfaceProgram(b.surfaces,b),validateCurveProgram3D(b.curves3d,b),validateExpressionProgram(b.expressions,b)])assert.deepEqual(ds.filter(d=>d.severity==='error'),[]);
  const direct=prepareMeshAttributeProgram(b.meshAttributes!,b),evaluate=createEvaluator(b);
  for(const t of [0,3,1.5,4]){const out=direct.sample(t,{factor:2});assert.deepEqual(out.resources.flat,resource(evaluate(t,{factor:2})));}
  assert.equal(prepareScene(b).manifest.generatedResources!.length,4);
  const span={file:'attributes/body.json',start:{line:1,column:1},end:{line:2,column:1}};b.meshAttributes!.operations[0].sourceSpan=span;
  assert.throws(()=>prepareMeshAttributeProgram(b.meshAttributes!,b,{}),(e:any)=>e.diagnostics.some((d:any)=>d.code==='MESH_ATTRIBUTE_SOURCE'&&d.sourceSpan.file===span.file));
});

test('invalid dependency order, collisions, domain policies, units, names, locals and expression shape fail preparation',()=>{
  const cases:((b:Bundle)=>void)[]=[
    b=>{b.meshAttributes!.operations.reverse();},b=>{b.meshAttributes!.operations[0].source='flat';},
    b=>{b.meshAttributes!.operations[0].resourceId='source';},b=>{b.meshAttributes!.operations[0].source='missing';},
    b=>{b.meshAttributes!.operations[0].units='m';},b=>{b.meshAttributes!.operations[0].steps=[];},
    b=>{(b.meshAttributes!.operations[0].steps[0] as any).expression=['z'];},
    b=>{(b.meshAttributes!.operations[0].steps[0] as any).expression='time';},
    b=>{(b.meshAttributes!.operations[0].steps[0] as any).expression='height';},
    b=>{(b.meshAttributes!.operations[0].steps[1] as any).expression=['x','y'];},
    b=>{(b.meshAttributes!.operations[0].steps[0] as any).name='constructor';},
    b=>{(b.meshAttributes!.operations[0].steps[1] as any).name='height';},
    b=>{(b.meshAttributes!.operations[0].steps[3] as any).normalPolicy='retain';},
    b=>{(b.meshAttributes!.operations[1].steps[0] as any).method='nearest';},
    b=>{(b.meshAttributes!.operations[1].steps[0] as any).domain='vertex';},
    b=>{(b.meshAttributes!.operations[1].steps[0] as any).zeroArea='ignore';},
    b=>{(b.meshAttributes!.operations[1].steps[0] as any).orphan='zero';},
    b=>{b.expressions!.parameters.x={type:'scalar',unit:'1',default:0};},
    b=>{b.meshAttributes!.operations=Array.from({length:17},(_,i)=>({...operation(),id:'o'+i,resourceId:'o'+i}));},
    b=>{b.meshAttributes!.operations[0].steps=Array.from({length:33},()=>({kind:'set-position',expression:['x','y','z'],normalPolicy:'drop'}));},
  ];for(const mutate of cases){const b=scene();mutate(b);assert.ok(errors(b).length,mutate.toString());}
  const b=scene();(b.meshAttributes!.operations[0].steps[2] as any).expression=['2','0','0'];assert.deepEqual(errors(b),[]);assert.throws(()=>createEvaluator(b),/ATTRIBUTE_COLOR/);
});

test('standalone validators and generated dictionaries reject getters and malformed contexts before invoking them',()=>{
  const b=scene();let reads=0;const bad={get malicious(){reads++;return 1;}};
  assert.throws(()=>prepareMeshAttributeProgram(b.meshAttributes!,b,bad as any));assert.equal(reads,0);
  const prepared=prepareMeshAttributeProgram(b.meshAttributes!,b);assert.throws(()=>prepared.sample(0,undefined,bad as any));assert.equal(reads,0);
  const program={version:1,get operations(){reads++;return [];}};assert.ok(validateMeshAttributeProgram(program,b).length);assert.deepEqual(meshAttributeResourceDeclarations(program),[]);assert.equal(reads,0);
  for(const context of [null,{...b,resources:null},{...b,space3d:{nodes:null}},{...b,meshAttributes:null}]){
    // The explicit input program is authoritative; null in the original slot may be replaced.
    if((context as any)?.meshAttributes===null)assert.deepEqual(validateMeshAttributeProgram(b.meshAttributes,context as unknown as Bundle).filter(d=>d.severity==='error'),[]);
    else assert.ok(validateMeshAttributeProgram(b.meshAttributes,context as any).some(d=>d.severity==='error'));
  }
  const candidate=structuredClone(b.expressions!);candidate.parameters.factor.unit='bp';assert.ok(validateExpressionProgram(candidate,b).some(d=>d.code==='MESH_ATTRIBUTE_EXPRESSION_TYPE'));
  b.diagnostics=[{severity:'warning',code:'NOTE',message:'Nonblocking.'}];assert.doesNotThrow(()=>createEvaluator(b)(0));
});

test('step expression diagnostics retain the decoded source location',()=>{
  const b=scene(),span={file:'attributes/height.expression.txt',start:{line:1,column:1},end:{line:1,column:28}};
  const step=b.meshAttributes!.operations[0].steps[0] as any;step.expression='1 / (time / 1s - 2)';step.expressionSpans=[span];
  const sample=createEvaluator(b);assert.throws(()=>sample(2),(e:any)=>e.diagnostics.some((d:any)=>d.path==='$.meshAttributes.operations[0].steps[0].expression[0]'&&d.sourceSpan.file===span.file));
});

test('capability and manifest declarations expose derived resources and explicit transfer',()=>{
  const b=scene(),features=sceneFeatures(b);for(const f of ['attribute.mesh.3d','attribute.domain-transfer.3d','material.color-attribute.3d'])assert.ok(features.includes(f as any));
  assert.equal(checkCapabilities(features,GPU_3D_PROFILE).compatible,true);assert.equal(checkCapabilities(features,CANVAS_2D_PROFILE).compatible,false);
  const manifest=prepareScene(b).manifest;assert.deepEqual(manifest.generatedResources!.map(r=>[r.id,r.producer]),[['captured','mesh-attributes'],['flat','mesh-attributes']]);assert.ok(Object.isFrozen(manifest.generatedResources![0]));
});
