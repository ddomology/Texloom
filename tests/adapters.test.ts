import test from 'node:test';
import assert from 'node:assert/strict';
import type {Bundle} from '../src/index.ts';
import {renderLemniroFigure, renderLemniroPlayer} from '../adapters/lemniro.ts';
import {placeOnChalkspace} from '../adapters/chalkspace.ts';
import {boardScreenRect} from '../adapters/chalkspace-canvas.ts';
const bundle: Bundle = {
  version: '0.1', title:'A < B', duration:1, units:'bp', viewport:{width:100,height:50},
  camera:{x:0,y:0,zoom:1}, nodes:[{id:'point',kind:'point',x:10,y:20,r:2}],
  tracks:[{target:'point',property:'x',keys:[[0,10],[1,90]]}], relations:[], resources:{},
};
test('consumer adapters use canonical evaluated positions and unit conversion', () => {
  const layer = placeOnChalkspace(bundle,.5,{x:0,y:2,width:10});
  assert.equal((layer.frame.nodes[0] as any).x,50);
  assert.deepEqual(layer.localToBoard,[.1,0,0,.1,-5,2]);
  assert.deepEqual(layer.bounds,{x:-5,y:2,width:10,height:5});
  assert.match(layer.svg,/<svg/);
});
test('HTML adapters escape captions and reject active URL schemes', () => {
  assert.match(renderLemniroFigure(bundle,.5),/A &lt; B/);
  assert.match(renderLemniroPlayer('./player.html','A "title"'),/&quot;title&quot;/);
  assert.throws(()=>renderLemniroPlayer('javascript:alert(1)'));
});
test('separate inline figures have independent clip and resource ID namespaces', () => {
  const grouped:Bundle={...bundle,nodes:[{id:'g',kind:'group',clip:{d:'M0 0H10V10H0Z'}}],tracks:[]};
  const a=renderLemniroFigure(grouped), b=renderLemniroFigure(grouped);
  const id=(html:string)=>html.match(/clipPath id="([^"]+)"/)![1];
  assert.notEqual(id(a),id(b));
  assert.match(a,/width:100%;height:auto/);
});
test('native board placement composes host camera without reapplying the embedded scene camera',()=>{
  const view={frameWidth:16,frameHeight:9,cameraY:4.5};
  assert.deepEqual(boardScreenRect({width:960,height:540},{x:0,y:1,width:12},view,1280),
    {x:160,y:80,width:960,height:540});
  assert.deepEqual(boardScreenRect({width:960,height:540},{x:0,y:1,width:12},{...view,cameraY:6},1280),
    {x:160,y:-40,width:960,height:540});
  assert.throws(()=>boardScreenRect(bundle.viewport,{x:0,y:0,width:0},view,1280),/BOARD_PLACEMENT/);
});
