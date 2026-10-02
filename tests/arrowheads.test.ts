import test from 'node:test';
import assert from 'node:assert/strict';
import {createArrowGeometry,normalizeArrowOptions,legacyArrowPoints,type ArrowOptions} from '../src/geometry/arrowheads.ts';
import {geometryLength,type PathGeometry} from '../src/path-geometry.ts';
import {validatePathGeometry} from '../src/path-contract.ts';

const line=(from:[number,number]=[0,0],to:[number,number]=[100,0]):PathGeometry=>({contours:[{id:'line',start:from,segments:[{id:'s',kind:'line',to}]}]});
const near=(a:readonly number[],b:readonly number[],tolerance=1e-8)=>{
  assert.equal(a.length,b.length);a.forEach((v,i)=>assert.ok(Number.isFinite(v)&&Math.abs(v-b[i])<=tolerance,`${a} != ${b}`));
};
const points=(geometry:ReturnType<typeof createArrowGeometry>['endTip'])=>{
  const c=geometry.contours[0];return [c.start,...c.segments.map(s=>s.to)];
};

test('default triangle preserves the original endpoint and trims only the returned shaft',()=>{
  const source=line(),before=structuredClone(source),result=createArrowGeometry(source);
  assert.deepEqual(source,before);assert.deepEqual(result.startTip,{contours:[]});assert.deepEqual(validatePathGeometry(result.startTip),[]);
  near(result.report.start.endpoint,[0,0]);near(result.report.end.endpoint,[100,0]);near(result.report.end.visualTip,[100,0]);
  near(result.report.end.shaftEndpoint,[91,0]);assert.equal(result.report.shaftTrimEnd,9);assert.equal(result.report.totalLength,100);
  assert.equal(result.endTip.contours[0].closed,true);assert.equal(result.endTip.contours[0].id,'arrow-end');
  points(result.endTip).forEach((p,i)=>near(p,[[100,0],[91,3.78],[91,-3.78]][i]));
  near([geometryLength(result.shaft as PathGeometry)],[91]);
});

test('two-ended shortening moves visual tips along the source and start frames face outward',()=>{
  const result=createArrowGeometry(line(),{start:1,end:1,shortenStart:3,shortenEnd:4,length:10,width:6});
  near(result.report.start.visualTip,[3,0]);near(result.report.end.visualTip,[96,0]);
  near(result.report.start.shaftEndpoint,[13,0]);near(result.report.end.shaftEndpoint,[86,0]);
  near(result.report.start.tangent,[-1,0]);near(result.report.end.tangent,[1,0]);
  points(result.startTip).forEach((p,i)=>near(p,[[3,0],[13,-3],[13,3]][i]));
  const reversed=createArrowGeometry(line([100,0],[0,0]),{start:1,end:1,length:10,width:6,shortenStart:4,shortenEnd:3});
  near(reversed.report.end.visualTip,result.report.start.visualTip);near(reversed.report.start.visualTip,result.report.end.visualTip);
  near(reversed.report.end.tangent,result.report.start.tangent);near(reversed.report.start.tangent,result.report.end.tangent);
});

test('stealth notch is an explicit polygon vertex and the body ends at its notch distance',()=>{
  const result=createArrowGeometry(line(),{end:2,shortenEnd:3});
  points(result.endTip).forEach((p,i)=>near(p,[[97,0],[88,3.78],[90.52,0],[88,-3.78]][i]));
  near(result.report.end.shaftEndpoint,[90.52,0]);near([result.report.shaftTrimEnd],[9.48]);
  assert.equal(result.endTip.contours[0].segments.length,3);
  const ignored=createArrowGeometry(line(),{end:1,inset:900});near(ignored.report.end.shaftEndpoint,[91,0]);
  const noTips=createArrowGeometry(line(),{start:0,end:0,shortenStart:2,shortenEnd:5});
  near(noTips.report.start.shaftEndpoint,[2,0]);near(noTips.report.end.shaftEndpoint,[95,0]);
  assert.deepEqual(noTips.startTip,{contours:[]});assert.deepEqual(noTips.endTip,{contours:[]});
});

test('length trimming handles nonuniform cubic speed and preserves cubic control geometry',()=>{
  const slow:PathGeometry={contours:[{id:'slow',start:[0,0],segments:[{id:'c',kind:'cubic',c1:[0,0],c2:[0,0],to:[100,0]}]}]};
  const result=createArrowGeometry(slow,{start:1,end:1,shortenStart:3,shortenEnd:10,tolerance:1e-7});
  near(result.report.start.visualTip,[3,0],1e-6);near(result.report.end.visualTip,[90,0],1e-6);
  near(result.report.start.shaftEndpoint,[12,0],1e-6);near(result.report.end.shaftEndpoint,[81,0],1e-6);
  assert.equal(result.shaft.contours[0].segments[0].kind,'cubic');near(result.report.start.tangent,[-1,0]);near(result.report.end.tangent,[1,0]);
  const arch:PathGeometry={contours:[{id:'arch',start:[0,0],segments:[{id:'c',kind:'cubic',c1:[0,100],c2:[100,100],to:[100,0]}]}]};
  const curved=createArrowGeometry(arch,{start:1,end:1,tolerance:1e-5});
  near(curved.report.start.tangent,[0,-1]);near(curved.report.end.tangent,[0,-1]);
  points(curved.endTip).forEach((p,i)=>near(p,[[100,0],[103.78,9],[96.22,9]][i]));
  assert.ok(curved.report.end.shaftEndpoint[1]>0);assert.equal(curved.shaft.contours[0].segments[0].kind,'cubic');
});

test('collision errors use full tip length and clamp uniformly scales every authored distance',()=>{
  assert.throws(()=>createArrowGeometry(line([0,0],[18,0]),{start:1,end:1}), (e:any)=>e.code==='ARROW_COLLISION');
  // Stealth reserves its full outer length for collision even though its shaft stops at the notch.
  assert.throws(()=>createArrowGeometry(line([0,0],[17,0]),{start:2,end:2}), (e:any)=>e.code==='ARROW_COLLISION');
  const result=createArrowGeometry(line([0,0],[10,0]),{start:2,end:2,length:9,width:6,inset:3,shortenStart:2,shortenEnd:4,collision:'clamp'});
  const scale=10/24*(1-1e-6);near([result.report.scale],[scale]);near([result.report.shortenStart,result.report.shortenEnd],[2*scale,4*scale]);
  near([result.report.shaftTrimStart,result.report.shaftTrimEnd],[8*scale,10*scale]);
  const tip=points(result.endTip);near([Math.abs(tip[1][1]-tip[3][1])],[6*scale]);
  near([tip[2][0]-tip[1][0]],[3*scale]);assert.ok(geometryLength(result.shaft as PathGeometry)>0);
  assert.deepEqual(createArrowGeometry(line(),{collision:'clamp'}),createArrowGeometry(line()));
});

test('arrow inputs reject invalid topology, dimensions, JSON and undefined path directions',()=>{
  for(const input of [{contours:[]},{contours:[{id:'c',start:[0,0],segments:[]}]},line([0,0],[0,0]),
    {contours:[{...line().contours[0],closed:true}]},{contours:[...line().contours,...line([200,0],[250,0]).contours.map(c=>({...c,id:'other'}))]}])
    assert.throws(()=>createArrowGeometry(input as PathGeometry));
  const bad=[{length:0},{width:0},{tolerance:0},{shortenStart:-1},{end:3},{start:true},{collision:'silent'},
    {inset:-1},{end:2,inset:-1},{end:2,inset:9},{length:Infinity},{unknown:1},{inset:undefined}];
  for(const option of bad)assert.throws(()=>normalizeArrowOptions(option as ArrowOptions));
  assert.throws(()=>createArrowGeometry(line([0,0],[1,0]),{width:Number.MIN_VALUE,collision:'clamp'}),
    (e:any)=>e.code==='ARROW_PRECISION');
  const sparse:any={contours:[{id:'c',start:new Array(2),segments:[]}]};assert.throws(()=>createArrowGeometry(sparse));
  let touched=false;const getter=Object.defineProperty({},'length',{enumerable:true,get(){touched=true;return 9;}});
  assert.throws(()=>normalizeArrowOptions(getter));assert.equal(touched,false);
  const cusp:PathGeometry={contours:[{id:'c',start:[0,0],segments:[{id:'s',kind:'cubic',c1:[1,0],c2:[1,0],to:[0,0]}]}]};
  assert.throws(()=>createArrowGeometry(cusp,{start:1,end:0,shortenStart:.75,length:.1,width:.1}),/Tangent|tangent/);
});

test('results are detached immutable snapshots with stable identifiers and no caller freezing',()=>{
  const geometry=line(),options:ArrowOptions={start:1,end:2},before=structuredClone({geometry,options}),result=createArrowGeometry(geometry,options);
  assert.deepEqual({geometry,options},before);assert.ok(!Object.isFrozen(geometry));assert.ok(!Object.isFrozen(options));
  assert.ok(Object.isFrozen(result));assert.ok(Object.isFrozen(result.shaft.contours[0].segments));assert.ok(Object.isFrozen(result.report.end.visualTip));
  assert.throws(()=>{(result.report.end.visualTip as any)[0]=0;},TypeError);
  geometry.contours[0].start[0]=-100;options.length=20;near(result.report.start.endpoint,[0,0]);
  const again=createArrowGeometry(before.geometry,before.options);assert.deepEqual(again,result);
});

test('legacy triangles retain the historical dimensions and collapsed-handle fallback',()=>{
  const resolved={start:[0,0] as [number,number],c1:[0,0] as [number,number],c2:[30,40] as [number,number],end:[30,40] as [number,number]};
  const end=legacyArrowPoints(resolved,true);near(end[0],[30,40]);near(end[1],[21.576,35.068]);near(end[2],[27.624,30.532]);
  const start=legacyArrowPoints(resolved,false);near(start[0],[0,0]);near(start[1],[8.424,4.932]);near(start[2],[2.376,9.468]);
  end[0][0]=0;assert.equal(resolved.end[0],30);
  assert.throws(()=>legacyArrowPoints({start:[0,0],c1:[0,0],c2:[0,0],end:[0,0]},true),(e:any)=>e.code==='ARROW_DIRECTION');
});
