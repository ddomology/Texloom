import test from 'node:test';
import assert from 'node:assert/strict';
import {createEvaluator,evaluate,validateBundle,worldMatrix,transformPoint,
  type Bundle,type PathNode,type PointNode,type LineNode} from '../src/index.ts';

const close=(actual:number,expected:number)=>assert.ok(Math.abs(actual-expected)<1e-8,`${actual} != ${expected}`);
const near=(actual:number[],expected:number[])=>actual.forEach((v,i)=>close(v,expected[i]));
function fixture():Bundle {
  return {version:'0.3',title:'Live paths',duration:4,units:'bp',viewport:{width:200,height:100},
    camera:{x:0,y:0,zoom:1},resources:{},tracks:[],
    nodes:[{id:'curve',kind:'path',d:'M0 0',style:{fill:'none',stroke:'#fff'},
      geometry:{contours:[{id:'main',start:[0,0],segments:[{id:'bend',kind:'cubic',c1:[0,100],c2:[100,100],to:[100,0]}]}]}},
      {id:'p',kind:'point',x:0,y:0,r:2,progress:.5},
      {id:'t',kind:'line',x1:0,y1:0,x2:0,y2:0},
      {id:'n',kind:'line',x1:0,y1:0,x2:0,y2:0}],
    relations:[{type:'pathDirection',target:'t',source:'curve',point:'p',length:30},
      {type:'pathDirection',target:'n',source:'curve',point:'p',length:20,normal:true},
      {type:'pointOnPath',target:'p',source:'curve'}]};
}
const get=<T>(frame:{nodes:{id:string}[]},id:string)=>frame.nodes.find(n=>n.id===id) as T;

test('live control tracks deform exact geometry and relation dependencies resolve out of order',()=>{
  const b=fixture();
  b.tracks.push({target:'curve',property:'geometry.main.bend.c1',keys:[[0,[0,100]],[4,[0,200]]]});
  const copy=structuredClone(b), run=createEvaluator(b), frame=run(4);
  // B(1/2) = P0/8 + 3P1/8 + 3P2/8 + P3/8.
  near([get<PointNode>(frame,'p').x,get<PointNode>(frame,'p').y],[50,112.5]);
  const line=get<LineNode>(frame,'t');
  close(Math.hypot(line.x2-line.x1,line.y2-line.y1),30);
  close((line.y2-line.y1)/(line.x2-line.x1),-.5);
  assert.match(get<PathNode>(frame,'curve').d,/200/);
  run(0);run(3);assert.deepEqual(run(4),frame);assert.deepEqual(b,copy);
  get<PathNode>(frame,'curve').geometry!.contours[0].start[0]=999;
  assert.equal(get<PathNode>(run(4),'curve').geometry!.contours[0].start[0],0);
});

test('reveal lowers visible prefix while analytic point samples full geometry',()=>{
  const b=fixture(),path=b.nodes[0] as PathNode;path.reveal=.5;
  const frame=evaluate(b,0),result=get<PathNode>(frame,'curve');
  assert.equal(result.d,'M 0 0 C 0 50 25 75 50 75');
  near(result.geometry!.contours[0].segments[0].to,[100,0]);
  (b.nodes[1] as PointNode).progress=1;
  const end=evaluate(b,0);near([get<PointNode>(end,'p').x,get<PointNode>(end,'p').y],[100,0]);
  path.reveal=0;assert.doesNotMatch(get<PathNode>(evaluate(b,0),'curve').d,/[CLZ]/);
});

test('point and directions cross differently transformed parents with world lengths and perpendicular normals',()=>{
  const b=fixture();
  b.nodes.push({id:'source-parent',kind:'group',transform:{translate:[20,30],scale:[2,3],rotate:Math.PI/2}},
    {id:'point-parent',kind:'group',transform:{translate:[-10,40],scale:[.5,2]}},
    {id:'line-parent',kind:'group',transform:{translate:[7,-8],rotate:-.8,scale:[3,.7]}});
  b.nodes[0].parent='source-parent';b.nodes[1].parent='point-parent';
  b.nodes[2].parent='line-parent';b.nodes[3].parent='line-parent';
  b.nodes[1].transform={translate:[1,2],rotate:.3};b.nodes[2].transform={scale:[2,1]};
  (b.nodes[1] as PointNode).progress=.25;
  const f=evaluate(b,0),map=new Map(f.nodes.map(n=>[n.id,n])),p=get<PointNode>(f,'p');
  const center=transformPoint(worldMatrix(p.id,map),[p.x,p.y]);
  near(center,[-148.75,61.25]);
  const ends=(id:string)=>{const n=get<LineNode>(f,id),m=worldMatrix(id,map);return [transformPoint(m,[n.x1,n.y1]),transformPoint(m,[n.x2,n.y2])];};
  const [ta,tb]=ends('t'),[na,nb]=ends('n');
  near([(ta[0]+tb[0])/2,(ta[1]+tb[1])/2],center);
  near([(na[0]+nb[0])/2,(na[1]+nb[1])/2],center);
  const tv=[tb[0]-ta[0],tb[1]-ta[1]],nv=[nb[0]-na[0],nb[1]-na[1]];
  close(Math.hypot(...tv),30);close(Math.hypot(...nv),20);close(tv[0]*nv[0]+tv[1]*nv[1],0);
  // B'(1/4)=(112.5,150); after scale then 90-degree rotation: (-450,225).
  close(tv[1]/tv[0],-.5);
});

test('length progress and direction share the same sample on unequal segments',()=>{
  const b=fixture(),path=b.nodes[0] as PathNode;
  path.geometry={contours:[{id:'main',start:[0,0],segments:[{id:'short',kind:'line',to:[10,0]},{id:'long',kind:'line',to:[10,90]}]}]};
  const p0=get<PointNode>(evaluate(b,0),'p');near([p0.x,p0.y],[10,0]);
  (b.relations[2] as any).mode='length';
  const f=evaluate(b,0),p=get<PointNode>(f,'p'),t=get<LineNode>(f,'t');
  near([p.x,p.y],[10,40]);close(t.x1,t.x2);close(t.y2-t.y1,30);
});

test('stable IDs survive contour reordering and cannot address nonexistent controls',()=>{
  const b=fixture(),path=b.nodes[0] as PathNode;
  path.geometry!.contours.unshift({id:'other',start:[-10,-10],segments:[]});
  b.tracks.push({target:'curve',property:'geometry.main.start',keys:[[0,[5,6]]]});
  near(get<PathNode>(evaluate(b,0),'curve').geometry!.contours[1].start,[5,6]);
  b.tracks[0].property='geometry.main.absent.c1';
  assert.ok(validateBundle(b).some(d=>d.code==='PATH_CONTROL_REFERENCE'));
});

test('invalid geometry, incompatible versions and conflicting writers fail at the boundary',()=>{
  const codes=(b:Bundle)=>validateBundle(b).map(d=>d.code);
  const b=fixture();b.version='0.2';assert.ok(codes(b).includes('PATH_VERSION'));b.version='0.3';
  const p=b.nodes[0] as PathNode;p.geometry!.contours[0].segments.push({kind:'line',id:'bend',to:[1,1]});
  assert.ok(codes(b).includes('PATH_GEOMETRY'));p.geometry!.contours[0].segments.pop();
  p.geometry!.contours[0].closed=true;p.geometry!.contours[0].segments[0].id='main:close';
  assert.ok(codes(b).includes('PATH_GEOMETRY'));p.geometry!.contours[0].segments[0].id='bend';
  b.tracks.push({target:'p',property:'x',keys:[[0,0]]});assert.ok(codes(b).includes('CONFLICTING_WRITERS'));
  b.tracks=[];b.relations.pop();assert.ok(codes(b).includes('PATH_POINT_SOURCE'));
});

test('inverse target scales are checked over their entire animated interval',()=>{
  const b=fixture();b.tracks.push({target:'p',property:'transform.scale',keys:[[0,[1,1]],[4,[-1,1]]]});
  assert.ok(validateBundle(b).some(d=>d.code==='SINGULAR_TRANSFORM'));
  b.tracks[0].interpolation='step';assert.deepEqual(validateBundle(b),[]);
});

test('degenerate sampling reports path context; static degenerate reveal is allowed',()=>{
  const b=fixture(),path=b.nodes[0] as PathNode;
  path.geometry={contours:[{id:'still',start:[3,4],segments:[]}]};
  assert.throws(()=>evaluate(b,0),/Path curve/);
  b.relations=[];path.reveal=.5;assert.doesNotThrow(()=>evaluate(b,0));
});

