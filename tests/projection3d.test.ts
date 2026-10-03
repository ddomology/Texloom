import test from 'node:test';
import assert from 'node:assert/strict';
import {projectionMatrix3D,viewProjectionMatrix3D,projectPoint3D,validateProjection3D,Projection3DError,
  composeTransform3D,inverseMatrix4,identityMatrix4,transformPoint3D,quaternionFromAxisAngle,
  createEvaluator,validateBundle,prepareSpace3D,prepareSpace3DSampler,validateSpace3D,sceneFeatures,
  type Bundle,type Space3D,type MeshResource,type Vec3} from '../src/index.ts';

const viewport={width:200,height:100};
function near(a:readonly number[],b:readonly number[],epsilon=1e-11):void {assert.equal(a.length,b.length);a.forEach((x,i)=>assert.ok(Math.abs(x-b[i])<=epsilon*Math.max(1,Math.abs(b[i])),`${i}: ${x} vs ${b[i]}`));}
function scene():Bundle {return {version:'0.3',title:'Projection',duration:4,units:'bp',viewport:{...viewport},camera:{x:0,y:0,zoom:1},nodes:[],tracks:[],relations:[],
  resources:{triangle:{kind:'mesh',version:1,primitive:'triangles',units:'unit',coordinateSpace:'object',winding:'ccw',topologyRevision:'triangle',
    positions:{version:1,componentType:'float64',components:3,count:3,byteOffset:0,byteStride:24,data:[0,0,0,1,0,0,0,1,0]},
    indices:{version:1,componentType:'uint16',components:1,count:3,byteOffset:0,byteStride:2,data:[0,1,2]},bounds:{min:[0,0,0],max:[1,1,0]}},
    label:{kind:'vector',items:[{kind:'path',d:'M0 0L3 0L3 -2Z'}],metrics:{width:3,height:2,depth:0},inkBounds:[0,-2,3,2]}},
  space3d:{version:1,units:'unit',handedness:'right',upAxis:'z',nodes:[{kind:'group',id:'pivot',transform:{translation:[0,0,-4]}},{kind:'mesh',id:'mesh',resourceId:'triangle',parent:'pivot'}],
    camera:{id:'eye',projection:{kind:'perspective',fovY:Math.PI/2,near:1,far:10}},
    overlays:[{id:'label3d',resourceId:'label',parent:'pivot',position:[1,1,0],offset:[2,-3]}]}};}
const errors=(b:Bundle)=>validateBundle(b).filter(d=>d.severity==='error');

test('perspective projection has analytic aspect, depth and bp Y-down coordinates',()=>{
  const matrix=projectionMatrix3D({kind:'perspective',fovY:Math.PI/2,near:1,far:9},viewport);
  near(projectPoint3D([2,1,-2],matrix,viewport).ndc!,[.5,.5,.125]);near(projectPoint3D([2,1,-2],matrix,viewport).position!,[150,25]);
  assert.equal(projectPoint3D([0,0,-1],matrix,viewport).visible,true);assert.equal(projectPoint3D([0,0,-9],matrix,viewport).visible,true);
  near(projectPoint3D([0,0,-1],matrix,viewport).ndc!,[0,0,-1]);near(projectPoint3D([0,0,-9],matrix,viewport).ndc!,[0,0,1]);
  for(const point of [[0,0,-.9],[0,0,-9.1],[0,0,2],[5,0,-2]] as Vec3[])assert.equal(projectPoint3D(point,matrix,viewport).visible,false);
  const eye=projectPoint3D([0,0,0],matrix,viewport);assert.equal(eye.visible,false);assert.equal(eye.ndc,null);assert.equal(eye.position,null);
  assert.ok(Object.isFrozen(matrix)&&Object.isFrozen(eye)&&Object.isFrozen(eye.clip));
});

test('orthographic projection preserves size with depth and includes numerically rounded near/far boundaries',()=>{
  const v={width:960,height:540},matrix=projectionMatrix3D({kind:'orthographic',height:5.2,near:.1,far:100},v);
  near(projectPoint3D([1,1,-2],matrix,v).position!,projectPoint3D([1,1,-20],matrix,v).position!);
  for(const z of [-.1,-100])assert.equal(projectPoint3D([0,0,z],matrix,v).visible,true);
  for(const z of [-.1+1e-9,-100-1e-9])assert.equal(projectPoint3D([0,0,z],matrix,v).visible,false);
  const zero=projectionMatrix3D({kind:'orthographic',height:2,near:0,far:10},viewport);
  assert.equal(projectPoint3D([0,0,0],zero,viewport).visible,true);assert.equal(projectPoint3D([0,0,.01],zero,viewport).visible,false);
});

test('camera affine view is applied once, including translation and nonuniform camera scale',()=>{
  const projection=projectionMatrix3D({kind:'perspective',fovY:Math.PI/2,near:1,far:10},viewport),pose=composeTransform3D({translation:[3,4,5],scale:[2,3,1]}),view=inverseMatrix4(pose);
  const matrix=viewProjectionMatrix3D(projection,view),point=transformPoint3D(pose,[2,1,-2]);
  near(projectPoint3D(point,matrix,viewport).position!,[150,25]);assert.ok(Object.isFrozen(matrix));
});

test('projection validators reject unsupported fields, accessors, nonfinite and unrepresentable coefficients',()=>{
  for(const bad of [null,{kind:'perspective',fovY:Math.PI,near:1,far:2},{kind:'perspective',fovY:1,near:0,far:2},
    {kind:'orthographic',height:1,near:-1,far:2},{kind:'orthographic',height:1,near:1,far:1},{kind:'perspective',fovY:1,near:1,far:2,unknown:true}])assert.ok(validateProjection3D(bad).length);
  let reads=0;assert.ok(validateProjection3D({kind:'perspective',get fovY(){reads++;return 1;},near:1,far:2}).length);assert.equal(reads,0);
  assert.throws(()=>projectionMatrix3D({kind:'perspective',fovY:Number.MIN_VALUE,near:1,far:2},viewport),e=>e instanceof Projection3DError&&e.code==='PROJECTION3D_RANGE');
  assert.throws(()=>projectionMatrix3D({kind:'orthographic',height:2,near:0,far:10},{width:Number.MAX_VALUE,height:Number.MIN_VALUE}),/PROJECTION3D_RANGE/);
  assert.throws(()=>projectPoint3D([0,0,Infinity],identityMatrix4(),viewport),/NON_JSON_VALUE/);
});

test('projected native overlays follow their parent; offsets are logical bp and mesh material is explicit',()=>{
  const b=scene(),frame=createEvaluator(b)(0),s=frame.space3d!,o=s.overlays[0];
  near(o.worldPosition,[1,1,-4]);near(o.position!,[114.5,34.5]);assert.equal(o.visible,true);assert.equal(o.scale,1);assert.equal(o.color,'#ffffff');
  assert.deepEqual(s.instances[0].material,{kind:'unlit',color:'#d4d9e2',side:'front'});assert.equal(s.camera!.aspect,2);
  assert.deepEqual(s.camera!.projection,b.space3d!.camera!.projection);assert.ok(Object.isFrozen(s.overlays[0].worldPosition));
  b.viewport={width:400,height:200};near(createEvaluator(b)(0).space3d!.overlays[0].position!,[227,72]);
});

test('world clipping uses normalized closed half-spaces and clips overlay anchors without changing geometry',()=>{
  const b=scene();b.space3d!.camera!.projection={kind:'orthographic',height:10,near:.1,far:100};
  b.space3d!.clippingPlanes=[{normal:[1,1,0],constant:-1}];b.space3d!.overlays![0]={id:'label3d',resourceId:'label',position:[.3,.7,-2]};
  const frame=createEvaluator(b)(0);assert.equal(frame.space3d!.overlays[0].visible,true);
  near(frame.space3d!.clippingPlanes[0].normal,[Math.SQRT1_2,Math.SQRT1_2,0]);near([frame.space3d!.clippingPlanes[0].constant],[-Math.SQRT1_2]);
  assert.deepEqual(frame.resources.triangle,b.resources.triangle);
  b.space3d!.overlays![0].position=[.3,.7-1e-10,-2];assert.equal(createEvaluator(b)(0).space3d!.overlays[0].visible,false);
  b.space3d!.overlays![0].position=[.3,.7+1e-10,-2];assert.equal(createEvaluator(b)(0).space3d!.overlays[0].visible,true);
  b.space3d!.overlays![0]={id:'label3d',resourceId:'label',parent:'mesh',position:[.6,.6,0]};
  (b.space3d!.nodes[1] as any).visible=false;assert.equal(createEvaluator(b)(0).space3d!.overlays[0].visible,false);
});

test('shortest quaternion interpolation is deterministic for absolute time, reverse seeking and antipodes',()=>{
  const b=scene();b.space3d!.tracks=[{target:'pivot',property:'rotation',keys:[[0,[0,0,0,1]],[4,[0,0,1,0]]]}];
  const run=createEvaluator(b),mid=run(2).space3d!;near(transformPoint3D(mid.groups[0].worldMatrix,[1,0,0]),[0,1,-4]);
  for(const t of [3,1,.01,4,0,2])run(t);assert.deepEqual(run(2).space3d,mid);
  near(run(-1).space3d!.overlays[0].worldPosition,[1,1,-4]);near(run(99).space3d!.overlays[0].worldPosition,[-1,-1,-4]);
  b.space3d!.tracks[0].keys[1][1]=[0,0,0,-2];near(createEvaluator(b)(2).space3d!.overlays[0].worldPosition,[1,1,-4]);
  b.space3d!.tracks[0].keys[1][1]=[...quaternionFromAxisAngle([0,0,1],1e-4)];
  near(createEvaluator(b)(2).space3d!.overlays[0].worldPosition,[Math.cos(5e-5)-Math.sin(5e-5),Math.sin(5e-5)+Math.cos(5e-5),-4]);
});

test('translation/scale tracks hold endpoints, step at exact keys and preserve singular mesh metadata',()=>{
  const b=scene();b.space3d!.tracks=[{target:'pivot',property:'translation',interpolation:'step',keys:[[1,[0,0,-4]],[2,[2,0,-4]]]},
    {target:'mesh',property:'scale',keys:[[0,[1,1,1]],[4,[-1,1,1]]]}];
  const run=createEvaluator(b);near(run(1.999).space3d!.groups[0].worldMatrix.slice(12,15),[0,0,-4]);near(run(2).space3d!.groups[0].worldMatrix.slice(12,15),[2,0,-4]);
  const collapsed=run(2).space3d!.instances[0];assert.equal(collapsed.orientation,0);assert.equal(collapsed.normalMatrix,null);
  assert.equal(run(4).space3d!.instances[0].orientation,-1);assert.ok(run(2).space3d!.diagnostics.some(d=>d.code==='SPACE3D_SINGULAR_NORMAL'));
});

test('sampler snapshots declarations, context and mesh bounds while static PR29 calls remain compatible',()=>{
  const b=scene(),context={duration:b.duration,viewport:{...b.viewport}};b.space3d!.tracks=[{target:'pivot',property:'translation',keys:[[0,[0,0,-4]],[4,[2,0,-4]]]}];
  const run=prepareSpace3DSampler(b.space3d!,b.resources,context),expected=run(2);
  b.space3d!.tracks[0].keys[1][1]=[999,999,999];context.viewport.width=1;(b.resources.triangle as MeshResource).bounds!.max[0]=999;
  assert.deepEqual(run(2),expected);assert.throws(()=>run(NaN),RangeError);assert.ok(Object.isFrozen(expected.instances[0].worldBounds));
  const old=scene();delete old.space3d!.camera!.projection;delete old.space3d!.overlays;
  const staticState=prepareSpace3D(old.space3d!,old.resources);assert.equal(staticState.camera!.projectionMatrix,null);
  assert.throws(()=>prepareSpace3DSampler(old.space3d!,old.resources,undefined as any),/SPACE3D_CONTEXT/);
  const evaluator=createEvaluator(old);assert.strictEqual(evaluator(0).space3d,evaluator(3).space3d);
});

test('track and scene contracts reject conflicting writers, matrix targets, bad keys and incompatible overlays',()=>{
  for(const mutate of [
    (b:Bundle)=>{b.space3d!.tracks=[{target:'pivot',property:'translation',keys:[[0,[0,0,0]],[5,[1,0,0]]]}];},
    (b:Bundle)=>{b.space3d!.tracks=[{target:'pivot',property:'rotation',keys:[[0,[0,0,0,0]]]}];},
    (b:Bundle)=>{b.space3d!.tracks=[{target:'pivot',property:'translation',keys:[[0,[0,0,0]],[0,[1,0,0]]]}];},
    (b:Bundle)=>{const t={target:'pivot',property:'translation' as const,keys:[[0,[0,0,0]]] as [number,Vec3][]};b.space3d!.tracks=[t,t];},
    (b:Bundle)=>{b.space3d!.nodes[0].transform={matrix:[...identityMatrix4()]};b.space3d!.tracks=[{target:'pivot',property:'translation',keys:[[0,[0,0,0]]]}];},
    (b:Bundle)=>{b.space3d!.overlays![0].resourceId='triangle';},
    (b:Bundle)=>{b.space3d!.overlays![0].parent='eye';},
    (b:Bundle)=>{b.space3d!.overlays![0].id='mesh';},
    (b:Bundle)=>{b.space3d!.clippingPlanes=[{normal:[0,0,0],constant:1}];},
    (b:Bundle)=>{Object.assign(b.space3d!.nodes[1],{material:{kind:'unlit',color:'#abc'}});},
  ]){const b=scene();mutate(b);assert.ok(errors(b).length);}
  const invalid=scene();(invalid.resources.label as any).items=null;
  assert.ok(validateSpace3D(invalid.space3d,invalid.resources,'$.space3d',{viewport,duration:4}).some(d=>d.code==='PAINT_ITEMS'));
  assert.ok(validateSpace3D(scene().space3d,scene().resources).some(d=>d.code==='SPACE3D_VIEWPORT'));
});

test('camera and ancestor scale tracks reject singular intervals while exact step reflections remain valid',()=>{
  const b=scene();b.space3d!.tracks=[{target:'eye',property:'scale',keys:[[0,[1,1,1]],[4,[-1,1,1]]]}];
  assert.ok(errors(b).some(d=>d.code==='SPACE3D_CAMERA_SCALE'));b.space3d!.tracks[0].interpolation='step';assert.deepEqual(errors(b),[]);
  assert.equal(createEvaluator(b)(4).space3d!.camera!.worldMatrix[0],-1);
  b.space3d!.camera!.parent='pivot';b.space3d!.tracks=[{target:'pivot',property:'scale',keys:[[0,[1,1,1]],[4,[0,1,1]]]}];
  assert.ok(errors(b).some(d=>d.code==='SPACE3D_CAMERA_SCALE'));
});

test('capability inventory adds authored PR30 features without changing old PR29 package requirements',()=>{
  const b=scene();b.space3d!.clippingPlanes=[{normal:[1,0,0],constant:0}];b.space3d!.tracks=[{target:'pivot',property:'translation',keys:[[0,[0,0,-4]]]}];
  (b.space3d!.nodes[1] as any).material={kind:'unlit',color:'#123456',side:'double'};
  const required=sceneFeatures(b);for(const feature of ['camera.projection.3d','overlay.tex.3d','clip.planes.3d','animation.transform.3d','material.unlit.3d'])assert.ok(required.includes(feature as any));
  delete b.space3d!.camera!.projection;delete b.space3d!.overlays;delete b.space3d!.clippingPlanes;delete b.space3d!.tracks;delete (b.space3d!.nodes[1] as any).material;
  assert.deepEqual(sceneFeatures(b),['camera.affine.3d','mesh.triangles.3d','path.2d','transform.affine.3d']);
});
