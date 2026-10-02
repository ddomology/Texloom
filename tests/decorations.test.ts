import test from 'node:test';
import assert from 'node:assert/strict';
import {createPathDecoration,createBraceGeometry,normalizeDecorationOptions,type DecorationOptions} from '../src/geometry/decorations.ts';
import {geometryBounds,type PathGeometry} from '../src/path-geometry.ts';
import {validatePathGeometry} from '../src/path-contract.ts';

const line=(a:[number,number]=[0,0],b:[number,number]=[100,0]):PathGeometry=>({contours:[{id:'c',start:a,segments:[{id:'s',kind:'line',to:b}]}]});
const near=(a:readonly number[],b:readonly number[],tolerance=1e-8)=>{assert.equal(a.length,b.length);a.forEach((v,i)=>assert.ok(Number.isFinite(v)&&Math.abs(v-b[i])<tolerance,`${a} != ${b}`));};
const square:PathGeometry={contours:[{id:'square',closed:true,start:[0,0],segments:[{id:'a',kind:'line',to:[10,0]},{id:'b',kind:'line',to:[10,10]},{id:'c',kind:'line',to:[0,10]}]}]};

test('ticks use arc distance and exact transverse endpoints, leaving logical input unchanged',()=>{
  const input=line(),before=structuredClone(input),result=createPathDecoration(input);
  assert.deepEqual(input,before);assert.equal(result.report.totalLength,100);assert.equal(result.report.candidateCount,6);
  assert.equal(result.report.emittedCount,6);assert.equal(result.report.representation,'exact');
  result.geometry.contours.forEach((c,i)=>{assert.equal(c.id,`mark-${i}`);near(c.start,[20*i,-3]);near(c.segments[0].to,[20*i,3]);});
  assert.deepEqual(validatePathGeometry(result.geometry),[]);
  const slow:PathGeometry={contours:[{id:'c',start:[0,0],segments:[{id:'s',kind:'cubic',c1:[0,0],c2:[0,0],to:[100,0]}]}]};
  createPathDecoration(slow,{tolerance:1e-7}).geometry.contours.forEach((c,i)=>near(c.start,[20*i,-3],1e-6));
});

test('global phase and origin preserve lattice IDs after trim and margins',()=>{
  const whole=createPathDecoration(line(),{spacing:20,phase:5,startMargin:10,endMargin:10});
  assert.deepEqual(whole.report.sampleIds,['mark-1','mark-2','mark-3','mark-4']);
  const trimmed=createPathDecoration(line([20,0],[80,0]),{spacing:20,phase:5,origin:20});
  assert.deepEqual(trimmed.report.sampleIds,['mark-1','mark-2','mark-3']);
  assert.deepEqual(trimmed.geometry.contours,whole.geometry.contours.slice(0,3));
  const negative=createPathDecoration(line(),{spacing:20,phase:45});
  assert.equal(negative.report.sampleIds[0],'mark--2');near(negative.geometry.contours[0].start,[5,-3]);
});

test('mark orientation changes its basis while offset retains the original normal',()=>{
  const input=line([0,0],[0,20]),options={kind:'marks' as const,spacing:100,offset:2,size:6};
  const expected={tangent:[[1,-3],[-2,0],[-5,-3]],fixed:[[-5,-3],[-2,0],[-5,3]],reverse:[[-5,3],[-2,0],[1,3]]};
  for(const orientation of ['tangent','fixed','reverse'] as const){
    const c=createPathDecoration(input,{...options,orientation}).geometry.contours[0];
    [c.start,...c.segments.map(s=>s.to)].forEach((p,i)=>near(p,expected[orientation][i]));
  }
  const reversed=createPathDecoration(line([100,0],[0,0]),{offset:2});
  near(reversed.geometry.contours[0].start,[100,1]);near(reversed.geometry.contours[0].segments[0].to,[100,-5]);
});

test('custom symbols preserve cubic geometry and get deterministic collision-free IDs',()=>{
  const symbol:PathGeometry={contours:[{id:'art',closed:true,start:[0,0],segments:[{id:'bend',kind:'cubic',c1:[1,0],c2:[2,1],to:[3,1]}]},
    {id:'dot',start:[-1,0],segments:[]}]};
  const result=createPathDecoration(line([0,0],[0,20]),{kind:'symbols',spacing:20,symbolScale:2,offset:1},symbol);
  assert.equal(result.geometry.contours.length,4);assert.deepEqual(result.report.sampleIds,['mark-0','mark-1']);
  const c=result.geometry.contours[0],segment=c.segments[0];assert.equal(c.id,'mark-0:contour-0');assert.equal(c.closed,true);assert.equal(segment.kind,'cubic');
  if(segment.kind==='cubic'){near(c.start,[-1,0]);near(segment.c1,[-1,2]);near(segment.c2,[-3,4]);near(segment.to,[-3,6]);}
  assert.deepEqual(validatePathGeometry(result.geometry),[]);
  symbol.contours[0].start[0]=99;near(result.geometry.contours[0].start,[-1,0]);
});

test('snake samples an independent sine wave with phase, margins and normal offset',()=>{
  const result=createPathDecoration(line([0,0],[80,0]),{kind:'snake',spacing:20,resolution:4,amplitude:3,offset:2,phase:5,startMargin:2,endMargin:3});
  assert.equal(result.report.representation,'polyline');assert.equal(result.geometry.contours.length,1);
  const c=result.geometry.contours[0];assert.notEqual(c.closed,true);
  const points=[c.start,...c.segments.map(s=>s.to)];near(points[0],[2,2+3*Math.sin(-3*Math.PI/10)]);near(points.at(-1)!,[77,2+3*Math.sin(7.2*Math.PI)]);
  points.forEach(([x,y])=>near([y],[2+3*Math.sin(2*Math.PI*(x-5)/20)]));
  assert.equal(result.report.candidateCount,17);assert.equal(result.report.emittedCount,17);
  const common={kind:'snake' as const,spacing:20,resolution:4,amplitude:3};
  assert.deepEqual(createPathDecoration(line(),{...common,origin:1e308,phase:1e308}),createPathDecoration(line(),common));
});

test('closed regular samples do not duplicate the seam and a nonperiodic snake remains open',()=>{
  const marks=createPathDecoration(square,{spacing:10});assert.equal(marks.report.emittedCount,4);assert.deepEqual(marks.report.sampleIds,['mark-0','mark-1','mark-2','mark-3']);
  const snake=createPathDecoration(square,{kind:'snake',spacing:24,resolution:4,amplitude:2});
  assert.equal(snake.geometry.contours.length,1);const c=snake.geometry.contours[0];assert.notEqual(c.closed,true);
  near(c.start,[0,0]);near(c.segments.at(-1)!.to,[0,2*Math.sin(2*Math.PI*40/24)]);
});

test('snake keeps boundary lattice IDs across path growth despite quotient roundoff',()=>{
  const options={kind:'snake' as const,spacing:.4,resolution:4,phase:.3,amplitude:.01};
  const short=createPathDecoration(line([0,0],[1,0]),{...options,maxSamples:11});
  const long=createPathDecoration(line([0,0],[1.1,0]),options);
  assert.equal(short.report.sampleIds.at(-1),'snake-7');
  assert.deepEqual(short.report.sampleIds,long.report.sampleIds.slice(0,short.report.sampleIds.length));
  assert.equal(short.report.candidateCount,11);
  assert.throws(()=>createPathDecoration(line([0,0],[1,0]),{...options,maxSamples:10}),/budget/i);
  const c=short.geometry.contours[0],larger=long.geometry.contours[0];
  assert.deepEqual(c.segments.at(-1),larger.segments.find(s=>s.id==='to-snake-7'));
  const lower=createPathDecoration(line([0,0],[1.1,0]),{...options,phase:.7,startMargin:1});
  assert.equal(lower.report.sampleIds[0],'snake-3');near(lower.geometry.contours[0].start,[1,-.01]);
});

test('skipped corners and off-grid cusps split snake output instead of bridging a gap',()=>{
  const elbow:PathGeometry={contours:[{id:'c',start:[0,0],segments:[{id:'a',kind:'line',to:[10,0]},{id:'b',kind:'line',to:[10,10]}]}]};
  const ticks=createPathDecoration(elbow,{spacing:10,corner:'skip'});assert.deepEqual(ticks.report.skippedIds,['mark-1']);assert.equal(ticks.report.candidateCount,3);assert.equal(ticks.report.emittedCount,2);
  const snake=createPathDecoration(elbow,{kind:'snake',spacing:32,resolution:4,corner:'skip'});
  assert.equal(snake.report.skippedIds.length,1);assert.equal(snake.geometry.contours.length,2);
  assert.throws(()=>createPathDecoration(elbow,{spacing:10,corner:'error'}),(error:any)=>error.code==='PATH_FRAME_CORNER');
  // x(t)=(t-.25)^2-.0625: the stationary point is not on the 0.04bp grid.
  const cusp:PathGeometry={contours:[{id:'c',start:[0,0],segments:[{id:'s',kind:'cubic',c1:[-1/6,0],c2:[0,0],to:[.5,0]}]}]};
  const split=createPathDecoration(cusp,{kind:'snake',spacing:.16,resolution:4,cusp:'skip',tolerance:1e-8});
  assert.equal(split.report.skippedIds.length,1);assert.equal(split.geometry.contours.length,2);
  assert.throws(()=>createPathDecoration(cusp,{kind:'snake',spacing:.16,resolution:4,tolerance:1e-8}),(error:any)=>error.code==='UNDEFINED_TANGENT');
});

test('sample and expanded symbol budgets fail before unbounded replication',()=>{
  assert.throws(()=>createPathDecoration(line(),{spacing:.001}),/budget|samples/i);
  assert.throws(()=>createPathDecoration(line(),{kind:'snake',spacing:.1,resolution:128}),/budget/i);
  const symbol:PathGeometry={contours:[{id:'c',start:[0,0],segments:Array.from({length:100},(_,i)=>({id:`s${i}`,kind:'line' as const,to:[i+1,0] as [number,number]}))}]};
  assert.throws(()=>createPathDecoration(line([0,0],[2047,0]),{kind:'symbols',spacing:1},symbol),/budget/i);
  assert.deepEqual(createPathDecoration(line(),{startMargin:80,endMargin:30}).geometry,{contours:[]});
});

test('options and JSON inputs fail explicitly without evaluating accessors',()=>{
  for(const option of [{size:0},{symbolScale:-1},{resolution:3},{resolution:4.5},{maxSamples:2049},{spacing:0},{startMargin:-1},{phase:Infinity},{orientation:'random'},{kind:'unknown'},{extra:1}])
    assert.throws(()=>normalizeDecorationOptions(option as DecorationOptions));
  assert.throws(()=>createPathDecoration(line(),{kind:'symbols'}),/symbol/i);assert.throws(()=>createPathDecoration(line(),{},line()),/symbol/i);
  assert.throws(()=>createPathDecoration({contours:[{id:'c',start:new Array(2),segments:[]}]} as unknown as PathGeometry));
  let touched=false;const getter=Object.defineProperty({},'size',{enumerable:true,get(){touched=true;return 6;}});
  assert.throws(()=>normalizeDecorationOptions(getter));assert.equal(touched,false);
});

test('all returned geometry and metadata are detached immutable snapshots',()=>{
  const input=line(),options:DecorationOptions={kind:'marks'},before=structuredClone({input,options}),result=createPathDecoration(input,options);
  assert.deepEqual({input,options},before);assert.ok(!Object.isFrozen(input));assert.ok(!Object.isFrozen(options));assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.geometry.contours[0].segments));assert.ok(Object.isFrozen(result.report.sampleIds));
  assert.throws(()=>{(result.geometry.contours[0].start as any)[0]=999;},TypeError);
  input.contours[0].start[0]=999;options.size=100;assert.deepEqual(createPathDecoration(before.input,before.options),result);
});

test('brace has ordered endpoints, four cubic bends and the requested cusp and extrema',()=>{
  const result=createBraceGeometry([0,0],[100,0],{amplitude:12,aspect:.3,offset:4}),c=result.contours[0];
  near(c.start,[0,4]);near(c.segments.at(-1)!.to,[100,4]);assert.equal(c.segments.filter(s=>s.kind==='cubic').length,4);
  near(c.segments.find(s=>s.id==='left-cusp')!.to,[30,16]);near(geometryBounds(result as PathGeometry)!,[0,4,100,12]);
  const negative=createBraceGeometry([10,20],[10,120],{amplitude:-12,aspect:.3,offset:4});
  near(negative.contours[0].start,[6,20]);near(negative.contours[0].segments.find(s=>s.id==='left-cusp')!.to,[18,50]);
  near(negative.contours[0].segments.at(-1)!.to,[6,120]);assert.deepEqual(validatePathGeometry(negative),[]);
  assert.ok(Object.isFrozen(result.contours[0].segments));
});

test('brace handles zero amplitude, tight spans, reversal, and rejects degenerate data',()=>{
  const flat=createBraceGeometry([0,0],[1,0],{amplitude:0});near(geometryBounds(flat as PathGeometry)!,[0,0,1,0]);
  const narrow=createBraceGeometry([0,0],[1,0],{amplitude:100,aspect:.1});near(narrow.contours[0].segments.find(s=>s.id==='left-cusp')!.to,[.1,100]);
  const reverse=createBraceGeometry([100,0],[0,0],{amplitude:12,aspect:.7});near(reverse.contours[0].segments.find(s=>s.id==='left-cusp')!.to,[30,-12]);
  for(const options of [{aspect:0},{aspect:1},{amplitude:NaN},{offset:Infinity},{extra:1}])assert.throws(()=>createBraceGeometry([0,0],[100,0],options));
  assert.throws(()=>createBraceGeometry([0,0],[0,0]),/separation/i);
});


