import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluate, createEvaluator, prepareScene, validateBundle, validateOperationGraph, validateExpressionProgram,
  type Bundle, type EvaluatedFrame, type InputRef, type PointNode, type SpaceRef, type TexNode,
} from '../src/index.ts';

const scene = {kind: 'scene'} as const;
const local = (node: string) => ({kind: 'local', node} as const);
type AnchorInput = Extract<InputRef, {kind:'anchor'}>;
type PlacementInput = Extract<InputRef, {kind:'textPlacement'}>;
const point = (value: [number, number], space: SpaceRef = scene): InputRef => ({kind:'literal',value:{type:'vec2',role:'point',space,value}});
const read = (node: string): InputRef => ({kind:'node',node,property:'position',space:scene});
const named = (node: string, name: string, options: Record<string, unknown> = {}): AnchorInput =>
  ({kind:'anchor',source:{kind:'node',node,...options},query:{kind:'named',name},space:scene} as AnchorInput);
const shapeAnchor = (query: AnchorInput['query']): AnchorInput => ({kind:'anchor',source:{kind:'shape',ref:{operation:'shape',socket:'shape'}},query,space:scene});
function fixture(): Bundle {
  return {version:'0.3',title:'Live anchor providers',duration:2,units:'bp',viewport:{width:300,height:250},camera:{x:0,y:0,zoom:1},
    resources:{text:{kind:'vector',metrics:{width:20,height:8,depth:4},inkBounds:[-2,-10,26,16],
      sourceTex:'x',items:[{kind:'path',d:'M0 0L20 0',style:{stroke:'white'}}]}},
    nodes:[{id:'label',kind:'tex',resourceId:'text',x:30,y:40,scale:2},
      {id:'marker',kind:'point',x:0,y:0,r:1},{id:'other',kind:'point',x:0,y:0,r:1},
      {id:'ellipse',kind:'ellipse',cx:1,cy:2,rx:4,ry:2},
      {id:'measured',kind:'group',anchors:{center:[2,3],east:[7,3],mid:[2,2]}}],
    tracks:[],relations:[],operationGraph:{version:1,operations:[],bindings:[]}};
}
function near(actual: readonly number[], expected: readonly number[], tolerance=1e-8) {
  assert.equal(actual.length,expected.length);
  actual.forEach((value,i)=>assert.ok(Number.isFinite(value)&&Math.abs(value-expected[i])<=tolerance,`${actual} != ${expected}`));
}
const at=(frame:EvaluatedFrame,id='marker')=>frame.nodes.find(node=>node.id===id) as PointNode;
const tex=(frame:EvaluatedFrame)=>frame.nodes.find(node=>node.id==='label') as TexNode;
function drive(b:Bundle,input:InputRef,target='marker',id='anchor') {
  b.operationGraph!.operations.push({id,operator:'midpoint',version:1,spaces:{space:scene},inputs:{a:input,b:structuredClone(input)}});
  b.operationGraph!.bindings.push({target,property:'position',value:{operation:id,socket:'position'}});
}
function shape(b:Bundle,space:SpaceRef=scene) {
  b.operationGraph!.operations.push({id:'shape',operator:'circle',version:1,spaces:{space},
    inputs:{center:point([0,0],space),radius:{kind:'expression',unit:'bp',expression:'10bp+5bp*time/1s'}}});
}

test('text compass and baseline anchors use logical width, height and depth with independent padding',()=>{
  const cases:[string,[number,number]][]=[['center',[50,36]],['north',[50,21]],['east',[75,36]],
    ['north east',[75,21]],['south east',[75,51]],['base',[50,40]],['base west',[30,40]],['base east',[70,40]]];
  for(const [name,expected] of cases){
    const b=fixture(); drive(b,named('label',name,{innerSep:[2,1],outerSep:[3,2]}));
    near([at(evaluate(b,0)).x,at(evaluate(b,0)).y],expected);
  }
});

test('phantom and overhanging artwork do not replace the logical text placement box',()=>{
  const b=fixture(); drive(b,named('label','north'));
  const expected=evaluate(b,0); near([at(expected).x,at(expected).y],[50,24]);
  const resource=b.resources.text; assert.equal(resource.kind,'vector'); if(resource.kind!=='vector')return;
  resource.inkBounds=[-100,-80,200,160]; resource.items=[]; resource.sourceTex='phantom';
  const f=evaluate(b,0); near([at(f).x,at(f).y],[50,24]);
});

test('measured PGF anchors retain measured coordinates and support explicitly measured mid',()=>{
  for(const [name,expected] of [['east',[12,-11]],['mid',[10,-1]]] as const){
    const b=fixture(); b.nodes.find(n=>n.id==='measured')!.transform={translate:[6,3],rotate:-Math.PI/2,scale:[2,2]};
    drive(b,named('measured',name)); const f=evaluate(b,0); near([at(f).x,at(f).y],expected);
  }
});

test('ellipse diagonal anchors are parametric while border rays invert reflected nonuniform transforms',()=>{
  const b=fixture(); b.nodes.push({id:'axes',kind:'group',transform:{translate:[10,20],rotate:Math.PI/2,scale:[-2,3]}});
  b.nodes.find(n=>n.id==='ellipse')!.parent='axes';
  drive(b,named('ellipse','north east'));
  const diagonal=evaluate(b,0); near([at(diagonal).x,at(diagonal).y],[4+3*Math.SQRT2,18-4*Math.SQRT2]);
  b.operationGraph!.operations=[]; b.operationGraph!.bindings=[];
  drive(b,{kind:'anchor',source:{kind:'node',node:'ellipse'},query:{kind:'border',towards:point([-8,2])},space:scene});
  b.camera={x:300,y:-100,zoom:7,rotation:1};
  const border=evaluate(b,0); near([at(border).x,at(border).y],[4-3*Math.SQRT2,18-4*Math.SQRT2]);
});

test('shape-anchor references wait for current radius and use the declared shape coordinate space',()=>{
  const b=fixture(); b.nodes.push({id:'axes',kind:'group',transform:{translate:[10,20],scale:[-2,3]}});
  // The consumer is deliberately declared before its shape producer.
  drive(b,shapeAnchor({kind:'border',towards:point([-100,20])})); shape(b,local('axes'));
  const run=createEvaluator(b); near([at(run(0)).x,at(run(0)).y],[-10,20]);
  near([at(run(2)).x,at(run(2)).y],[-30,20]); near([at(run(1)).x,at(run(1)).y],[-20,20]);
});

test('textPlacement binds a transformed baseline without reading its own old position',()=>{
  const b=fixture(); b.nodes.push({id:'axes',kind:'group',transform:{translate:[10,20],rotate:Math.PI/2,scale:[-2,3]}});
  const label=b.nodes.find(n=>n.id==='label') as TexNode;
  Object.assign(label,{parent:'axes',x:300,y:-200,scale:1,transform:{translate:[2,-1]}});
  b.expressions={version:1,parameters:{},bindings:[{target:'label',property:'scale',expression:'1+time/1s'}]};
  drive(b,named('label','base'),'marker','aObserve');
  drive(b,{kind:'textPlacement',node:'label',anchor:'base',point:point([50,60])},'label','zPlace');
  const f=evaluate(b,1); near([tex(f).x,tex(f).y],[-42,-37/3]); near([at(f).x,at(f).y],[50,60]);
  near(f.anchors!['$.operationGraph.operations[1].inputs.a'].position,[50,100]);
  assert.equal(tex(f).scale,2); assert.equal(label.x,300); assert.equal(label.y,-200);
});

test('textPlacement padding uses the same logical anchor as the subsequent live anchor query',()=>{
  const b=fixture(); const input:PlacementInput={kind:'textPlacement',node:'label',anchor:'north east',point:point([100,120]),innerSep:[2,1],outerSep:[3,2]};
  drive(b,input,'label','place'); drive(b,named('label','north east',{innerSep:[2,1],outerSep:[3,2]}),'marker','observe');
  const f=evaluate(b,0); near([tex(f).x,tex(f).y],[55,139]); near([at(f).x,at(f).y],[100,120]);
});

test('textPlacement position writes conflict with scalar position tracks',()=>{
  const b=fixture(); drive(b,{kind:'textPlacement',node:'label',anchor:'center',point:point([10,20])},'label');
  b.tracks.push({target:'label',property:'x',keys:[[0,1]]});
  assert.ok(validateBundle(b).some(d=>/WRITER|CONFLICT/.test(d.code))); assert.throws(()=>createEvaluator(b),/WRITER|CONFLICT/);
});

test('shape references and placement point inputs participate in graph and property dependency cycles',()=>{
  const shapeCycle=fixture(); drive(shapeCycle,shapeAnchor({kind:'named',name:'center'})); shape(shapeCycle);
  shapeCycle.operationGraph!.operations.find(o=>o.id==='shape')!.inputs.center={kind:'output',ref:{operation:'anchor',socket:'position'}};
  const placementCycle=fixture(); drive(placementCycle,{kind:'textPlacement',node:'label',anchor:'base',point:read('label')},'label');
  for(const b of [shapeCycle,placementCycle]){
    b.operationGraph!.operations[0].sourceSpan={file:'anchor-cycle.tex',start:{line:4,column:1},end:{line:4,column:50}};
    assert.throws(()=>createEvaluator(b),(error:any)=>{
      const d=error.diagnostics?.find((d:any)=>/CYCLE/.test(d.code)); assert.ok(d,String(error));
      assert.ok(d.sourceSpan?.file==='anchor-cycle.tex'||d.related?.some((r:any)=>r.sourceSpan?.file==='anchor-cycle.tex')); return true;
    });
  }
});

test('missing or unsupported anchors, padding overrides and zero border direction give located diagnostics',()=>{
  const inputs:InputRef[]=[named('label','mid'),named('measured','south'),named('measured','east',{outerSep:[1,1]}),
    {kind:'anchor',source:{kind:'node',node:'measured'},query:{kind:'border',towards:point([20,20])},space:scene},
    {kind:'anchor',source:{kind:'node',node:'ellipse'},query:{kind:'border',towards:point([1,2])},space:scene},
    named('label','east',{innerSep:[-1,0]}),named('absent','center')];
  for(const input of inputs){
    const b=fixture(); drive(b,input); b.operationGraph!.operations[0].sourceSpan={file:'invalid-anchor.tex',start:{line:5,column:1},end:{line:5,column:40}};
    assert.throws(()=>evaluate(b,0),(error:any)=>{
      const d=error.diagnostics?.[0]; assert.ok(d,String(error)); assert.equal(d.sourceSpan?.file,'invalid-anchor.tex');
      assert.match(d.path??'',/operations\[0\]/); return true;
    });
  }
});

test('nested border expressions see candidate globals and retain their own runtime source location',()=>{
  const b=fixture(); b.expressions={version:1,parameters:{},bindings:[]};
  drive(b,{kind:'anchor',source:{kind:'node',node:'ellipse'},query:{kind:'border',towards:{kind:'pointExpression',expression:'vec2(1bp+dx,2bp)',space:scene,
    sourceSpan:{file:'ray.tex',start:{line:8,column:3},end:{line:8,column:28}}}},space:scene});
  const candidate={version:1 as const,parameters:{dx:{type:'scalar' as const,unit:'bp' as const,default:10}},bindings:[]};
  assert.deepEqual(validateExpressionProgram(candidate,b),[]); b.expressions=candidate;
  assert.deepEqual(validateOperationGraph(b.operationGraph,b),[]); const f=evaluate(b,0); near([at(f).x,at(f).y],[5,2]);
  const input=b.operationGraph!.operations[0].inputs.a as AnchorInput;
  if(input.query.kind!=='border')throw new Error('Expected border query');
  input.query.towards={kind:'pointExpression',expression:'vec2(1bp/(dx/1bp),2bp)',space:scene,
    sourceSpan:{file:'ray.tex',start:{line:8,column:3},end:{line:8,column:30}}};
  assert.throws(()=>evaluate(b,0,{dx:0}),(error:any)=>{
    const d=error.diagnostics?.find((d:any)=>d.code==='EXPRESSION_DOMAIN'); assert.ok(d,String(error));
    assert.equal(d.sourceSpan?.file,'ray.tex'); assert.match(d.path??'',/inputs\.a.*towards/); return true;
  });
});

test('anchor evaluation preserves authored data and independent frames through reverse seeking',()=>{
  const b=fixture(); b.tracks.push({target:'label',property:'scale',keys:[[0,1],[2,3]]}); drive(b,named('label','north'));
  const source=structuredClone(b),one=prepareScene(b),two=createEvaluator(b),first=one.sample(0.75),expected=structuredClone(first);
  one.sample(2); one.sample(0); two(1); assert.deepEqual(one.sample(0.75),expected); assert.deepEqual(two(0.75),expected);
  at(first).x=999; tex(first).y=999; assert.deepEqual(one.sample(0.75),expected); assert.deepEqual(b,source);
  const resource=b.resources.text; if(resource.kind==='vector')resource.metrics.width=900;
  assert.deepEqual(one.sample(0.75),expected); assert.deepEqual(two(0.75),expected);
});

test('provider revisions distinguish resource content snapshots even when logical metrics are unchanged',()=>{
  const b=fixture(); drive(b,named('label','base'));
  const one=prepareScene(b),first=one.sample(0),inputPath='$.operationGraph.operations[0].inputs.a';
  const entry=first.anchors![inputPath]; assert.ok(entry); assert.deepEqual(entry.space,scene); near(entry.position,[50,40]);
  const revision=entry.provider.revision; assert.equal(typeof revision,'string'); assert.ok(revision.length>0);
  const resource=b.resources.text; if(resource.kind!=='vector')throw new Error('Expected text resource');
  resource.sourceTex='different formula';
  const second=prepareScene(b).sample(0),changed=second.anchors![inputPath];
  assert.notEqual(changed.provider.revision,revision); near(changed.position,entry.position);
  resource.sourceTex='x'; resource.items=[{kind:'path',d:'M0 0L10 -4L20 0'}];
  assert.notEqual(prepareScene(b).sample(0).anchors![inputPath].provider.revision,revision);
  assert.equal(one.sample(0).anchors![inputPath].provider.revision,revision);
  assert.notEqual(second.anchors,first.anchors); assert.notEqual(changed.provider,entry.provider);
});

test('anchor output space validation rejects malformed and mismatched spaces while accepting plot charts',()=>{
  const b=fixture(); const input:AnchorInput={kind:'anchor',source:{kind:'node',node:'ellipse'},query:{kind:'border',towards:point([10,0])},space:scene};
  (input as any).space=null; drive(b,input);
  assert.doesNotThrow(()=>validateOperationGraph(b.operationGraph,b)); assert.doesNotThrow(()=>validateBundle(b));
  assert.ok(validateOperationGraph(b.operationGraph,b).some(d=>d.code==='SPACE_TYPE'));
  assert.ok(validateBundle(b).some(d=>d.code==='SPACE_TYPE'));
  const chart={kind:'plot',node:'measured'} as const,valid=fixture();
  const border:AnchorInput={kind:'anchor',source:{kind:'node',node:'ellipse'},query:{kind:'border',towards:point([10,0])},space:chart};
  drive(valid,border); valid.operationGraph!.operations[0].spaces.space=chart; valid.operationGraph!.bindings=[];
  assert.ok(validateOperationGraph(valid.operationGraph,valid).some(d=>d.code==='OPERATION_SPACE_MISMATCH'&&d.path?.endsWith('.query.towards')));
  for(const input of Object.values(valid.operationGraph!.operations[0].inputs)){
    if(input.kind==='anchor'&&input.query.kind==='border')input.query.towards=point([10,0],chart);
  }
  assert.deepEqual(validateOperationGraph(valid.operationGraph,valid),[]);
  assert.deepEqual(evaluate(valid,0).anchors!['$.operationGraph.operations[0].inputs.a'].space,chart);
});
