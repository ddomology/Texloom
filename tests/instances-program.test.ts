import test from 'node:test';
import assert from 'node:assert/strict';
import {createEvaluator,validateBundle,prepareInstanceProgram,validateInstanceProgram,prepareScene,
  validateExpressionProgram,validateSurfaceProgram,validateCurveProgram3D,validateMeshAttributeProgram,
  attachMeshAttributes,copyMeshAttribute,sceneFeatures,checkCapabilities,GPU_3D_PROFILE,CANVAS_2D_PROFILE,
  instanceResourceDeclarations,type Bundle,type MeshResource,type InstanceOperation} from '../src/index.ts';

function mesh():MeshResource{return {kind:'mesh',version:1,primitive:'triangles',units:'unit',coordinateSpace:'object',winding:'ccw',topologyRevision:'triangle-1',
  positions:{version:1,componentType:'float64',components:3,count:3,byteOffset:0,byteStride:24,data:[0,0,0,1,0,0,0,1,0]},
  indices:{version:1,componentType:'uint16',components:1,count:3,byteOffset:0,byteStride:2,data:[0,1,2]},
  normals:{version:1,componentType:'float64',components:3,count:3,byteOffset:0,byteStride:24,data:[0,0,1,0,0,1,0,0,1]},bounds:{min:[0,0,0],max:[1,1,0]}};}
function operation():InstanceOperation{return {id:'arrows',prototype:'prototype',units:'unit',seed:123,source:{kind:'points',points:[{id:'a',position:[1,2,0]},{id:'b',position:[3,0,0]}]},
  position:['x','y','z+time / 1s'],rotation:['0','0','sin(time / 8s)','cos(time / 8s)'],scale:['factor','1','1'],color:['rand','rand1','rand2'],selection:'rand3 < density'};}
function scene():Bundle{return {version:'0.3',units:'bp',title:'Instance program',duration:8,viewport:{width:300,height:200},camera:{x:0,y:0,zoom:1},nodes:[],tracks:[],relations:[],resources:{prototype:mesh(),source:mesh()},
  instances:{version:1,operations:[operation()]},expressions:{version:1,parameters:{factor:{type:'scalar',unit:'1',default:1,min:.1,max:3},density:{type:'scalar',unit:'1',default:1,min:0,max:1}},bindings:[]},
  space3d:{version:1,units:'unit',handedness:'right',upAxis:'z',nodes:[{kind:'instances',id:'display',instanceSetId:'arrows',transform:{translation:[0,0,-20]}}],camera:{id:'camera',projection:{kind:'orthographic',height:20,near:.1,far:100}}}};}
const errors=(b:Bundle)=>validateBundle(b).filter(d=>d.severity==='error');

test('instance program shares prototype data, publishes immutable sets and evaluates absolute time',()=>{
  const b=scene(),original=structuredClone(b);assert.deepEqual(errors(b),[]);const evaluate=createEvaluator(b),f=evaluate(2,{factor:2}),set=f.instanceSets!.arrows;
  assert.equal(set.instances.length,2);assert.equal(set.prototypeResourceId,'prototype');assert.deepEqual(set.instances[0].transform!.translation,[1,2,2]);
  assert.deepEqual(set.instances[0].transform!.scale,[2,1,1]);assert.ok(set.instances.every(i=>i.selected));
  assert.ok(set.instances.every(i=>i.color!.every(v=>v>=0&&v<1)));assert.ok(Object.isFrozen(set.instances[0].transform!.translation));
  assert.strictEqual(f.resources.prototype,evaluate(5).resources.prototype);assert.deepEqual(Object.keys(f.resources),['prototype','source']);
  assert.equal(f.space3d!.instanceBatches![0].instances.length,2);assert.deepEqual(b,original);
  assert.deepEqual(evaluate(-1),evaluate(0));assert.deepEqual(evaluate(99),evaluate(8));
  const manifest=prepareScene(b).manifest;assert.deepEqual(manifest.instanceSets,[{id:'arrows',prototypeResourceId:'prototype',units:'unit'}]);assert.equal(manifest.generatedResources,undefined);
  assert.ok(sceneFeatures(b).includes('instance.mesh.3d'));assert.ok(checkCapabilities(sceneFeatures(b),GPU_3D_PROFILE).compatible);assert.ok(!checkCapabilities(sceneFeatures(b),CANVAS_2D_PROFILE).compatible);
});

test('seed lanes are stable per element ID through seeks, frame rates, point reordering and selection',()=>{
  const b=scene(),evaluate=createEvaluator(b),expected=evaluate(3.25).instanceSets;
  for(const fps of [30,60])for(let i=0;i<fps*2;i++)evaluate(i/fps);for(const t of [8,1,6,0,4,7])evaluate(t);
  assert.deepEqual(evaluate(3.25).instanceSets,expected);
  const colors=new Map(expected!.arrows.instances.map(i=>[i.id,i.color]));(b.instances!.operations[0].source as {kind:'points';points:any[]}).points.reverse();
  const reordered=createEvaluator(b)(3.25);for(const i of reordered.instanceSets!.arrows.instances)assert.deepEqual(i.color,colors.get(i.id));
  const none=evaluate(3.25,{density:0});assert.equal(none.instanceSets!.arrows.instances.length,2);assert.ok(none.instanceSets!.arrows.instances.every(i=>!i.selected));assert.deepEqual(none.instanceSets!.arrows.instances.map(i=>i.id),['a','b']);
  b.instances!.operations[0].seed++;assert.notDeepEqual(createEvaluator(b)(3.25).instanceSets!.arrows.instances[0].color,colors.get('b'));
});

test('mesh vertex, face and corner source domains are explicit and topology participates in stable identity',()=>{
  for(const domain of ['vertex','face','corner'] as const){const b=scene(),o=b.instances!.operations[0];o.source={kind:'mesh',resourceId:'source',domain};delete o.position;
    const before=createEvaluator(b)(0).instanceSets!.arrows.instances;
    assert.equal(before.length,domain==='face'?1:3);assert.deepEqual(before[0].transform!.translation,domain==='face'?[1/3,1/3,0]:[0,0,0]);
    (b.resources.source as MeshResource).positions.data[2]=.5;(b.resources.source as MeshResource).bounds!.max[2]=.5;
    const moved=createEvaluator(b)(0).instanceSets!.arrows.instances;assert.deepEqual(moved.map(i=>i.id),before.map(i=>i.id));
    (b.resources.source as MeshResource).topologyRevision='rewired';const rewired=createEvaluator(b)(0).instanceSets!.arrows.instances;assert.notEqual(rewired[0].id,before[0].id);
  }
});

test('surface, curve, attribute and instance programs coexist; standalone generated inputs sample current time',()=>{
  const b=scene();delete b.resources.source;
  b.surfaces={version:1,operations:[{id:'grid',resourceId:'source',units:'unit',domain:{u:[0,1],v:[0,1]},segments:{u:2,v:2},position:['u','v','time / 1s'],normals:{kind:'analytic',dU:['1','0','0'],dV:['0','1','0']}}]};
  b.curves3d={version:1,operations:[{id:'line',resourceId:'line',units:'unit',domain:[0,1],segments:3,position:['u','0','0'],frame:{seed:{kind:'up',up:[0,1,0]}}}],followers:[]};
  b.meshAttributes={version:1,operations:[{id:'lift',source:'source',resourceId:'lifted',units:'unit',steps:[{kind:'set-position',normalPolicy:'drop',expression:['x','y','z*factor']}]}]};
  b.instances!.operations[0].source={kind:'mesh',resourceId:'lifted',domain:'vertex'};delete b.instances!.operations[0].position;
  b.space3d!.nodes.push({kind:'curve',id:'line',resourceId:'line'});
  for(const d of [errors(b),validateInstanceProgram(b.instances,b),validateSurfaceProgram(b.surfaces,b),validateCurveProgram3D(b.curves3d,b),validateMeshAttributeProgram(b.meshAttributes,b),validateExpressionProgram(b.expressions,b)])assert.deepEqual(d.filter(x=>x.severity==='error'),[]);
  const direct=prepareInstanceProgram(b.instances!,b),evaluate=createEvaluator(b);
  for(const t of [0,4,1.25,8]){const actual=evaluate(t,{factor:2});assert.deepEqual(direct.sample(t,{factor:2}).instanceSets,actual.instanceSets);assert.equal(actual.instanceSets!.arrows.instances[0].transform!.translation![2],t*2);}
});

test('explicit realization preserves prototype attributes, selection and topology while producing an ordinary output mesh',()=>{
  const b=scene();b.resources.prototype=structuredClone(attachMeshAttributes(mesh(),{height:{domain:'vertex',valueType:'scalar',buffer:{version:1,componentType:'float64',components:1,count:3,byteOffset:0,byteStride:8,data:[2,3,4]}}})) as MeshResource;
  b.instances!.operations[0].selection='index == 0';b.instances!.operations[0].realize={resourceId:'realized',normalPolicy:'transform',instanceColorAttribute:'instanceColor',instanceSelectionAttribute:'chosen'};
  b.space3d!.nodes.push({kind:'mesh',id:'realized',resourceId:'realized',material:{kind:'unlit',color:'#ffffff',colorAttribute:'instanceColor'}});
  assert.deepEqual(errors(b),[]);const evaluate=createEvaluator(b),f=evaluate(2),out=f.resources.realized as MeshResource;
  assert.equal(out.positions.count,3);assert.deepEqual(Array.from(copyMeshAttribute(out,'height')),[2,3,4]);assert.deepEqual(Array.from(copyMeshAttribute(out,'chosen')),[1,1,1]);assert.ok(out.normals);
  assert.equal(out.topologyRevision,(evaluate(5).resources.realized as MeshResource).topologyRevision);
  assert.ok(Object.isFrozen(out.positions.data));assert.equal(prepareScene(b).manifest.generatedResources![0].producer,'instances');
  assert.deepEqual(instanceResourceDeclarations(b.instances),[{id:'arrows',prototype:'prototype',units:'unit',source:{kind:'points'},resourceId:'realized'}]);
  b.instances!.operations[0].realize!.selection='all';const all=createEvaluator(b)(2).resources.realized as MeshResource;assert.equal(all.positions.count,6);assert.deepEqual(Array.from(copyMeshAttribute(all,'chosen')),[1,1,1,0,0,0]);
});

test('source/prototype contracts, output collisions, expression types and budget failures reject without implicit adaptation',()=>{
  const cases:((b:Bundle)=>void)[]=[b=>b.instances!.operations[0].prototype='missing',b=>b.instances!.operations[0].units='m',
    b=>b.instances!.operations[0].source={kind:'mesh',resourceId:'missing',domain:'vertex'},b=>b.instances!.operations[0].seed=-1,
    b=>b.instances!.operations[0].source={kind:'points',points:[{id:'same',position:[0,0,0]},{id:'same',position:[1,0,0]}]},
    b=>(b.instances!.operations[0] as any).extra=1,b=>b.instances!.operations[0].position=['time','0','0'],b=>b.instances!.operations[0].selection='1',
    b=>b.instances!.operations[0].rotation=['0','0','0','0'],b=>b.instances!.operations[0].color=['2','0','0'],
    b=>b.instances!.operations[0].realize={resourceId:'prototype',normalPolicy:'drop'},
    b=>b.instances!.operations[0].realize={resourceId:'new',normalPolicy:'drop',maxVertices:1},
    b=>b.expressions!.parameters.rand={type:'scalar',unit:'1',default:0},
    b=>b.instances!.operations[0].source={kind:'points',points:Array.from({length:4097},(_,i)=>({id:String(i),position:[0,0,0]}))},
    b=>b.instances!.operations=Array.from({length:17},(_,i)=>({...operation(),id:String(i)}))];
  for(const mutate of cases){const b=scene();mutate(b);assert.throws(()=>createEvaluator(b),mutate.toString());}
  const b=scene();b.instances!.operations=Array.from({length:2},(_,j)=>({...operation(),id:String(j),source:{kind:'points',points:Array.from({length:2049},(_,i)=>({id:String(i),position:[0,0,0]}))}}));assert.ok(errors(b).some(d=>d.code==='INSTANCE_BUDGET'));
});

test('earlier realizations can feed later sources and prototypes, while forward references cannot',()=>{
  const b=scene();b.instances!.operations[0].realize={resourceId:'baked',normalPolicy:'drop'};
  b.instances!.operations.push({id:'second',prototype:'baked',units:'unit',seed:0,source:{kind:'mesh',resourceId:'baked',domain:'face'}});
  b.space3d!.nodes.push({kind:'instances',id:'second-view',instanceSetId:'second'});
  assert.deepEqual(errors(b),[]);const evaluate=createEvaluator(b),frame=evaluate(2);
  assert.equal((frame.resources.baked as MeshResource).positions.count,6);assert.equal(frame.instanceSets!.second.instances.length,2);
  assert.equal(frame.instanceSets!.second.prototypeResourceId,'baked');assert.notDeepEqual(evaluate(3).instanceSets!.second,frame.instanceSets!.second);
  b.instances!.operations.reverse();assert.ok(errors(b).some(d=>d.code==='INSTANCE_PROTOTYPE'||d.code==='INSTANCE_SOURCE'));
});

test('prepared inputs are detached and public generated overrides reject accessors without calling them',()=>{
  const b=scene(),prepared=prepareInstanceProgram(b.instances!,b),expected=prepared.sample(1);
  b.instances!.operations[0].seed=2;(b.resources.prototype as MeshResource).positions.data[0]=99;b.expressions!.parameters.factor.default=3;
  assert.deepEqual(prepared.sample(1),expected);assert.throws(()=>prepared.sample(NaN),/finite/);assert.throws(()=>prepared.sample(0,{unknown:1}),/EXPRESSION_PARAMETER/);
  let calls=0;const hostile=Object.defineProperty({},'bad',{enumerable:true,get(){calls++;return mesh();}});
  assert.throws(()=>prepared.sample(0,undefined,hostile),/JSON|Accessor/);assert.throws(()=>prepareInstanceProgram(scene().instances!,scene(),hostile),/JSON|Accessor/);assert.equal(calls,0);
  const invalid=scene();Object.defineProperty(invalid.instances!.operations[0],'seed',{enumerable:true,get(){calls++;return 1;}});assert.ok(validateInstanceProgram(invalid.instances,invalid).some(d=>d.severity==='error'));assert.equal(calls,0);
  assert.ok(validateInstanceProgram(scene().instances,{...scene(),resources:null} as any).some(d=>d.severity==='error'));
});

test('expression and runtime failures retain authored spans and finite-data diagnostics',()=>{
  const b=scene(),span={file:'instances/position-2.txt',start:{line:1,column:1},end:{line:1,column:20}},o=b.instances!.operations[0];
  o.position=['x','y','1 / (time / 1s - 2)'];o.expressionSpans={position:[span,span,span]};
  const sample=createEvaluator(b);assert.throws(()=>sample(2),(e:any)=>e.diagnostics.some((d:any)=>d.sourceSpan?.file===span.file&&d.path==='$.instances.operations[0].position[2]'));
  o.position=['x','y','true'];assert.ok(errors(b).some(d=>d.code==='INSTANCE_EXPRESSION_TYPE'&&d.sourceSpan?.file===span.file));
});
