import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareParametricSurface,sampleParametricSurface,validateParametricSurfaceOptions,ParametricSurfaceError,
  type ParametricSurfaceOptions,type SurfacePosition,type SurfaceDerivatives} from '../src/geometry/parametric-surface.ts';
import {copyMeshBuffers,validateMeshResource} from '../src/ir/mesh.ts';
import type {Vec3} from '../src/geometry/matrix4.ts';

const options=(kind:'analytic'|'finite-difference'='analytic'):ParametricSurfaceOptions=>({units:'unit',domain:{u:[0,1],v:[0,1]},segments:{u:3,v:2},normals:{kind}});
const plane:SurfacePosition=(u,v)=>[u,v,2*u-3*v];
const planeDerivatives:SurfaceDerivatives=()=>({dU:[1,0,2],dV:[0,1,-3]});
const code=(name:string)=>(e:unknown)=>e instanceof ParametricSurfaceError&&e.code===name;
const close=(a:number,b:number,tolerance=1e-10)=>assert.ok(Math.abs(a-b)<=tolerance,`${a} != ${b} (±${tolerance})`);
const sphere=(r:number):SurfacePosition=>(u,v)=>[r*Math.cos(v)*Math.cos(u),r*Math.cos(v)*Math.sin(u),r*Math.sin(v)];
const sphereDerivatives=(r:number):SurfaceDerivatives=>(u,v)=>({
  dU:[-r*Math.cos(v)*Math.sin(u),r*Math.cos(v)*Math.cos(u),0],
  dV:[-r*Math.sin(v)*Math.cos(u),-r*Math.sin(v)*Math.sin(u),r*Math.cos(v)]});
const sphereOptions=():ParametricSurfaceOptions=>({units:'m',domain:{u:[-Math.PI,Math.PI],v:[-Math.PI/2,Math.PI/2]},
  segments:{u:24,v:12},seams:{u:'weld',v:'open'},collapsedBoundaries:['v-min','v-max'],normals:{kind:'analytic'}});

test('plane UV, finite bounds and analytic normal agree with independent equations and indexed orientation',()=>{
  const prepared=prepareParametricSurface(options(),plane,planeDerivatives),mesh=copyMeshBuffers(prepared.baseMesh);
  assert.equal(mesh.positions.length/3,12);assert.equal(mesh.triangleCount,12);assert.deepEqual(mesh.degenerateTriangles,[]);
  assert.deepEqual(mesh.bounds,{min:[0,0,-3],max:[1,1,2]});
  const normal=[-2,3,1].map(n=>n/Math.sqrt(14));
  for(let i=0;i<mesh.positions.length/3;i++){
    const [u,v]=prepared.attributes.uv.data.slice(i*2,i*2+2);
    assert.deepEqual([...mesh.positions.slice(i*3,i*3+3)],[u,v,2*u-3*v]);
    normal.forEach((n,k)=>close(mesh.normals![i*3+k],n));
  }
  assert.deepEqual(validateMeshResource(prepared.baseMesh),[]);
  const flipped=prepareParametricSurface({...options(),orientation:'vu'},plane,planeDerivatives);
  for(let t=0;t<mesh.indices.length;t+=3)assert.deepEqual(flipped.baseMesh.indices.data.slice(t,t+3),[mesh.indices[t],mesh.indices[t+2],mesh.indices[t+1]]);
  flipped.baseMesh.normals!.data.forEach((n,i)=>close(n,-mesh.normals![i]));
});

test('sphere welds longitude and collapses declared poles without pole triangles or cracks',()=>{
  const prepared=prepareParametricSurface(sphereOptions(),sphere(2),sphereDerivatives(2)),sample=sampleParametricSurface(prepared,sphere(2),sphereDerivatives(2));
  const mesh=copyMeshBuffers(sample.mesh);assert.equal(sample.report.vertices,24*11+2);assert.equal(mesh.triangleCount,2*24*11);
  assert.equal(sample.report.omittedTriangles,48);assert.equal(sample.report.collapsedVertices.length,2);assert.deepEqual(mesh.degenerateTriangles,[]);
  for(let i=0;i<mesh.positions.length;i+=3){
    close(Math.hypot(...mesh.positions.slice(i,i+3)),2);
    for(let k=0;k<3;k++)close(mesh.normals![i+k],mesh.positions[i+k]/2,1e-9);
  }
  for(let j=0;j<=12;j++)assert.equal(prepared.gridToVertex[j*25],prepared.gridToVertex[j*25+24]);
  assert.equal(sample.report.normals.kind,'analytic');assert.equal(sample.report.normals.collapsedPolicy,'incident-face-average');
});

test('duplicate seams retain separate domain coordinates but exactly coincident positions',()=>{
  const config=sphereOptions();config.seams={u:'duplicate'};
  const prepared=prepareParametricSurface(config,sphere(1),sphereDerivatives(1));
  assert.equal(prepared.baseMesh.positions.count,25*11+2);
  for(let j=1;j<12;j++){
    const a=prepared.gridToVertex[j*25],b=prepared.gridToVertex[j*25+24];assert.notEqual(a,b);
    assert.deepEqual(prepared.baseMesh.positions.data.slice(a*3,a*3+3),prepared.baseMesh.positions.data.slice(b*3,b*3+3));
    assert.equal(prepared.attributes.uv.data[a*2],-Math.PI);assert.equal(prepared.attributes.uv.data[b*2],Math.PI);
  }
});

test('periodic finite-difference torus has the specified major/minor radii and outward normals',()=>{
  const major=2,minor=.4,position:SurfacePosition=(u,v)=>[(major+minor*Math.cos(v))*Math.cos(u),(major+minor*Math.cos(v))*Math.sin(u),minor*Math.sin(v)];
  const config:ParametricSurfaceOptions={units:'unit',domain:{u:[-Math.PI,Math.PI],v:[-Math.PI,Math.PI]},segments:{u:24,v:12},seams:{u:'weld',v:'weld'},normals:{kind:'finite-difference'}};
  const prepared=prepareParametricSurface(config,position),sample=sampleParametricSurface(prepared,position),mesh=copyMeshBuffers(sample.mesh);
  assert.equal(sample.report.vertices,288);assert.equal(sample.report.triangles,576);assert.deepEqual(mesh.degenerateTriangles,[]);
  for(let i=0;i<288;i++){
    const [u,v]=sample.attributes.uv.data.slice(i*2,i*2+2),[x,y,z]=mesh.positions.slice(i*3,i*3+3);
    close(Math.hypot(Math.hypot(x,y)-major,z),minor);
    [Math.cos(u)*Math.cos(v),Math.sin(u)*Math.cos(v),Math.sin(v)].forEach((n,k)=>close(mesh.normals![i*3+k],n,1e-8));
  }
  assert.equal(sample.report.derivativeEvaluations,0);assert.ok(sample.report.positionEvaluations>sample.report.gridSamples);
  assert.equal(sample.report.normals.kind,'finite-difference');
});

test('finite-difference open boundaries and collapsed poles are explicit approximations',()=>{
  const prepared=prepareParametricSurface(options('finite-difference'),plane),mesh=copyMeshBuffers(prepared.baseMesh);
  [-2,3,1].map(n=>n/Math.sqrt(14)).forEach((n,k)=>{for(let i=k;i<mesh.normals!.length;i+=3)close(mesh.normals![i],n,1e-9);});
  const config=sphereOptions();config.normals={kind:'finite-difference'};
  const round=prepareParametricSurface(config,sphere(1));assert.deepEqual(copyMeshBuffers(round.baseMesh).degenerateTriangles,[]);
  for(let i=0;i<round.baseMesh.positions.count;i++)for(let k=0;k<3;k++)close(round.baseMesh.normals!.data[i*3+k],round.baseMesh.positions.data[i*3+k],1e-8);
});

test('captured base positions are immutable and sample order does not change topology or a repeated frame',()=>{
  const config=sphereOptions(),input=JSON.stringify(config),prepared=prepareParametricSurface(config,sphere(1),sphereDerivatives(1));
  const captured=JSON.stringify(prepared.attributes),first=sampleParametricSurface(prepared,sphere(2),sphereDerivatives(2));
  sampleParametricSurface(prepared,sphere(.5),sphereDerivatives(.5));
  assert.deepEqual(sampleParametricSurface(prepared,sphere(2),sphereDerivatives(2)),first);
  assert.equal(JSON.stringify(prepared.attributes),captured);assert.equal(JSON.stringify(config),input);
  assert.ok(Object.isFrozen(first.attributes.basePositions.data));assert.ok(Object.isFrozen(first.mesh.positions.data));
  first.attributes.basePositions.data.forEach((n,i)=>close(first.mesh.positions.data[i],2*n));
  const finer={...sphereOptions(),segments:{u:24,v:14}},changed=prepareParametricSurface(finer,sphere(1),sphereDerivatives(1));
  assert.notEqual(changed.topologyRevision,prepared.topologyRevision);assert.equal(first.mesh.topologyRevision,prepared.topologyRevision);
  config.domain.u[0]=0;assert.equal(prepared.options.domain.u[0],-Math.PI);
});

test('unexpected folds, undeclared poles and mismatched closed seams fail instead of dropping faces',()=>{
  const config=options(),prepared=prepareParametricSurface(config,plane,planeDerivatives);
  assert.throws(()=>sampleParametricSurface(prepared,()=>[0,0,0],planeDerivatives),code('SURFACE_DEGENERATE'));
  const bad=sphereOptions();bad.collapsedBoundaries=[];
  const exactPoles:SurfacePosition=(u,v)=>Math.abs(v)===Math.PI/2?[0,0,Math.sign(v)]:sphere(1)(u,v);
  assert.throws(()=>prepareParametricSurface(bad,exactPoles,sphereDerivatives(1)),code('SURFACE_DEGENERATE'));
  const seam=options();seam.seams={u:'weld'};
  assert.throws(()=>prepareParametricSurface(seam,plane,planeDerivatives),code('SURFACE_SEAM'));
  assert.throws(()=>sampleParametricSurface(prepareParametricSurface(sphereOptions(),sphere(1),sphereDerivatives(1)),
    (u,v)=>[...sphere(1)(u,v).slice(0,2),Math.sin(v)+u*.01] as Vec3,sphereDerivatives(1)),code('SURFACE_SEAM'));
});

test('normal singularity, callback errors and nonfinite positions are never silently masked',()=>{
  assert.throws(()=>prepareParametricSurface(options(),plane,()=>({dU:[1,0,0],dV:[2,0,0]})),code('SURFACE_NORMAL'));
  assert.throws(()=>prepareParametricSurface(options(),()=>[NaN,0,0],planeDerivatives),code('SURFACE_NONFINITE'));
  const original=new Error('expression source diagnostic');
  assert.throws(()=>prepareParametricSurface(options(),()=>{throw original;},planeDerivatives),e=>e===original);
  const p=prepareParametricSurface(options(),plane,planeDerivatives);
  assert.throws(()=>sampleParametricSurface(structuredClone(p),plane,planeDerivatives),code('SURFACE_PREPARED'));
});

test('options reject unsupported collapse, budgets, accessors and floating-point aliased grids before callbacks',()=>{
  const cases:[(v:any)=>void,string][]=[
    [v=>v.collapsedBoundaries=null,'SURFACE_COLLAPSE'],[v=>v.collapsedBoundaries=['u-min','v-min'],'SURFACE_COLLAPSE'],
    [v=>{v.collapsedBoundaries=['u-min'];v.seams={u:'weld'};},'SURFACE_COLLAPSE'],
    [v=>v.segments={u:256,v:256},'SURFACE_BUDGET'],[v=>v.segments.u=1.5,'SURFACE_GRID'],
    [v=>v.domain.u=[0,Infinity],'ASSET_JSON_VALUE'],[v=>v.domain.u=[2**53,2**53+4],'SURFACE_PRECISION'],
    [v=>v.seamTolerance=-1,'SURFACE_TOLERANCE'],[v=>v.orientation='auto','SURFACE_ORIENTATION'],
  ];
  for(const [edit,expected] of cases){const input=options();edit(input);const diagnostics=validateParametricSurfaceOptions(input);assert.ok(diagnostics.some(d=>d.code===expected),JSON.stringify(diagnostics));}
  let calls=0;const input=options();Object.defineProperty(input,'segments',{enumerable:true,get(){calls++;return {u:1,v:1};}});
  assert.ok(validateParametricSurfaceOptions(input).length);assert.equal(calls,0);
  const oversized=options();oversized.segments={u:256,v:256};
  assert.throws(()=>prepareParametricSurface(oversized,()=>{calls++;return [0,0,0];},planeDerivatives));assert.equal(calls,0);
});

test('decimal UV endpoints exactly match callback parameters and huge periodic domains never pass infinity',()=>{
  const config=options();config.domain={u:[.3,.9],v:[.1,.7]};
  const prepared=prepareParametricSurface(config,(u,v)=>[u,v,0],()=>({dU:[1,0,0],dV:[0,1,0]}));
  for(let i=0;i<prepared.baseMesh.positions.count;i++)assert.deepEqual(prepared.attributes.uv.data.slice(i*2,i*2+2),prepared.baseMesh.positions.data.slice(i*3,i*3+2));
  assert.equal(prepared.attributes.uv.data.at(-2),.9);assert.equal(prepared.attributes.uv.data.at(-1),.7);
  const a=1e308,b=Number.MAX_VALUE,extreme:ParametricSurfaceOptions={units:'unit',domain:{u:[a,b],v:[0,1]},segments:{u:8,v:2},seams:{u:'weld'},normals:{kind:'finite-difference'}};
  let count=0;const cylinder=prepareParametricSurface(extreme,(u,v)=>{assert.ok(Number.isFinite(u)&&u>=a&&u<=b);count++;const angle=(u-a)/(b-a)*2*Math.PI;return [Math.cos(angle),Math.sin(angle),v];});
  assert.ok(count>27);assert.deepEqual(copyMeshBuffers(cylinder.baseMesh).degenerateTriangles,[]);
});

test('anisotropic finite cross products keep their nonzero normal before normalized overflow fallback',()=>{
  const config=options();config.domain={u:[0,.1],v:[0,.1]};config.segments={u:1,v:1};
  const prepared=prepareParametricSurface(config,(u,v)=>[1e308*(u+v),1e-100*u,0],()=>({dU:[1e308,1e-100,0],dV:[1e308,0,0]}));
  for(let i=0;i<prepared.baseMesh.normals!.count;i++)assert.deepEqual(prepared.baseMesh.normals!.data.slice(i*3,i*3+3),[0,0,-1]);
});
