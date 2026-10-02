import test from 'node:test';
import assert from 'node:assert/strict';
import {preparePathFrames,regularPathFrames,type PathFrameOptions} from '../src/geometry/path-frame.ts';
import {reverseCurveGeometry,trimCurveGeometry} from '../src/geometry/curves.ts';
import type {PathGeometry} from '../src/path-geometry.ts';

const line=(end=100):PathGeometry=>({contours:[{id:'c',start:[0,0],segments:[{id:'line',kind:'line',to:[end,0]}]}]});
const elbow:PathGeometry={contours:[{id:'c',start:[0,0],segments:[{id:'east',kind:'line',to:[10,0]},{id:'north',kind:'line',to:[10,10]}]}]};
const square:PathGeometry={contours:[{id:'box',start:[0,0],closed:true,segments:[{id:'east',kind:'line',to:[10,0]},
  {id:'south',kind:'line',to:[10,10]},{id:'west',kind:'line',to:[0,10]}]}]};
const near=(a:readonly number[],b:readonly number[],tolerance=1e-8)=>{
  assert.equal(a.length,b.length);a.forEach((value,i)=>assert.ok(Number.isFinite(value)&&Math.abs(value-b[i])<=tolerance,`${a} != ${b}`));
};

test('regular spacing uses absolute local distances and stable signed lattice indices',()=>{
  const result=regularPathFrames(line());
  assert.equal(result.totalLength,100);assert.equal(result.closed,false);assert.deepEqual(result.skipped,[]);
  assert.deepEqual(result.frames.map(f=>[f.id,f.index,f.distance]),[0,1,2,3,4,5].map(k=>[`mark-${k}`,k,k*20]));
  for(const frame of result.frames){near(frame.position,[frame.distance,0]);near(frame.tangent,[1,0]);near(frame.normal,[0,1]);}
  const shifted=regularPathFrames(line(),{spacing:20,phase:25,startMargin:10,endMargin:10});
  assert.deepEqual(shifted.frames.map(f=>[f.id,f.distance]),[['mark-0',25],['mark-1',45],['mark-2',65],['mark-3',85]]);
  assert.equal(regularPathFrames(line(),{phase:25}).frames[0].id,'mark--1');
  assert.deepEqual(regularPathFrames(line(),{startMargin:80,endMargin:30}).frames,[]);
  // (.1*7)+.3 is exactly 1, although (1-.3)/.1 rounds below 7.
  const fractional=regularPathFrames(line(1),{spacing:.1,phase:.3});
  assert.equal(fractional.frames.at(-1)!.id,'mark-7');assert.equal(fractional.frames.at(-1)!.distance,1);
});

test('trim origin preserves world positions and IDs instead of restarting the phase',()=>{
  const source=line(),whole=regularPathFrames(source,{spacing:20,phase:5});
  const trimmed=trimCurveGeometry(source,.2,.8,{mode:'length'}).geometry;
  const part=regularPathFrames(trimmed,{spacing:20,phase:5,origin:20});
  assert.deepEqual(part.frames.map(f=>f.id),['mark-1','mark-2','mark-3']);
  for(const frame of part.frames){const original=whole.frames.find(f=>f.id===frame.id)!;near(frame.position,original.position);near([frame.distance+20],[original.distance]);}
});

test('closed paths include the closing edge and emit the seam only once',()=>{
  const sampler=preparePathFrames(square);
  assert.equal(sampler.closed,true);assert.equal(sampler.totalLength,40);assert.deepEqual(sampler.corners,[0,10,20,30]);
  assert.deepEqual(sampler.breakpoints,[0,10,20,30]);
  const seam=sampler.frameAt(40)!;near(seam.position,[0,0]);near(seam.tangent,[1,0]);assert.equal(seam.distance,0);assert.equal(seam.segmentId,'east');
  const close=sampler.frameAt(35)!;near(close.position,[0,5]);near(close.tangent,[0,-1]);assert.equal(close.segmentId,'box:close');
  const marks=regularPathFrames(square,{spacing:10,maxSamples:4});assert.equal(marks.frames.length,4);assert.deepEqual(marks.frames.map(f=>f.distance),[0,10,20,30]);
  const skipped=regularPathFrames(square,{spacing:10,corner:'skip'});assert.deepEqual(skipped.frames,[]);assert.deepEqual(skipped.skipped,[0,10,20,30]);
});

test('sharp joins use outgoing tangents and skip/error only at machine-near boundaries',()=>{
  const following=preparePathFrames(elbow,{tolerance:5}),frame=following.frameAt(10)!;
  assert.deepEqual(following.corners,[10]);near(frame.position,[10,0]);near(frame.tangent,[0,1]);near(frame.normal,[-1,0]);assert.equal(frame.segmentId,'north');
  const skip=preparePathFrames(elbow,{corner:'skip',tolerance:5});assert.equal(skip.frameAt(10),undefined);
  near(skip.frameAt(10-1e-8)!.tangent,[1,0]);near(skip.frameAt(10+1e-8)!.tangent,[0,1]);
  assert.throws(()=>preparePathFrames(elbow,{corner:'error'}).frameAt(10),(e:any)=>e.code==='PATH_FRAME_CORNER');
  const straight:PathGeometry={contours:[{id:'c',start:[0,0],segments:[{id:'a',kind:'line',to:[10,0]},
    {id:'zero',kind:'line',to:[10,0]},{id:'b',kind:'line',to:[20,0]}]}]};
  const smooth=preparePathFrames(straight,{corner:'error'});assert.deepEqual(smooth.corners,[]);assert.deepEqual(smooth.breakpoints,[10]);assert.equal(smooth.frameAt(10)!.segmentId,'b');
});

test('reverse geometry reverses traversal tangents while retaining arc-length positions',()=>{
  const forward=preparePathFrames(elbow),backward=preparePathFrames(reverseCurveGeometry(elbow).geometry);
  for(const distance of [0,3,9,11,17,20]){
    const a=forward.frameAt(distance)!,b=backward.frameAt(forward.totalLength-distance)!;
    near(a.position,b.position);near(a.tangent,b.tangent.map(v=>-v));near(a.normal,b.normal.map(v=>-v));
  }
});

test('nonuniform cubic speed is inverted and known interior cusps are explicit breakpoints',()=>{
  const cubic:PathGeometry={contours:[{id:'c',start:[0,0],segments:[{id:'slow',kind:'cubic',c1:[0,0],c2:[0,0],to:[100,0]}]}]};
  const frames=preparePathFrames(cubic,{tolerance:1e-7});near(frames.frameAt(12.5)!.position,[12.5,0]);near([frames.frameAt(12.5)!.localParameter],[.5]);near(frames.frameAt(0)!.tangent,[1,0]);
  const cusp:PathGeometry={contours:[{id:'c',start:[.0625,0],segments:[{id:'turn',kind:'cubic',c1:[-5/48,0],c2:[.0625,0],to:[.5625,0]}]}]};
  const skip=preparePathFrames(cusp,{cusp:'skip',tolerance:1e-7});near(skip.breakpoints,[.0625]);near([skip.totalLength],[.625]);assert.equal(skip.frameAt(skip.breakpoints[0]),undefined);
  near(skip.frameAt(.03)!.tangent,[-1,0]);near(skip.frameAt(.1)!.tangent,[1,0]);
  const error=preparePathFrames(cusp,{cusp:'error'});assert.throws(()=>error.frameAt(error.breakpoints[0]),(e:any)=>e.code==='UNDEFINED_TANGENT');
  const lattice=regularPathFrames(cusp,{spacing:.0625,cusp:'skip',tolerance:1e-7});assert.deepEqual(lattice.skipped,[.0625]);assert.ok(!lattice.frames.some(f=>f.id==='mark-1'));
});

test('preparation and repeated frames are immutable detached snapshots',()=>{
  const source=line(),configuration:PathFrameOptions={corner:'following'},before=structuredClone(source),sampler=preparePathFrames(source,configuration);
  const first=sampler.frameAt(25)!,second=sampler.frameAt(25)!;assert.deepEqual(first,second);assert.notEqual(first,second);
  assert.deepEqual(source,before);assert.equal(Object.isFrozen(source),false);assert.equal(Object.isFrozen(configuration),false);
  assert.ok(Object.isFrozen(sampler));assert.ok(Object.isFrozen(sampler.corners));assert.ok(Object.isFrozen(first.position));
  assert.throws(()=>{(first.position as any)[0]=999;},TypeError);source.contours[0].segments[0].to[0]=999;configuration.corner='error';near(sampler.frameAt(25)!.position,[25,0]);
  const output=regularPathFrames(before);assert.ok(Object.isFrozen(output.frames));assert.ok(Object.isFrozen(output.skipped));
});

test('candidate budgets count skipped frames and guard unsafe lattice arithmetic',()=>{
  assert.throws(()=>regularPathFrames(line(),{spacing:1,maxSamples:100}),(e:any)=>e.code==='PATH_FRAME_BUDGET');
  assert.equal(regularPathFrames(line(),{spacing:1,maxSamples:101}).frames.length,101);
  assert.throws(()=>regularPathFrames(square,{spacing:10,corner:'skip',maxSamples:3}),(e:any)=>e.code==='PATH_FRAME_BUDGET');
  for(const configuration of [{spacing:Number.MIN_VALUE},{phase:1e20,spacing:1},{origin:-Number.MAX_VALUE,phase:Number.MAX_VALUE}])
    assert.throws(()=>regularPathFrames(line(),configuration),(e:any)=>e.code==='PATH_FRAME_PRECISION');
});

test('malformed JSON, degenerate geometry, unsupported options and distances fail explicitly',()=>{
  for(const geometry of [{contours:[]},{contours:[{id:'c',start:[0,0],segments:[]}]},line(0),
    {contours:[...line().contours,...line().contours.map(c=>({...c,id:'d'}))]},
    {contours:[{id:'c',start:new Array(2),segments:[]}]}, {...line(),unknown:true}])assert.throws(()=>preparePathFrames(geometry as any));
  for(const configuration of [{tolerance:0},{tolerance:Infinity},{corner:'average'},{cusp:'following'},{spacing:20},{corner:undefined}])
    assert.throws(()=>preparePathFrames(line(),configuration as any));
  for(const configuration of [{spacing:0},{startMargin:-1},{maxSamples:0},{maxSamples:1.5},{phase:NaN},{unknown:true}])
    assert.throws(()=>regularPathFrames(line(),configuration as any));
  let touched=false;const getter=Object.defineProperty({},'tolerance',{enumerable:true,get(){touched=true;return 1;}});
  assert.throws(()=>preparePathFrames(line(),getter));assert.equal(touched,false);
  const sampler=preparePathFrames(line());for(const distance of [-1,101,NaN,Infinity,'3'])assert.throws(()=>sampler.frameAt(distance as number));
  const overflow:PathGeometry={contours:[{id:'c',start:[-Number.MAX_VALUE,0],segments:[{id:'s',kind:'line',to:[Number.MAX_VALUE,0]}]}]};
  assert.throws(()=>preparePathFrames(overflow,{cusp:'skip'}),/finite/);
});
