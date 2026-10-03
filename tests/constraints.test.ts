import test from 'node:test';
import assert from 'node:assert/strict';
import {constraintOperatorDefinitions, executeConstraintOperation, isConstraintOperator} from '../src/operations/constraints.ts';
import {executeAuthoredOperation, requireAuthoredImplementation} from '../src/operations/builtins/authored.ts';
import {defaultOperatorRegistry} from '../src/operations/registry.ts';
import {createEvaluator} from '../src/evaluate.ts';
import {validateBundle, type Bundle, type GroupNode, type PointNode, type TexNode} from '../src/schema.ts';
import {nodePosition} from '../src/geometry/spaces.ts';
import {worldMatrix} from '../src/geometry.ts';
import {renderSvg} from '../src/render-svg.ts';
import type {InputRef, LiteralValue, Operation, SpaceRef} from '../src/ir/operations.ts';

const scene = {kind:'scene'} as const;
const local = (node:string):SpaceRef => ({kind:'local', node});
const parent = (node:string):SpaceRef => ({kind:'parent', node});
const scalar = (value:number, unit:'1'|'rad'|'bp'='1'):LiteralValue => ({type:'scalar', value, unit});
const point = (value:[number,number], space:SpaceRef=scene):LiteralValue => ({type:'vec2', role:'point', space, value});
const vector = (value:[number,number], space:SpaceRef=scene):LiteralValue => ({type:'vec2', role:'vector', space, value});
const literal = (value:LiteralValue):InputRef => ({kind:'literal', value});
const output = (operation:string, socket:string):InputRef => ({kind:'output', ref:{operation, socket}});
const span = {file:'updates.tex', start:{line:7,column:2}, end:{line:7,column:70}};
const operation = (operator:string, spaces:Record<string,SpaceRef>=operator==='thresholdOpacity'?{}:{space:scene}):Operation =>
  ({id:'constraint', operator, version:1, spaces, inputs:{}, sourceSpan:span});
const run = (operator:string, inputs:Record<string,LiteralValue>, spaces?:Record<string,SpaceRef>) =>
  executeConstraintOperation(operation(operator, spaces), inputs)!;
const near = (actual:number, expected:number, tolerance=1e-12) =>
  assert.ok(Number.isFinite(actual) && Math.abs(actual-expected)<=tolerance, `${actual} != ${expected}`);
const components = (literal:LiteralValue):[number,number] => {
  assert.equal(literal.type,'vec2');return literal.value as [number,number];
};

test('constraint operators expose explicit typed contracts through the immutable default registry',()=>{
  assert.deepEqual(constraintOperatorDefinitions.map(x=>x.name), ['followPoint','alignDirection','lookAt','thresholdOpacity','transformVector']);
  for (const definition of constraintOperatorDefinitions) {
    assert.equal(definition.version,1);assert.equal(definition.pure,true);assert.equal(definition.deterministic,true);
    assert.ok(Object.values(definition.inputs).every(input=>input.required===true && !Object.hasOwn(input,'default')));
    const registered=defaultOperatorRegistry.get(definition.name,1)!;
    assert.deepEqual(registered,definition);assert.ok(Object.isFrozen(registered));assert.ok(Object.isFrozen(registered.inputs));
    assert.throws(()=>{(registered as any).inputs={};},TypeError);
    requireAuthoredImplementation(definition.name,1);
  }
  assert.deepEqual(defaultOperatorRegistry.get('alignDirection',1)!.inputs.fallbackAngle.value,{type:'scalar',unit:'rad'});
  assert.deepEqual(defaultOperatorRegistry.get('thresholdOpacity',1)!.outputs.opacity,{type:'scalar',unit:'1'});
  assert.equal(isConstraintOperator('lookAt',2),false);
  assert.equal(executeConstraintOperation({...operation('lookAt'),version:2},{}),undefined);
  assert.equal(executeConstraintOperation(operation('notRegistered'),{}),undefined);
});

test('followPoint adds the full offset vector and returns detached coordinates and space identities',()=>{
  const chart=local('plot'), op=operation('followPoint',{space:chart});
  const inputs={point:point([8,-3],chart),offset:vector([2,7],chart)},original=structuredClone({op,inputs});
  const result=executeAuthoredOperation(op,inputs);
  assert.deepEqual(result.position,point([10,4],chart));
  components(result.position)[0]=999;
  if(result.position.type==='vec2')result.position.space=scene;
  assert.deepEqual({op,inputs},original);
  assert.deepEqual(executeAuthoredOperation(op,inputs).position,point([10,4],chart));
  assert.throws(()=>run('followPoint',{point:point([Number.MAX_VALUE,0]),offset:vector([Number.MAX_VALUE,0])}),/OPERATION_NONFINITE_OUTPUT/);
});

test('alignDirection uses the supplied chart axes and an explicit exact-zero fallback without history',()=>{
  for(const [x,y,angle] of [[1,0,0],[0,1,Math.PI/2],[-1,0,Math.PI],[0,-1,-Math.PI/2],[3,4,Math.atan2(4,3)]]) {
    const result=run('alignDirection',{direction:vector([x,y]),fallbackAngle:scalar(.25,'rad')});
    near(result.angle.value as number,angle);assert.deepEqual(result.valid,scalar(1));
  }
  assert.deepEqual(run('alignDirection',{direction:vector([0,-0]),fallbackAngle:scalar(13,'rad')}),
    {angle:scalar(13,'rad'),valid:scalar(0)});
  const tiny=run('alignDirection',{direction:vector([Number.MIN_VALUE,0]),fallbackAngle:scalar(13,'rad')});
  assert.deepEqual(tiny,{angle:scalar(0,'rad'),valid:scalar(1)});
  const before=run('alignDirection',{direction:vector([0,0]),fallbackAngle:scalar(-.75,'rad')});
  run('alignDirection',{direction:vector([1,9]),fallbackAngle:scalar(-.75,'rad')});
  assert.deepEqual(run('alignDirection',{direction:vector([0,0]),fallbackAngle:scalar(-.75,'rad')}),before);
});

test('lookAt produces normalized direction and angle and uses the authored fallback for coincident points',()=>{
  const result=run('lookAt',{from:point([2,3]),to:point([5,7]),fallbackAngle:scalar(2,'rad')});
  near(result.angle.value as number,Math.atan2(4,3));
  const direction=components(result.direction);near(direction[0],.6);near(direction[1],.8);
  assert.deepEqual(result.valid,scalar(1));
  const fallback=run('lookAt',{from:point([2,3]),to:point([2,3]),fallbackAngle:scalar(.7,'rad')});
  assert.deepEqual(fallback.angle,scalar(.7,'rad'));assert.deepEqual(fallback.valid,scalar(0));
  near(components(fallback.direction)[0],Math.cos(.7));near(components(fallback.direction)[1],Math.sin(.7));
});

test('orientation remains finite for huge vectors, overflowing endpoint gaps and subnormal directions',()=>{
  const max=Number.MAX_VALUE,min=Number.MIN_VALUE;
  for(const [from,to,expected] of [
    [[-max,-max],[max,max],[Math.SQRT1_2,Math.SQRT1_2]],
    [[max,max],[-max,max],[-1,0]],
    [[0,0],[min,min],[Math.SQRT1_2,Math.SQRT1_2]],
    [[max,0],[max,min],[0,1]],
  ] as [number[],number[],number[]][]) {
    const result=run('lookAt',{from:point(from as [number,number]),to:point(to as [number,number]),fallbackAngle:scalar(0,'rad')});
    const value=components(result.direction);near(value[0],expected[0]);near(value[1],expected[1]);near(Math.hypot(...value),1);
    assert.equal(result.valid.value,1);near(result.angle.value as number,Math.atan2(expected[1],expected[0]));
  }
  near(run('alignDirection',{direction:vector([max,max]),fallbackAngle:scalar(0,'rad')}).angle.value as number,Math.PI/4);
});

test('thresholdOpacity has an inclusive boundary and emits only dimensionless zero or one',()=>{
  for(const [value,threshold,expected] of [[-2,-1,0],[-1,-1,1],[0,0,1],[.499,.5,0],[.5,.5,1],[1,.5,1]])
    assert.deepEqual(run('thresholdOpacity',{value:scalar(value),threshold:scalar(threshold)}),{opacity:scalar(expected)});
  assert.deepEqual(run('thresholdOpacity',{value:scalar(-Number.MAX_VALUE),threshold:scalar(Number.MAX_VALUE)}),{opacity:scalar(0)});
});

test('transformVector carries the full affine linear part between spaces while ignoring translation',()=>{
  const from=local('source'),to=parent('arrow'),op=operation('transformVector',{from,to});
  const inputs={vector:vector([3,4],from),transform:{type:'transform2d',from,to,value:[0,-2,-3,0,100,-500]} as LiteralValue};
  const original=structuredClone(inputs),result=executeAuthoredOperation(op,inputs);
  assert.deepEqual(result.vector,vector([-12,-6],to));assert.deepEqual(inputs,original);
  components(result.vector)[0]=42;assert.deepEqual(executeAuthoredOperation(op,inputs).vector,vector([-12,-6],to));
  const singular={...inputs,transform:{type:'transform2d',from,to,value:[0,0,0,0,Number.MAX_VALUE,Number.MAX_VALUE]} as LiteralValue};
  assert.deepEqual(executeAuthoredOperation(op,singular).vector,vector([0,0],to));
  const overflow={...inputs,transform:{type:'transform2d',from,to,value:[Number.MAX_VALUE,0,0,1,0,0]} as LiteralValue};
  assert.throws(()=>executeAuthoredOperation(op,overflow),/OPERATION_NONFINITE_OUTPUT/);
});

test('direct execution rejects malformed inputs, units, roles, coordinate spaces and accessors with source locations',()=>{
  const op=operation('alignDirection'),good={direction:vector([1,0]),fallbackAngle:scalar(0,'rad')};
  for(const bad of [{fallbackAngle:scalar(0)},{direction:point([1,0])},{direction:vector([1,0],local('other'))},
    {direction:vector([NaN,0])},{direction:vector([Infinity,0])},{fallbackAngle:scalar(Infinity,'rad')},
    {surprise:scalar(1)},{fallbackAngle:undefined}]) {
    assert.throws(()=>executeConstraintOperation(op,{...good,...bad} as any),(error:any)=>{
      assert.deepEqual(error.diagnostics[0].sourceSpan,span);assert.match(error.diagnostics[0].path,/constraint/);return true;
    });
  }
  assert.throws(()=>executeConstraintOperation(op,{direction:good.direction}),/Missing required input fallbackAngle/);
  assert.throws(()=>executeConstraintOperation(op,null as any),/input record/);
  assert.throws(()=>executeConstraintOperation({...op,spaces:{}},good),/coordinate space/);
  assert.throws(()=>executeConstraintOperation({...op,spaces:{space:scene,extra:scene}},good),/Unknown coordinate space/);
  let reads=0;const accessor={...good};Object.defineProperty(accessor,'direction',{get(){reads++;return good.direction;},enumerable:true});
  assert.throws(()=>executeConstraintOperation(op,accessor),/NON_JSON_VALUE/);assert.equal(reads,0);
  assert.throws(()=>run('thresholdOpacity',{value:scalar(1,'bp'),threshold:scalar(1)}),/OPERATION_RUNTIME_UNIT/);
  assert.throws(()=>run('thresholdOpacity',{value:scalar(1)}),/Missing required input threshold/);
  assert.throws(()=>run('transformVector',{vector:vector([1,0]),transform:{type:'transform2d',from:scene,to:local('wrong'),value:[1,0,0,1,0,0]}},
    {from:scene,to:scene}),/OPERATION_RUNTIME_SPACE/);
});

function fixture():Bundle {
  return {version:'0.3',title:'Declarative updates',duration:2,units:'bp',viewport:{width:400,height:300},camera:{x:0,y:0,zoom:1},
    resources:{label:{kind:'vector',metrics:{width:5,height:5,depth:0},inkBounds:[0,-5,5,5],items:[{kind:'path',d:'M0 0L5 -5'}]}},
    nodes:[{id:'P',kind:'point',x:0,y:0,r:2},
      {id:'parent',kind:'group',transform:{translate:[30,40],rotate:Math.PI/2,scale:[-2,3]}},
      {id:'label',kind:'tex',parent:'parent',resourceId:'label',x:0,y:0},
      {id:'arrow',kind:'group',parent:'parent'},
      {id:'arrowInk',kind:'line',parent:'arrow',x1:0,y1:0,x2:10,y2:0}],
    tracks:[{target:'P',property:'x',keys:[[0,0],[2,20]]},{target:'P',property:'y',keys:[[0,0],[2,10]]}],relations:[],
    operationGraph:{version:1,operations:[
      {...operation('thresholdOpacity'),id:'visible',inputs:{value:{kind:'expression',expression:'time/1s',unit:'1'},threshold:literal(scalar(1))}},
      {...operation('alignDirection',{space:parent('arrow')}),id:'align',inputs:{direction:output('transport','vector'),fallbackAngle:literal(scalar(0,'rad'))}},
      {...operation('followPoint'),id:'follow',inputs:{point:{kind:'node',node:'P',property:'position',space:scene},offset:literal(vector([5,-7]))}},
      {...operation('transformVector',{from:scene,to:parent('arrow')}),id:'transport',inputs:{vector:literal(vector([1,0])),
        transform:{kind:'spaceTransform',from:scene,to:parent('arrow')}}},
    ],bindings:[{target:'label',property:'position',value:{operation:'follow',socket:'position'}},
      {target:'arrow',property:'transform.rotate',value:{operation:'align',socket:'angle'}},
      {target:'label',property:'style.opacity',value:{operation:'visible',socket:'opacity'}}]}};
}

test('graph composition follows moving nodes, transports directions through reflected parents and thresholds visibility',()=>{
  const bundle=fixture(),evaluate=createEvaluator(bundle);
  assert.deepEqual(validateBundle(bundle),[]);
  for(const time of [0,.5,.999,1,1.5,2]) {
    const frame=evaluate(time),nodes=new Map(frame.nodes.map(node=>[node.id,node]));
    const position=nodePosition('label',scene,nodes);near(position[0],10*time+5);near(position[1],5*time-7);
    const matrix=worldMatrix('arrow',nodes),length=Math.hypot(matrix[0],matrix[1]);near(matrix[0]/length,1);near(matrix[1]/length,0);
    assert.equal(nodes.get('label')!.style!.opacity,time>=1?1:0);
  }
});

test('constraint graphs remain seek-independent, order-independent and detached from mutable callers and frames',()=>{
  const bundle=fixture(),evaluate=createEvaluator(bundle),first=evaluate(.75),original=structuredClone(first),svg=renderSvg(first);
  evaluate(2);evaluate(.125);assert.deepEqual(evaluate(.75),original);
  const reversed=fixture();reversed.operationGraph!.operations.reverse();reversed.operationGraph!.bindings.reverse();
  assert.equal(renderSvg(createEvaluator(reversed)(.75)),svg);
  (first.nodes.find(node=>node.id==='label') as TexNode).x=999;
  (bundle.nodes[0] as PointNode).x=999;bundle.tracks[0].keys[1][1]=999;
  assert.deepEqual(evaluate(.75),original);
});

test('lookAt composes anchor reads and output references while its coincident fallback can control visibility',()=>{
  const bundle=fixture();bundle.nodes.push({id:'A',kind:'group',anchors:{center:[0,0]}},{id:'B',kind:'group',anchors:{center:[3,4]}});
  bundle.operationGraph!.operations=[
    {...operation('thresholdOpacity'),id:'visible',inputs:{value:output('look','valid'),threshold:literal(scalar(.5))}},
    {...operation('lookAt'),id:'look',inputs:{from:{kind:'anchor',source:{kind:'node',node:'A'},query:{kind:'named',name:'center'},space:scene},
      to:{kind:'anchor',source:{kind:'node',node:'B'},query:{kind:'named',name:'center'},space:scene},fallbackAngle:literal(scalar(.4,'rad'))}},
  ];
  bundle.operationGraph!.bindings=[{target:'label',property:'style.opacity',value:{operation:'visible',socket:'opacity'}},
    {target:'P',property:'transform.rotate',value:{operation:'look',socket:'angle'}}];
  const frame=createEvaluator(bundle)(0);near(frame.nodes[0].transform!.rotate!,Math.atan2(4,3));assert.equal(frame.nodes[2].style!.opacity,1);
  (bundle.nodes.find(node=>node.id==='B') as GroupNode).anchors!.center=[0,0];
  const empty=createEvaluator(bundle)(0);near(empty.nodes[0].transform!.rotate!,.4);assert.equal(empty.nodes[2].style!.opacity,0);
});

test('existing preparation rejects cyclic reads, conflicting writers and wrong units for constraint operations',()=>{
  const cycle=fixture();cycle.operationGraph!.operations.find(op=>op.id==='follow')!.inputs.point={kind:'node',node:'label',property:'position',space:scene};
  assert.throws(()=>createEvaluator(cycle),/CYCLE/);
  const conflict=fixture();conflict.tracks.push({target:'label',property:'x',keys:[[0,0],[2,20]]});
  assert.throws(()=>createEvaluator(conflict),/WRITER|CONFLICT/);
  const unit=fixture();unit.operationGraph!.operations.find(op=>op.id==='align')!.inputs.fallbackAngle=literal(scalar(0));
  assert.ok(validateBundle(unit).some(d=>d.code.includes('UNIT')));
  const missing=fixture();delete missing.operationGraph!.operations.find(op=>op.id==='align')!.inputs.fallbackAngle;
  assert.ok(validateBundle(missing).some(d=>d.message.includes('fallbackAngle')));
});
