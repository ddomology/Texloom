import test from 'node:test';
import assert from 'node:assert/strict';
import {createEvaluator,prepareScene,validateBundle,validateCurveProgram3D,prepareCurveProgram3D,curveResourceDeclarations,
  validateExpressionProgram,validateSurfaceProgram,prepareSpace3DSampler,composeTransform3D,multiplyMatrix4,transformPoint3D,
  sceneFeatures,checkCapabilities,GPU_3D_PROFILE,CANVAS_2D_PROFILE,
  type Bundle,type Curve3DResource,type CurveOperation3D,type FrameTransform3D,type MeshResource} from '../src/index.ts';

function operation():CurveOperation3D{return {id:'line',resourceId:'generated-line',units:'unit',domain:[0,1],segments:4,
  position:['radius*u','0','time / 1s'],frame:{seed:{kind:'up',up:[0,1,0]}}};}
function scene():Bundle{return {version:'0.3',units:'bp',title:'Curve frames',duration:4,viewport:{width:200,height:100},camera:{x:0,y:0,zoom:1},nodes:[],tracks:[],relations:[],
  resources:{label:{kind:'vector',items:[],metrics:{width:0,height:0,depth:0},inkBounds:[0,0,0,0]}},
  expressions:{version:1,parameters:{radius:{type:'scalar',unit:'1',default:2,min:1,max:4}},bindings:[]},
  curves3d:{version:1,operations:[operation()],followers:[{id:'follow',curveNode:'line-node',target:'traveller',progress:'time / 4s'}]},
  space3d:{version:1,units:'unit',handedness:'right',upAxis:'z',nodes:[
    {kind:'group',id:'parent',transform:{translation:[3,4,-6],scale:[2,3,1]}},
    {kind:'curve',id:'line-node',parent:'parent',resourceId:'generated-line',color:'#aabbcc'},
    {kind:'group',id:'traveller',parent:'parent',transform:{translation:[999,999,999],rotation:[0,0,1,0],scale:[2,1,1]}}],
    overlays:[{id:'label',parent:'traveller',resourceId:'label',position:[0,0,0]}],
    camera:{id:'camera',projection:{kind:'orthographic',height:20,near:.1,far:100}}}};}
const errors=(b:Bundle)=>validateBundle(b).filter(d=>d.severity==='error');
const near=(a:readonly number[],b:readonly number[])=>{assert.equal(a.length,b.length);a.forEach((v,i)=>assert.ok(Math.abs(v-b[i])<1e-10,`${a} != ${b}`));};

test('generated curves and followers share one local chart and preserve authored scale',()=>{
  const b=scene(),original=structuredClone(b);assert.deepEqual(errors(b),[]);
  const sample=createEvaluator(b),f=sample(2,{radius:3}),curve=f.resources['generated-line'] as Curve3DResource;
  assert.equal(curve.positions.count,5);assert.deepEqual(curve.bounds,{min:[0,0,2],max:[3,0,2]});
  assert.deepEqual(f.space3d!.curves[0].worldBounds,{min:[3,4,-4],max:[9,4,-4]});
  assert.equal(f.space3d!.curves[0].color,'#aabbcc');assert.deepEqual(f.curves3d!.followers.follow.sample.position,[1.5,0,2]);
  const world=f.space3d!.groups.find(g=>g.id==='traveller')!.worldMatrix;
  near(transformPoint3D(world,[0,0,0]),[6,4,-4]);near(transformPoint3D(world,[1,0,0]),[10,4,-4]);
  near(f.space3d!.overlays[0].worldPosition,[6,4,-4]);assert.deepEqual(f.curves3d!.followers.follow.sample.quaternion,[0,0,0,1]);
  assert.ok(Object.isFrozen(curve.positions.data)&&Object.isFrozen(f.curves3d!.followers.follow.sample));assert.deepEqual(b,original);
  assert.deepEqual(sample(100),sample(4));assert.deepEqual(sample(-100),sample(0));
});

test('curved quaternion frame, animated shared parent and seek histories agree exactly',()=>{
  const b=scene(),o=b.curves3d!.operations[0];o.domain=[0,Math.PI*4];o.segments=64;o.position=['radius*cos(u)','radius*sin(u)','u / 5'];o.frame={seed:{kind:'up',up:[0,0,1]},twist:Math.PI/3};
  b.space3d!.tracks=[{target:'parent',property:'translation',keys:[[0,[3,4,-6]],[4,[7,8,-10]]]}];
  const sample=createEvaluator(b),expected=sample(1.7),s=expected.curves3d!.followers.follow.sample;
  const local=composeTransform3D({translation:[...s.position],rotation:[...s.quaternion],scale:[2,1,1]}),parent=expected.space3d!.groups.find(g=>g.id==='parent')!.worldMatrix;
  near(expected.space3d!.groups.find(g=>g.id==='traveller')!.worldMatrix,multiplyMatrix4(parent,local));
  near([local[0]/2,local[1]/2,local[2]/2],s.tangent);assert.notDeepEqual(s.tangent,s.chordTangent);
  for(const fps of [24,30,60]){for(let i=0;i<fps*4;i++)sample(i/fps);assert.deepEqual(sample(1.7),expected);}
  for(const t of [4,0,3,1,.7,2.8])sample(t);assert.deepEqual(sample(1.7),expected);
});

test('prepared declarations and options are detached, with explicit parameter and progress diagnostics',()=>{
  const b=scene(),prepared=prepareCurveProgram3D(b.curves3d!,b),base=prepared.sample(2);
  b.curves3d!.operations[0].domain[1]=9;b.curves3d!.operations[0].position[0]='999';b.curves3d!.followers[0].progress='0';b.expressions!.parameters.radius.default=4;
  assert.deepEqual(prepared.sample(2),base);assert.throws(()=>prepared.sample(NaN),/finite/);
  for(const override of [{radius:0},{radius:true},{unknown:1}] as Record<string,number|boolean>[])assert.throws(()=>prepared.sample(0,override),/EXPRESSION_PARAMETER/);
  const p=scene();p.curves3d!.followers[0].progress='time / 1s';assert.throws(()=>createEvaluator(p)(2),/CURVE3D_PROGRESS/);
  p.curves3d!.followers[0].progress='2';assert.throws(()=>createEvaluator(p),/CURVE3D_PROGRESS/);
  const bad=scene(),span={file:'curve-position.txt',start:{line:1,column:1},end:{line:1,column:28}};
  bad.curves3d!.operations[0].position[2]='1 / (time / 1s - 2)';bad.curves3d!.operations[0].expressionSpans={position:[span,span,span]};
  assert.throws(()=>createEvaluator(bad)(2),(e:any)=>e.diagnostics.some((d:any)=>d.path==='$.curves3d.operations[0].position[2]'&&d.sourceSpan.file===span.file));
});

test('curve binding rejects conflicting charts, writers, IDs, topology, units and budgets',()=>{
  const cases:((b:Bundle)=>void)[]=[
    b=>{b.curves3d!.operations[0].units='m';},b=>{b.curves3d!.operations[0].position[0]='time';},
    b=>{b.curves3d!.operations[0].position[0]='vec2(u,u)';},b=>{b.curves3d!.operations[0].segments=8193;},
    b=>{b.curves3d!.operations[0].domain=[0,0];},b=>{b.curves3d!.operations[0].frame=null as any;},
    b=>{b.curves3d!.operations[0].resourceId='label';},b=>{b.curves3d!.operations.push(structuredClone(operation()));},
    b=>{b.curves3d!.followers.push({...b.curves3d!.followers[0],id:'another'});},
    b=>{b.curves3d!.followers[0].target='camera';},b=>{b.curves3d!.followers[0].curveNode='traveller';},
    b=>{b.space3d!.nodes[2].parent=undefined;delete b.space3d!.nodes[2].parent;},
    b=>{b.space3d!.nodes[1].transform={translation:[1,0,0]};},
    b=>{b.space3d!.nodes[2].transform={matrix:[...composeTransform3D()]};},
    b=>{b.space3d!.tracks=[{target:'traveller',property:'rotation',keys:[[0,[0,0,0,1]]]}];},
    b=>{b.space3d!.tracks=[{target:'line-node',property:'scale',keys:[[0,[1,1,1]]]}];},
    b=>{b.expressions!.parameters.u={type:'scalar',unit:'1',default:1};},
    b=>{b.curves3d!.followers[0].progress='1bp';},b=>{(b.curves3d!.operations[0] as any).guessFrame=true;},
    b=>{b.curves3d!.operations=Array.from({length:17},(_,i)=>({...operation(),id:'c'+i,resourceId:'c'+i}));},
    b=>{b.curves3d!.operations=Array.from({length:5},(_,i)=>({...operation(),id:'c'+i,resourceId:'c'+i,segments:8192}));},
  ];for(const mutate of cases){const b=scene();mutate(b);assert.ok(errors(b).length>0,mutate.toString());}
  const valid=scene();valid.space3d!.tracks=[{target:'traveller',property:'scale',keys:[[0,[2,1,1]],[4,[4,1,1]]]}];assert.deepEqual(errors(valid),[]);
  near(createEvaluator(valid)(4).space3d!.groups.find(g=>g.id==='traveller')!.worldMatrix.slice(0,3),[8,0,0]);
});

test('standalone validators reject malformed contexts without getters and use candidate parameters',()=>{
  const b=scene();assert.deepEqual(validateCurveProgram3D(b.curves3d,b).filter(d=>d.severity==='error'),[]);
  assert.deepEqual(validateExpressionProgram(b.expressions,b).filter(d=>d.severity==='error'),[]);
  const candidate=structuredClone(b.expressions!);candidate.parameters.radius.unit='bp';assert.ok(validateExpressionProgram(candidate,b).some(d=>d.code==='CURVE3D_EXPRESSION_TYPE'));
  for(const context of [null,{...b,resources:null},{...b,space3d:{version:1,nodes:null}},{...b,space3d:{...b.space3d,tracks:null}}])assert.ok(validateCurveProgram3D(b.curves3d,context as any).some(d=>d.severity==='error'));
  let reads=0;const accessor={version:1,get operations(){reads++;return [];},followers:[]};assert.ok(validateCurveProgram3D(accessor,b).length);assert.deepEqual(curveResourceDeclarations(accessor),[]);assert.equal(reads,0);
  assert.ok(validateCurveProgram3D({version:1,operations:null,followers:[]},b).length);
  b.diagnostics=[{severity:'warning',code:'NOTE',message:'Nonblocking note.'}];assert.doesNotThrow(()=>createEvaluator(b)(0));
});

test('surfaces and curves coexist across standalone preparation, dynamic bounds and generated inventories',()=>{
  const b=scene();b.surfaces={version:1,operations:[{id:'sheet',resourceId:'sheet',units:'unit',domain:{u:[0,1],v:[0,1]},segments:{u:2,v:2},position:['radius*u','v','time / 1s'],normals:{kind:'analytic',dU:['radius','0','0'],dV:['0','1','0']}}]};
  b.space3d!.nodes.push({id:'sheet-node',kind:'mesh',resourceId:'sheet',parent:'parent'});
  assert.deepEqual(errors(b),[]);assert.deepEqual(validateCurveProgram3D(b.curves3d,b).filter(d=>d.severity==='error'),[]);assert.deepEqual(validateSurfaceProgram(b.surfaces,b).filter(d=>d.severity==='error'),[]);
  assert.deepEqual(validateExpressionProgram(b.expressions,b).filter(d=>d.severity==='error'),[]);
  const runtime=prepareScene(b),frame=runtime.sample(2,{radius:3});assert.equal(frame.space3d!.curves.length,1);assert.equal(frame.space3d!.instances.length,1);
  assert.deepEqual(frame.space3d!.instances[0].worldBounds,{min:[3,4,-4],max:[9,7,-4]});assert.equal((frame.resources.sheet as MeshResource).positions.count,9);
  assert.deepEqual(runtime.manifest.generatedResources!.map(r=>[r.id,r.kind,r.producer]),[['sheet','mesh','surface'],['generated-line','curve3d','curve3d']]);
  b.curves3d!.operations[0].resourceId='sheet';assert.ok(errors(b).some(d=>d.code==='CURVE3D_RESOURCE'));
});

test('spatial follower input snapshots and current dynamic metadata cannot be changed by callers',()=>{
  const b=scene(),prepared=prepareCurveProgram3D(b.curves3d!,b),resources={...b.resources,...prepared.baseResources} as Bundle['resources'];
  const spatial=prepareSpace3DSampler(b.space3d!,resources,{viewport:b.viewport,duration:b.duration},prepared.resourceIds,prepared.baseTransforms);
  const one=prepared.sample(1),metadata=Object.fromEntries(Object.entries(one.resources).map(([id,r])=>[id,{bounds:r.bounds,topologyRevision:r.topologyRevision}]));
  const expected=spatial(1,metadata,one.transforms);b.space3d!.nodes=[];b.space3d!.tracks=[{target:'traveller',property:'rotation',keys:[[0,[0,0,0,1]]]}];
  assert.deepEqual(spatial(1,metadata,one.transforms),expected);
  for(const transforms of [undefined,{}, {unexpected:{translation:[0,0,0],rotation:[0,0,0,1]}},{traveller:{translation:[0,0,0],rotation:[0,0,0,0]}},{traveller:{translation:[0,0,0],rotation:[0,0,0,1],scale:[1,1,1]}}])assert.throws(()=>spatial(1,metadata,transforms as any),/SPACE3D_DYNAMIC_TRANSFORM|NON_JSON/);
  const mutable={traveller:{translation:[1,2,3],rotation:[0,0,0,1]}} as Record<string,FrameTransform3D>,before=spatial(1,metadata,mutable);mutable.traveller.translation[0]=100;assert.notDeepEqual(spatial(1,metadata,mutable),before);
  const overflow=scene();overflow.space3d!.nodes[0].transform={scale:[1e308,1,1]};overflow.space3d!.nodes[2].transform={};assert.deepEqual(errors(overflow),[]);assert.throws(()=>createEvaluator(overflow),/RANGE|finite|range/);
});

test('curve features and manifest distinguish transport/following from 2D output',()=>{
  const b=scene(),features=sceneFeatures(b);for(const f of ['curve.polyline.3d','frame.transport.3d','constraint.curve-follow.3d'])assert.ok(features.includes(f as any));
  assert.equal(checkCapabilities(features,GPU_3D_PROFILE).compatible,true);assert.equal(checkCapabilities(features,CANVAS_2D_PROFILE).compatible,false);
  const runtime=prepareScene(b);assert.deepEqual(runtime.manifest.generatedResources,[{id:'generated-line',kind:'curve3d',producer:'curve3d',operationId:'line',units:'unit'}]);
  assert.ok(Object.isFrozen(runtime.manifest.generatedResources![0]));assert.deepEqual(curveResourceDeclarations(b.curves3d),[{resourceId:'generated-line',units:'unit'}]);
});
