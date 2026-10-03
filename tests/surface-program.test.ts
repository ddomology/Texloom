import test from 'node:test';
import assert from 'node:assert/strict';
import {createEvaluator,validateBundle,validateSurfaceProgram,prepareSurfaceProgram,validateExpressionProgram,
  surfaceResourceDeclarations,prepareSpace3DSampler,prepareScene,sceneFeatures,checkCapabilities,GPU_3D_PROFILE,CANVAS_2D_PROFILE,
  type Bundle,type MeshResource,type SurfaceOperation} from '../src/index.ts';

function operation():SurfaceOperation{return {id:'sheet',resourceId:'generated-sheet',units:'unit',domain:{u:[0,1],v:[0,1]},segments:{u:2,v:2},
  position:['radius*u','v','time / 1s'],normals:{kind:'analytic',dU:['radius','0','0'],dV:['0','1','0']}};}
function scene():Bundle{return {version:'0.3',units:'bp',title:'Generated sheet',duration:4,viewport:{width:200,height:100},camera:{x:0,y:0,zoom:1},nodes:[],tracks:[],relations:[],resources:{},
  expressions:{version:1,parameters:{radius:{type:'scalar',unit:'1',default:2,min:1,max:4}},bindings:[]},surfaces:{version:1,operations:[operation()]},
  space3d:{version:1,units:'unit',handedness:'right',upAxis:'z',nodes:[{kind:'group',id:'parent',transform:{translation:[3,4,-6]}},{kind:'mesh',id:'sheet',parent:'parent',resourceId:'generated-sheet',material:{kind:'unlit',color:'#aabbcc',wireframe:true}}],camera:{id:'camera',projection:{kind:'orthographic',height:10,near:.1,far:100}}}};}
const errors=(b:Bundle)=>validateBundle(b).filter(d=>d.severity==='error');
const mesh=(f:ReturnType<ReturnType<typeof createEvaluator>>)=>f.resources['generated-sheet'] as MeshResource;

test('surface declarations need no placeholder assets; bounds, units and wireframe reach every absolute spatial frame',()=>{
  const b=scene(),original=structuredClone(b);assert.deepEqual(errors(b),[]);assert.deepEqual(surfaceResourceDeclarations(b.surfaces),[{resourceId:'generated-sheet',units:'unit'}]);
  const sample=createEvaluator(b),a=sample(0),end=sample(4),mid=sample(2,{radius:3});
  assert.deepEqual(a.space3d!.instances[0].worldBounds,{min:[3,4,-6],max:[5,5,-6]});
  assert.deepEqual(end.space3d!.instances[0].worldBounds,{min:[3,4,-2],max:[5,5,-2]});
  assert.deepEqual(mid.space3d!.instances[0].worldBounds,{min:[3,4,-4],max:[6,5,-4]});
  assert.equal(mid.space3d!.instances[0].material.wireframe,true);assert.equal(mesh(mid).positions.count,9);assert.equal(mesh(mid).indices.count,24);
  assert.equal(mid.space3d!.instances[0].topologyRevision,mesh(mid).topologyRevision);assert.deepEqual(sample(4),end);assert.deepEqual(sample(0),a);
  assert.deepEqual(b,original);assert.deepEqual(b.resources,{});assert.ok(Object.isFrozen(mid.resources)&&Object.isFrozen(mesh(mid).positions.data));
  assert.deepEqual(sample(100),end);assert.deepEqual(sample(-1),a);
  const manifest=prepareScene(b).manifest;assert.deepEqual(manifest.generatedResources,[{id:'generated-sheet',kind:'mesh',producer:'surface',operationId:'sheet',units:'unit'}]);
  assert.ok(Object.isFrozen(manifest.generatedResources![0]));assert.equal(manifest.assets,undefined);
});

test('surface attributes retain immutable time-zero base positions and stable topology while evaluated positions change',()=>{
  const sample=createEvaluator(scene()),a=sample(0),b=sample(2,{radius:4}),metadata=b.surfaces!.sheet;
  assert.equal(metadata.resourceId,'generated-sheet');assert.equal(metadata.attributes.uv.components,2);
  assert.deepEqual(metadata.attributes.basePositions.data,mesh(a).positions.data);assert.notDeepEqual(mesh(b).positions.data,metadata.attributes.basePositions.data);
  assert.equal(mesh(a).topologyRevision,mesh(b).topologyRevision);assert.deepEqual(mesh(a).indices.data,mesh(b).indices.data);
  assert.equal(metadata.report.normals.kind,'analytic');assert.ok(Object.isFrozen(metadata)&&Object.isFrozen(metadata.attributes.basePositions.data));
  for(let i=0;i<mesh(b).normals!.data.length;i+=3)assert.deepEqual(mesh(b).normals!.data.slice(i,i+3),[0,0,1]);
});

test('finite difference normals, explicit orientation and capability reporting agree',()=>{
  const b=scene(),o=b.surfaces!.operations[0];o.normals={kind:'finite-difference'};o.orientation='vu';
  const f=createEvaluator(b)(1);for(let i=2;i<mesh(f).normals!.data.length;i+=3)assert.ok(Math.abs(mesh(f).normals!.data[i]+1)<1e-10);
  assert.equal(f.surfaces!.sheet.report.normals.kind,'finite-difference');const features=sceneFeatures(b);
  for(const feature of ['mesh.triangles.3d','surface.parametric.3d','material.wireframe.3d'])assert.ok(features.includes(feature as any));
  assert.equal(checkCapabilities(features,GPU_3D_PROFILE).compatible,true);assert.equal(checkCapabilities(features,CANVAS_2D_PROFILE).compatible,false);
});

test('surface params share strict override validation, mutable declaration snapshots and expression diagnostics',()=>{
  const b=scene(),sample=createEvaluator(b);b.surfaces!.operations[0].position[0]='999';b.expressions!.parameters.radius.default=4;
  assert.equal(mesh(sample(0)).bounds!.max[0],2);for(const params of [{unknown:1},{radius:0},{radius:true}] as Record<string,number|boolean>[])assert.throws(()=>sample(0,params),/EXPRESSION_PARAMETER/);
  const p=prepareSurfaceProgram(scene().surfaces!,scene());assert.throws(()=>p.sample(Number.NaN),/finite/);assert.throws(()=>p.sample(0,{radius:99}),/EXPRESSION_PARAMETER/);
  const bad=scene();bad.surfaces!.operations[0].position[2]='1 / (time / 1s - 2)';const fail=createEvaluator(bad);
  assert.throws(()=>fail(2),(e:any)=>e.diagnostics.some((d:any)=>d.path==='$.surfaces.operations[0].position[2]'));
});

test('surface declaration rejects collisions, unknown fields, invalid topology, units, locals and budgets',()=>{
  const cases:((b:Bundle)=>void)[]=[
    b=>b.surfaces!.operations.push(structuredClone(b.surfaces!.operations[0])),
    b=>{b.resources['generated-sheet']={kind:'vector',items:[],metrics:{width:0,height:0,depth:0},inkBounds:[0,0,0,0]};},
    b=>(b.surfaces!.operations[0] as any).guessNormals=true,
    b=>b.surfaces!.operations[0].segments.u=0,
    b=>b.surfaces!.operations[0].domain.u=[1,1],
    b=>b.surfaces!.operations[0].units='m',
    b=>b.surfaces!.operations[0].position[0]='time',
    b=>b.surfaces!.operations[0].position[0]='vec2(u,v)',
    b=>{b.expressions!.parameters.u={type:'scalar',unit:'1',default:1};},
    b=>{b.surfaces!.operations[0].segments={u:256,v:256};b.surfaces!.operations.push({...operation(),id:'more',resourceId:'more'});},
    b=>{b.surfaces!.operations=Array.from({length:17},(_,i)=>({...operation(),id:'s'+i,resourceId:'s'+i}));},
    b=>{(b.space3d!.nodes[1] as any).material.wireframe='yes';},
  ];for(const mutate of cases){const b=scene();mutate(b);assert.ok(errors(b).length>0,mutate.toString());}
});

test('standalone surface and expression validators compose and never invoke accessors',()=>{
  const b=scene();assert.deepEqual(validateSurfaceProgram(b.surfaces,b).filter(d=>d.severity==='error'),[]);
  assert.deepEqual(validateExpressionProgram(b.expressions,b).filter(d=>d.severity==='error'),[]);
  const wrong=structuredClone(b.expressions!);wrong.parameters.radius.unit='bp';assert.ok(validateExpressionProgram(wrong,b).some(d=>d.code==='SURFACE_EXPRESSION_TYPE'));
  let reads=0;const input={version:1,get operations(){reads++;return [];}};assert.ok(validateSurfaceProgram(input,b).length);assert.deepEqual(surfaceResourceDeclarations(input),[]);assert.equal(reads,0);
  assert.ok(validateSurfaceProgram(b.surfaces,null as any).length);assert.ok(validateSurfaceProgram({version:1,operations:null},b).length);
  assert.ok(validateSurfaceProgram(b.surfaces,{...b,resources:null} as any).length);
  b.diagnostics=[{severity:'warning',code:'AUTHORED_NOTE',message:'A nonblocking authored note.'}];assert.doesNotThrow(()=>createEvaluator(b)(0));
});

test('dynamic spatial metadata must be declared, complete, detached and bounded',()=>{
  const b=scene(),f=createEvaluator(b)(0),prepare=prepareSpace3DSampler(b.space3d!,f.resources,{viewport:b.viewport,duration:b.duration},['generated-sheet']);
  const metadata={'generated-sheet':{bounds:{min:[0,0,0],max:[5,6,7]} as any,topologyRevision:'sample'}};
  const before=prepare(0,metadata);metadata['generated-sheet'].bounds.max[0]=100;assert.equal(before.instances[0].worldBounds!.max[0],8);
  for(const value of [undefined,{}, {unexpected:metadata['generated-sheet']},{'generated-sheet':{bounds:{min:[1,0,0],max:[0,1,1]},topologyRevision:'bad'}}])assert.throws(()=>prepare(1,value as any));
  assert.throws(()=>prepareSpace3DSampler(b.space3d!,f.resources,{viewport:b.viewport,duration:4},['missing']),/DYNAMIC_RESOURCE/);
  const overflow=scene();overflow.space3d!.nodes[0].transform={scale:[1e308,1,1]};
  assert.deepEqual(errors(overflow),[]);assert.throws(()=>createEvaluator(overflow),/RANGE|finite|range/);
});
