import test from 'node:test';
import assert from 'node:assert/strict';
import {sampleCurveGeometry,trimCurveGeometry,resampleCurveGeometry,reverseCurveGeometry,joinCurveGeometries,
  seedCurveProvenance,assertCurveProvenance,transformCurveInput} from '../src/geometry/curves.ts';
import {geometryLength,evaluateSegment,type PathGeometry} from '../src/path-geometry.ts';

const near=(actual:readonly number[],expected:readonly number[],tolerance=1e-7)=>{
  assert.equal(actual.length,expected.length);actual.forEach((v,i)=>assert.ok(Number.isFinite(v)&&Math.abs(v-expected[i])<=tolerance,`${actual} != ${expected}`));
};
const slow:PathGeometry={contours:[{id:'curve',start:[0,0],segments:[{id:'cubic',kind:'cubic',c1:[0,0],c2:[0,0],to:[100,0]}]}]};
const arch:PathGeometry={contours:[{id:'arch',start:[0,0],segments:[{id:'s',kind:'cubic',c1:[0,100],c2:[100,100],to:[100,0]}]}]};
const disconnected:PathGeometry={contours:[{id:'A',start:[0,0],segments:[{id:'s',kind:'line',to:[10,0]}]},
  {id:'B',start:[100,0],segments:[{id:'s',kind:'line',to:[130,0]}]}]};
const square:PathGeometry={contours:[{id:'loop',start:[0,0],closed:true,segments:[{id:'a',kind:'line',to:[10,0]},
  {id:'b',kind:'line',to:[10,10]},{id:'c',kind:'line',to:[0,10]}]}]};
const lengthOptions={mode:'length' as const,tolerance:1e-6};

test('rich sampling separates parameter speed, accumulated length, and selected contour scope',()=>{
  near(sampleCurveGeometry(slow,.5,{mode:'parameter'}).position,[12.5,0]);
  const sample=sampleCurveGeometry(slow,.5,lengthOptions);
  near(sample.position,[50,0],1e-6);near(sample.tangent,[1,0]);near([sample.length,sample.totalLength],[50,100],1e-6);
  near([sample.localParameter],[Math.cbrt(.5)],1e-8);assert.equal(sample.mapping,'exact');
  assert.equal(sample.sourceRefs[0].segmentId,'cubic');near(sample.sourceRefs[0].parameterInterval,[sample.localParameter,sample.localParameter]);
  near(sampleCurveGeometry(disconnected,.5,{mode:'parameter'}).position,[100,0]);near(sampleCurveGeometry(disconnected,.5,lengthOptions).position,[110,0]);
  const selected=sampleCurveGeometry(disconnected,.5,{...lengthOptions,scope:{kind:'contour',contourId:'B'}});
  near(selected.position,[115,0]);near([selected.length,selected.totalLength],[15,30]);
});

test('trim preserves exact cubic subcurves and composes original parameter provenance',()=>{
  const seed=seedCurveProvenance(slow,'authored'),result=trimCurveGeometry(slow,.2,.8,lengthOptions,seed),contour=result.geometry.contours[0];
  assert.equal(contour.segments[0].kind,'cubic');near(contour.start,[20,0],1e-6);near(contour.segments[0].to,[80,0],1e-6);
  near([geometryLength(result.geometry as PathGeometry)],[60],1e-6);assert.equal(result.report.representation,'exact');
  const [a,b]=result.provenance.segments[0].sources[0].parameterInterval;
  for(let i=0;i<=20;i++)near(evaluateSegment(contour.start as [number,number],contour.segments[0] as any,i/20),[100*(a+(b-a)*i/20)**3,0]);
  const trimmedAgain=trimCurveGeometry(result.geometry,.25,.75,{mode:'parameter'},result.provenance),reference=trimmedAgain.provenance.segments[0].sources[0];
  assert.equal(reference.geometryId,'authored');assert.equal(reference.segmentId,'cubic');
  near(reference.parameterInterval,[a+.25*(b-a),a+.75*(b-a)]);
  assert.deepEqual(trimCurveGeometry(slow,0,1).geometry,slow);
});

test('whole-path trim preserves disconnected moves and equal endpoints keep the located contour identity',()=>{
  const result=trimCurveGeometry(disconnected,.25,.75,{mode:'parameter'});
  assert.equal(result.geometry.contours.length,2);near(result.geometry.contours[0].start,[5,0]);near(result.geometry.contours[1].start,[100,0]);
  near(result.geometry.contours[1].segments[0].to,[115,0]);near([geometryLength(result.geometry as PathGeometry)],[20]);
  const empty=trimCurveGeometry(disconnected,.75,.75,{mode:'parameter'});assert.equal(empty.geometry.contours[0].id,'B');near(empty.geometry.contours[0].start,[115,0]);
  assert.equal(empty.report.outputSegments,0);
  const selected=trimCurveGeometry(disconnected,.25,.75,{scope:{kind:'contour',contourId:'B'}});
  assert.equal(selected.geometry.contours.length,1);near(selected.geometry.contours[0].start,[107.5,0]);
});

test('implicit closing edge sampling, trims and explicit closed wrapping retain source references',()=>{
  const sample=sampleCurveGeometry(square,.875);near(sample.position,[0,5]);near(sample.tangent,[0,-1]);
  assert.equal(sample.segmentId,'loop:close');assert.equal(sample.sourceRefs[0].closing,true);
  const close=trimCurveGeometry(square,.75,1);near(close.geometry.contours[0].start,[0,10]);
  near(close.geometry.contours[0].segments[0].to,[0,0]);assert.equal(close.geometry.contours[0].closed,false);
  assert.equal(close.provenance.segments[0].sources[0].closing,true);
  const wrap=trimCurveGeometry(square,.875,.125,{wrap:true});near(wrap.geometry.contours[0].start,[0,5]);
  near(wrap.geometry.contours[0].segments.at(-1)!.to,[5,0]);near([geometryLength(wrap.geometry as PathGeometry)],[10]);
  assert.equal(wrap.geometry.contours[0].closed,false);assert.equal(wrap.geometry.contours.length,1);
  assert.equal(trimCurveGeometry(square,0,1).geometry.contours[0].closed,true);
});

test('reversal reverses cubic handles, tangent signs, contour order, and original source intervals',()=>{
  const reverse=reverseCurveGeometry(arch,{},seedCurveProvenance(arch,'arch-source'));
  for(const p of [0,.2,.5,.8,1]) {
    const a=sampleCurveGeometry(arch,1-p,{mode:'parameter'}),b=sampleCurveGeometry(reverse.geometry,p,{mode:'parameter'},reverse.provenance);
    near(b.position,a.position);near(b.tangent,a.tangent.map(v=>-v));
    near(b.sourceRefs[0].parameterInterval,[1-p,1-p]);
  }
  assert.deepEqual(reverse.provenance.segments[0].sources[0].parameterInterval,[1,0]);
  near([geometryLength(reverse.geometry as PathGeometry,1e-6)],[200],1e-6);
  const separated=reverseCurveGeometry(disconnected);assert.deepEqual(separated.geometry.contours.map(c=>c.id),['B','A']);
  near(sampleCurveGeometry(separated.geometry,0).position,[130,0]);near([geometryLength(separated.geometry as PathGeometry)],[40]);
  const loop=reverseCurveGeometry(square);near(loop.geometry.contours[0].start,[0,0]);near(sampleCurveGeometry(loop.geometry,0).tangent,[0,1]);
  assert.equal(loop.geometry.contours[0].closed,true);
});

test('count resampling is per contour with open endpoints and unique closed seam samples',()=>{
  const parameter=resampleCurveGeometry(slow,{count:3,mode:'parameter'}),length=resampleCurveGeometry(slow,{count:3,...lengthOptions});
  near(parameter.geometry.contours[0].segments[0].to,[12.5,0]);near(length.geometry.contours[0].segments[0].to,[50,0],1e-6);
  const multi=resampleCurveGeometry(disconnected,{count:3,...lengthOptions});assert.equal(multi.report.sampleCount,6);assert.equal(multi.report.outputSegments,4);
  assert.equal(multi.geometry.contours.length,2);near([geometryLength(multi.geometry as PathGeometry)],[40]);
  const closed=resampleCurveGeometry(square,{count:4,...lengthOptions}),contour=closed.geometry.contours[0];
  assert.equal(closed.report.sampleCount,4);assert.equal(closed.report.outputSegments,4);assert.equal(contour.closed,true);
  assert.deepEqual([contour.start,...contour.segments.map(s=>s.to)],[[0,0],[10,0],[10,10],[0,10],[0,0]]);
  assert.equal(closed.report.representation,'polyline');assert.ok(closed.provenance.segments.every(s=>s.mapping==='approximate'));
});

test('spacing uses unsnapped Float64 ceil and redistributes intervals with endpoints retained',()=>{
  const line=(end:number):PathGeometry=>({contours:[{id:'line',start:[0,0],segments:[{id:'s',kind:'line',to:[end,0]}]}]});
  const result=resampleCurveGeometry(line(10),{mode:'length',spacing:3});assert.equal(result.report.sampleCount,5);
  near(result.geometry.contours[0].segments.map(s=>s.to[0]),[2.5,5,7.5,10]);
  assert.equal(resampleCurveGeometry(line(.3),{mode:'length',spacing:.1}).report.sampleCount,4);
  assert.equal(resampleCurveGeometry(line(.30000000000000004),{mode:'length',spacing:.1}).report.sampleCount,5);
  assert.equal(resampleCurveGeometry(square,{mode:'length',spacing:100}).report.sampleCount,3);
});

test('resampled chords retain conservative original coverage through subsequent exact operations',()=>{
  const result=resampleCurveGeometry(square,{count:3},seedCurveProvenance(square,'original-square'));
  assert.ok(result.provenance.segments.some(s=>s.sources.length>1));
  const reversed=reverseCurveGeometry(result.geometry,{},result.provenance),trimmed=trimCurveGeometry(reversed.geometry,.2,.8,{},reversed.provenance);
  const sample=sampleCurveGeometry(trimmed.geometry,.3,{},trimmed.provenance);
  assert.equal(sample.mapping,'approximate');assert.ok(sample.sourceRefs.every(s=>s.geometryId==='original-square'));
  assert.ok(sample.sourceRefs.some(s=>s.parameterInterval[0]!==s.parameterInterval[1]));
});

test('join policies preserve disconnected topology or insert only explicitly requested bridges',()=>{
  const a={geometry:{contours:[disconnected.contours[0]]}},b={geometry:{contours:[disconnected.contours[1]]}};
  const separate=joinCurveGeometries([a,b],{policy:'separate'});assert.equal(separate.geometry.contours.length,2);
  near([geometryLength(separate.geometry as PathGeometry)],[40]);
  assert.equal(separate.provenance.segments[0].sources[0].geometryId,'join-input-0');
  assert.equal(separate.provenance.segments[1].sources[0].geometryId,'join-input-1');
  assert.throws(()=>joinCurveGeometries([a,b],{policy:'coincident'}),/exactly equal endpoints/);
  const bridge=joinCurveGeometries([a,b],{policy:'bridge'});assert.equal(bridge.report.outputSegments,3);
  near([geometryLength(bridge.geometry as PathGeometry)],[130]);assert.equal(bridge.provenance.segments[1].mapping,'synthetic');
  const sample=sampleCurveGeometry(bridge.geometry,.5,{},bridge.provenance);assert.equal(sample.mapping,'synthetic');assert.deepEqual(sample.sourceRefs,[]);
  const attached={geometry:{contours:[{id:'B',start:[10,0] as [number,number],segments:[{id:'s',kind:'line' as const,to:[15,0] as [number,number]}]}]}};
  assert.equal(joinCurveGeometries([a,attached],{policy:'coincident'}).report.outputSegments,2);
  assert.deepEqual(joinCurveGeometries([],{policy:'separate'}).geometry,{contours:[]});
  assert.throws(()=>joinCurveGeometries([{geometry:square}],{policy:'bridge'}),/closed contours/);
});

test('join remaps reserved closing IDs safely and maintains original identities across duplicate IDs',()=>{
  const original:PathGeometry={contours:[{id:'old',start:[0,0],closed:true,segments:[{id:'join-0-0:close',kind:'line',to:[1,0]}]}]};
  const result=joinCurveGeometries([{geometry:original},{geometry:original}],{policy:'separate'});
  assert.equal(result.geometry.contours[0].segments[0].id,'segment-0');assertCurveProvenance(result.geometry,result.provenance);
  assert.equal(result.provenance.segments[0].sources[0].segmentId,'join-0-0:close');
  assert.equal(result.provenance.segments[1].segmentId,'join-0-0:close');
  assert.notEqual(result.provenance.segments[0].sources[0].geometryId,result.provenance.segments[2].sources[0].geometryId);
});

test('move-only contours stay detached single samples while sampling and invalid options fail',()=>{
  const move:PathGeometry={contours:[{id:'move',start:[4,5],segments:[],closed:false}]},before=structuredClone(move);
  const result=resampleCurveGeometry(move,{count:3});assert.equal(result.report.sampleCount,1);assert.deepEqual(result.geometry,move);
  assert.ok(Object.isFrozen(result.geometry.contours[0].start));assert.deepEqual(move,before);
  assert.throws(()=>sampleCurveGeometry(move,.5),/drawable segment/);
  assert.throws(()=>sampleCurveGeometry(slow,-.1),/\[0,1\]/);
  assert.throws(()=>trimCurveGeometry(slow,.8,.2,{wrap:true}),/closed contour/);
  assert.throws(()=>trimCurveGeometry(square,.8,.2),/explicit wrap/);
  assert.throws(()=>resampleCurveGeometry(square,{count:2}),/at least three/);
  assert.throws(()=>resampleCurveGeometry(slow,{count:65537}),/65536/);
  assert.throws(()=>resampleCurveGeometry(slow,{spacing:1,mode:'parameter'}),/length mode/);
  assert.throws(()=>resampleCurveGeometry(slow,{count:3,spacing:1,mode:'length'}),/exactly one/);
  assert.throws(()=>sampleCurveGeometry(slow,.5,{scope:{kind:'contour',contourId:'missing'}}),/Unknown contour/);
  const bad:any=structuredClone(seedCurveProvenance(slow));bad.segments.push(structuredClone(bad.segments[0]));
  assert.throws(()=>assertCurveProvenance(slow,bad),/exactly once/);
});

test('forward singular transforms preserve collapsed implicit closing-edge provenance explicitly',()=>{
  const source:PathGeometry={contours:[{id:'c',start:[0,0],closed:true,segments:[
    {id:'transform-close',kind:'line',to:[10,0]},{id:'b',kind:'line',to:[0,10]}]}]};
  const seed=seedCurveProvenance(source,'triangle'),before=structuredClone(source);
  const result=transformCurveInput({geometry:source,provenance:seed},[1,0,0,0,0,0]),contour=result.geometry.contours[0];
  assert.equal(contour.segments.length,3);assert.equal(contour.segments[2].id,'transform-close-1');
  near(contour.segments[1].to,[0,0]);near(contour.segments[2].to,[0,0]);
  const close=result.provenance.segments[2];assert.equal(close.segmentId,'transform-close-1');
  assert.equal(close.sources[0].segmentId,'c:close');assert.equal(close.sources[0].geometryId,'triangle');
  assert.equal(close.sources[0].closing,true);assert.deepEqual(close.sources[0].parameterInterval,[0,1]);
  assertCurveProvenance(result.geometry,result.provenance);near([sampleCurveGeometry(result.geometry,.25,{},result.provenance).totalLength],[20]);
  assert.equal(reverseCurveGeometry(result.geometry,{},result.provenance).report.outputSegments,3);
  const identity=transformCurveInput({geometry:source,provenance:seed},[1,0,0,1,0,0]);
  assert.equal(identity.geometry.contours[0].segments.length,2);assert.equal(identity.provenance.segments[2].segmentId,'c:close');
  assert.deepEqual(source,before);assert.ok(Object.isFrozen(result.geometry.contours[0].segments[2]));
});
