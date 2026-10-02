import test from 'node:test';
import assert from 'node:assert/strict';
import {matrixBoxLayout,distributeBoxLayout,alignBoxLayout,fitBoxBounds,assertBoxList,MAX_BOX_SLOTS,
  type BoxList,type LayoutBox} from '../src/geometry/boxes.ts';
import type {PathPoint} from '../src/path-geometry.ts';

const box=(width:number,height:number,baseline=height,x=0,y=0):LayoutBox=>({bounds:[x,y,width,height],baseline});
const near=(actual:readonly number[],expected:readonly number[])=>actual.forEach((n,i)=>assert.ok(Math.abs(n-expected[i])<1e-10,`${actual} != ${expected}`));
const code=(expected:string)=>(error:any)=>error.code===expected;

test('matrix uses per-column width and per-row baseline ascent and depth including empty cells',()=>{
  const input:BoxList=[box(20,10,0,2,-8),box(30,18,0,-4,-12),null,box(10,8,7,0,3),null,box(40,14,8,5,-1)];
  const before=structuredClone(input),result=matrixBoxLayout(input,{columns:3,gapX:7,gapY:11,origin:[100,200]});
  assert.deepEqual(result,{positions:[[98,212],[131,212],[164,200],[105,231],[127,229],[159,230]],bounds:[100,200,104,43],rows:2,columns:3});
  assert.deepEqual(input,before);
  assert.equal(input[0]!.baseline+result.positions[0][1],input[1]!.baseline+result.positions[1][1]);
  assert.equal(input[3]!.baseline+result.positions[3][1],input[5]!.baseline+result.positions[5][1]);
});

test('matrix reserves ragged trailing columns and allocated empty rows without manufacturing boxes',()=>{
  const ragged=matrixBoxLayout([box(20,10)],{columns:3,gapX:10});
  assert.deepEqual(ragged.bounds,[0,0,40,10]);assert.equal(ragged.positions.length,1);
  const emptyCells=matrixBoxLayout([null,null,null,null],{columns:2,gapX:5,gapY:7,origin:[3,4]});
  assert.deepEqual(emptyCells,{positions:[[3,4],[8,4],[3,11],[8,11]],bounds:[3,4,5,7],rows:2,columns:2});
  assert.deepEqual(matrixBoxLayout([],{columns:4,origin:[3,4]}),{positions:[],bounds:[3,4,0,0],rows:0,columns:4});
});

test('matrix start, center and end align unequal boxes within measured cells',()=>{
  const input:BoxList=[box(10,10,0,2,3),box(20,30),box(30,15)];
  for(const [align,amount] of [['start',0],['center',.5],['end',1]] as const) {
    const r=matrixBoxLayout(input,{columns:2,gapX:4,gapY:6,alignX:align,alignY:align});
    assert.deepEqual(r.bounds,[0,0,54,51]);
    near(r.positions[0],[20*amount-2,20*amount-3]);near(r.positions[2],[0,36]);
  }
});

test('finite baselines outside measured bounds retain the actual row envelope',()=>{
  const above=matrixBoxLayout([box(10,10,-10),box(10,10,-20)],{columns:2,gapX:0});
  assert.deepEqual(above.positions,[[0,0],[10,10]]);assert.deepEqual(above.bounds,[0,0,20,20]);
  const below=matrixBoxLayout([box(10,10,30),box(10,10,40)],{columns:2,gapX:0});
  assert.deepEqual(below.positions,[[0,10],[10,0]]);assert.deepEqual(below.bounds,[0,0,20,20]);
  assert.deepEqual(matrixBoxLayout([box(10,10,1000)]).bounds,[0,0,10,10]);
  const remoteBaseline=[box(10,10,1e308,0,3),box(20,20,1e308,0,-5)];
  assert.deepEqual(matrixBoxLayout(remoteBaseline,{columns:2,gapX:0}).bounds,[0,0,30,20]);
  assert.deepEqual(distributeBoxLayout(remoteBaseline,{align:'baseline',gap:0}).positions,[[0,5],[10,5]]);
});

test('distribution preserves source order, excludes nulls from gap counts and never scales',()=>{
  const input:BoxList=[box(10,10,8,2,3),null,box(30,20,14,-5,-8),box(0,4)];
  const r=distributeBoxLayout(input,{gap:7,origin:[20,30],maxWidth:1,maxHeight:1,overflow:'allow'});
  assert.deepEqual(r.positions,[[18,32],[20,30],[42,38],[74,38]]);assert.deepEqual(r.bounds,[20,30,54,20]);
  assert.equal(r.rows,1);assert.equal(r.columns,3);
  const firstRight=input[0]!.bounds[0]+r.positions[0][0]+input[0]!.bounds[2],secondLeft=input[2]!.bounds[0]+r.positions[2][0];
  assert.equal(secondLeft-firstRight,7);
  assert.deepEqual(distributeBoxLayout([null,null],{origin:[20,30]}),{positions:[[20,30],[20,30]],bounds:[20,30,0,0],rows:0,columns:0});
});

test('horizontal wrapping greedily packs exact extents and aligns each line independently',()=>{
  const input:BoxList=[box(25,10),null,box(20,20),box(30,15)];
  const r=distributeBoxLayout(input,{gap:5,crossGap:7,maxWidth:50,overflow:'wrap',origin:[10,20]});
  assert.deepEqual(r,{positions:[[10,25],[10,20],[40,20],[10,47]],bounds:[10,20,50,42],rows:2,columns:2});
  const baseline=distributeBoxLayout([box(25,10,8),box(20,20,14),box(30,15,2)],{gap:5,crossGap:7,maxWidth:50,overflow:'wrap',align:'baseline'});
  assert.deepEqual(baseline.positions,[[0,6],[30,0],[0,27]]);assert.deepEqual(baseline.bounds,[0,0,50,42]);
  const roundoff=distributeBoxLayout([box(.1,1),box(.2,1)],{gap:0,maxWidth:.3,overflow:'wrap'});
  assert.equal(roundoff.rows,1);near(roundoff.bounds,[0,0,.3,1]);
});

test('vertical distribution wraps into columns and supports edge or center cross alignment',()=>{
  const input:BoxList=[box(10,25,0,2,3),box(20,20,0,-2,-4),box(15,30)];
  const r=distributeBoxLayout(input,{axis:'y',gap:5,crossGap:7,maxHeight:50,overflow:'wrap',align:'end',origin:[10,20]});
  assert.deepEqual(r,{positions:[[18,17],[12,54],[37,20]],bounds:[10,20,42,50],rows:2,columns:2});
  assert.throws(()=>distributeBoxLayout(input,{axis:'y',align:'baseline'}),code('BOX_OPTIONS'));
});

test('overflow is explicit for matrices, distributions, wrap items and wrap cross extent',()=>{
  const input=[box(20,10),box(30,15)];
  assert.throws(()=>matrixBoxLayout(input,{columns:2,gapX:5,maxWidth:54,overflow:'error'}),code('BOX_OVERFLOW'));
  assert.throws(()=>matrixBoxLayout(input,{columns:2,maxHeight:14,overflow:'error'}),code('BOX_OVERFLOW'));
  assert.throws(()=>distributeBoxLayout(input,{gap:5,maxWidth:54,overflow:'error'}),code('BOX_OVERFLOW'));
  assert.throws(()=>distributeBoxLayout(input,{maxWidth:29,overflow:'wrap'}),code('BOX_OVERFLOW'));
  assert.throws(()=>distributeBoxLayout(input,{gap:5,crossGap:5,maxWidth:30,maxHeight:29,overflow:'wrap'}),code('BOX_OVERFLOW'));
  assert.throws(()=>distributeBoxLayout(input,{overflow:'wrap'}),code('BOX_OPTIONS'));
  assert.throws(()=>distributeBoxLayout([box(1e-16,1)],{maxWidth:1e-18,overflow:'wrap'}),code('BOX_OVERFLOW'));
  assert.deepEqual(matrixBoxLayout(input,{columns:2,gapX:5,maxWidth:55,maxHeight:15,overflow:'error'}).bounds,[0,0,55,15]);
});

test('alignment preserves the orthogonal translation and ignores null slots without replacing their position',()=>{
  const input:BoxList=[box(20,10,9,2,3),null,box(10,8,5,-4,-2)],positions:PathPoint[]=[[100,200],[7,8],[300,400]];
  const before=structuredClone(positions);
  assert.deepEqual(alignBoxLayout(input,positions,{axis:'x',align:'center',at:50}),{
    positions:[[38,200],[7,8],[49,400]],bounds:[40,203,20,203],rows:0,columns:0});
  assert.deepEqual(alignBoxLayout(input,positions,{axis:'y',align:'baseline',at:30}).positions,[[100,21],[7,8],[300,25]]);
  assert.deepEqual(alignBoxLayout(input,positions,{axis:'y',align:'end',at:30}).positions,[[100,17],[7,8],[300,24]]);
  assert.deepEqual(alignBoxLayout(input,positions,{axis:'x',align:'start',at:30}).positions,[[28,200],[7,8],[34,400]]);
  assert.deepEqual(positions,before);assert.throws(()=>alignBoxLayout(input,positions,{axis:'x',align:'baseline'}),code('BOX_OPTIONS'));
});

test('fit bounds uses full translated multiline dimensions plus padding; empty unions stay zero',()=>{
  const input:BoxList=[box(40,60,12,-2,-10),null,box(30,10,4)],positions:PathPoint[]=[[20,30],[999,999],[100,5]];
  assert.deepEqual(fitBoxBounds(input,positions),[18,5,112,75]);
  assert.deepEqual(fitBoxBounds(input,positions,{paddingX:4,paddingY:6}),[14,-1,120,87]);
  assert.deepEqual(fitBoxBounds([null],[[7,8]],{paddingX:100,paddingY:100}),[0,0,0,0]);
  assert.deepEqual(fitBoxBounds([],[],{paddingX:100}),[0,0,0,0]);
  assert.deepEqual(fitBoxBounds([box(0,0,0,2,3)],[[5,7]],{paddingX:1,paddingY:2}),[6,8,2,4]);
});

test('all layout outputs are detached and deeply frozen with deterministic source-index positions',()=>{
  const source=[box(10,20),box(30,40)],positions:PathPoint[]=[[1,2],[3,4]];
  const results=[matrixBoxLayout(source,{columns:2}),distributeBoxLayout(source),alignBoxLayout(source,positions)],bounds=fitBoxBounds(source,positions);
  const snapshots=structuredClone(results);source[0].bounds[0]=999;positions[0][0]=999;
  assert.deepEqual(results,snapshots);assert.ok(Object.isFrozen(bounds));
  for(const r of results){assert.ok(Object.isFrozen(r));assert.ok(Object.isFrozen(r.positions));assert.ok(Object.isFrozen(r.positions[0]));assert.ok(Object.isFrozen(r.bounds));}
  const repeat=[box(10,20),box(30,40)];assert.deepEqual(matrixBoxLayout(repeat,{columns:2}),results[0]);
});

test('strict JSON rejects accessors, prototypes, sparse arrays, unknown properties and nonfinite metrics',()=>{
  let accessed=false;const accessor=Object.defineProperty({},'bounds',{enumerable:true,get(){accessed=true;return [0,0,1,1];}});
  const invalid:unknown[]=[{},[accessor],[new Date()],[{...box(1,1),extra:1}],[{bounds:[0,0,-1,2],baseline:0}],
    [{bounds:[0,0,1,2],baseline:Infinity}],[{bounds:[0,0,1,NaN],baseline:0}],Array(1),[{bounds:[0,0,1,2],baseline:undefined}]];
  for(const value of invalid)assert.throws(()=>assertBoxList(value));assert.equal(accessed,false);
  const cycle:any={};cycle.bounds=cycle;assert.throws(()=>assertBoxList([cycle]),code('BOX_DATA'));
  const symbol=box(1,1);Object.defineProperty(symbol,Symbol('metadata'),{value:3});assert.throws(()=>assertBoxList([symbol]),code('BOX_DATA'));
  assert.throws(()=>matrixBoxLayout([box(1,1)],{wat:1} as any),code('BOX_OPTIONS'));
  assert.throws(()=>matrixBoxLayout([box(1,1)],{gapX:null} as any),code('BOX_OPTIONS'));
  assert.throws(()=>matrixBoxLayout([box(1,1)],{columns:'2'} as any),code('BOX_OPTIONS'));
  assert.throws(()=>fitBoxBounds([box(1,1)],[]),code('BOX_POSITIONS'));
  assert.throws(()=>alignBoxLayout([null],[[0,Infinity]]),code('BOX_DATA'));
});

test('slot and arithmetic budgets fail predictably instead of truncating or returning infinities',()=>{
  assert.equal(matrixBoxLayout(Array(MAX_BOX_SLOTS).fill(null),{columns:MAX_BOX_SLOTS,gapX:0}).positions.length,MAX_BOX_SLOTS);
  assert.throws(()=>matrixBoxLayout(Array(MAX_BOX_SLOTS+1).fill(null)),code('BOX_BUDGET'));
  assert.throws(()=>matrixBoxLayout([],{columns:MAX_BOX_SLOTS+1}),code('BOX_OPTIONS'));
  assert.throws(()=>matrixBoxLayout([box(1e308,1,0,1e308)]),code('BOX_RANGE'));
  assert.throws(()=>matrixBoxLayout([box(1e308,1),box(1e308,1)],{columns:2}),code('BOX_RANGE'));
  assert.throws(()=>distributeBoxLayout([box(1,1)],{origin:[1e308,0],gap:Infinity}),code('BOX_DATA'));
  assert.throws(()=>fitBoxBounds([box(1,1)],[[0,0]],{paddingX:1e308}),code('BOX_RANGE'));
  assert.throws(()=>fitBoxBounds([box(0,0,0,1.7e308,0)],[[0,0]],{paddingX:1e307}),code('BOX_RANGE'));
  assert.deepEqual(distributeBoxLayout([box(1e308,1)],{gap:1e308}).bounds,[0,0,1e308,1]);
});
