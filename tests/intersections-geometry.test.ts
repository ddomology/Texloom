import test from 'node:test';
import assert from 'node:assert/strict';
import {intersectPathGeometries,assertIntersectionSet} from '../src/geometry/intersections.ts';
import type {PathGeometry,PathPoint} from '../src/path-geometry.ts';

const line=(a:PathPoint,b:PathPoint,id='line'):PathGeometry=>({contours:[{id,start:a,segments:[{id:'s',kind:'line',to:b}]}]});
const cubic=(p0:PathPoint,p1:PathPoint,p2:PathPoint,p3:PathPoint,id='curve'):PathGeometry=>({contours:[{id,start:p0,segments:[{id:'c',kind:'cubic',c1:p1,c2:p2,to:p3}]}]});
const near=(actual:readonly (number|null)[],expected:readonly number[],tolerance=1e-7)=>{
  assert.equal(actual.length,expected.length);actual.forEach((v,i)=>assert.ok(typeof v==='number'&&Number.isFinite(v)&&Math.abs(v-expected[i])<=tolerance,`${actual} != ${expected}`));
};
const triple=cubic([0,-8],[10/3,14],[20/3,-14],[10,8]);
const sorted=(set:ReturnType<typeof intersectPathGeometries>)=>[...set.points].sort((a,b)=>a.point[0]-b.point[0]);

test('line intersections distinguish crossings, endpoints, parallel paths and finite clipping',()=>{
  const crossed=intersectPathGeometries(line([0,0],[10,0]),line([5,-3],[5,7]));
  assert.equal(crossed.points.length,1);assert.equal(crossed.overlaps.length,0);near(crossed.points[0].point,[5,0]);
  near([crossed.points[0].incidents[0].parameterA,crossed.points[0].incidents[0].parameterB],[.5,.3]);
  assert.equal(crossed.points[0].incidents[0].contact,'crossing');
  assert.equal(intersectPathGeometries(line([0,0],[1,0]),line([0,1],[1,1])).points.length,0);
  assert.equal(intersectPathGeometries(line([0,0],[1,0]),line([2,-1],[2,1])).points.length,0);
  const endpoint=intersectPathGeometries(line([0,0],[1,0]),line([1,0],[1,2]));
  assert.equal(endpoint.points.length,1);assert.equal(endpoint.points[0].incidents[0].contact,'endpoint');
  const outside=intersectPathGeometries(line([0,0],[1e8,0]),line([1e8+.05,-1],[1e8+.05,1]),
    {positionTolerance:1e-7,parameterTolerance:1e-9});
  assert.equal(outside.points.length,0);
});

test('infinite mode extends only line operands and exposes unbounded local parameters',()=>{
  const a=line([4,0],[6,0]),finite=intersectPathGeometries(a,triple),extended=intersectPathGeometries(a,triple,{modeA:'line'});
  assert.equal(finite.points.length,1);near(finite.points[0].point,[5,0]);
  const roots=sorted(extended);assert.equal(roots.length,3);near(roots.map(p=>p.point[0]),[2,5,8]);
  near(roots.map(p=>p.incidents[0].parameterA),[-1,.5,2]);
  assert.throws(()=>intersectPathGeometries(a,triple,{modeB:'line'}));
});

test('analytic cubic roots include all three clipped roots and preserve current segment identities',()=>{
  const result=intersectPathGeometries(line([10,0],[0,0],'reversed'),triple),roots=sorted(result);
  assert.equal(roots.length,3);near(roots.map(p=>p.point[0]),[2,5,8]);
  near(roots.map(p=>p.incidents[0].parameterB),[.2,.5,.8]);
  near(roots.map(p=>p.incidents[0].parameterA),[.8,.5,.2]);
  for(const point of roots){const hit=point.incidents[0];assert.equal(hit.a.contourId,'reversed');assert.equal(hit.b.segmentId,'c');
    assert.equal(hit.a.contourIndex,0);assert.equal(hit.b.segmentIndex,0);assert.equal(hit.contact,'crossing');}
  const swapped=sorted(intersectPathGeometries(triple,line([10,0],[0,0])));
  near(swapped.map(p=>p.incidents[0].parameterA),[.2,.5,.8]);
  assert.equal(intersectPathGeometries(line([-1,0],[11,0]),triple,{parameterTolerance:.4}).points.length,3);
});

test('tangent double roots are retained once alongside a separate transverse root',()=>{
  const tangent=cubic([0,3],[10/3,-1],[20/3,-1],[10,3]);
  const one=intersectPathGeometries(line([-1,0],[11,0]),tangent);
  assert.equal(one.points.length,1);near(one.points[0].point,[5,0]);assert.equal(one.points[0].incidents[0].contact,'tangent');
  const mixed=cubic([0,-9],[4/3,19],[8/3,-33],[4,27]);
  const roots=sorted(intersectPathGeometries(line([0,0],[4,0]),mixed));
  assert.equal(roots.length,2);near(roots.map(p=>p.point[0]),[1,3]);
  assert.equal(roots[0].incidents[0].contact,'tangent');assert.equal(roots[1].incidents[0].contact,'crossing');
});

test('curve endpoints and adjacent path endpoint duplicates retain all incident identities',()=>{
  const endpoints=cubic([0,0],[1/3,-1/3],[2/3,-1/3],[1,0]);
  const found=sorted(intersectPathGeometries(line([-1,0],[2,0]),endpoints));
  assert.equal(found.length,2);near(found.map(p=>p.point[0]),[0,1]);assert.ok(found.every(p=>p.incidents[0].contact==='endpoint'));
  const joint:PathGeometry={contours:[{id:'joint',start:[0,0],segments:[{id:'left',kind:'line',to:[1,0]},{id:'right',kind:'line',to:[2,0]}]}]};
  const dedup=intersectPathGeometries(joint,line([1,-1],[1,1]));
  assert.equal(dedup.points.length,1);assert.equal(dedup.points[0].incidents.length,2);
  assert.deepEqual(new Set(dedup.points[0].incidents.map(i=>i.a.segmentId)),new Set(['left','right']));
});

test('unrelated branches sharing a coordinate do not collapse into one topological intersection',()=>{
  const a:PathGeometry={contours:[{id:'first',start:[-1,0],segments:[{id:'s',kind:'line',to:[1,0]}]},
    {id:'second',start:[-2,0],segments:[{id:'s',kind:'line',to:[2,0]}]}]};
  const result=intersectPathGeometries(a,line([0,-1],[0,1]));assert.equal(result.points.length,2);
  assert.ok(result.points.every(p=>p.incidents.length===1));assert.deepEqual(result.points[0].point,result.points[1].point);
  assert.deepEqual(new Set(result.points.map(p=>p.incidents[0].a.contourId)),new Set(['first','second']));
  const backtrack:PathGeometry={contours:[{id:'backtrack',start:[0,0],segments:[{id:'out',kind:'line',to:[1e12,0]},
    {id:'back',kind:'line',to:[0,0]}]}]};
  const nearVertex=intersectPathGeometries(backtrack,line([1e12-100,-1],[1e12-100,1]),{positionTolerance:.001,parameterTolerance:1e-9});
  assert.equal(nearVertex.points.length,2);assert.ok(nearVertex.points.every(p=>p.incidents.length===1));
});

test('coincident line overlap is an interval with orientation and never an arbitrary point',()=>{
  const a=line([0,0],[10,0]),forward=intersectPathGeometries(a,line([5,0],[15,0])),reverse=intersectPathGeometries(a,line([15,0],[5,0]));
  assert.equal(forward.points.length,0);assert.equal(forward.overlaps.length,1);
  near(forward.overlaps[0].parameterA,[.5,1]);near(forward.overlaps[0].parameterB,[0,.5]);assert.equal(forward.overlaps[0].orientation,1);
  near(reverse.overlaps[0].parameterB,[.5,1]);assert.equal(reverse.overlaps[0].orientation,-1);
  near(forward.overlaps[0].points[0]!,[5,0]);near(forward.overlaps[0].points[1]!,[10,0]);
  const unbounded=intersectPathGeometries(a,line([20,0],[30,0]),{modeA:'line',modeB:'line'});
  assert.deepEqual(unbounded.overlaps[0].parameterA,[null,null]);assert.deepEqual(unbounded.overlaps[0].parameterB,[null,null]);
  assert.deepEqual(unbounded.overlaps[0].points,[null,null]);
  const touch=intersectPathGeometries(line([0,0],[1,0]),line([1,0],[2,0]));
  assert.equal(touch.overlaps.length,0);assert.equal(touch.points.length,1);near(touch.points[0].point,[1,0]);
});

test('collinear nonmonotone cubic overlaps split at turning parameters and clip both traversals',()=>{
  // x(t)=4t(1-t), y(t)=0; the same interval is traversed in both directions.
  const backtrack=cubic([0,0],[4/3,0],[4/3,0],[0,0]),result=intersectPathGeometries(line([.5,0],[1,0]),backtrack);
  assert.equal(result.points.length,0);assert.equal(result.overlaps.length,2);
  const ranges=[...result.overlaps].sort((a,b)=>a.parameterB[0]!-b.parameterB[0]!);
  const t0=(1-Math.SQRT1_2)/2,t1=(1+Math.SQRT1_2)/2;
  near(ranges[0].parameterB,[t0,.5]);near(ranges[1].parameterB,[.5,t1]);
  near(ranges[0].parameterA,[0,1]);near(ranges[1].parameterA,[0,1]);
  assert.deepEqual(ranges.map(r=>r.orientation),[1,-1]);
  const turns=cubic([0,0],[.234375,0],[-.03125,0],[.203125,0]);
  assert.equal(intersectPathGeometries(line([-1,0],[1,0]),turns,{parameterTolerance:.3}).overlaps.length,3);
});

test('degenerate finite lines and constant cubics are points; an infinite zero line is undefined',()=>{
  const point=line([2,0],[2,0]),cross=intersectPathGeometries(point,line([0,0],[4,0]));
  assert.equal(cross.points.length,1);near(cross.points[0].point,[2,0]);assert.equal(cross.points[0].incidents[0].contact,'degenerate');
  assert.equal(cross.points[0].incidents[0].parameterA,0);assert.equal(intersectPathGeometries(point,line([0,1],[4,1])).points.length,0);
  assert.throws(()=>intersectPathGeometries(point,line([0,0],[4,0]),{modeA:'line'}));
  const constant=cubic([2,0],[2,0],[2,0],[2,0]);
  const hit=intersectPathGeometries(line([0,0],[4,0]),constant);assert.equal(hit.points.length,1);
  assert.equal(hit.points[0].incidents[0].parameterB,0);assert.equal(hit.points[0].incidents[0].contact,'degenerate');
  const pointOnCurve=intersectPathGeometries(line([5,0],[5,0]),triple);assert.equal(pointOnCurve.points.length,1);
  near([pointOnCurve.points[0].incidents[0].parameterB],[.5]);assert.equal(pointOnCurve.points[0].incidents[0].contact,'degenerate');
  const onExtended=intersectPathGeometries(line([2,0],[2,0]),line([0,0],[1,0]),{modeB:'line'});
  assert.equal(onExtended.points.length,1);near([onExtended.points[0].incidents[0].parameterB],[2]);
});

test('implicit closed edges participate without bridging disconnected contours',()=>{
  const triangle:PathGeometry={contours:[{id:'triangle',start:[0,0],closed:true,segments:[{id:'a',kind:'line',to:[4,0]},
    {id:'b',kind:'line',to:[0,4]}]}]};
  const result=sorted(intersectPathGeometries(line([-1,2],[5,2]),triangle));assert.equal(result.length,2);near(result.map(p=>p.point[0]),[0,2]);
  const closing=result[0].incidents[0].b;assert.equal(closing.segmentId,'triangle:close');assert.equal(closing.closing,true);assert.equal(closing.segmentIndex,2);
  const seam=intersectPathGeometries(line([-1,-1],[1,1]),triangle);assert.equal(seam.points.length,1);assert.equal(seam.points[0].incidents.length,2);
  const separated:PathGeometry={contours:[...line([0,0],[1,0],'one').contours,...line([10,0],[11,0],'two').contours]};
  assert.equal(intersectPathGeometries(separated,line([5,-1],[5,1])).points.length,0);
});

test('scaled analytic roots retain independent parameter accuracy with position tolerance in coordinate units',()=>{
  for(const scale of [1e-6,1,1e6]) {
    const map=(p:PathPoint):PathPoint=>[p[0]*scale,p[1]*scale];
    const curve=cubic(map([0,-8]),map([10/3,14]),map([20/3,-14]),map([10,8]));
    const result=sorted(intersectPathGeometries(line(map([-1,0]),map([11,0])),curve,{positionTolerance:scale*1e-8,parameterTolerance:1e-10}));
    assert.equal(result.length,3);near(result.map(p=>p.point[0]/scale),[2,5,8],1e-7);
    near(result.map(p=>p.incidents[0].parameterB),[.2,.5,.8],1e-8);
  }
  const tiny=cubic([0,-8e-6],[10e-6/3,14e-6],[20e-6/3,-14e-6],[10e-6,8e-6]);
  const closePositions=intersectPathGeometries(line([-1e-6,0],[11e-6,0]),tiny,{positionTolerance:1e-3,parameterTolerance:1e-10});
  assert.equal(closePositions.points.length,3);assert.equal(closePositions.overlaps.length,0);
  assert.throws(()=>intersectPathGeometries(line([0,0],[1e-200,0]),line([5e-201,-1e200],[5e-201,1e200]),{positionTolerance:1e185}),
    (error:any)=>error.code==='INTERSECTION_PRECISION');
});

test('results are deterministic frozen snapshots and validation rejects malformed metadata and budgets',()=>{
  const a=line([0,0],[10,0]),before=structuredClone(a),result=intersectPathGeometries(a,triple);
  assertIntersectionSet(result);assert.deepEqual(intersectPathGeometries(a,triple),result);assert.deepEqual(a,before);
  assert.ok(Object.isFrozen(result));assert.ok(Object.isFrozen(result.points[0].incidents));
  assert.throws(()=>{(result.points[0].point as any)[0]=999;},TypeError);
  const malformed:any=structuredClone(result);malformed.points[0].incidents[0].parameterA=Infinity;assert.throws(()=>assertIntersectionSet(malformed));
  const missingOptions:any=structuredClone(result);delete missingOptions.options;
  assert.throws(()=>assertIntersectionSet(missingOptions),(error:any)=>error.name==='PathGeometryError'&&error.code==='INTERSECTION_DATA');
  assert.throws(()=>intersectPathGeometries(a,triple,{positionTolerance:0}));
  assert.throws(()=>intersectPathGeometries(a,triple,{parameterTolerance:NaN}));
  assert.throws(()=>intersectPathGeometries(a,triple,{parameterTolerance:16*Number.EPSILON}),
    (error:any)=>error.code==='INTERSECTION_TOLERANCE');
  assert.throws(()=>intersectPathGeometries(a,triple,{maxResults:1}));
  const many:PathGeometry={contours:[...line([0,0],[1,0],'a').contours,...line([0,1],[1,1],'b').contours]};
  assert.throws(()=>intersectPathGeometries(many,many,{maxPairs:1}));
  assert.throws(()=>intersectPathGeometries(triple,triple));
});
