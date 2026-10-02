import test from 'node:test';
import assert from 'node:assert/strict';
import {createCartesianMapping,createCartesianAxes,cartesianLabelPosition,formatTick,formatTickLabels,type CartesianConfig} from '../src/geometry/data-space.js';

const base:CartesianConfig={origin:[20,30],width:240,height:180,xMin:-2,xMax:4,yMin:-1,yMax:5};
const near=(a:number,b:number,tolerance=1e-10):void=>assert.ok(Math.abs(a-b)<=tolerance*Math.max(1,Math.abs(b)),`${a} != ${b}`);
const pair=(a:readonly number[],b:readonly number[]):void=>{near(a[0],b[0]);near(a[1],b[1]);};
const error=(fn:()=>unknown,code:string):void=>assert.throws(fn,(e:unknown)=>e instanceof Error&&'code' in e&&e.code===code);

test('Cartesian data is y-up, scene bp y-down: origin, unit points and all four corners',()=>{
  const m=createCartesianMapping(base);
  pair(m.dataToScene(0,0),[100,180]);pair(m.dataToScene(1,1),[140,150]);
  pair(m.dataToScene(-2,5),[20,30]);pair(m.dataToScene(4,5),[260,30]);
  pair(m.dataToScene(-2,-1),[20,210]);pair(m.dataToScene(4,-1),[260,210]);
  for(const p of [[-2,-1],[4,5],[0,0],[1.3,2.7],[-3,7]] as [number,number][])pair(m.sceneToData(m.dataToScene(...p)),p);
});

test('resizing and domain changes remap points; mapping snapshots its input',()=>{
  const config=structuredClone(base),m=createCartesianMapping(config);
  config.origin[0]=500;config.xMax=20;
  pair(m.dataToScene(1,1),[140,150]);
  pair(createCartesianMapping({...base,width:480,height:360}).dataToScene(1,1),[260,270]);
  pair(createCartesianMapping({...base,xMax:10,yMax:11}).dataToScene(1,1),[80,180]);
  assert.ok(Object.isFrozen(m));assert.ok(Object.isFrozen(m.dataToScene(1,1)));
});

test('linear axes cross zero, else the nearest boundary; generated grid is data-independent bp paths',()=>{
  const axes=createCartesianAxes(base);
  pair(axes.xAxis.contours[0].start,[20,180]);pair(axes.xAxis.contours[0].segments[0].to,[260,180]);
  pair(axes.yAxis.contours[0].start,[100,210]);pair(axes.yAxis.contours[0].segments[0].to,[100,30]);
  assert.deepEqual(axes.xTicks,[-2,-1,0,1,2,3,4]);assert.deepEqual(axes.yTicks,[-1,0,1,2,3,4,5]);
  assert.equal(axes.ticks.contours.length,14);assert.equal(axes.grid.contours.length,14);
  pair(axes.ticks.contours[0].start,[20,177]);pair(axes.ticks.contours[0].segments[0].to,[20,183]);
  assert.ok(Object.isFrozen(axes.grid.contours[0].segments[0].to));
  const positive=createCartesianAxes({...base,xMin:2,xMax:8,yMin:1,yMax:7});
  pair(positive.xAxis.contours[0].start,[20,210]);pair(positive.yAxis.contours[0].start,[20,210]);
  const negative=createCartesianAxes({...base,xMin:-8,xMax:-2,yMin:-7,yMax:-1});
  pair(negative.xAxis.contours[0].start,[20,30]);pair(negative.yAxis.contours[0].start,[260,210]);
});

test('decimal tick lattice does not accumulate rounding or duplicate values',()=>{
  const config={...base,xMin:-0.3,xMax:0.3,yMin:0,yMax:0.2,xStep:0.1,yStep:0.1};
  const axes=createCartesianAxes(config);
  assert.equal(axes.xTicks.length,7);assert.equal(axes.yTicks.length,3);assert.equal(new Set(axes.xTicks).size,7);
  assert.deepEqual(formatTickLabels(axes.xTicks,{precision:1}),['-0.3','-0.2','-0.1','0','0.1','0.2','0.3']);
  assert.equal(Object.is(axes.xTicks[3],-0),false);
  // Deliberately retain actual lattice multiplication, separately from the formatted labels.
  assert.equal(axes.xTicks[6],3*0.1);
  assert.equal(cartesianLabelPosition(config,axes.xTicks[0],0,'x').visible,true);
  assert.equal(cartesianLabelPosition(config,axes.xTicks.at(-1)!,0,'x').visible,true);
  assert.equal(cartesianLabelPosition(config,0.3,0,'x').visible,true);
  assert.equal(cartesianLabelPosition(config,0.15,0,'x').visible,false);
});

test('ticks generated only on the zero-anchored lattice; no ticks is valid',()=>{
  const axes=createCartesianAxes({...base,xMin:0.2,xMax:0.4,yMin:1.2,yMax:1.4});
  assert.deepEqual(axes.xTicks,[]);assert.deepEqual(axes.yTicks,[]);assert.deepEqual(axes.grid,{contours:[]});
  assert.equal(cartesianLabelPosition({...base,xMin:0.2,xMax:0.4},0.3,0,'x').visible,false);
  assert.equal(cartesianLabelPosition({...base,xMin:0.2,xMax:0.4},0.3,0,'x',false).visible,true);
  const noMarks=createCartesianAxes({...base,tickSize:0});assert.equal(noMarks.ticks.contours.length,0);assert.equal(noMarks.grid.contours.length,14);
  const tiny=createCartesianAxes({...base,xMin:1e-300,xMax:1e-299});assert.deepEqual(tiny.xTicks,[]);
  const tinyNegative=createCartesianAxes({...base,xMin:-1e-299,xMax:-1e-300});assert.deepEqual(tinyNegative.xTicks,[]);
  assert.equal(cartesianLabelPosition({...base,xMin:1e-300,xMax:1e-299},0,0,'x',false).visible,false);
  assert.equal(cartesianLabelPosition({...base,xMin:1,xMax:1+Number.EPSILON},1-Number.EPSILON,0,'x',false).visible,false);
});

test('logarithmic axes are opt-in and exponent ticks use the chosen base',()=>{
  const config:CartesianConfig={...base,xMin:1,xMax:1000,yMin:0.1,yMax:10,xScale:'log',yScale:'log'};
  const m=createCartesianMapping(config),axes=createCartesianAxes(config);
  pair(m.dataToScene(10,1),[100,120]);pair(m.sceneToData([100,120]),[10,1]);
  pair(m.dataToScene(1,10),[20,30]);pair(m.dataToScene(1000,0.1),[260,210]);
  assert.deepEqual(axes.xTicks,[1,10,100,1000]);assert.deepEqual(axes.yTicks,[0.1,1,10]);
  pair(axes.xAxis.contours[0].start,[20,210]);pair(axes.yAxis.contours[0].start,[20,210]);
  const binary=createCartesianAxes({...config,logBase:2,xMin:1,xMax:16,xStep:2,yMin:1,yMax:4});
  assert.deepEqual(binary.xTicks,[1,4,16]);assert.deepEqual(binary.yTicks,[1,2,4]);
  assert.equal(cartesianLabelPosition(config,100,0,'x').visible,true);
  assert.equal(cartesianLabelPosition(config,50,0,'x').visible,false);
});

test('log mapping handles wide positive domains and rejects invalid data and inverse underflow',()=>{
  const m=createCartesianMapping({...base,xMin:1e-200,xMax:1e200,xScale:'log'});
  pair(m.dataToScene(1,0),[140,180]);near(m.sceneToData([140,180])[0],1);
  error(()=>m.dataToScene(0,0),'AXIS_DOMAIN');error(()=>m.dataToScene(-1,0),'AXIS_DOMAIN');
  error(()=>m.sceneToData([-1e6,0]),'AXIS_RANGE');error(()=>m.sceneToData([1e6,0]),'AXIS_RANGE');
});

test('label visibility responds to ranges and tick steps while using central scene mapping',()=>{
  pair(cartesianLabelPosition(base,1,500,'x').position,[140,180]);
  pair(cartesianLabelPosition(base,500,1,'y').position,[100,150]);
  pair(cartesianLabelPosition(base,1,1,'point').position,[140,150]);
  assert.equal(cartesianLabelPosition(base,1,1,'point').visible,true);
  assert.equal(cartesianLabelPosition(base,10,1,'point').visible,false);
  assert.equal(cartesianLabelPosition(base,10,0,'x').visible,false);
  assert.equal(cartesianLabelPosition({...base,xStep:2},1,0,'x').visible,false);
  assert.equal(cartesianLabelPosition({...base,xStep:2},2,0,'x').visible,true);
  assert.equal(cartesianLabelPosition({...base,xStep:2},1,0,'x',false).visible,true);
});

test('strict domains, dimensions, profiles and logarithmic base are diagnosed',()=>{
  for(const patch of [{xMax:-2},{yMax:-1},{xMin:NaN},{yMax:Infinity},{xScale:'log',xMin:0}])
    error(()=>createCartesianMapping({...base,...patch} as CartesianConfig),'AXIS_DOMAIN');
  for(const patch of [{width:0},{height:-1},{xStep:0},{yStep:NaN},{tickSize:-1},{logBase:1},{logBase:Infinity},{xScale:'polar'},{alien:1},{xScale:null},{tickSize:null}])
    error(()=>createCartesianMapping({...base,...patch} as CartesianConfig),'AXIS_OPTIONS');
  error(()=>createCartesianMapping({...base,origin:[NaN,0]}),'AXIS_OPTIONS');
  error(()=>createCartesianMapping({...base,origin:[0,0,0]} as unknown as CartesianConfig),'AXIS_OPTIONS');
  let accessed=false;const getter={...base};Object.defineProperty(getter,'width',{enumerable:true,get:()=>{accessed=true;return 10;}});
  error(()=>createCartesianMapping(getter),'AXIS_OPTIONS');assert.equal(accessed,false);
  error(()=>cartesianLabelPosition(base,0,0,'polar' as 'point'),'AXIS_OPTIONS');
});

test('finite overflow and precision collapse never publish invalid geometry',()=>{
  error(()=>createCartesianMapping({...base,xMin:-1e308,xMax:1e308}),'AXIS_RANGE');
  error(()=>createCartesianMapping({...base,origin:[1e308,0],width:1e308}),'AXIS_RANGE');
  error(()=>createCartesianMapping({...base,origin:[1e308,0],width:1}),'AXIS_PRECISION');
  error(()=>createCartesianMapping({...base,xMin:1e300,xMax:1e300+2e284,xScale:'log'}),'AXIS_PRECISION');
  error(()=>createCartesianAxes({...base,xMin:1e20,xMax:1e20+1e6}),'AXIS_PRECISION');
  error(()=>createCartesianAxes({...base,xMin:1e-300,xMax:1e-299,xStep:1e300}),'AXIS_PRECISION');
  error(()=>createCartesianMapping(base).dataToScene(Number.MAX_VALUE,0),'AXIS_RANGE');
  error(()=>createCartesianMapping(base).dataToScene(NaN,0),'AXIS_COORDINATE');
  error(()=>createCartesianMapping(base).sceneToData([Infinity,0]),'AXIS_OPTIONS');
});

test('tick budgets are bounded before iteration, count both axes, and permit the exact limit',()=>{
  assert.equal(createCartesianAxes({...base,maxTicks:14}).grid.contours.length,14);
  error(()=>createCartesianAxes({...base,maxTicks:13}),'AXIS_BUDGET');
  error(()=>createCartesianAxes({...base,xStep:1e-6}),'AXIS_BUDGET');
  for(const maxTicks of [0,1.5,4097,Infinity])error(()=>createCartesianAxes({...base,maxTicks}),'AXIS_BUDGET');
  error(()=>cartesianLabelPosition({...base,maxTicks:13},1,1,'x'),'AXIS_BUDGET');
});

test('formatting separates numeric values from displayed rounding and has deterministic notation',()=>{
  assert.equal(formatTick(-0),'0');assert.equal(formatTick(-1e-8,{precision:3}),'0');
  assert.equal(formatTick(1.230000),'1.23');assert.equal(formatTick(1e21),'1000000000000000000000');
  assert.equal(formatTick(-1.23e24),'-1230000000000000000000000');
  assert.equal(formatTick(12340,{notation:'scientific',precision:3}),'1.234e+4');
  assert.equal(formatTick(0.00012,{notation:'scientific',precision:5}),'1.2e-4');
  assert.equal(formatTick(-0,{notation:'scientific'}),'0e+0');
  assert.deepEqual(formatTickLabels([0,-0,1,1]),['0','0','1','1']);
  error(()=>formatTickLabels([0.101,0.102],{precision:2}),'AXIS_LABEL_DUPLICATE');
  error(()=>formatTickLabels([1.001e8,1.002e8],{notation:'scientific',precision:2}),'AXIS_LABEL_DUPLICATE');
  for(const precision of [-1,1.5,13,Infinity])error(()=>formatTick(1,{precision}),'AXIS_FORMAT');
  error(()=>formatTick(Infinity),'AXIS_FORMAT');
  error(()=>formatTick(1,{precision:null} as unknown as {precision:number}),'AXIS_FORMAT');
  assert.ok(Object.isFrozen(formatTickLabels([1,2])));
});
