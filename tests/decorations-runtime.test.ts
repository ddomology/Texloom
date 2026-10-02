import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareScene,validateBundle,executeDecorationOperation,type Bundle,type Operation,type PathNode,type PathGeometry} from '../src/index.ts';
import {renderSvg} from '../src/render-svg.ts';

const scene={kind:'scene'} as const;
const local=(node:string)=>({kind:'local',node} as const);
const scalar=(value:number,unit:'1'|'bp'='bp')=>({kind:'literal' as const,value:{type:'scalar' as const,unit,value}});
const line:PathGeometry={contours:[{id:'c',start:[0,0],segments:[{id:'s',kind:'line',to:[100,0]}]}]};
function fixture():Bundle {
  return {version:'0.3',title:'Decorated paths',duration:2,units:'bp',viewport:{width:200,height:100},camera:{x:0,y:0,zoom:1},resources:{},
    nodes:['source','target','symbol'].map(id=>({id,kind:'path',d:'M0 0L100 0',geometry:structuredClone(line)})),
    tracks:[],relations:[],operationGraph:{version:1,operations:[],bindings:[]}};
}
const path=(frame:{nodes:readonly unknown[]},index:number)=>(frame.nodes[index] as PathNode).geometry!;
function decoration(b:Bundle):Operation {
  const op:Operation={id:'decorate',operator:'decoratePath',version:1,spaces:{space:local('target')},inputs:{path:{kind:'path',node:'source',space:local('target')},spacing:scalar(20),phase:scalar(10)}};
  b.operationGraph!.operations.push(op);b.operationGraph!.bindings.push({target:'target',property:'geometry',value:{operation:op.id,socket:'path'}});return op;
}

test('live source geometry updates decorations in a distinct target chart and preserves source sampling',()=>{
  const b=fixture();decoration(b);(b.nodes[1] as PathNode).transform={translate:[10,20]};
  b.nodes.push({id:'mid',kind:'point',x:0,y:0,r:2,progress:.5});
  b.relations.push({type:'pointOnPath',source:'source',target:'mid'});
  b.operationGraph!.operations.push({id:'move',operator:'connectStraight',version:1,spaces:{space:local('source')},inputs:{
    from:{kind:'pointExpression',space:local('source'),expression:'vec2(0bp,0bp)'},
    to:{kind:'pointExpression',space:local('source'),expression:'vec2(100bp+time/1s*20bp,0bp)'}}});
  b.operationGraph!.bindings.push({target:'source',property:'geometry',value:{operation:'move',socket:'path'}});
  const run=prepareScene(b),first=run.sample(0),later=run.sample(2);
  assert.equal(path(first,1).contours.length,5);assert.equal(path(later,1).contours.length,7);
  assert.deepEqual(path(first,1).contours[0].start,[0,-23]);assert.deepEqual(path(later,0).contours[0].segments[0].to,[140,0]);
  assert.equal((later.nodes[3] as any).x,70);assert.equal((later.nodes[3] as any).y,0);
  assert.deepEqual(path(b,0),line);assert.deepEqual(run.sample(0),first);
});

test('symbols use their declared local geometry without applying placement twice',()=>{
  const b=fixture(),op=decoration(b);op.operator='repeatPathSymbols';op.spaces.symbol=local('symbol');
  op.inputs.symbol={kind:'path',node:'symbol',space:local('symbol')};op.inputs.symbolScale=scalar(2,'1');
  const symbol=b.nodes[2] as PathNode;symbol.transform={translate:[700,800],rotate:1.2};symbol.geometry={contours:[{id:'sym',start:[-1,0],segments:[{id:'leg',kind:'line',to:[1,2]}]}]};
  const result=prepareScene(b).sample(0);assert.deepEqual(path(result,1).contours[0].start,[8,0]);assert.deepEqual(path(result,1).contours[0].segments[0].to,[12,4]);
});

test('decoration count is an ordinary scalar socket and snapshots remain detached across reverse seeks',()=>{
  const b=fixture(),op=decoration(b);b.nodes.push({id:'counter',kind:'point',x:0,y:0,r:1});
  op.inputs.spacing={kind:'expression',expression:'20bp+time/1s*10bp',unit:'bp'};
  b.operationGraph!.operations.push({id:'readCount',operator:'scalarValue',version:1,spaces:{},inputs:{value:{kind:'output',ref:{operation:op.id,socket:'count'}}}});
  const run=prepareScene(b),original=run.sample(0),saved=structuredClone(original);assert.equal(path(run.sample(2),1).contours.length,3);
  path(original,1).contours[0].start[0]=999;path(b,0).contours[0].start[0]=-999;
  assert.deepEqual(run.sample(0),saved);assert.equal(renderSvg(run.sample(0)),renderSvg(saved));
  const direct=executeDecorationOperation(op,{path:{type:'path2d',space:local('target'),value:line}})!;assert.equal(direct.count.value,6);
});

test('derived geometry feedback, competing writers and output-chart mismatch are rejected',()=>{
  const b=fixture(),op=decoration(b);op.spaces.space=local('source');op.inputs.path={kind:'path',node:'source',space:local('source')};
  b.operationGraph!.bindings[0].target='source';assert.throws(()=>prepareScene(b),/CYCLE/);
  b.operationGraph!.bindings[0].target='target';assert.ok(validateBundle(b).some(d=>d.code==='OPERATION_SPACE_MISMATCH'));
  const competing=fixture();decoration(competing);competing.operationGraph!.bindings.push(structuredClone(competing.operationGraph!.bindings[0]));assert.throws(()=>prepareScene(competing),/WRITER|CONFLICT|DUPLICATE/);
});

test('typed decoration inputs enforce units, space, enums and source-located diagnostics',()=>{
  const span={file:'decorations.tex',start:{line:7,column:1},end:{line:7,column:20}};
  const op:Operation={id:'bad',operator:'decoratePath',version:1,spaces:{space:scene},inputs:{},sourceSpan:span};
  const good={path:{type:'path2d',space:scene,value:line}};
  for(const invalid of [{spacing:{type:'scalar',unit:'1',value:20}},{orientation:{type:'scalar',unit:'1',value:.5}},
    {mode:{type:'scalar',unit:'1',value:7}},{maxSamples:{type:'scalar',unit:'1',value:2}},
    {path:{type:'path2d',space:local('source'),value:line}},{extra:{type:'scalar',value:1}}])
    assert.throws(()=>executeDecorationOperation(op,{...good,...invalid} as any),(e:any)=>{assert.deepEqual(e.diagnostics[0].sourceSpan,span);return true;});
  assert.equal(executeDecorationOperation({...op,version:2},{}),undefined);
});

test('endpoint braces share the regular geometry binding and enforce point roles',()=>{
  const b=fixture();b.operationGraph!.operations.push({id:'brace',operator:'bracePath',version:1,spaces:{space:local('target')},inputs:{
    from:{kind:'pointExpression',space:local('target'),expression:'vec2(10bp,20bp)'},to:{kind:'pointExpression',space:local('target'),expression:'vec2(110bp+time/1s*10bp,20bp)'}}});
  b.operationGraph!.bindings.push({target:'target',property:'geometry',value:{operation:'brace',socket:'path'}});
  const f=prepareScene(b).sample(2),g=path(f,1);assert.deepEqual(g.contours[0].start,[10,20]);assert.deepEqual(g.contours[0].segments.at(-1)!.to,[130,20]);
  const op=b.operationGraph!.operations[0];assert.throws(()=>executeDecorationOperation(op,{from:{type:'vec2',role:'vector',space:local('target'),value:[0,0]},to:{type:'vec2',role:'point',space:local('target'),value:[10,0]}}),/point/);
});
