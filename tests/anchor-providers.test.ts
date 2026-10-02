import test from 'node:test';
import assert from 'node:assert/strict';
import {createShapeAnchorProvider,createTextAnchorProvider,createMeasuredAnchorProvider,anchorPosition,anchorNames} from '../src/geometry/anchors.ts';
import type {AnchorProvider,AnchorName} from '../src/ir/text.ts';
import type {DeepReadonly} from '../src/ir/operations.ts';

const near=(actual:readonly number[],expected:readonly number[],tolerance=1e-10)=>{
  assert.equal(actual.length,expected.length);actual.forEach((v,i)=>assert.ok(Number.isFinite(v)&&Math.abs(v-expected[i])<=tolerance,`${actual} != ${expected}`));
};
const named=(provider:DeepReadonly<AnchorProvider>,name:AnchorName)=>anchorPosition(provider,{kind:'named',name});
const border=(provider:DeepReadonly<AnchorProvider>,direction:[number,number])=>anchorPosition(provider,{kind:'border',direction});

test('shape names use negative-y north and analytic PGF conic diagonal positions',()=>{
  assert.equal(anchorNames.length,13);assert.equal(new Set(anchorNames).size,13);
  const circle=createShapeAnchorProvider({kind:'circle',center:[10,20],radius:5},[2,3]);
  near(named(circle,'center'),[10,20]);near(named(circle,'north'),[10,12]);near(named(circle,'west'),[3,20]);
  near(named(circle,'north east'),[10+7*Math.SQRT1_2,20-8*Math.SQRT1_2]);
  const ellipse=createShapeAnchorProvider({kind:'ellipse',center:[-3,7],rx:10,ry:4});
  near(named(ellipse,'south'),[-3,11]);near(named(ellipse,'south west'),[-3-10*Math.SQRT1_2,7+4*Math.SQRT1_2]);
  assert.deepEqual(circle.logicalBounds,[5,15,10,10]);assert.deepEqual(circle.inkBounds,circle.logicalBounds);
});

test('ellipse border is a true ray intersection, independent of the parametric named diagonals',()=>{
  const provider=createShapeAnchorProvider({kind:'ellipse',center:[4,-2],rx:10,ry:3});
  for(const direction of [[1,1],[2,-7],[-4,3],[-1,-8],[0,1],[1,0]] as [number,number][]) {
    const p=border(provider,direction),x=p[0]-4,y=p[1]+2;
    near([x*x/100+y*y/9],[1]);near([x*direction[1]-y*direction[0]],[0]);
    assert.ok(x*direction[0]+y*direction[1]>0);
  }
  assert.notDeepEqual(border(provider,[1,-1]),named(provider,'north east'));
  near(border(provider,[Number.MIN_VALUE,Number.MIN_VALUE]),border(provider,[1,1]));
});

test('rectangle anchors and rays use logical extents with explicit outer separation',()=>{
  const provider=createShapeAnchorProvider({kind:'rectangle',origin:[0,0],width:20,height:10},[2,3]);
  near(named(provider,'center'),[10,5]);near(named(provider,'north east'),[22,-3]);near(named(provider,'south west'),[-2,13]);
  near(border(provider,[3,-1]),[22,1]);near(border(provider,[0,2]),[10,13]);near(border(provider,[-2,0]),[-2,5]);
});

test('rounded rectangle border satisfies its straight or elliptical-corner equation',()=>{
  const provider=createShapeAnchorProvider({kind:'roundedRectangle',origin:[0,0],width:20,height:12,cornerRadius:3},[1,2]);
  near(named(provider,'north'),[10,-2]);
  near(named(provider,'north east'),[17+4*Math.SQRT1_2,3-5*Math.SQRT1_2]);
  for(let step=0;step<64;step++) {
    const angle=step*2*Math.PI/64,direction:[number,number]=[Math.cos(angle),Math.sin(angle)];
    const p=border(provider,direction),x=p[0]-10,y=p[1]-6,ax=Math.abs(x),ay=Math.abs(y);
    near([x*direction[1]-y*direction[0]],[0]);
    assert.ok(ax<=11+1e-10&&ay<=8+1e-10);
    if(ax>7+1e-10&&ay>3+1e-10)near([(ax-7)**2/16+(ay-3)**2/25],[1]);
    else assert.ok(Math.abs(ax-11)<1e-10||Math.abs(ay-8)<1e-10);
  }
  const square=createShapeAnchorProvider({kind:'roundedRectangle',origin:[0,0],width:10,height:10,cornerRadius:5});
  near(border(square,[1,1]),[5+5*Math.SQRT1_2,5+5*Math.SQRT1_2]);
  const zero=createShapeAnchorProvider({kind:'roundedRectangle',origin:[0,0],width:10,height:8,cornerRadius:0});
  near(border(zero,[1,1]),[9,8]);
});

test('text logical dimensions, depth, padding and baseline are independent of ink bounds',()=>{
  const provider=createTextAnchorProvider({width:20,height:8,depth:3},[-1,-9,24,11],{innerSep:[2,1],outerSep:[1,2]});
  assert.deepEqual(provider.logicalBounds,[0,-8,20,11]);assert.deepEqual(provider.inkBounds,[-1,-9,24,11]);
  near(named(provider,'center'),[10,-2.5]);near(named(provider,'north'),[10,-11]);near(named(provider,'south east'),[23,6]);
  near(named(provider,'base'),[10,0]);near(named(provider,'base west'),[0,0]);near(named(provider,'base east'),[20,0]);
  near(border(provider,[0,1]),[10,6]);
  const phantom=createTextAnchorProvider({width:20,height:8,depth:3},[0,0,0,0],{innerSep:[2,1],outerSep:[1,2]});
  near(named(phantom,'north east'),named(provider,'north east'));assert.deepEqual(phantom.inkBounds,[0,0,0,0]);
  const lowered=createTextAnchorProvider({width:4,height:-2,depth:5},[0,2,4,3]);
  near(named(lowered,'center'),[2,3.5]);near(named(lowered,'base'),[2,0]);
});

test('measured PGF coordinates are authoritative and never imply a border from artwork',()=>{
  const provider=createMeasuredAnchorProvider({center:[50,30],north:[7,-9],mid:[2,-2],base:[2,0]},
    {logicalBounds:[0,-8,20,10],inkBounds:[100,200,1,1],revision:'pgf-source'});
  near(named(provider,'center'),[50,30]);near(named(provider,'north'),[7,-9]);near(named(provider,'mid'),[2,-2]);
  assert.throws(()=>named(provider,'east'),/ANCHOR_UNSUPPORTED/);assert.throws(()=>border(provider,[1,0]),/ANCHOR_UNSUPPORTED/);
});

test('revisions encode geometry, text metrics, ink, padding and source identity in canonical order',()=>{
  const circle=createShapeAnchorProvider({kind:'circle',center:[1,2],radius:3});
  assert.equal(circle.revision,createShapeAnchorProvider({radius:3,center:[1,2],kind:'circle'}).revision);
  assert.notEqual(circle.revision,createShapeAnchorProvider({kind:'circle',center:[1,2],radius:4}).revision);
  assert.notEqual(circle.revision,createShapeAnchorProvider({kind:'circle',center:[1,2],radius:3},[1,0]).revision);
  const metrics={width:10,height:7,depth:2},ink:[number,number,number,number]=[0,-7,10,9];
  const original=createTextAnchorProvider(metrics,ink,{revision:'font A'});
  assert.equal(original.revision,createTextAnchorProvider({depth:2,height:7,width:10},ink,{revision:'font A'}).revision);
  for(const changed of [createTextAnchorProvider(metrics,ink,{revision:'font B'}),createTextAnchorProvider({...metrics,depth:3},ink,{revision:'font A'}),
    createTextAnchorProvider(metrics,[0,-7,9,9],{revision:'font A'}),createTextAnchorProvider(metrics,ink,{revision:'font A',innerSep:[1,0]})])
    assert.notEqual(original.revision,changed.revision);
  assert.equal(createMeasuredAnchorProvider({north:[0,-1],center:[0,0]}).revision,createMeasuredAnchorProvider({center:[0,0],north:[0,-1]}).revision);
});

test('providers and queries preserve detached data and frozen metric snapshots',()=>{
  const metrics={width:20,height:8,depth:3},ink:[number,number,number,number]=[-1,-9,24,11],padding:[number,number]=[2,1];
  const provider=createTextAnchorProvider(metrics,ink,{innerSep:padding}),point=named(provider,'north');
  assert.ok(Object.isFrozen(provider));assert.ok(Object.isFrozen(provider.logicalBounds));
  metrics.width=999;ink[0]=999;padding[0]=999;point[0]=999;
  near(named(provider,'north'),[10,-9]);assert.deepEqual(provider.inkBounds,[-1,-9,24,11]);
  assert.throws(()=>{(provider.logicalBounds as any)[0]=999;},TypeError);
});

test('unsupported names and primitives, degenerate rays and malformed metadata fail explicitly',()=>{
  const provider=createShapeAnchorProvider({kind:'circle',center:[0,0],radius:1});
  assert.throws(()=>named(provider,'base'),/ANCHOR_UNSUPPORTED/);assert.throws(()=>border(provider,[0,0]),/ANCHOR_DIRECTION/);
  assert.throws(()=>anchorPosition(provider,{kind:'named',name:'toString'} as any),/ANCHOR_NAME/);
  assert.throws(()=>anchorPosition(provider,{kind:'border',direction:[NaN,0]}),/NON_JSON_VALUE/);
  assert.throws(()=>createShapeAnchorProvider({kind:'polyline',points:[[0,0],[1,1],[2,0]],closed:true}),/ANCHOR_UNSUPPORTED/);
  assert.throws(()=>createShapeAnchorProvider({kind:'arc',center:[0,0],rx:1,ry:1,startAngle:0,sweepAngle:1}),/ANCHOR_UNSUPPORTED/);
  assert.throws(()=>createShapeAnchorProvider({kind:'circle',center:[0,0],radius:1},[-1,0]),/ANCHOR_METRICS/);
  assert.throws(()=>createTextAnchorProvider({width:2,height:1,depth:-2},[0,0,1,1]),/ANCHOR_METRICS/);
  assert.throws(()=>createTextAnchorProvider({width:2,height:1,depth:0},[0,0,-1,1]),/ANCHOR_METRICS/);
  assert.throws(()=>named(createTextAnchorProvider({width:2,height:1,depth:0},[0,-1,2,1]),'mid'),/ANCHOR_UNSUPPORTED/);
  assert.throws(()=>createMeasuredAnchorProvider({}),/ANCHOR_METRICS/);
  assert.throws(()=>createShapeAnchorProvider({kind:'circle',center:[0,0],radius:1},[Number.MAX_VALUE,0]),/ANCHOR_METRICS|ANCHOR_NONFINITE/);
});
