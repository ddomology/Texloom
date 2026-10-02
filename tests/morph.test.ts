import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareCorrespondence,sampleCorrespondence,type CorrespondenceOptions} from '../src/geometry/correspondence.js';
import type {PathGeometry,PathContour,PathPoint,PathSegment} from '../src/path-geometry.js';
const line=(id='main',x=0):PathGeometry=>({contours:[{id,start:[x,0],segments:[{id:'edge',kind:'line',to:[x+12,0]}]}]});
const curve=():PathGeometry=>({contours:[{id:'main',start:[0,0],segments:[{id:'edge',kind:'cubic',c1:[0,12],c2:[12,12],to:[12,0]}]}]});
const matched:CorrespondenceOptions={approved:true,contours:[{source:'main',target:'main',segments:[{source:'edge',target:'edge'}]}]};
const fail=(fn:()=>unknown,pattern:RegExp)=>assert.throws(fn,(e:unknown)=>e instanceof Error&&'code' in e&&pattern.test(String(e.code)));
const near=(a:readonly number[],b:readonly number[])=>a.forEach((v,i)=>assert.ok(Math.abs(v-b[i])<1e-9,`${a} != ${b}`));
const mapped=(source:PathContour,target:PathContour)=>({source:source.id,target:target.id,segments:source.segments.map((s,i)=>({source:s.id,target:target.segments[i].id}))});
function polygon(id:string,points:PathPoint[]):PathContour{return {id,start:points[0],closed:true,segments:points.slice(1).map((to,i)=>({id:`edge-${i}`,kind:'line',to}))};}
function signedArea(c:{start:readonly number[];segments:readonly {to:readonly number[]}[]}):number {
 const points=[c.start,...c.segments.map(s=>s.to)];let sum=0;for(let i=0;i<points.length;i++){const a=points[i],b=points[(i+1)%points.length];sum+=a[0]*b[1]-a[1]*b[0];}return sum/2;
}

test('approved line-to-cubic correspondence promotes controls while original endpoints remain byte-for-byte geometric snapshots',()=>{
 const source=line(),target=curve(),beforeSource=structuredClone(source),beforeTarget=structuredClone(target),prepared=prepareCorrespondence(source,target,matched);
 const first=sampleCorrespondence(prepared,0),last=sampleCorrespondence(prepared,1),middle=sampleCorrespondence(prepared,.5);
 assert.deepEqual(first.geometry,source);assert.deepEqual(last.geometry,target);
 const segment=middle.matched.contours[0].segments[0];assert.equal(segment.kind,'cubic');if(segment.kind!=='cubic')throw Error('Expected promoted cubic');
 near(segment.c1,[2,6]);near(segment.c2,[10,6]);near(segment.to,[12,0]);near(middle.matched.contours[0].start,[0,0]);
 assert.deepEqual(prepared.report.pairs[0].segments,[{source:'edge',target:'edge',promotedSource:true,promotedTarget:false}]);
 assert.equal(prepared.report.endpointPolicy,'original-snapshots');assert.deepEqual(source,beforeSource);assert.deepEqual(target,beforeTarget);
});

test('explicit reversed open correspondence swaps cubic handles and pairs reversed original segment IDs',()=>{
 const target:PathGeometry={contours:[{id:'back',start:[12,0],segments:[{id:'back-edge',kind:'cubic',c1:[12,12],c2:[0,12],to:[0,0]}]}]};
 const prepared=prepareCorrespondence(curve(),target,{approved:true,contours:[{source:'main',target:'back',reverseTarget:true,segments:[{source:'edge',target:'back-edge'}]}]});
 const mid=sampleCorrespondence(prepared,.5).matched.contours[0].segments[0];assert.equal(mid.kind,'cubic');if(mid.kind!=='cubic')throw Error('Expected cubic');
 near(mid.c1,[0,12]);near(mid.c2,[12,12]);near(mid.to,[12,0]);assert.deepEqual(sampleCorrespondence(prepared,1).geometry,target);
});

test('closed contour reversal handles the implicit closing edge without silently changing winding',()=>{
 const source={contours:[polygon('square',[[0,0],[10,0],[10,10],[0,10]])]},target={contours:[polygon('reverse',[[0,10],[10,10],[10,0],[0,0]])]};
 const mapping={source:'square',target:'reverse',segments:[{source:'edge-0',target:'edge-2'},{source:'edge-1',target:'edge-1'},{source:'edge-2',target:'edge-0'}]};
 fail(()=>prepareCorrespondence(source,target,{approved:true,contours:[{...mapping,reverseTarget:false}]}),/WINDING/);
 const prepared=prepareCorrespondence(source,target,{approved:true,contours:[{...mapping,reverseTarget:true}]});
 const mid=sampleCorrespondence(prepared,.5).matched.contours[0];assert.equal(mid.closed,true);near(mid.start,[0,0]);near(mid.segments[2].to,[0,10]);assert.equal(signedArea(mid),100);
 assert.equal(prepared.report.pairs[0].sourceWinding,1);assert.equal(prepared.report.pairs[0].targetWinding,-1);assert.equal(prepared.report.pairs[0].alignedTargetWinding,1);
});

test('outer contours and holes preserve opposite winding independently across matched multipath transitions',()=>{
 const outer=polygon('outer',[[0,0],[12,0],[12,12],[0,12]]),hole=polygon('hole',[[3,3],[3,9],[9,9],[9,3]]);
 const source={contours:[outer,hole]},target:PathGeometry=structuredClone(source);
 for(const c of target.contours){c.start=c.start.map(v=>2*v+5) as PathPoint;for(const s of c.segments)s.to=s.to.map(v=>2*v+5) as PathPoint;}
 const prepared=prepareCorrespondence(source,target,{approved:true,contours:source.contours.map((c,i)=>mapped(c,target.contours[i]))});
 const sample=sampleCorrespondence(prepared,.5);assert.equal(sample.geometry.contours.length,2);
 assert.ok(signedArea(sample.matched.contours[0])>0);assert.ok(signedArea(sample.matched.contours[1])<0);
 near(sample.matched.contours[0].start,[2.5,2.5]);near(sample.matched.contours[1].start,[7,7]);
 assert.deepEqual(prepared.report.pairs.map(p=>[p.sourceWinding,p.targetWinding]),[[1,1],[-1,-1]]);
});

test('multipath order is explicitly mapped without inventing a connector between contours',()=>{
 const source={contours:[line('a').contours[0],line('b',100).contours[0]]},target={contours:[line('c',10).contours[0],line('d',200).contours[0]]};
 const prepared=prepareCorrespondence(source,target,{approved:true,contours:[mapped(source.contours[1],target.contours[1]),mapped(source.contours[0],target.contours[0])]});
 const mid=sampleCorrespondence(prepared,.5);assert.equal(mid.geometry.contours.length,2);assert.equal(mid.geometry.contours.reduce((n,c)=>n+c.segments.length,0),2);
 near(mid.geometry.contours[0].start,[150,0]);near(mid.geometry.contours[1].start,[5,0]);assert.deepEqual(sampleCorrespondence(prepared,1).geometry,target);
});

test('unequal segment counts require opt-in per-contour arc-length resampling with a correspondence report',()=>{
 const source=line(),target:PathGeometry={contours:[{id:'main',start:[0,0],segments:[{id:'a',kind:'line',to:[6,6]},{id:'b',kind:'line',to:[12,0]}]}]};
 fail(()=>prepareCorrespondence(source,target,matched),/TOPOLOGY/);
 const prepared=prepareCorrespondence(source,target,{approved:true,contours:[{source:'main',target:'main'}],resample:{count:5,tolerance:.001}});
 const mid=sampleCorrespondence(prepared,.5).matched.contours[0],points=[mid.start,...mid.segments.map(s=>s.to)];
 [[0,0],[3,1.5],[6,3],[9,1.5],[12,0]].forEach((p,i)=>near(points[i],p));
 assert.equal(prepared.report.resampled,true);assert.equal(prepared.report.pairs[0].representation,'arc-length-polyline');assert.equal(prepared.report.pairs[0].sampleCount,5);
 assert.deepEqual(sampleCorrespondence(prepared,0).geometry,source);assert.deepEqual(sampleCorrespondence(prepared,1).geometry,target);
 fail(()=>prepareCorrespondence(source,target,{...matched,resample:{count:5}}),/MAP/);
});

test('unmatched fade and create partitions carry explicit weights rather than silently disappearing geometry',()=>{
 const source={contours:[line().contours[0],line('leaving',30).contours[0]]},target={contours:[curve().contours[0],line('entering',60).contours[0]]};
 fail(()=>prepareCorrespondence(source,target,matched),/UNMATCHED/);
 for(const policy of ['fade','create'] as const){const prepared=prepareCorrespondence(source,target,{...matched,unmatched:policy}),mid=sampleCorrespondence(prepared,.25);
  assert.equal(mid.matched.contours.length,1);assert.equal(mid.sourceOnly.contours.length,1);assert.equal(mid.targetOnly.contours.length,1);
  assert.deepEqual(prepared.report.sourceOnly,['leaving']);assert.deepEqual(prepared.report.targetOnly,['entering']);
  if(policy==='fade'){near([mid.sourceOpacity,mid.targetOpacity],[.75,.25]);near([mid.sourceReveal,mid.targetReveal],[1,1]);}
  else{near([mid.sourceOpacity,mid.targetOpacity],[1,1]);near([mid.sourceReveal,mid.targetReveal],[.75,.25]);}
  assert.equal(sampleCorrespondence(prepared,0).targetOpacity,0);assert.equal(sampleCorrespondence(prepared,1).sourceOpacity,0);
  assert.deepEqual(sampleCorrespondence(prepared,0).geometry,source);assert.deepEqual(sampleCorrespondence(prepared,1).geometry,target);
 }
});

test('zero-length authored segments remain explicit, duplicate IDs and disconnected mapping permutations are rejected',()=>{
 const source:PathGeometry={contours:[{id:'main',start:[0,0],segments:[{id:'zero',kind:'line',to:[0,0]},{id:'edge',kind:'line',to:[12,0]}]}]},target=structuredClone(source);
 const options:CorrespondenceOptions={approved:true,contours:[mapped(source.contours[0],target.contours[0])]};
 const prepared=prepareCorrespondence(source,target,options);assert.equal(prepared.report.pairs[0].sourceZeroSegments,1);assert.equal(sampleCorrespondence(prepared,.5).geometry.contours[0].segments.length,2);
 const duplicated=structuredClone(source);duplicated.contours[0].segments[1].id='zero';fail(()=>prepareCorrespondence(duplicated,target,options),/GEOMETRY/);
 const dupMap=structuredClone(options);dupMap.contours[0].segments![1].source='zero';fail(()=>prepareCorrespondence(source,target,dupMap),/DUPLICATE/);
 const disconnected=structuredClone(options);disconnected.contours[0].segments!.reverse();fail(()=>prepareCorrespondence(source,target,disconnected),/ORDER/);
 const duplicateContours=structuredClone(options);duplicateContours.contours.push(duplicateContours.contours[0]);fail(()=>prepareCorrespondence(source,target,duplicateContours),/DUPLICATE/);
});

test('closed-state mismatches, unsupported approval, hostile inputs and sampling budgets fail explicitly',()=>{
 const closed=line();closed.contours[0].closed=true;fail(()=>prepareCorrespondence(line(),closed,matched),/CLOSED/);
 fail(()=>prepareCorrespondence(line(),curve(),{...matched,approved:false} as any),/APPROVAL/);
 fail(()=>prepareCorrespondence(line(),curve(),{...matched,resample:{count:4097}}),/RESAMPLE/);
 const many:PathGeometry={contours:Array.from({length:129},(_,i)=>line(`c${i}`).contours[0])};fail(()=>prepareCorrespondence(many,line(),matched),/BUDGET/);
 let reads=0;const input={get contours(){reads++;return [];}} as PathGeometry;fail(()=>prepareCorrespondence(input,line(),matched),/DATA/);assert.equal(reads,0);
 const prepared=prepareCorrespondence(line(),curve(),matched);for(const p of [-.1,1.1,NaN,Infinity])fail(()=>sampleCorrespondence(prepared,p),/PROGRESS/);
});

test('prepared geometry and every returned frame are detached immutable snapshots independent of seek order',()=>{
 const source=line(),target=curve(),original=structuredClone(source),prepared=prepareCorrespondence(source,target,matched),expected=sampleCorrespondence(prepared,.37);
 source.contours[0].start[0]=100;target.contours[0].segments[0].to[0]=500;
 assert.deepEqual(sampleCorrespondence(prepared,0).geometry,original);sampleCorrespondence(prepared,1);sampleCorrespondence(prepared,.9);sampleCorrespondence(prepared,0);
 assert.deepEqual(sampleCorrespondence(prepared,.37),expected);assert.ok(Object.isFrozen(prepared.source.contours[0].start));assert.ok(Object.isFrozen(expected.matched.contours[0].segments[0]));
 assert.throws(()=>{(expected.geometry.contours[0].start as PathPoint)[0]=999;},TypeError);
});
