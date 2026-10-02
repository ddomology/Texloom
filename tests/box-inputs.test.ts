import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluate,prepareScene,validateOperationGraph,createOperatorRegistry,type Bundle,type InputRef,type Operation,
  type TexNode,type PointNode,type OperatorDefinition} from '../src/index.ts';
import {validateLiteralValue} from '../src/operations/values.ts';
import {validateDynamicInput,prepareOperationInputs} from '../src/operations/inputs.ts';
import {measureNodeBox,boxInputReads,resolveBoxesInput} from '../src/operations/boxes.ts';

const scene={kind:'scene'} as const;
const span={file:'measured-layout.tex',start:{line:6,column:1},end:{line:6,column:80}};
const boxes=(nodes:(string|null)[]=['text',null,'captured']):Extract<InputRef,{kind:'boxes'}>=>({kind:'boxes',space:scene,nodes});
function fixture():Bundle {
  return {version:'0.3',title:'Intrinsic box metrics',duration:2,units:'bp',viewport:{width:300,height:200},camera:{x:0,y:0,zoom:1},
    resources:{text:{kind:'vector',metrics:{width:20,height:8,depth:4},inkBounds:[-500,-200,2000,1000],items:[]}},
    nodes:[{id:'text',kind:'tex',resourceId:'text',x:999,y:-888,scale:2,transform:{translate:[500,300],rotate:1,scale:[4,3]}},
      {id:'captured',kind:'group',transform:{translate:[800,-400],rotate:.5},anchors:{center:[0,0],base:[0,3]},
        anchorMetrics:{kind:'pgf',shape:'rectangle',logicalTextBox:[-12,-7,24,14],textMetrics:{width:24,height:10,depth:4},
          innerSep:[4,4],outerSep:[2,2],alignment:'left',revision:'captured-v1'}},
      {id:'width',kind:'point',x:0,y:0,r:1}],tracks:[],relations:[],operationGraph:{version:1,operations:[],bindings:[]}};
}
const scalar=(value:number):InputRef=>({kind:'literal',value:{type:'scalar',unit:'1',value}});
function matrix(b:Bundle):Operation {
  const op:Operation={id:'layout',operator:'matrixBoxLayout',version:1,spaces:{space:scene},sourceSpan:span,inputs:{
    boxes:boxes(['text','captured']),origin:{kind:'literal',value:{type:'vec2',role:'point',space:scene,value:[0,0]}},columns:scalar(2)}};
  b.operationGraph!.operations.push(op);
  b.operationGraph!.bindings.push({target:'width',property:'r',value:{operation:'layout',socket:'width'}});
  return op;
}
function placeText(b:Bundle) {
  b.operationGraph!.operations.push({id:'place',operator:'boxPlacement',version:1,
    spaces:{space:scene,node:{kind:'local',node:'text'},parent:{kind:'parent',node:'text'}},inputs:{
      positions:{kind:'output',ref:{operation:'layout',socket:'positions'}},
      mapping:{kind:'spaceTransform',from:scene,to:{kind:'parent',node:'text'}}}});
  for(const property of ['transform','x','y'])b.operationGraph!.bindings.push({target:'text',property,value:{operation:'place',socket:property}});
}

test('boxes use scaled logical TeX dimensions and measured group baselines, excluding pose and ink',()=>{
  const b=fixture(),nodes=new Map(b.nodes.map(n=>[n.id,n])),input=boxes();
  const value=resolveBoxesInput(input,nodes,b.resources);
  assert.deepEqual(value,{type:'boxes2d',space:scene,value:[{bounds:[0,-16,40,24],baseline:0},null,{bounds:[-12,-7,24,14],baseline:3}]});
  // Measurements are detached: callers cannot mutate cached source metrics or a later measurement.
  assert.equal(value.type,'boxes2d');if(value.type!=='boxes2d')return;
  value.value[2]!.bounds[0]=777;
  assert.deepEqual(measureNodeBox(nodes.get('captured'),b.resources),{bounds:[-12,-7,24,14],baseline:3});
  assert.deepEqual(boxInputReads(input,nodes),[{node:'text',property:'scale'},{node:'captured',property:'anchors'},{node:'captured',property:'anchorMetrics'}]);
});

test('prepared inputs read current metrics without consulting destination transforms or camera',()=>{
  const b=fixture(),op=matrix(b),prepared=prepareOperationInputs(op,b,'$.operationGraph.operations[0]',[]);
  const live=new Map(structuredClone(b.nodes).map(n=>[n.id,n]));
  (live.get('text') as TexNode).scale=3;
  live.get('text')!.transform={scale:[0,0]}; // Never inverted: the placement owns this pose.
  const captured=live.get('captured');assert.equal(captured?.kind,'group');if(captured?.kind!=='group')return;
  captured.anchorMetrics!.logicalTextBox=[-15,-9,30,20];captured.anchors!.base=[0,5];
  assert.deepEqual(prepared.resolve(live,0,{},new Map()).boxes,{type:'boxes2d',space:scene,
    value:[{bounds:[0,-24,60,36],baseline:0},{bounds:[-15,-9,30,20],baseline:5}]});
});

test('live scale writers precede intrinsic layout while complete pose sinks do not self-cycle',()=>{
  const b=fixture();matrix(b);placeText(b);
  b.operationGraph!.operations.push({id:'zScale',operator:'scalarValue',version:1,spaces:{},inputs:{value:{kind:'expression',expression:'1+time/1s',unit:'1'}}});
  b.operationGraph!.bindings.push({target:'text',property:'scale',value:{operation:'zScale',socket:'value'}});
  const run=prepareScene(b),at=(time:number)=>run.sample(time),f0=at(0),f2=at(2);
  assert.equal((f0.nodes.find(n=>n.id==='width') as PointNode).r,64);
  assert.equal((f2.nodes.find(n=>n.id==='width') as PointNode).r,104);
  const tex=f2.nodes.find(n=>n.id==='text') as TexNode;
  assert.equal(tex.scale,3);assert.equal(tex.x,0);assert.equal(tex.y,0);
  assert.deepEqual(at(0),f0);
  tex.transform!.translate![0]=9999;
  assert.deepEqual(at(0),f0);
  assert.equal((b.nodes[0] as TexNode).x,999);
});

test('box dependencies reject a genuine metric feedback cycle with source location',()=>{
  const b=fixture();matrix(b);placeText(b);
  b.operationGraph!.bindings.push({target:'text',property:'scale',value:{operation:'layout',socket:'rows'}});
  assert.throws(()=>prepareScene(b),(error:any)=>{
    const d=error.diagnostics?.find((d:any)=>/CYCLE/.test(d.code));assert.ok(d,String(error));
    assert.ok(d.sourceSpan?.file===span.file||d.related?.some((r:any)=>r.sourceSpan?.file===span.file));return true;
  });
});

test('invalid node slots, duplicate IDs and absent measured metrics produce located input errors',()=>{
  const b=fixture();
  const cases:unknown[]=[{kind:'boxes',space:scene,nodes:['text','text']},boxes(['missing']),boxes(['width']),
    {kind:'boxes',space:scene,nodes:[42]}, {kind:'boxes',space:scene,nodes:Array(4097).fill(null)},
    {kind:'boxes',space:scene,nodes:[],extra:true},{kind:'boxes',space:{kind:'local',node:'missing'},nodes:[]}];
  for(const input of cases){const ds=validateDynamicInput(input,b,'$.input',span).diagnostics;
    assert.ok(ds.length,JSON.stringify(input));assert.equal(ds[0].sourceSpan?.file,span.file);}
  const g=b.nodes.find(n=>n.id==='captured');assert.equal(g?.kind,'group');if(g?.kind!=='group')return;
  delete g.anchors!.base;
  assert.match(validateDynamicInput(boxes(),b,'$.input',span).diagnostics[0].message,/base anchor/);
  delete g.anchorMetrics;
  assert.ok(validateDynamicInput(boxes(),b,'$.input',span).diagnostics.length);
});

test('boxes2d literal boundary requires finite strict logical box data with a bounded slot count',()=>{
  const valid={type:'boxes2d',space:scene,value:[null,{bounds:[-2,-8,20,12],baseline:0}]};
  assert.deepEqual(validateLiteralValue(valid),[]);
  for(const value of [[{bounds:[0,0,-1,2],baseline:0}],[{bounds:[0,0,1,2],baseline:Infinity}],
    [{bounds:[0,0,1,2],baseline:0,ink:true}],[{bounds:[0,0,1,2]}],Array(4097).fill(null)])
    assert.ok(validateLiteralValue({...valid,value}).length);
  let read=false;const getter={get bounds(){read=true;return [0,0,1,1];},baseline:0};
  assert.ok(validateLiteralValue({...valid,value:[getter]}).length);assert.equal(read,false);
  assert.ok(validateLiteralValue({...valid,extra:1}).some(d=>d.code==='UNKNOWN_PROPERTY'));
});

test('boxes2d registry sockets carry exact charts and have no implicit node-property sink',()=>{
  const definition:OperatorDefinition={name:'boxEcho',version:1,spaces:['space'],pure:true,deterministic:true,
    inputs:{value:{value:{type:'boxes2d',space:'space'},required:true}},outputs:{boxes:{type:'boxes2d',space:'space'}}};
  const registry=createOperatorRegistry([definition]),b=fixture();
  b.operationGraph!.operations=[{id:'echo',operator:'boxEcho',version:1,spaces:{space:scene},inputs:{value:boxes()}}];
  assert.deepEqual(validateOperationGraph(b.operationGraph,b,registry),[]);
  b.operationGraph!.operations[0].inputs.value={kind:'literal',value:{type:'boxes2d',space:{kind:'local',node:'captured'},value:[]}};
  assert.ok(validateOperationGraph(b.operationGraph,b,registry).some(d=>d.code==='OPERATION_SPACE_MISMATCH'));
  b.operationGraph!.operations[0].inputs.value={kind:'literal',value:{type:'boxes2d',space:{kind:'local',node:'missing'},value:[]}};
  assert.ok(validateOperationGraph(b.operationGraph,b,registry).some(d=>d.code==='OPERATION_SPACE_REFERENCE'));
  b.operationGraph!.operations[0].inputs.value=boxes();
  b.operationGraph!.bindings=[{target:'width',property:'position',value:{operation:'echo',socket:'boxes'}}];
  assert.ok(validateOperationGraph(b.operationGraph,b,registry).some(d=>d.code==='OPERATION_TYPE_MISMATCH'));
});

test('group metadata remains authoritative and overflowing live metrics fail before layout',()=>{
  const b=fixture(),g=b.nodes[1];assert.equal(g.kind,'group');if(g.kind!=='group')return;
  b.nodes.push({id:'art',kind:'tex',parent:'captured',resourceId:'text',x:3000,y:4000,scale:12});
  assert.deepEqual(measureNodeBox(g,b.resources),{bounds:[-12,-7,24,14],baseline:3});
  matrix(b);b.tracks.push({target:'text',property:'scale',keys:[[0,1],[2,Number.MAX_VALUE]]});
  assert.throws(()=>evaluate(b,2),(error:any)=>{
    const d=error.diagnostics?.find((d:any)=>d.code==='BOX_METRICS');assert.ok(d,String(error));assert.equal(d.sourceSpan?.file,span.file);return true;
  });
});
