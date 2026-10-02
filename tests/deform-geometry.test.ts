import test from 'node:test';
import assert from 'node:assert/strict';
import {compileDeformation} from '../src/geometry/deform-expression.ts';
import {deformGeometry} from '../src/geometry/deform.ts';
import {evaluateSegment, type PathGeometry, type PathPoint} from '../src/path-geometry.ts';

const line=():PathGeometry=>({contours:[{id:'c',start:[0,0],segments:[{id:'s',kind:'line',to:[100,0]}]}]});
const cubic=():PathGeometry=>({contours:[{id:'c',start:[0,0],segments:[{id:'s',kind:'cubic',c1:[0,10],c2:[10,10],to:[10,0]}]}]});
const near=(a:readonly number[],b:readonly number[],tolerance=1e-9)=>a.forEach((n,i)=>assert.ok(Math.abs(n-b[i])<=tolerance,`${a} != ${b}`));
function distance(point:PathPoint,a:PathPoint,b:PathPoint):number {
  const dx=b[0]-a[0],dy=b[1]-a[1],denominator=dx*dx+dy*dy;
  const t=denominator?Math.max(0,Math.min(1,((point[0]-a[0])*dx+(point[1]-a[1])*dy)/denominator)):0;
  return Math.hypot(point[0]-a[0]-t*dx,point[1]-a[1]-t*dy);
}

test('position-affine syntax retains cubic topology with dynamic global constants',()=>{
  const input=cubic(),before=structuredClone(input);
  const compiled=compileDeformation('vec2(-dot(position,vec2(0,1)),dot(position,vec2(1,0))) + shift*time/1s',
    {shift:{type:'vec2',unit:'bp',default:[2,3]}});
  const result=deformGeometry(input,compiled,{mode:'pointwiseDeform',time:2});
  assert.equal(result.report.method,'affine-exact');assert.equal(result.report.maxErrorBound,0);
  const contour=result.geometry.contours[0],segment=contour.segments[0];
  near(contour.start,[4,6]);assert.equal(segment.kind,'cubic');
  if(segment.kind==='cubic'){near(segment.c1,[-6,6]);near(segment.c2,[-6,16]);}near(segment.to,[4,16]);
  assert.equal(segment.id,'s');assert.deepEqual(input,before);assert.ok(Object.isFrozen(segment.to));
});

test('controlDeform maps authored handles rather than claiming true nonlinear curve deformation',()=>{
  const input=cubic(),compiled=compileDeformation('position+vec2(0bp,dot(position,vec2(1,0))^2/1bp)');
  const result=deformGeometry(input,compiled,{mode:'controlDeform',time:0});
  assert.equal(result.report.method,'control');assert.equal(result.report.boundPolicy,'exact-control-map');
  const contour=result.geometry.contours[0],segment=contour.segments[0];
  assert.equal(segment.kind,'cubic');if(segment.kind==='cubic')near(segment.c2,[10,110]);
  near(evaluateSegment([...contour.start],structuredClone(segment) as any,.5),[5,57.5]);
  // The pointwise image of the original midpoint is [5,32.5], intentionally different.
  const ordinal=deformGeometry(input,compileDeformation('position+vec2(parameter*1bp,index*1bp/count)'),{mode:'controlDeform',time:0});
  near(ordinal.geometry.contours[0].segments[0].to,[11,.75]);
});

test('adaptive nonlinear image has a per-leaf envelope covering dense original-curve probes',()=>{
  const input=cubic(),compiled=compileDeformation('position+vec2(0bp,dot(position,vec2(1,0))^2/1bp)');
  const result=deformGeometry(input,compiled,{mode:'pointwiseDeform',time:0,tolerance:.05});
  assert.equal(result.report.method,'adaptive-polyline');assert.ok(result.report.outputSegments>10);
  assert.ok(result.report.maxErrorBound<=.05);assert.equal(result.report.tangentPolicy,'polyline-right-hand');
  let start:PathPoint=[...result.geometry.contours[0].start];
  result.report.segments.forEach((entry,index)=>{
    const segment=result.geometry.contours[0].segments[index],end:PathPoint=[...segment.to];
    assert.equal(entry.outputSegmentId,segment.id);assert.equal(entry.sourceSegmentId,'s');
    for(let i=0;i<=12;i++) {
      const t=entry.sourceInterval[0]+(entry.sourceInterval[1]-entry.sourceInterval[0])*i/12;
      const p=evaluateSegment(input.contours[0].start,input.contours[0].segments[0],t);
      assert.ok(distance([p[0],p[1]+p[0]**2],start,end)<=entry.errorBound+1e-10);
    }
    start=end;
  });
  near(start,[10,100]);assert.deepEqual(result, deformGeometry(input,compiled,{mode:'pointwiseDeform',time:0,tolerance:.05}));
});

test('interval trigonometry catches oscillations whose endpoints and midpoint all alias to zero',()=>{
  const compiled=compileDeformation('position+vec2(0bp,20bp*sin(128*pi*parameter))');
  const result=deformGeometry(line(),compiled,{mode:'pointwiseDeform',time:0,tolerance:.25});
  const ys=result.geometry.contours[0].segments.map(segment=>segment.to[1]);
  assert.ok(Math.max(...ys)>19.9&&Math.min(...ys)<-19.9);assert.ok(result.report.outputSegments>=256);
  assert.ok(result.report.maxErrorBound<=.25);
  assert.throws(()=>deformGeometry(line(),compiled,{mode:'pointwiseDeform',time:0,maxDepth:1}),/DEFORMATION_TOLERANCE/);
  assert.throws(()=>deformGeometry(line(),compiled,{mode:'pointwiseDeform',time:0,maxSegments:3}),/DEFORMATION_BUDGET/);
});

test('pointwise modes reject control-only variables and uncertified spatial branches with source locations',()=>{
  const span={file:'warp.tex',start:{line:7,column:3},end:{line:7,column:80}};
  for(const expression of ['position+vec2(index*1bp,0bp)','position/count'])
    assert.throws(()=>deformGeometry(line(),compileDeformation(expression,{},span),{mode:'pointwiseDeform',time:0}),/DEFORMATION_CONTEXT/);
  const branch=compileDeformation('parameter < .5 ? position : position+vec2(0bp,10bp)',{},span);
  assert.throws(()=>deformGeometry(line(),branch,{mode:'pointwiseDeform',time:0}),(error:any)=>{
    assert.equal(error.diagnostics[0].code,'DEFORMATION_INTERVAL_UNSUPPORTED');assert.equal(error.diagnostics[0].sourceSpan.file,'warp.tex');return true;
  });
  const global=compileDeformation('on ? position : position*2',{on:{type:'boolean',default:false}});
  near(deformGeometry(line(),global,{mode:'pointwiseDeform',time:0}).geometry.contours[0].segments[0].to,[200,0]);
});

test('singular nonlinear maps fail explicitly instead of outputting nonfinite samples',()=>{
  const input=line();input.contours[0].start=[-1,0];input.contours[0].segments[0].to=[1,0];
  assert.throws(()=>deformGeometry(input,compileDeformation('normalize(position)*1bp'),{mode:'pointwiseDeform',time:0}),/EXPRESSION_DOMAIN/);
  assert.throws(()=>deformGeometry(input,compileDeformation('position/parameter'),{mode:'pointwiseDeform',time:0}),/EXPRESSION_DOMAIN/);
  assert.throws(()=>deformGeometry(line(),compileDeformation('position*1e308-position*1e308'),{mode:'pointwiseDeform',time:0}),/EXPRESSION_NONFINITE/);
});

test('closed contours preserve the mapped closing edge; nonperiodic seam maps fail',()=>{
  const input:PathGeometry={contours:[{id:'closed',start:[0,0],closed:true,segments:[{id:'a',kind:'line',to:[10,0]},
    {id:'b',kind:'line',to:[10,10]}]}]};
  const compiled=compileDeformation('position+vec2(0bp,dot(position,vec2(1,0))^2/10bp)');
  const result=deformGeometry(input,compiled,{mode:'pointwiseDeform',time:0});
  assert.equal(result.geometry.contours[0].closed,true);near(result.geometry.contours[0].segments.at(-1)!.to,[0,0]);
  assert.equal(result.report.sourceSegments,3);assert.ok(result.report.segments.some(segment=>segment.closing));
  assert.throws(()=>deformGeometry(input,compileDeformation('position+vec2(parameter*10bp,0bp)'),{mode:'pointwiseDeform',time:0}),/DEFORMATION_CLOSURE/);
  const periodic=deformGeometry(input,compileDeformation('position+vec2(0bp,sin(parameter*2*pi)*1bp)'),{mode:'pointwiseDeform',time:0});
  assert.deepEqual(periodic.geometry.contours[0].segments.at(-1)!.to,periodic.geometry.contours[0].start);
});

test('report provenance describes newly created and collapsed implicit closing edges',()=>{
  const input:PathGeometry={contours:[{id:'closed',start:[0,0],closed:true,segments:[{id:'a',kind:'line',to:[1,0]},
    {id:'b',kind:'line',to:[0,0]}]}]};
  const opened=deformGeometry(input,compileDeformation('position+vec2(index*1bp,0bp)'),{mode:'controlDeform',time:0});
  assert.equal(opened.report.sourceSegments,2);assert.equal(opened.report.outputSegments,3);
  assert.equal(opened.report.segments.length,3);assert.equal(opened.report.segments[2].synthetic,'closing-edge');
  assert.equal(opened.report.segments[2].sourceSegmentId,null);assert.deepEqual(opened.report.segments[2].sourceInterval,[1,1]);
  assert.throws(()=>deformGeometry(input,compileDeformation('position+vec2(index*1bp,0bp)'),{mode:'controlDeform',time:0,maxSegments:2}),/DEFORMATION_BUDGET/);
  input.contours[0].segments[1].to=[1,1];
  const collapsed=deformGeometry(input,compileDeformation('position*0'),{mode:'pointwiseDeform',time:0});
  assert.equal(collapsed.report.sourceSegments,3);assert.equal(collapsed.report.outputSegments,2);
  assert.equal(collapsed.report.segments.length,2);assert.ok(collapsed.report.segments.every(segment=>!segment.closing));
});

test('degenerate segments and multiple contours retain source provenance without connecting moves',()=>{
  const input:PathGeometry={contours:[{id:'one',start:[0,0],segments:[{id:'still',kind:'line',to:[0,0]},{id:'go',kind:'line',to:[2,0]}]},
    {id:'two',start:[10,0],segments:[{id:'go',kind:'line',to:[12,0]}]}]};
  const result=deformGeometry(input,compileDeformation('position+vec2(0bp,parameter^2*1bp)'),{mode:'pointwiseDeform',time:0,tolerance:.05});
  assert.equal(result.geometry.contours.length,2);near(result.geometry.contours[1].start,[10,.25]);
  assert.deepEqual(result.report.segments[0].parameterInterval,[0,0]);assert.equal(result.report.segments[0].sourceSegmentId,'still');
  assert.equal(result.report.sourceSegments,3);assert.ok(result.report.segments.every(segment=>segment.contourId==='one'||segment.contourId==='two'));
});

test('a stationary interior cusp deforms without demanding an undefined unit tangent',()=>{
  const input:PathGeometry={contours:[{id:'cusp',start:[0,0],segments:[{id:'fold',kind:'cubic',c1:[10,10],c2:[10,10],to:[0,0]}]}]};
  // The original derivative vanishes at .5; its image point is [7.5,13.125].
  const result=deformGeometry(input,compileDeformation('position+vec2(0bp,dot(position,vec2(1,0))^2/10bp)'),
    {mode:'pointwiseDeform',time:0,tolerance:.05});
  assert.equal(result.report.method,'adaptive-polyline');assert.ok(result.report.maxErrorBound<=.05);
  assert.ok(result.geometry.contours[0].segments.some(segment=>Math.hypot(segment.to[0]-7.5,segment.to[1]-13.125)<1e-9));
  near(result.geometry.contours[0].segments.at(-1)!.to,[0,0]);
  assert.ok(result.report.segments.some(segment=>segment.sourceInterval[1]===.5));
});

test('API units, finite values, declaration defaults, options and budget limits are checked',()=>{
  assert.throws(()=>compileDeformation('vec2(1,2)'),/DEFORMATION_TYPE/);
  assert.throws(()=>compileDeformation('position',{unused:{type:'scalar',default:4,max:2}}),/DEFORMATION_PARAMETERS/);
  const compiled=compileDeformation('position');
  for(const changes of [{time:Infinity},{tolerance:0},{maxDepth:0},{maxDepth:25},{maxSegments:131073},{unknown:true}])
    assert.throws(()=>deformGeometry(line(),compiled,{mode:'pointwiseDeform',time:0,...changes} as any));
  assert.throws(()=>deformGeometry(line(),compiled,{mode:'pointwiseDeform',time:0,parameters:{undeclared:1}}),/DEFORMATION_PARAMETERS/);
});
