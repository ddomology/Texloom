import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareScene, bindSceneClip, checkCapabilities, SVG_2D_PROFILE, CANVAS_2D_PROFILE, type Bundle} from '../src/index.ts';

const fixture = (): Bundle => ({version:'0.2', title:'Host clock', duration:8, units:'bp',
  viewport:{width:100,height:50}, camera:{x:0,y:0,zoom:1}, resources:{}, relations:[],
  nodes:[{id:'p',kind:'point',x:0,y:10,r:2}], tracks:[{target:'p',property:'x',keys:[[0,0],[8,80]]}]});

test('prepared runtime owns a source snapshot and returns independent frames',()=>{
  const b=fixture(), runtime=prepareScene(b);
  b.nodes[0].style={opacity:0}; b.title='changed'; b.tracks[0].keys[1][1]=999;
  const first=runtime.sample(4); (first.nodes[0] as any).x=-10;
  assert.equal((runtime.sample(4).nodes[0] as any).x,40);
  assert.equal(runtime.manifest.title,'Host clock');
  assert.ok(Object.isFrozen(runtime.manifest.features));
  runtime.require(SVG_2D_PROFILE); runtime.require(CANVAS_2D_PROFILE);
});
test('clip applies host offset and source rate once with exact boundary policy',()=>{
  const clip=bindSceneClip(prepareScene(fixture()),{start:10,sourceStart:2,rate:2,duration:3,after:'hidden'});
  assert.equal(clip.sample(9).visible,false);
  assert.equal(clip.sample(10).sourceTime,2);
  assert.equal((clip.sample(11.5).frame!.nodes[0] as any).x,50);
  assert.equal(clip.sample(13).visible,false);
  assert.equal(clip.sample(13).sourceTime,8);
  assert.deepEqual(clip.sample(10.5),clip.sample(10.5));
});
test('held endpoints and backwards host seeking stay deterministic',()=>{
  const clip=bindSceneClip(prepareScene(fixture()),{start:3,before:'hold'});
  assert.equal(clip.sample(-2).frame!.time,0);
  const a=clip.sample(7); clip.sample(100); clip.sample(0);
  assert.deepEqual(clip.sample(7),a);
  assert.equal(clip.sample(100).frame!.time,8);
  assert.throws(()=>clip.sample(NaN),/CLIP_TIME/);
});
test('invalid rates, source overflow, and extrapolation fail explicitly',()=>{
  const runtime=prepareScene(fixture());
  for(const timing of [{start:0,rate:0},{start:0,rate:-1},{start:-1},{start:0,sourceStart:9},
    {start:0,duration:9},{start:0,rate:2,duration:5},{start:0,rate:Infinity}])
    assert.throws(()=>bindSceneClip(runtime,timing),/CLIP_TIMING/);
});
test('capability inventory includes hidden resources and unsupported features never disappear',()=>{
  const b=fixture(); b.resources.extra={kind:'vector',metrics:{width:1,height:1,depth:0},inkBounds:[0,0,1,1],
    items:[{kind:'group',style:{opacity:.5},clip:{d:'M0 0H1V1Z'},children:[{kind:'path',d:'M0 0L1 1',style:{stroke:'currentColor',dash:[1,2]}}]}]};
  const runtime=prepareScene(b);
  for(const name of ['path.2d','paint.clip','paint.opacity','paint.dash','paint.current-color'])
    assert.ok(runtime.manifest.features.includes(name as any));
  const report=checkCapabilities([...runtime.manifest.features,'mesh.3d'],SVG_2D_PROFILE);
  assert.equal(report.compatible,false); assert.deepEqual(report.unsupported,['mesh.3d']);
  assert.throws(()=>runtime.require({id:'partial',contract:'texloom-render/1',features:[]}),/RENDER_CAPABILITY/);
});
test('capabilities include paint and transforms introduced only by animation',()=>{
  const b=fixture(); b.tracks.push({target:'p',property:'transform.rotate',keys:[[0,0],[8,1]]},
    {target:'p',property:'style.opacity',keys:[[0,1],[8,.5]]});
  const features=prepareScene(b).manifest.features;
  assert.ok(features.includes('transform.affine.2d'));assert.ok(features.includes('paint.opacity'));
});
