import test from 'node:test';
import assert from 'node:assert/strict';
import {bindSceneClip,prepareScene} from '../src/runtime.ts';
import {prepareChalkspaceLecture} from '../adapters/chalkspace-lecture.ts';
import {boardProjectionMatrix,scenePointToBoard} from '../adapters/chalkspace-canvas.ts';
import type {Bundle} from '../src/schema.ts';

const bundle=():Bundle=>({version:'0.3',title:'Intent adapter',duration:8,units:'bp',viewport:{width:100,height:50},
  camera:{x:0,y:0,zoom:1},nodes:[{id:'line',kind:'line',x1:2,y1:3,x2:80,y2:3,style:{stroke:'#fff'}}],
  tracks:[],resources:{},relations:[],presentation:{version:1,seed:28,events:[
    {kind:'draw',id:'write',target:'line',mode:'stroke',start:1,end:4},
    {kind:'erase',id:'wipe',targets:['line'],start:6,end:8},
  ]}});

test('clip interval mapping shares clock offsets, rates, trimming and zero-duration semantics',()=>{
  const clip=bindSceneClip(prepareScene(bundle()),{start:10,sourceStart:2,rate:2,duration:2,before:'hold',after:'hold'});
  assert.deepEqual(clip.mapInterval(1,4),{hostStart:10,hostEnd:11,sourceStart:2,sourceEnd:4});
  assert.equal(clip.mapInterval(6,8),null);
  assert.equal(clip.mapInterval(4,4),null);
  assert.equal(clip.mapInterval(0,1),null);
  for(const [a,b] of [[-1,1],[2,1],[0,9],[NaN,4]])assert.throws(()=>clip.mapInterval(a,b),/CLIP_INTERVAL/);
  const coarse=bindSceneClip(prepareScene(bundle()),{start:1e16,duration:2});
  assert.throws(()=>coarse.mapInterval(.1,.2),/clock precision/);
  const decimal=bindSceneClip(prepareScene(bundle()),{start:0,sourceStart:.1,rate:3,duration:.1});
  assert.equal(decimal.mapInterval(0,1)!.hostEnd,.1);
});
test('consumer schedule is snapshotted, host-clipped and silent on held endpoints',async()=>{
  const lecture=await prepareChalkspaceLecture({contract:'texloom-lecture/1',scenes:{native:bundle()},clips:[
    {id:'first',scene:'native',timing:{start:10,sourceStart:2,rate:2,duration:2},placement:{x:0,y:1,width:8}},
    {id:'second',scene:'native',timing:{start:20,sourceStart:6,rate:.5,duration:4},placement:{x:0,y:4,width:8}},
  ]});
  const intervals=lecture.intentSchedule();
  assert.deepEqual(intervals.map(i=>[i.clipId,i.eventId,i.hostStart,i.hostEnd,i.kind]),[
    ['first','write',10,11,'write'],['second','wipe',20,24,'erase']]);
  assert.equal(intervals[0].seed,28);intervals[0].hostStart=999;
  assert.equal(lecture.intentSchedule()[0].hostStart,10);
  assert.equal(lecture.sample(100)[1].phase,'after');
  assert.equal(lecture.intentSchedule()[1].hostEnd,24);
  lecture.dispose();assert.throws(()=>lecture.intentSchedule(),/DISPOSED/);
});
test('board projection composes scene camera and host camera once',()=>{
  const frame=prepareScene(bundle()).sample(3),placement={x:0,y:1,width:8},view={frameWidth:16,frameHeight:9,cameraY:4.5};
  assert.deepEqual(scenePointToBoard(frame,[0,0],placement,view,1600),[400,100]);
  assert.deepEqual(scenePointToBoard(frame,[100,50],placement,view,1600),[1200,500]);
  frame.camera={x:10,y:5,zoom:2,rotation:Math.PI/2};
  const center=scenePointToBoard(frame,[60,30],placement,view,1600);
  assert.ok(Math.abs(center[0]-800)<1e-10&&Math.abs(center[1]-300)<1e-10);
  const a=boardProjectionMatrix(frame,placement,view,854);
  const b=boardProjectionMatrix(frame,placement,{...view,cameraY:6.5},854);
  assert.deepEqual(a.slice(0,5),b.slice(0,5));
  assert.ok(Math.abs(a[5]-b[5]-106.75)<1e-10);
});
