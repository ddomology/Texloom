import test from 'node:test';
import assert from 'node:assert/strict';
import {validatePrimitive,samplePrimitive,primitiveBounds,primitiveToPath,type Primitive2D,type PrimitivePathOptions} from '../src/geometry/primitives.ts';

const options:PrimitivePathOptions={profile:'cubic',tolerance:.01,maxSegments:4096};
const near=(actual:readonly number[],expected:readonly number[],tolerance=1e-10)=>{
  assert.equal(actual.length,expected.length);
  actual.forEach((value,i)=>assert.ok(Number.isFinite(value)&&Math.abs(value-expected[i])<=tolerance,`${actual} != ${expected}`));
};
const circle:Primitive2D={kind:'circle',center:[3,-2],radius:10};

test('analytic primitive validation rejects malformed definitions and explicit degenerate domains',()=>{
  const invalid:unknown[]=[null,{},[],{...circle,kind:'torus'},{...circle,extra:1},{...circle,radius:0},
    {...circle,radius:-1},{...circle,center:[1,Infinity]},{...circle,center:[1]},
    {kind:'ellipse',center:[0,0],rx:1,ry:0},
    {kind:'arc',center:[0,0],rx:1,ry:1,startAngle:0,sweepAngle:0},
    {kind:'arc',center:[0,0],rx:1,ry:1,startAngle:0,sweepAngle:7},
    {kind:'rectangle',origin:[0,0],width:0,height:2},
    {kind:'roundedRectangle',origin:[0,0],width:4,height:2,cornerRadius:1.01},
    {kind:'polyline',points:[[0,0],[1,1]],closed:true},
    {kind:'polyline',points:[[0,0],[0,0]],closed:false},
    {kind:'polyline',points:[[0,0],[1,0],[0,0]],closed:true}];
  for(const value of invalid)assert.ok(validatePrimitive(value).length,JSON.stringify(value));
  assert.deepEqual(validatePrimitive(circle),[]);
  assert.deepEqual(validatePrimitive({kind:'polyline',points:[[0,0],[2,2],[0,2],[2,0]],closed:true}),[]);
});

test('circle and ellipse retain analytic angular samples and unit tangents independent of rendering',()=>{
  near(samplePrimitive(circle,0).point,[13,-2]);near(samplePrimitive(circle,.25).point,[3,8]);
  near(samplePrimitive(circle,.25).tangent,[-1,0]);near(samplePrimitive(circle,1).point,[13,-2]);
  near(samplePrimitive(circle,-3).point,[13,-2]);near(samplePrimitive(circle,5).point,[13,-2]);
  const ellipse:Primitive2D={kind:'ellipse',center:[0,0],rx:8,ry:2};
  near(samplePrimitive(ellipse,.125).point,[4*Math.SQRT2,Math.SQRT2]);
  near(samplePrimitive(ellipse,.125).tangent,[-4/Math.sqrt(17),1/Math.sqrt(17)]);
  assert.throws(()=>samplePrimitive(circle,NaN),/PRIMITIVE_DOMAIN/);
  near(primitiveBounds(circle),[-7,-12,20,20]);near(primitiveBounds(ellipse),[-8,-2,16,4]);
});

test('signed arcs preserve endpoint direction, analytic extrema, and open full sweeps',()=>{
  const arc:Primitive2D={kind:'arc',center:[3,4],rx:8,ry:2,startAngle:Math.PI/2,sweepAngle:-Math.PI};
  near(samplePrimitive(arc,0).point,[3,6]);near(samplePrimitive(arc,.5).point,[11,4]);
  near(samplePrimitive(arc,.5).tangent,[0,-1]);near(samplePrimitive(arc,1).point,[3,2]);
  near(primitiveBounds(arc),[3,2,8,4]);
  const reverse={...arc,startAngle:-Math.PI/2,sweepAngle:Math.PI};
  near(primitiveBounds(reverse),[3,2,8,4]);near(samplePrimitive(reverse,.5).tangent,[0,1]);
  const full={...arc,startAngle:0,sweepAngle:2*Math.PI};
  assert.equal(primitiveToPath(full,options).geometry.contours[0].closed,false);
  near(primitiveBounds(full),[-5,2,16,4]);
});

test('rectangle and polyline sampling follows perimeter distance with right-hand corner tangents',()=>{
  const rectangle:Primitive2D={kind:'rectangle',origin:[1,2],width:4,height:2};
  near(samplePrimitive(rectangle,.25).point,[4,2]);
  near(samplePrimitive(rectangle,1/3).point,[5,2]);near(samplePrimitive(rectangle,1/3).tangent,[0,1]);
  near(samplePrimitive(rectangle,1).point,[1,2]);near(samplePrimitive(rectangle,1).tangent,[0,-1]);
  near(primitiveBounds(rectangle),[1,2,4,2]);
  const polyline:Primitive2D={kind:'polyline',points:[[0,0],[3,0],[3,4]],closed:false};
  near(samplePrimitive(polyline,.5).point,[3,.5]);near(samplePrimitive(polyline,3/7).tangent,[0,1]);
  near(samplePrimitive(polyline,1).point,[3,4]);near(primitiveBounds(polyline),[0,0,3,4]);
  const lowered=primitiveToPath(polyline,{...options,profile:'polyline',tolerance:Number.MIN_VALUE});
  assert.equal(lowered.report.errorBound,0);assert.equal(lowered.report.segments,2);
});

test('rounded rectangles use exact straight and circular perimeter pieces including zero and maximum radii',()=>{
  const rounded:Primitive2D={kind:'roundedRectangle',origin:[0,0],width:6,height:4,cornerRadius:1};
  const length=12+2*Math.PI;
  near(samplePrimitive(rounded,0).point,[1,0]);near(samplePrimitive(rounded,4/length).point,[5,0]);
  near(samplePrimitive(rounded,(4+Math.PI/2)/length).point,[6,1]);
  near(samplePrimitive(rounded,.5).point,[5,4]);near(samplePrimitive(rounded,.5).tangent,[-1,0]);
  near(primitiveBounds(rounded),[0,0,6,4]);
  const zero={...rounded,cornerRadius:0};
  assert.equal(primitiveToPath(zero,options).report.segments,4);
  const maximal={...rounded,width:4,cornerRadius:2};
  const path=primitiveToPath(maximal,options);
  assert.ok(path.report.spans.every(span=>span.source==='arc'));
  near(samplePrimitive(maximal,.25).point,[4,2]);near(samplePrimitive(maximal,1).point,[2,0]);
});

test('cubic and polyline conic approximations obey independently sampled reported error bounds',()=>{
  const conics:Primitive2D[]=[circle,{kind:'ellipse',center:[-11,23],rx:100,ry:3},
    {kind:'arc',center:[2,7],rx:25,ry:40,startAngle:1.2,sweepAngle:-4.8}];
  for(const primitive of conics)for(const profile of ['cubic','polyline'] as const)for(const tolerance of [.1,.005]) {
    assert.ok(primitive.kind==='circle'||primitive.kind==='ellipse'||primitive.kind==='arc');
    const result=primitiveToPath(primitive,{profile,tolerance,maxSegments:4096});
    assert.ok(result.report.errorBound<=tolerance);assert.equal(result.report.segments,result.report.spans.length);
    let start:readonly number[]=result.geometry.contours[0].start;
    for(const [index,segment] of result.geometry.contours[0].segments.entries()) {
      const span=result.report.spans[index];assert.equal(span.segmentId,segment.id);
      for(let step=0;step<=32;step++) {
        const u=step/32,v=1-u,t=span.parameterInterval[0]+u*(span.parameterInterval[1]-span.parameterInterval[0]);
        const angle=primitive.kind==='arc'?primitive.startAngle+primitive.sweepAngle*t:2*Math.PI*t;
        const rx=primitive.kind==='circle'?primitive.radius:primitive.rx,ry=primitive.kind==='circle'?primitive.radius:primitive.ry;
        const expected=[primitive.center[0]+rx*Math.cos(angle),primitive.center[1]+ry*Math.sin(angle)];
        const actual=[0,1].map(axis=>segment.kind==='line'?v*start[axis]+u*segment.to[axis]:
          v**3*start[axis]+3*v*v*u*segment.c1[axis]+3*v*u*u*segment.c2[axis]+u**3*segment.to[axis]);
        const distance=Math.hypot(actual[0]-expected[0],actual[1]-expected[1]);
        assert.ok(distance<=span.errorBound,`${primitive.kind}/${profile}: ${distance} > ${span.errorBound}`);
      }
      start=segment.to;
    }
  }
});

test('Hermite cubic endpoints have the analytic oriented tangent and refinement is deterministic',()=>{
  const arc:Primitive2D={kind:'arc',center:[1,2],rx:30,ry:7,startAngle:.6,sweepAngle:-3};
  const result=primitiveToPath(arc,options),contour=result.geometry.contours[0];
  const first=contour.segments[0],last=contour.segments.at(-1)!;
  assert.equal(first.kind,'cubic');assert.equal(last.kind,'cubic');
  if(first.kind==='cubic'&&last.kind==='cubic') {
    const normalized=(v:number[])=>{const n=Math.hypot(...v);return v.map(value=>value/n);};
    near(normalized(first.c1.map((v,i)=>v-contour.start[i])),samplePrimitive(arc,0).tangent);
    near(normalized(last.to.map((v,i)=>v-last.c2[i])),samplePrimitive(arc,1).tangent);
  }
  const finer=primitiveToPath(arc,{...options,tolerance:.001});
  assert.ok(finer.report.segments>result.report.segments);
  assert.deepEqual(primitiveToPath(arc,options),result);
  assert.equal(result.report.spans[0].parameterInterval[0],0);
  assert.equal(result.report.spans.at(-1)!.parameterInterval[1],1);
});

test('lowering enforces quality and segment budgets with finite diagnostics',()=>{
  assert.throws(()=>primitiveToPath(circle,{...options,maxSegments:1}),/PRIMITIVE_BUDGET/);
  assert.throws(()=>primitiveToPath(circle,{...options,tolerance:1e-16}),/PRIMITIVE_TOLERANCE/);
  assert.throws(()=>primitiveToPath(circle,{...options,tolerance:0}),/PRIMITIVE_TOLERANCE/);
  assert.throws(()=>primitiveToPath(circle,{...options,maxSegments:131073}),/PRIMITIVE_BUDGET/);
  assert.throws(()=>primitiveToPath(circle,{...options,unknown:true} as any),/PRIMITIVE_OPTIONS/);
  assert.throws(()=>primitiveToPath(circle,null as any),/PRIMITIVE_OPTIONS/);
  assert.throws(()=>primitiveBounds({...circle,radius:Number.MAX_VALUE}),/PRIMITIVE_NONFINITE/);
  assert.throws(()=>samplePrimitive({kind:'rectangle',origin:[1e20,0],width:1,height:2},0),/PRIMITIVE_NONFINITE/);
  const points=Array.from({length:10000},(_,i):[number,number]=>[i,0]);
  assert.throws(()=>primitiveToPath({kind:'polyline',points,closed:false},{...options,maxSegments:10}),/PRIMITIVE_BUDGET/);
});

test('lowered paths and reports are frozen detached snapshots and closed endpoints agree exactly',()=>{
  const primitive:Primitive2D={kind:'roundedRectangle',origin:[4,-3],width:20,height:8,cornerRadius:2};
  const before=structuredClone(primitive),settings={...options},result=primitiveToPath(primitive,settings);
  assert.deepEqual(primitive,before);assert.deepEqual(settings,options);
  const contour=result.geometry.contours[0];assert.deepEqual(contour.start,contour.segments.at(-1)!.to);
  assert.ok(Object.isFrozen(result.geometry));assert.ok(Object.isFrozen(contour.start));
  assert.ok(Object.isFrozen(result.report.spans[0].parameterInterval));
  assert.throws(()=>{(contour.start as any)[0]=123;},TypeError);
  primitive.origin[0]=500;settings.tolerance=1;
  near(contour.start,[6,-3]);assert.equal(result.report.tolerance,.01);
});

test('closed primitives have positive winding and polylines preserve authored winding',()=>{
  const signedArea=(primitive:Primitive2D,profile:'cubic'|'polyline')=>{
    const contour=primitiveToPath(primitive,{...options,profile}).geometry.contours[0];
    assert.equal(contour.closed,true);
    let previous=contour.start,twiceArea=0;
    for(const segment of contour.segments) {
      twiceArea+=previous[0]*segment.to[1]-segment.to[0]*previous[1];previous=segment.to;
    }
    return twiceArea/2;
  };
  const primitives:Primitive2D[]=[circle,{kind:'ellipse',center:[-2,4],rx:9,ry:3},
    {kind:'rectangle',origin:[-5,-7],width:8,height:6},
    {kind:'roundedRectangle',origin:[3,-4],width:10,height:6,cornerRadius:2}];
  const points:[number,number][]=[[0,0],[4,0],[4,3],[0,3]];
  for(const profile of ['cubic','polyline'] as const) {
    for(const primitive of primitives)assert.ok(signedArea(primitive,profile)>0,`${primitive.kind}/${profile}`);
    assert.equal(signedArea({kind:'polyline',points,closed:true},profile),12);
    assert.equal(signedArea({kind:'polyline',points:[...points].reverse(),closed:true},profile),-12);
  }
});
