import test from 'node:test';
import assert from 'node:assert/strict';
import {coordinateOperatorDefinitions,executeCoordinateOperation} from '../src/operations/coordinates.ts';
import {sameSpace,spaceMatrix,spaceTransform,spaceTransformReads,nodePosition,nodePositionReads} from '../src/geometry/spaces.ts';
import {transformPoint} from '../src/geometry.ts';
import type {LiteralValue,Operation,SpaceRef} from '../src/ir/operations.ts';
import type {Node} from '../src/schema.ts';

const scene:SpaceRef={kind:'scene'};
const p=(value:[number,number],space:SpaceRef=scene):LiteralValue=>({type:'vec2',role:'point',space,value});
const s=(value:number,unit:'1'|'bp'|'rad'='1'):LiteralValue=>({type:'scalar',unit,value});
function run(name:string,inputs:Record<string,LiteralValue>,space:SpaceRef=scene) {
  const op:Operation={id:'calculation',operator:name,version:1,spaces:{space},inputs:{},
    sourceSpan:{file:'coordinates.tex',start:{line:4,column:1},end:{line:4,column:50}}};
  return executeCoordinateOperation(op,inputs)!;
}
function position(result:Record<string,LiteralValue>):[number,number] {
  assert.equal(result.position.type,'vec2');return result.position.value as [number,number];
}
const near=(actual:readonly number[],expected:readonly number[],tolerance=1e-10)=>{
  assert.equal(actual.length,expected.length);actual.forEach((value,i)=>assert.ok(Number.isFinite(value)&&Math.abs(value-expected[i])<=tolerance,`${actual} != ${expected}`));
};
function nodes():Map<string,Node> {return new Map<string,Node>([
  ['A',{id:'A',kind:'group',transform:{translate:[10,20],rotate:Math.PI/2,scale:[-2,3]}}],
  ['B',{id:'B',kind:'group',transform:{translate:[-4,6],scale:[2,-1]}}],
  ['P',{id:'P',kind:'point',parent:'A',transform:{translate:[2,-1]},x:3,y:4,r:1}],
  ['E',{id:'E',kind:'ellipse',parent:'A',cx:-1,cy:2,rx:1,ry:2}],
  ['T',{id:'T',kind:'tex',parent:'B',resourceId:'label',x:5,y:7}],
]);}

test('coordinate metadata declares exact v1 operations and scalar dimensions',()=>{
  assert.deepEqual(coordinateOperatorDefinitions.map(d=>d.name),['midpoint','lerpPoint','pointTowards','rotatePoint','projectLine','projectSegment']);
  assert.deepEqual(coordinateOperatorDefinitions.find(d=>d.name==='lerpPoint')!.inputs.factor.default,s(.5));
  assert.deepEqual(coordinateOperatorDefinitions.find(d=>d.name==='pointTowards')!.inputs.distance.value,{type:'scalar',unit:'bp'});
  assert.deepEqual(coordinateOperatorDefinitions.find(d=>d.name==='rotatePoint')!.inputs.angle.value,{type:'scalar',unit:'rad'});
  for(const definition of coordinateOperatorDefinitions){assert.equal(definition.version,1);assert.equal(definition.pure,true);assert.equal(definition.deterministic,true);}
});

test('midpoint and affine interpolation support extrapolation without mutating input literals',()=>{
  const inputs={a:p([2,4]),b:p([8,10]),factor:s(.25)},snapshot=structuredClone(inputs);
  near(position(run('midpoint',inputs)),[5,7]);near(position(run('lerpPoint',inputs)),[3.5,5.5]);
  near(position(run('lerpPoint',{...inputs,factor:s(1.5)})),[11,13]);
  near(position(run('lerpPoint',{...inputs,factor:s(-1)})),[-4,-2]);assert.deepEqual(inputs,snapshot);
  assert.deepEqual(position(run('midpoint',{a:p([Number.MAX_VALUE,-Number.MAX_VALUE]),b:p([Number.MAX_VALUE,Number.MAX_VALUE])})),[Number.MAX_VALUE,0]);
  assert.equal(position(run('midpoint',{a:p([Number.MIN_VALUE,0]),b:p([Number.MIN_VALUE,0])}))[0],Number.MIN_VALUE);
});

test('pointTowards measures signed Euclidean bp distance along the declared-space baseline',()=>{
  const inputs={a:p([1,2]),b:p([4,6]),distance:s(10,'bp')};
  near(position(run('pointTowards',inputs)),[7,10]);near(position(run('pointTowards',{...inputs,distance:s(-5,'bp')})),[-2,-2]);
  near(position(run('pointTowards',{...inputs,distance:s(0,'bp')})),[1,2]);
  const tiny=run('pointTowards',{a:p([0,0]),b:p([1e-300,0]),distance:s(2,'bp')});near(position(tiny),[2,0]);
  const subnormal=run('pointTowards',{a:p([0,0]),b:p([Number.MIN_VALUE,Number.MIN_VALUE]),distance:s(1,'bp')});near(position(subnormal),[Math.SQRT1_2,Math.SQRT1_2]);
  const huge=run('pointTowards',{a:p([-Number.MAX_VALUE,0]),b:p([Number.MAX_VALUE,0]),distance:s(Number.MAX_VALUE,'bp')});near(position(huge),[0,0]);
});

test('rotation is in radians around an explicit center in the same space',()=>{
  near(position(run('rotatePoint',{point:p([3,1]),center:p([1,1]),angle:s(Math.PI/2,'rad')})),[1,3]);
  near(position(run('rotatePoint',{point:p([3,1]),center:p([1,1]),angle:s(-Math.PI/2,'rad')})),[1,-1]);
  near(position(run('rotatePoint',{point:p([3,1]),center:p([1,1]),angle:s(0,'rad')})),[3,1]);
});

test('projection distinguishes unbounded line parameters from clamped segment parameters',()=>{
  const inputs={point:p([5,6]),a:p([1,2]),b:p([3,2])};
  const line=run('projectLine',inputs),segment=run('projectSegment',inputs);
  near(position(line),[5,2]);assert.deepEqual(line.parameter,s(2));
  near(position(segment),[3,2]);assert.deepEqual(segment.parameter,s(1));
  const before={...inputs,point:p([-1,-20])};assert.deepEqual(run('projectLine',before).parameter,s(-1));
  near(position(run('projectSegment',before)),[1,2]);
  const angled=run('projectLine',{point:p([2,0]),a:p([0,0]),b:p([2,2])});near(position(angled),[1,1]);near([angled.parameter.value as number],[.5]);
});

test('zero-length constructions, units, point roles and nonfinite outputs have located diagnostics',()=>{
  for(const name of ['pointTowards','projectLine','projectSegment'])assert.throws(()=>run(name,{a:p([1,1]),b:p([1,1]),point:p([3,4]),distance:s(0,'bp')}),(error:any)=>{
    assert.equal(error.diagnostics[0].code,'COORDINATE_DEGENERATE');assert.equal(error.diagnostics[0].sourceSpan.file,'coordinates.tex');return true;
  });
  assert.throws(()=>run('pointTowards',{a:p([0,0]),b:p([1,0]),distance:s(2)}),/OPERATION_RUNTIME_UNIT/);
  assert.throws(()=>run('rotatePoint',{point:p([1,0]),center:p([0,0]),angle:s(90)}),/OPERATION_RUNTIME_UNIT/);
  assert.throws(()=>run('midpoint',{a:{type:'vec2',role:'vector',space:scene,value:[0,0]},b:p([1,0])}),/OPERATION_RUNTIME_TYPE/);
  assert.throws(()=>run('midpoint',{a:p([Infinity,0]),b:p([1,0])}),/OPERATION_DOMAIN/);
  assert.throws(()=>run('lerpPoint',{a:p([0,0]),b:p([Number.MAX_VALUE,0]),factor:s(2)}),/OPERATION_NONFINITE_OUTPUT/);
});

test('output spaces are detached and exact names/versions stay within closed dispatch',()=>{
  const space:SpaceRef={kind:'plot',node:'chart'},result=run('midpoint',{a:p([0,0],space),b:p([2,2],space)},space);
  assert.equal(result.position.type,'vec2');if(result.position.type==='vec2')assert.deepEqual(result.position.space,space);
  space.node='changed';if(result.position.type==='vec2')assert.deepEqual(result.position.space,{kind:'plot',node:'chart'});
  assert.throws(()=>run('midpoint',{a:p([0,0]),b:p([2,2],{kind:'local',node:'A'})}),/OPERATION_RUNTIME_SPACE/);
  for(const [name,version] of [['missing',1],['midpoint',2]] as const)
    assert.equal(executeCoordinateOperation({id:'x',operator:name,version,spaces:{space:scene},inputs:{}},{}),undefined);
});

test('local, parent and plot identities remain distinct even for identical matrices',()=>{
  assert.equal(sameSpace(undefined,undefined),true);assert.equal(sameSpace(scene,undefined),false);
  assert.equal(sameSpace({kind:'parent',node:'P'},{kind:'local',node:'A'}),false);
  assert.equal(sameSpace({kind:'plot',node:'A'},{kind:'local',node:'A'}),false);
  assert.equal(sameSpace({kind:'plot',node:'A'},{kind:'plot',node:'A'}),true);
  assert.equal(sameSpace({kind:'parent',node:'A'},{kind:'parent',node:'B'}),false);
  const map=nodes();near(spaceMatrix({kind:'parent',node:'P'},map),spaceMatrix({kind:'local',node:'A'},map));
  near(spaceMatrix({kind:'plot',node:'A'},map),spaceMatrix({kind:'local',node:'A'},map));
  near(spaceMatrix({kind:'parent',node:'A'},map),[1,0,0,1,0,0]);
});

test('node positions and matrices convert through reflected, rotated, nonuniform parent spaces',()=>{
  const map=nodes();near(nodePosition('P',scene,map),[1,10]);
  near(nodePosition('P',{kind:'local',node:'P'},map),[3,4]);near(nodePosition('P',{kind:'parent',node:'P'},map),[5,3]);
  near(nodePosition('P',{kind:'local',node:'B'},map),[2.5,-4]);near(nodePosition('E',scene,map),[4,22]);
  near(nodePosition('T',scene,map),[6,-1]);
  const matrix=spaceTransform({kind:'local',node:'P'},{kind:'plot',node:'B'},map);near(transformPoint(matrix,[3,4]),[2.5,-4]);
  map.get('B')!.transform!.translate=[6,6];near(nodePosition('P',{kind:'local',node:'B'},map),[-2.5,-4]);
});

test('read dependencies match position properties and exactly consumed transform ancestors',()=>{
  const map=nodes();assert.deepEqual(spaceTransformReads(scene,map),[]);
  assert.deepEqual(spaceTransformReads({kind:'parent',node:'P'},map),[{node:'A',property:'transform'}]);
  assert.deepEqual(spaceTransformReads({kind:'parent',node:'A'},map),[]);
  assert.deepEqual(nodePositionReads('P',{kind:'local',node:'B'},map),[
    {node:'P',property:'x'},{node:'P',property:'y'},{node:'P',property:'transform'},
    {node:'A',property:'transform'},{node:'B',property:'transform'},
  ]);
  assert.deepEqual(nodePositionReads('E',scene,map).slice(0,2),[{node:'E',property:'cx'},{node:'E',property:'cy'}]);
  assert.equal(nodePositionReads('P',{kind:'parent',node:'P'},map).filter(read=>read.node==='A').length,1);
  assert.ok(nodePositionReads('P',scene,map).every(read=>read.node!=='$camera'));
});

test('scene conversion excludes viewing camera data and accepts singular source forward maps',()=>{
  const map=nodes();map.set('S',{id:'S',kind:'group',transform:{translate:[5,6],scale:[0,2]}});
  const before=spaceMatrix(scene,map);map.set('$camera',{id:'$camera',kind:'group',transform:{translate:[100,200],rotate:2,scale:[10,10]}});
  assert.deepEqual(spaceMatrix(scene,map),before);near(nodePosition('P',scene,map),[1,10]);
  near(transformPoint(spaceTransform({kind:'local',node:'S'},scene,map),[10,3]),[5,12]);
  assert.throws(()=>spaceTransform(scene,{kind:'local',node:'S'},map),/SINGULAR_TRANSFORM/);
  assert.throws(()=>spaceTransform({kind:'local',node:'S'},{kind:'local',node:'S'},map),/SINGULAR_TRANSFORM/);
});

test('invalid chart nodes, hierarchy cycles, missing nodes and nonfinite positions fail explicitly',()=>{
  const map=nodes();assert.throws(()=>spaceMatrix({kind:'plot',node:'P'},map),/OPERATION_PLOT_SPACE/);
  assert.throws(()=>spaceMatrix({kind:'parent',node:'missing'},map),/OPERATION_SPACE_REFERENCE/);
  assert.throws(()=>nodePosition('A',scene,map),/OPERATION_NODE_POSITION/);
  (map.get('P') as any).x=Infinity;assert.throws(()=>nodePosition('P',scene,map),/OPERATION_DOMAIN/);
  map.get('A')!.parent='A';assert.throws(()=>spaceMatrix({kind:'local',node:'A'},map),/PARENT_CYCLE/);
  assert.throws(()=>spaceTransformReads({kind:'parent',node:'P'},map),/PARENT_CYCLE/);
});
