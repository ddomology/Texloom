import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluate,prepareScene,executeArrowOperation,validateBundle,type Bundle,type Operation,type PathNode} from '../src/index.ts';

function fixture():Bundle {
  return {version:'0.3',title:'Arrow graph',duration:2,units:'bp',viewport:{width:200,height:100},camera:{x:0,y:0,zoom:1},resources:{},
    nodes:['source','shaft','head'].map(id=>({id,kind:'path',d:'M0 0L100 0',geometry:{contours:[{id:'c',start:[0,0],segments:[{id:'s',kind:'line',to:[100,0]}]}]}}) as PathNode),
    tracks:[],relations:[],operationGraph:{version:1,operations:[],bindings:[]}};
}
const scalar=(value:number,unit:'1'|'bp'='bp')=>({kind:'literal' as const,value:{type:'scalar' as const,unit,value}});
const path=(bundle:Bundle,id:string)=>bundle.nodes.find(n=>n.id===id) as PathNode;

test('arrowPath produces portable shaft/tip paths after a live geometry writer and independently of seek order',()=>{
  const b=fixture(),space={kind:'local' as const,node:'shaft'};
  b.operationGraph!.operations=[{id:'derive',operator:'arrowPath',version:1,spaces:{space},inputs:{
    path:{kind:'path',node:'source',space},length:scalar(12),width:scalar(8),end:scalar(2,'1'),inset:scalar(3),shortenEnd:scalar(4)}},
    {id:'move',operator:'connectStraight',version:1,spaces:{space:{kind:'local',node:'source'}},inputs:{
      from:{kind:'pointExpression',space:{kind:'local',node:'source'},expression:'vec2(0bp,0bp)'},
      to:{kind:'pointExpression',space:{kind:'local',node:'source'},expression:'vec2(100bp+time/1s*20bp,0bp)'}}}];
  b.operationGraph!.bindings=[{target:'shaft',property:'geometry',value:{operation:'derive',socket:'shaft'}},
    {target:'source',property:'geometry',value:{operation:'move',socket:'path'}}];
  const run=prepareScene(b),first=run.sample(0);
  assert.deepEqual((first.nodes[1] as PathNode).geometry!.contours[0].segments.at(-1)!.to,[87,0]);
  assert.deepEqual((run.sample(2).nodes[1] as PathNode).geometry!.contours[0].segments.at(-1)!.to,[127,0]);
  assert.deepEqual(run.sample(0),first);assert.deepEqual(path(b,'source').geometry!.contours[0].segments[0].to,[100,0]);
});

test('default arrow scalars are visible to graph readers before live style writers',()=>{
  for(const configured of [false,true]){
    const b=fixture();if(configured)path(b,'source').arrows={end:2};
    b.operationGraph!.operations=[{id:'style',operator:'arrowStyle',version:1,spaces:{},inputs:{length:{kind:'property',node:'source',property:'arrows.length',unit:'bp'}}}];
    // A writer activates the profile; reading a different default field creates no cycle.
    b.operationGraph!.bindings=[{target:'source',property:'arrows.width',value:{operation:'style',socket:'length'}}];
    const e=evaluate(b,0).nodes[0] as PathNode;
    assert.equal(e.arrows!.length,9);assert.equal(e.arrows!.width,9);assert.ok(e.resolvedArrows);
    if(!configured)assert.equal(path(b,'source').arrows,undefined);
  }
});

test('arrowStyle sockets use explicit units, enum validation and authored diagnostics',()=>{
  const span={file:'arrow.tex',start:{line:3,column:1},end:{line:3,column:30}};
  const operation:Operation={id:'style',operator:'arrowStyle',version:1,spaces:{},inputs:{},sourceSpan:span};
  assert.equal(executeArrowOperation(operation,{length:{type:'scalar',unit:'bp',value:12}})!.length.value,12);
  for(const input of [{length:{type:'scalar',unit:'1',value:12}},{end:{type:'scalar',unit:'1',value:1.5}},
    {inset:{type:'scalar',unit:'bp',value:-1}},{unexpected:{type:'scalar',unit:'bp',value:1}}] as any[])
    assert.throws(()=>executeArrowOperation(operation,input),(e:any)=>{assert.deepEqual(e.diagnostics[0].sourceSpan,span);return true;});
});

test('arrowPath does not allow feedback into its source or an incorrect output chart',()=>{
  const b=fixture();b.operationGraph!.operations=[{id:'derive',operator:'arrowPath',version:1,spaces:{space:{kind:'local',node:'source'}},
    inputs:{path:{kind:'path',node:'source',space:{kind:'local',node:'source'}}}}];
  b.operationGraph!.bindings=[{target:'source',property:'geometry',value:{operation:'derive',socket:'shaft'}}];
  assert.throws(()=>prepareScene(b),/CYCLE/);
  b.operationGraph!.bindings[0].target='head';assert.ok(validateBundle(b).some(d=>d.code==='OPERATION_SPACE_MISMATCH'));
});

test('boolean flags on editable paths select a triangle profile without changing logical geometry',()=>{
  const b=fixture(),source=path(b,'source');source.arrowStart=true;source.arrowEnd=true;source.arrowSize=12;
  const e=evaluate(b,0).nodes[0] as PathNode;
  assert.deepEqual(e.resolvedArrows!.report.start.visualTip,[0,0]);
  assert.deepEqual(e.resolvedArrows!.report.end.visualTip,[100,0]);
  assert.deepEqual(e.resolvedArrows!.report.start.shaftEndpoint,[12,0]);
  assert.deepEqual(e.resolvedArrows!.report.end.shaftEndpoint,[88,0]);
  assert.equal(e.resolvedArrows!.endTip.contours[0].segments[0].to[1],5.04);
  assert.deepEqual(e.geometry,source.geometry);assert.equal(source.resolvedArrows,undefined);
});
