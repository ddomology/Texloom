import test from 'node:test';
import assert from 'node:assert/strict';
import {executeAxesOperation,prepareScene,validateBundle,worldMatrix,transformPoint,
  type Bundle,type InputRef,type LiteralValue,type Operation,type PathNode,type PointNode,type SpaceRef,type TexNode} from '../src/index.ts';
import {renderSvg} from '../src/render-svg.ts';

const scene = {kind:'scene'} as const;
const local = (node:string) => ({kind:'local',node} as const);
const parent = (node:string) => ({kind:'parent',node} as const);
const number = (value:number,unit:'1'|'bp'='1'):LiteralValue => ({type:'scalar',unit,value});
const point = (value:[number,number],space:SpaceRef=scene):LiteralValue => ({type:'vec2',role:'point',space,value});
const literal = (value:LiteralValue):InputRef => ({kind:'literal',value});
const out = (operation:string,socket:string):InputRef => ({kind:'output',ref:{operation,socket}});
const config = (space:SpaceRef=scene):Record<string,LiteralValue> => ({origin:point([10,20],space),width:number(200,'bp'),height:number(100,'bp'),
  xMin:number(-2),xMax:number(2),yMin:number(-1),yMax:number(1)});
const operation = (operator:string,spaces:Record<string,SpaceRef>={space:scene}):Operation => ({id:'axes',operator,version:1,spaces,inputs:{}});
const execute = (operator:string,values:Record<string,LiteralValue>={}) => executeAxesOperation(operation(operator),{...config(),...values})!;
const near = (actual:number,expected:number) => assert.ok(Math.abs(actual-expected)<1e-9,`${actual} != ${expected}`);

test('data coordinates cross a typed dimensionless-to-bp boundary and invert independently',()=>{
  const mapped = execute('dataToScene',{x:number(1),y:number(.5)});
  assert.deepEqual(mapped.point,point([160,45]));assert.deepEqual(mapped.x,number(160,'bp'));assert.deepEqual(mapped.y,number(45,'bp'));
  const back = execute('sceneToData',{point:mapped.point});assert.deepEqual(back,{x:number(1),y:number(.5)});
  const origin = execute('dataToScene',{x:number(0),y:number(0)});assert.deepEqual(origin.point.value,[110,70]);
  const log = execute('dataToScene',{xMin:number(1),xMax:number(1000),yMin:number(1),yMax:number(100),xScale:number(1),yScale:number(1),x:number(10),y:number(10)});
  const inverse = execute('sceneToData',{xMin:number(1),xMax:number(1000),yMin:number(1),yMax:number(100),xScale:number(1),yScale:number(1),point:log.point});
  near(inverse.x.value as number,10);near(inverse.y.value as number,10);
});

test('cartesianAxes returns detached editable bp geometry and tick counts',()=>{
  const values = config(),before = structuredClone(values),axes = executeAxesOperation(operation('cartesianAxes'),values)!;
  assert.equal(axes.xCount.value,5);assert.equal(axes.yCount.value,3);
  assert.equal(axes.xAxis.type,'path2d');if(axes.xAxis.type!=='path2d')throw new Error('path');
  assert.deepEqual(axes.xAxis.value.contours[0].start,[10,70]);
  assert.deepEqual(axes.xAxis.value.contours[0].segments[0].to,[210,70]);
  axes.xAxis.value.contours[0].start[0]=999;(axes.xAxis.space as any).node='mutated';
  assert.deepEqual(values,before);
  const again = executeAxesOperation(operation('cartesianAxes'),values)!;
  assert.deepEqual((again.xAxis.value as any).contours[0].start,[10,70]);assert.deepEqual(again.xAxis.type==='path2d'&&again.xAxis.space,scene);
});

test('axis label placement maps the full basis and measured baseline anchor into its target parent',()=>{
  const chart=local('plot'),label=local('label'),to=parent('label');
  const op=operation('placeAxisLabel',{space:chart,label,parent:to});
  const inputs={...config(chart),x:number(1),y:number(0),axis:number(0),anchor:point([10,0],label),offsetY:number(12,'bp'),
    mapping:{type:'transform2d' as const,from:chart,to,value:[0,2,-2,0,30,40] as [number,number,number,number,number,number]}};
  const placed=executeAxesOperation(op,inputs)!;
  assert.deepEqual(placed.transform,{type:'transform2d',from:label,to,value:[0,2,-2,0,-134,340]});
  assert.deepEqual(placed.x,number(0,'bp'));assert.deepEqual(placed.y,number(0,'bp'));assert.deepEqual(placed.opacity,number(1));
  const hidden=executeAxesOperation(op,{...inputs,x:number(3)})!;assert.deepEqual(hidden.opacity,number(0));
  const offTick=executeAxesOperation(op,{...inputs,x:number(.5)})!;assert.deepEqual(offTick.opacity,number(0));
  const free=executeAxesOperation(op,{...inputs,x:number(.5),respectTicks:number(0)})!;assert.deepEqual(free.opacity,number(1));
  const log=executeAxesOperation(op,{...inputs,xMin:number(1),xMax:number(100),yMin:number(1),yMax:number(10),xScale:number(1),yScale:number(1),x:number(10),y:number(0)})!;
  assert.equal(log.opacity.value,1); // y=0 is unused for an x-axis label, including on log charts.
});

test('axes direct executors reject units, roles, spaces, unknown keys, nonfinite input and invalid domains with source spans',()=>{
  const span={file:'axes.tex',start:{line:9,column:1},end:{line:9,column:20}};
  const op={...operation('dataToScene'),sourceSpan:span};
  const good={...config(),x:number(1),y:number(0)};
  for(const bad of [{width:number(100)},{x:number(1,'bp')},{origin:point([0,0],local('other'))},
    {origin:{type:'vec2',role:'vector',space:scene,value:[0,0]}},{xScale:number(.5)},
    {xMax:number(-2)},{width:number(0,'bp')},{xScale:number(1)},
    {surprise:number(2)},{x:number(Infinity)},{x:undefined},{x:number(NaN)}]) {
    assert.throws(()=>executeAxesOperation(op,{...good,...bad} as any),(error:any)=>{
      assert.deepEqual(error.diagnostics[0].sourceSpan,span);assert.ok(error.diagnostics[0].path.includes('axes'));return true;
    });
  }
  assert.throws(()=>executeAxesOperation({...op,spaces:{space:scene,extra:scene}},good),/Unknown coordinate space/);
  assert.throws(()=>executeAxesOperation({...op,spaces:{}},good),/space/);
  assert.throws(()=>executeAxesOperation(op,null as any),/input record/);
  assert.equal(executeAxesOperation({...op,version:2},good),undefined);
  assert.equal(executeAxesOperation({...op,operator:'unknown'},good),undefined);
});

test('label mapping requires semantic source and parent charts, bounded flags and finite composed outputs',()=>{
  const label=local('label'),to=parent('label'),op=operation('placeAxisLabel',{space:scene,label,parent:to});
  const good={...config(),x:number(1),y:number(0),anchor:point([5,0],label),
    mapping:{type:'transform2d' as const,from:scene,to,value:[1,0,0,1,0,0] as [number,number,number,number,number,number]}};
  for(const bad of [{axis:number(2)},{respectTicks:number(.5)},{offsetX:number(2)},{anchor:point([0,0],scene)},
    {mapping:{...good.mapping,to:scene}},{mapping:{...good.mapping,from:local('sameMatrix')}},
    {mapping:{...good.mapping,value:[Number.MAX_VALUE,0,0,1,0,0]}}])
    assert.throws(()=>executeAxesOperation(op,{...good,...bad} as any));
});

function graphFixture():Bundle {
  const b:Bundle={version:'0.3',title:'Typed axes',duration:2,units:'bp',viewport:{width:600,height:400},camera:{x:0,y:0,zoom:1},
    resources:{label:{kind:'vector',metrics:{width:10,height:8,depth:2},inkBounds:[0,-8,10,10],items:[{kind:'path',d:'M0 0L10 0L5 -8Z'}]}},
    nodes:[{id:'plot',kind:'group',transform:{translate:[30,40],scale:[2,2]}},
      {id:'xAxis',kind:'path',parent:'plot',d:'M0 0',geometry:{contours:[]}},
      {id:'P',kind:'point',x:0,y:0,r:3},
      {id:'labelParent',kind:'group',transform:{translate:[-20,10],rotate:Math.PI/2,scale:[.5,.5]}},
      {id:'label',kind:'tex',parent:'labelParent',resourceId:'label',x:777,y:888,scale:2}],
    tracks:[{target:'plot',property:'transform.translate',keys:[[0,[30,40]],[2,[50,80]]]}],relations:[],
    operationGraph:{version:1,operations:[],bindings:[]}};
  const inputs=(chart:SpaceRef):Record<string,InputRef>=>({...Object.fromEntries(Object.entries(config(chart)).map(([key,value])=>[key,literal(value)])),
    xMax:{kind:'expression',expression:'2+time/1s*2',unit:'1'}});
  b.operationGraph!.operations=[
    {id:'axes',operator:'cartesianAxes',version:1,spaces:{space:local('xAxis')},inputs:inputs(local('xAxis'))},
    {id:'mapped',operator:'dataToScene',version:1,spaces:{space:local('plot')},inputs:{...inputs(local('plot')),x:literal(number(1)),y:literal(number(0))}},
    {id:'world',operator:'transformPoint',version:1,spaces:{from:local('plot'),to:scene},inputs:{point:out('mapped','point'),transform:{kind:'spaceTransform',from:local('plot'),to:scene}}},
    {id:'labelPlacement',operator:'placeAxisLabel',version:1,spaces:{space:local('plot'),label:local('label'),parent:parent('label')},
      inputs:{...inputs(local('plot')),x:literal(number(1)),y:literal(number(0)),axis:literal(number(0)),offsetY:literal(number(12,'bp')),
        anchor:{kind:'textAnchor',node:'label',anchor:'base'},mapping:{kind:'spaceTransform',from:local('plot'),to:parent('label')}}},
  ];
  b.operationGraph!.bindings=[{target:'xAxis',property:'geometry',value:{operation:'axes',socket:'xAxis'}},
    {target:'P',property:'position',value:{operation:'world',socket:'position'}},
    ...['transform','x','y'].map(property=>({target:'label',property,value:{operation:'labelPlacement',socket:property}})),
    {target:'label',property:'style.opacity',value:{operation:'labelPlacement',socket:'opacity'}}];
  return b;
}

test('prepared graphs share dynamic ranges, preserve y-up conversion, and honor transformed label parents and live TeX scale',()=>{
  const b=graphFixture(),run=prepareScene(b),first=run.sample(0),later=run.sample(1);
  assert.equal((first.nodes[2] as PointNode).x,350);assert.equal((first.nodes[2] as PointNode).y,180);
  assert.equal((later.nodes[2] as PointNode).x,260);assert.equal((later.nodes[2] as PointNode).y,200);
  for(const frame of [first,later]){
    const nodes=new Map(frame.nodes.map(node=>[node.id,node])),label=frame.nodes[4] as TexNode,P=frame.nodes[2] as PointNode;
    const baseline=transformPoint(worldMatrix('label',nodes),[10,0]);
    near(baseline[0],P.x);near(baseline[1],P.y+24);assert.equal(label.x,0);assert.equal(label.y,0);
    const geometry=(frame.nodes[1] as PathNode).geometry!;
    assert.deepEqual(geometry.contours[0].start,[10,70]);assert.deepEqual(geometry.contours[0].segments[0].to,[210,70]);
  }
  b.expressions={version:1,parameters:{},bindings:[{target:'label',property:'scale',expression:'2+time/1s'}]};
  const scaled=prepareScene(b).sample(1),nodes=new Map(scaled.nodes.map(node=>[node.id,node]));
  const baseline=transformPoint(worldMatrix('label',nodes),[15,0]);near(baseline[0],260);near(baseline[1],224);
});

test('axes frames and renderer input remain seek-independent and detached from both source and earlier samples',()=>{
  const b=graphFixture(),run=prepareScene(b),first=run.sample(0),saved=structuredClone(first),svg=renderSvg(first);
  run.sample(2);(first.nodes[1] as PathNode).geometry!.contours[0].start[0]=999;(b.nodes[0].transform!.translate!)[0]=999;
  assert.deepEqual(run.sample(0),saved);assert.equal(renderSvg(run.sample(0)),svg);assert.ok(svg.includes('<path'));
});

test('graph preparation rejects data units, chart aliases, label feedback and duplicate pose writers',()=>{
  const unit=graphFixture();unit.operationGraph!.operations[1].inputs.x=literal(number(1,'bp'));
  assert.ok(validateBundle(unit).some(d=>d.code.includes('UNIT')));
  const mismatch=graphFixture();mismatch.operationGraph!.operations[3].spaces.parent=scene;
  assert.ok(validateBundle(mismatch).some(d=>d.code==='OPERATION_SPACE_MISMATCH'));
  const cyclic=graphFixture();cyclic.operationGraph!.bindings.push({target:'label',property:'scale',value:{operation:'labelPlacement',socket:'opacity'}});
  assert.throws(()=>prepareScene(cyclic),/CYCLE/);
  const conflict=graphFixture();conflict.tracks.push({target:'label',property:'x',keys:[[0,0],[2,10]]});
  assert.throws(()=>prepareScene(conflict),/WRITER|CONFLICT/);
});
