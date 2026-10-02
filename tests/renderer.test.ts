import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import type {Bundle} from '../src/index.ts';
import {evaluate} from '../src/index.ts';
import {renderSvg,fieldColor} from '../src/render-svg.ts';

const base:Bundle={version:'0.1',title:'render',duration:2,units:'bp',viewport:{width:100,height:100},camera:{x:0,y:0,zoom:1},nodes:[],tracks:[],relations:[],resources:{}};
test('group alpha and clipping retain hierarchy and paint order',()=>{
  const b:Bundle={...base,nodes:[
    {id:'g',kind:'group',style:{opacity:.5},clip:{d:'M0 0H100V100H0Z'}},
    {id:'a',parent:'g',kind:'ellipse',cx:40,cy:50,rx:30,ry:20,style:{fill:'red'}},
    {id:'b',parent:'g',kind:'ellipse',cx:60,cy:50,rx:30,ry:20,style:{fill:'blue',fillOpacity:.7}},
  ]};
  const svg=renderSvg(evaluate(b,0));
  assert.match(svg,/<clipPath[^>]+clipPathUnits="userSpaceOnUse"/);
  assert.match(svg,/<g data-node-id="g" opacity="0.5"[^>]*><ellipse/);
  assert.ok(svg.indexOf('data-node-id="a"')<svg.indexOf('data-node-id="b"'));
  assert.match(svg,/fill-opacity="0.7"/);
});
test('resource origins and per-instance currentColor are preserved',()=>{
  const b:Bundle={...base,resources:{formula:{kind:'vector',metrics:{width:12,height:8,depth:2},inkBounds:[0,-8,12,10],items:[{kind:'path',d:'M0 -8L12 2',style:{fill:'currentColor'}}]}},
    nodes:[{id:'formula',kind:'tex',resourceId:'formula',x:10,y:20,scale:2,style:{fill:'#abcdef'}}]};
  const svg=renderSvg(evaluate(b,0));
  assert.match(svg,/color="#abcdef"/);
  assert.match(svg,/translate\(10 20\) scale\(2\)/);
  assert.match(svg,/M0 -8L12 2/);
});
test('camera stays centered and dimensions are renderer output options',()=>{
  const b:Bundle={...base,camera:{x:10,y:20,zoom:2}};
  const svg=renderSvg(evaluate(b,1),{width:400,height:400,background:'transparent'});
  assert.match(svg,/width="400" height="400" viewBox="0 0 100 100"/);
  assert.match(svg,/translate\(50 50\) scale\(2\) rotate\(0\) translate\(-60 -70\)/);
  assert.doesNotMatch(svg,/fill="#091c27"/);
});
test('actual compiled scene preserves baseline resources and random seek SVG identity',()=>{
  const b=JSON.parse(readFileSync(new URL('../build/demo/bundle.json',import.meta.url),'utf8'));
  const at4=renderSvg(evaluate(b,4));
  renderSvg(evaluate(b,11));renderSvg(evaluate(b,0));
  assert.equal(renderSvg(evaluate(b,4)),at4);
  assert.ok(Object.values(b.resources).every((r:any)=>r.kind!=='vector'||(r.metrics&&r.items)));
  assert.match(at4,/data-node-id="tikz-node"/);
});
test('scalar colors clamp and nonfinite values fail',()=>{
  assert.equal(fieldColor(-10,[-1,1]),fieldColor(-1,[-1,1]));
  assert.equal(fieldColor(10,[-1,1]),fieldColor(1,[-1,1]));
  assert.notEqual(fieldColor(-1,[-1,1]),fieldColor(1,[-1,1]));
  assert.throws(()=>fieldColor(NaN,[-1,1]));
});
test('TeX foreground inherits parent color and malformed hex paint is diagnosed',()=>{
  const b:Bundle={...base,resources:{m:{kind:'vector',metrics:{width:10,height:10,depth:0},inkBounds:[0,-10,10,10],items:[{kind:'path',d:'M0 -10H10V0H0Z',style:{fill:'currentColor'}}]}},nodes:[
    {id:'parent',kind:'group',style:{fill:'red'}},
    {id:'math',parent:'parent',kind:'tex',resourceId:'m',x:0,y:20}
  ]};
  assert.match(renderSvg(evaluate(b,0)),/data-node-id="parent" fill="red" color="red"/);
  b.nodes[0].style={fill:'##abcdef'};
  assert.throws(()=>evaluate(b,0),/Invalid hexadecimal/);
});

test('connector arrow tips follow anchors and use a single compositing group',()=>{
  const b:Bundle={...base,version:'0.2',nodes:[
    {id:'g',kind:'group',style:{stroke:'#abcdef',strokeOpacity:.8}},
    {id:'A',kind:'group',anchors:{east:[5,0]},transform:{translate:[10,20]}},
    {id:'B',kind:'group',anchors:{west:[-5,0]},transform:{translate:[90,20]}},
    {id:'edge',parent:'g',kind:'path',d:'M0 0',arrowStart:true,arrowEnd:true,arrowSize:10,style:{fill:'none',opacity:.5}},
  ],tracks:[{target:'B',property:'transform.translate',keys:[[0,[90,20]],[2,[70,40]]]}],relations:[
    {type:'connect',target:'edge',from:{node:'A',anchor:'east'},to:{node:'B',anchor:'west'}}
  ]};
  const svg=renderSvg(evaluate(b,0));
  assert.match(svg,/<g data-node-id="edge" fill="none" opacity="0.5"[^>]*><path/);
  assert.equal((svg.match(/opacity="0.5"/g)??[]).length,1);
  assert.match(svg,/data-arrow="start" points="15,20 /);
  assert.match(svg,/data-arrow="end" points="85,20 /);
  assert.match(svg,/<polygon[^>]+fill="#abcdef" fill-opacity="0.8" stroke="none"/);
  assert.match(renderSvg(evaluate(b,2)),/data-arrow="end" points="65,40 /);
});

test('curved arrowheads use the resolved cubic tangent and survive reverse seeking',()=>{
  const b:Bundle={...base,version:'0.2',nodes:[
    {id:'A',kind:'group',anchors:{center:[0,0]},transform:{translate:[10,20]}},
    {id:'B',kind:'group',anchors:{center:[0,0]},transform:{translate:[90,20]}},
    {id:'edge',kind:'path',d:'M0 0',arrowEnd:true,style:{stroke:'red',fill:'none'}},
  ],relations:[{type:'connect',target:'edge',from:{node:'A',anchor:'center'},to:{node:'B',anchor:'center'},bend:30}]};
  const frame=evaluate(b,1);
  const path=frame.nodes.find(n=>n.id==='edge');
  assert.ok(path?.kind==='path'&&path.resolvedPath);
  const svg=renderSvg(frame);
  const match=svg.match(/data-arrow="end" points="([^"]+)"/);
  assert.ok(match);
  const points=match[1].split(' ').map(p=>p.split(',').map(Number));
  assert.deepEqual(points[0],path.resolvedPath.end);
  const back=[(points[1][0]+points[2][0])/2,(points[1][1]+points[2][1])/2];
  const direction=[points[0][0]-back[0],points[0][1]-back[1]];
  const tangent=[path.resolvedPath.end[0]-path.resolvedPath.c2[0],path.resolvedPath.end[1]-path.resolvedPath.c2[1]];
  assert.ok(Math.abs(direction[0]*tangent[1]-direction[1]*tangent[0])<1e-9);
  renderSvg(evaluate(b,2));renderSvg(evaluate(b,0));
  assert.equal(renderSvg(evaluate(b,1)),svg);
});

test('unfilled connector inherits currentColor rather than becoming transparent',()=>{
  const b:Bundle={...base,version:'0.2',nodes:[
    {id:'A',kind:'group',anchors:{center:[10,10]}},
    {id:'B',kind:'group',anchors:{center:[90,90]}},
    {id:'edge',kind:'path',d:'M0 0',arrowEnd:true,style:{stroke:'currentColor',fill:'none'}},
  ],relations:[{type:'connect',target:'edge',from:{node:'A',anchor:'center'},to:{node:'B',anchor:'center'}}]};
  const svg=renderSvg(evaluate(b,0));
  assert.doesNotMatch(svg,/color="transparent"/);
  assert.match(svg,/<polygon[^>]+fill="currentColor"/);
});
