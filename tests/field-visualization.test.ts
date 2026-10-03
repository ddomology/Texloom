import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareFieldVisualizationProgram,validateFieldVisualizationProgram,type FieldVisualizationOperation} from '../src/operations/field-visualization.ts';
import {prepareInstanceProgram} from '../src/operations/instances.ts';
import {prepareSurfaceProgram} from '../src/operations/surface.ts';
import {prepareMeshAttributeProgram} from '../src/operations/mesh-attributes.ts';
import {prepareCurveProgram3D} from '../src/operations/curve3d.ts';
import {validateExpressionProgram} from '../src/fields/program.ts';
import {prepareScene} from '../src/runtime.ts';
import {validateBundle,type Bundle} from '../src/schema.ts';
import {copyMeshAttribute} from '../src/ir/attributes.ts';
import {copyMeshBuffers,type MeshResource} from '../src/ir/mesh.ts';
import type {NumericBuffer} from '../src/resources/buffers.ts';
import {composeTransform3D,transformPoint3D} from '../src/geometry/matrix4.ts';

const buffer=(data:number[],components:1|3,componentType:NumericBuffer['componentType']='float64'):NumericBuffer=>({version:1,componentType,components,count:data.length/components,byteOffset:0,byteStride:components*(componentType==='float64'?8:4),data});
const mesh=():MeshResource=>({kind:'mesh',version:1,primitive:'triangles',units:'unit',coordinateSpace:'object',winding:'ccw',topologyRevision:'triangle',positions:buffer([0,0,0,2,0,0,0,1,0],3),normals:buffer([0,0,1,0,0,1,0,0,1],3),indices:buffer([0,1,2],1,'uint32'),bounds:{min:[0,0,0],max:[2,1,0]}});
const operation=():FieldVisualizationOperation=>({id:'field',source:'source',resourceId:'display',units:'unit',scalar:'x+time/1s',invalidPolicy:'error',color:{attribute:'color',stops:[{position:0,color:[0,0,1]},{position:1,color:[1,0,0]}],range:{mode:'fixed',min:0,max:4},outOfRange:'clamp',invalidColor:[0,1,0]},displacement:{amplitude:'amplitude',normalPolicy:'recompute',degenerateNormalPolicy:'error'}});
const bundle=():Bundle=>({version:'0.3',title:'Field',duration:4,units:'bp',viewport:{width:320,height:240},camera:{x:0,y:0,zoom:1},nodes:[],resources:{source:mesh(),arrow:mesh()},tracks:[],relations:[],expressions:{version:1,parameters:{amplitude:{type:'scalar',default:.5,min:0,max:1}},bindings:[]},fieldVisualization:{version:1,operations:[operation()]}});
const code=(run:()=>unknown,expected:string)=>assert.throws(run,(e:any)=>e.diagnostics?.some((d:any)=>d.code===expected));
const near=(a:number,b:number)=>assert.ok(Math.abs(a-b)<1e-12,`${a} != ${b}`);

test('raw scalar, fixed linear colors and original-normal displacement have independent numeric meanings',()=>{
  const b=bundle(),original=JSON.stringify(b),runtime=prepareScene(b),f=runtime.sample(1),r=f.fieldVisualization!.field;
  assert.deepEqual(r.scalar,[1,3,1]);assert.deepEqual(r.validity,[true,true,true]);assert.deepEqual(r.range,{min:0,max:4});assert.equal(r.amplitude,.5);
  assert.deepEqual([...copyMeshAttribute(f.resources.display as MeshResource,'color')],[.25,0,.75,.75,0,.25,.25,0,.75]);
  assert.deepEqual([...copyMeshBuffers(f.resources.display).positions],[0,0,.5,2,0,1.5,0,1,.5]);assert.equal(r.normalOrigin,'recomputed');
  assert.deepEqual(r.sourceNormals,b.resources.source.kind==='mesh'?b.resources.source.normals:undefined);assert.notDeepEqual(r.displayNormals,r.sourceNormals);
  assert.ok(Object.isFrozen(r.scalar));assert.ok(Object.isFrozen(r.displayNormals!.data));assert.equal(JSON.stringify(b),original);
  assert.deepEqual(runtime.sample(1),f);runtime.sample(4);assert.deepEqual(runtime.sample(1),f);
  assert.equal(runtime.manifest.generatedResources!.find(r=>r.id==='display')!.producer,'fieldVisualization');assert.ok(runtime.manifest.features.includes('field.normal-displacement.3d'));
});

test('zero amplitude retains source positions/normals while range and amplitude changes do not rewrite raw fields',()=>{
  const b=bundle(),zero=prepareScene(b).sample(1,{amplitude:0});assert.deepEqual(copyMeshBuffers(zero.resources.display).positions,copyMeshBuffers(b.resources.source).positions);
  assert.equal(zero.fieldVisualization!.field.normalOrigin,'source');assert.deepEqual(zero.fieldVisualization!.field.sourceNormals,zero.fieldVisualization!.field.displayNormals);
  b.fieldVisualization!.operations[0].color!.range={mode:'auto'};const auto=prepareScene(b).sample(1,{amplitude:1});
  assert.deepEqual(auto.fieldVisualization!.field.scalar,zero.fieldVisualization!.field.scalar);assert.deepEqual(auto.fieldVisualization!.field.range,{min:1,max:3});
});

test('explicit mask is lazy; evaluation failures mask into null or raise a located error',()=>{
  const b=bundle(),o=b.fieldVisualization!.operations[0];o.scalar='1/x';o.mask='x>0';delete o.displacement;
  let f=prepareScene(b).sample(0);assert.deepEqual(f.fieldVisualization!.field.scalar,[null,.5,null]);assert.deepEqual(f.fieldVisualization!.field.validity,[false,true,false]);
  delete o.mask;assert.throws(()=>prepareScene(b));o.invalidPolicy='mask';f=prepareScene(b).sample(0);assert.deepEqual(f.fieldVisualization!.field.scalar,[null,.5,null]);
  assert.ok(JSON.stringify(f).includes('null'));assert.ok(!JSON.stringify(f).includes('NaN'));
});

test('presentation range masks keep raw validity and values distinct',()=>{
  const b=bundle(),o=b.fieldVisualization!.operations[0];delete o.displacement;o.color!.range={mode:'fixed',min:0,max:1};o.color!.outOfRange='mask';
  const r=prepareScene(b).sample(0).fieldVisualization!.field;assert.deepEqual(r.scalar,[0,2,0]);assert.deepEqual(r.validity,[true,true,true]);assert.deepEqual(r.mappedValidity,[true,false,true]);
});

test('vector arrows share one prototype, align +X, use display anchors and honor zero/mapping masks',()=>{
  const b=bundle(),o=b.fieldVisualization!.operations[0];o.vector=['-y','x','0'];o.arrows={instanceSetId:'arrows',prototype:'arrow',up:[0,0,1],lengthScale:'0.25',zeroPolicy:'hide'};
  const f=prepareScene(b).sample(1),set=f.instanceSets!.arrows;assert.equal(set.prototypeResourceId,'arrow');assert.equal(set.instances.length,3);assert.equal(set.instances[0].selected,false);
  assert.deepEqual(set.instances[1].color,[.75,0,.25]);assert.deepEqual(set.instances[1].transform!.translation,[2,0,1.5]);
  const tip=transformPoint3D(composeTransform3D(set.instances[1].transform),[1,0,0]);near(tip[0],2);near(tip[1],.5);near(tip[2],1.5);
  const ids=set.instances.map(i=>i.id);assert.deepEqual(prepareScene(b).sample(2).instanceSets!.arrows.instances.map(i=>i.id),ids);
  o.color!.range={mode:'fixed',min:0,max:1};o.color!.outOfRange='mask';assert.equal(prepareScene(b).sample(1).instanceSets!.arrows.instances[1].selected,false);
  o.arrows.color=[1,1,1];o.arrows.zeroPolicy='identity';delete o.color;assert.equal(prepareScene(b).sample(1).instanceSets!.arrows.instances[0].selected,true);
});

test('normal locals and displacement require original normals; unused normals impose no requirement',()=>{
  const b=bundle(),o=b.fieldVisualization!.operations[0];delete (b.resources.source as MeshResource).normals;delete o.displacement;
  assert.doesNotThrow(()=>prepareScene(b));o.scalar='nx';code(()=>prepareScene(b),'FIELD_VISUALIZATION_NORMALS');o.scalar='x';o.displacement={amplitude:'0',normalPolicy:'drop',degenerateNormalPolicy:'error'};code(()=>prepareScene(b),'FIELD_VISUALIZATION_NORMALS');
});

test('ordered field outputs feed later fields and generic instances in the same sample',()=>{
  const b=bundle();b.fieldVisualization!.operations.push({id:'next',source:'display',resourceId:'next-display',units:'unit',scalar:'z',invalidPolicy:'error'});
  b.instances={version:1,operations:[{id:'generic',source:{kind:'mesh',resourceId:'next-display',domain:'vertex'},prototype:'arrow',seed:2,units:'unit'}]};
  const f=prepareScene(b).sample(2);assert.deepEqual(f.fieldVisualization!.next.scalar,[1,2,1]);assert.deepEqual(f.instanceSets!.generic.instances[1].transform!.translation,[2,0,2]);
  const standalone=prepareInstanceProgram(b.instances,b);assert.deepEqual(standalone.sample(2).instanceSets.generic,f.instanceSets!.generic);
});

test('generated surfaces and attributes are resampled by standalone field and instance preparation',()=>{
  const b=bundle();b.surfaces={version:1,operations:[{id:'surface',resourceId:'surface',units:'unit',domain:{u:[0,1],v:[0,1]},segments:{u:1,v:1},position:['u','v','time/1s'],normals:{kind:'analytic',dU:['1','0','0'],dV:['0','1','0']}}]};
  b.meshAttributes={version:1,operations:[{id:'attrs',source:'surface',resourceId:'attrs',units:'unit',steps:[{kind:'capture',name:'height',domain:'vertex',valueType:'scalar',expression:'z'}]}]};b.fieldVisualization!.operations[0].source='attrs';b.fieldVisualization!.operations[0].scalar='z';
  assert.deepEqual(validateBundle(b),[]);const f=prepareFieldVisualizationProgram(b.fieldVisualization!,b).sample(2);assert.deepEqual(f.fieldVisualization.field.scalar,[2,2,2,2]);
  assert.ok([...copyMeshBuffers(f.resources.display).positions].filter((_,i)=>i%3===2).every(v=>v===3));
  assert.doesNotThrow(()=>prepareSurfaceProgram(b.surfaces!,b));assert.doesNotThrow(()=>prepareMeshAttributeProgram(b.meshAttributes!,b));assert.deepEqual(validateExpressionProgram(b.expressions!,b),[]);
  b.curves3d={version:1,operations:[],followers:[]};assert.doesNotThrow(()=>prepareCurveProgram3D(b.curves3d!,b));
});

test('schema rejects forward sources, resource/set collisions, wrong units and ambiguous expression controls',()=>{
  const changes:[(b:Bundle)=>void,string][]=[
    [b=>b.fieldVisualization!.operations[0].source='future','FIELD_VISUALIZATION_SOURCE'],
    [b=>b.fieldVisualization!.operations[0].resourceId='source','FIELD_VISUALIZATION_RESOURCE'],
    [b=>b.fieldVisualization!.operations[0].units='cm','FIELD_VISUALIZATION_UNITS'],
    [b=>b.fieldVisualization!.operations[0].mask='1','FIELD_VISUALIZATION_EXPRESSION_TYPE'],
    [b=>b.fieldVisualization!.operations[0].displacement!.amplitude='x','EXPRESSION_IDENTIFIER'],
    [b=>b.expressions!.parameters.x={type:'scalar',default:1},'FIELD_VISUALIZATION_PARAMETER_SHADOW'],
    [b=>(b.fieldVisualization!.operations[0].color as any).attribute='__proto__','FIELD_VISUALIZATION_ATTRIBUTE'],
  ];
  for(const [change,expected] of changes){const b=bundle();change(b);assert.ok(validateFieldVisualizationProgram(b.fieldVisualization,b).some(d=>d.code===expected),expected);}
  const b=bundle(),o=b.fieldVisualization!.operations[0];o.vector=['1','0','0'];o.arrows={instanceSetId:'same',prototype:'arrow',up:[0,0,1],lengthScale:'1',zeroPolicy:'hide'};
  b.instances={version:1,operations:[{id:'same',source:{kind:'points',points:[]},prototype:'arrow',seed:1,units:'unit'}]};assert.ok(validateBundle(b).some(d=>d.code==='FIELD_VISUALIZATION_INSTANCE_ID'));
});

test('input and supplied-resource descriptors are inspected before any getter or clone',()=>{
  const b=bundle();let reads=0;const raw:any=structuredClone(b.fieldVisualization);Object.defineProperty(raw.operations[0],'source',{enumerable:true,get(){reads++;throw Error('read');}});
  assert.ok(validateFieldVisualizationProgram(raw,b).some(d=>d.severity==='error'));assert.equal(reads,0);
  const prepared=prepareFieldVisualizationProgram(b.fieldVisualization!,b),generated:any={};Object.defineProperty(generated,'trap',{enumerable:true,get(){reads++;throw Error('read');}});
  assert.throws(()=>prepared.sample(0,undefined,generated));assert.equal(reads,0);
});

test('field budgets include hidden arrows and combine with generic sets before spatial rendering',()=>{
  const b=bundle(),source=mesh(),count=4096;source.positions=buffer(Array(count*3).fill(0),3);source.normals=buffer(Array.from({length:count*3},(_,i)=>i%3===2?1:0),3);source.bounds={min:[0,0,0],max:[0,0,0]};b.resources.source=source;
  b.fieldVisualization!.operations=[{id:'field',source:'source',resourceId:'display',units:'unit',vector:['0','0','0'],invalidPolicy:'error',arrows:{instanceSetId:'arrows',prototype:'arrow',up:[0,0,1],lengthScale:'1',zeroPolicy:'hide'}}];
  b.instances={version:1,operations:[{id:'other',prototype:'arrow',units:'unit',seed:0,source:{kind:'points',points:[{id:'one',position:[0,0,0]}]}}]};
  code(()=>prepareScene(b),'INSTANCE_BUDGET');code(()=>prepareInstanceProgram(b.instances!,b),'INSTANCE_BUDGET');
  source.positions=buffer(Array(65537*3).fill(0),3);delete source.normals;delete b.instances;delete b.fieldVisualization!.operations[0].arrows;
  assert.ok(validateBundle(b).some(d=>d.code==='FIELD_VISUALIZATION_BUDGET'));
  const excessive=bundle();excessive.fieldVisualization!.operations=Array.from({length:17},(_,i)=>({...operation(),id:`f${i}`,resourceId:`r${i}`}));assert.ok(validateBundle(excessive).some(d=>d.code==='FIELD_VISUALIZATION_BUDGET'));
});

test('arrow identities change with source topology but remain independent of field values',()=>{
  const b=bundle(),o=b.fieldVisualization!.operations[0];o.vector=['1','0','0'];o.arrows={instanceSetId:'arrows',prototype:'arrow',up:[0,0,1],lengthScale:'1',zeroPolicy:'hide'};
  const before=prepareScene(b).sample(0).instanceSets!.arrows.instances.map(i=>i.id);
  (b.resources.source as MeshResource).topologyRevision='new-topology';const after=prepareScene(b).sample(0).instanceSets!.arrows.instances.map(i=>i.id);assert.notDeepEqual(after,before);
});

test('field expression diagnostics preserve component source spans and stable field paths',()=>{
  const b=bundle(),o=b.fieldVisualization!.operations[0],span={file:'lecture.tex',start:{line:20,column:5},end:{line:20,column:8}};delete o.displacement;delete o.color;o.scalar='1/x';o.expressionSpans={scalar:span};
  assert.throws(()=>prepareScene(b),(e:any)=>e.diagnostics?.some((d:any)=>d.path==='$.fieldVisualization.operations[0].scalar'&&d.sourceSpan.file==='lecture.tex'&&d.sourceSpan.start.line===20));
});
