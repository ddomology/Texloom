import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareScene,validateBundle,executeLayoutOperation,type Bundle,type Operation,type TexNode,type PathNode,type LiteralValue,type VectorResource} from '../src/index.ts';
import {renderSvg} from '../src/render-svg.ts';

const scene={kind:'scene'} as const;
const local=(node:string)=>({kind:'local',node} as const);
const parent=(node:string)=>({kind:'parent',node} as const);
const literal=(value:LiteralValue)=>({kind:'literal' as const,value});
const scalar=(value:number,unit:'bp'|'1'='bp')=>literal({type:'scalar',unit,value});
const output=(operation:string,socket:string)=>({kind:'output' as const,ref:{operation,socket}});
function fixture():Bundle {
  const resources=Object.fromEntries([['A',10,8,2],['B',30,12,4],['C',20,6,3]].map(([id,width,height,depth])=>[id,{kind:'vector',metrics:{width,height,depth},inkBounds:[0,-Number(height),width,Number(height)+Number(depth)],items:[]}])) as Bundle['resources'];
  return {version:'0.3',title:'Measured placement',duration:2,units:'bp',viewport:{width:200,height:120},camera:{x:0,y:0,zoom:1},resources,
    nodes:['A','B','C'].map(id=>({id,kind:'tex',resourceId:id,x:777,y:888})),tracks:[],relations:[],operationGraph:{version:1,operations:[],bindings:[]}};
}
function layout(b:Bundle):Operation {
  const op:Operation={id:'layout',operator:'matrixBoxLayout',version:1,spaces:{space:scene},inputs:{boxes:{kind:'boxes',space:scene,nodes:['A','B','C',null]},
    origin:literal({type:'vec2',role:'point',space:scene,value:[10,20]}),columns:scalar(2,'1'),gapX:scalar(10),gapY:scalar(15)}};
  b.operationGraph!.operations.push(op);
  for(const [index,id] of ['A','B','C'].entries()){
    b.operationGraph!.operations.push({id:'place'+id,operator:'boxPlacement',version:1,spaces:{space:scene,node:local(id),parent:parent(id)},inputs:{positions:output('layout','positions'),index:scalar(index,'1'),mapping:{kind:'spaceTransform',from:scene,to:parent(id)}}});
    for(const property of ['transform','x','y'])b.operationGraph!.bindings.push({target:id,property,value:{operation:'place'+id,socket:property}});
  }
  return op;
}
const pose=(b:{nodes:readonly unknown[]},id:string)=>(b.nodes.find(n=>(n as any).id===id) as TexNode).transform!.translate!;

test('measured matrix uses live TeX depth/scale before placing nodes and downstream connectors',()=>{
  const b=fixture();layout(b);b.expressions={version:1,parameters:{},bindings:[{target:'A',property:'scale',expression:'1+time/1s'}]};
  b.nodes.push({id:'edge',kind:'path',d:'M0 0L1 0',geometry:{contours:[{id:'e',start:[0,0],segments:[{id:'s',kind:'line',to:[1,0]}]}]}});
  b.operationGraph!.operations.push({id:'connect',operator:'connectStraight',version:1,spaces:{space:local('edge')},inputs:{
    from:{kind:'anchor',source:{kind:'node',node:'A'},query:{kind:'named',name:'east'},space:local('edge')},
    to:{kind:'anchor',source:{kind:'node',node:'B'},query:{kind:'named',name:'west'},space:local('edge')}}});
  b.operationGraph!.bindings.push({target:'edge',property:'geometry',value:{operation:'connect',socket:'path'}});
  const run=prepareScene(b),first=run.sample(0),second=run.sample(1);
  assert.deepEqual(pose(first,'A'),[15,32]);assert.deepEqual(pose(first,'B'),[40,32]);assert.deepEqual(pose(first,'C'),[10,57]);
  assert.deepEqual(pose(second,'A'),[10,36]);assert.deepEqual(pose(second,'C'),[10,61]);
  const edge=second.nodes[3] as PathNode;assert.deepEqual(edge.geometry!.contours[0].start,[30,30]);assert.deepEqual(edge.geometry!.contours[0].segments[0].to,[40,32]);
  assert.equal((second.nodes[0] as TexNode).x,0);assert.equal((second.nodes[0] as TexNode).y,0);
  assert.equal((b.nodes[0] as TexNode).x,777);assert.equal((b.resources.A as VectorResource).metrics.width,10);
});

test('fit combines measured metrics and explicit placements into independently checked padded bounds',()=>{
  const b=fixture();layout(b);b.nodes.push({id:'fit',kind:'path',d:'M0 0',geometry:{contours:[]}});
  b.operationGraph!.operations.push({id:'fitBounds',operator:'fitBoxBounds',version:1,spaces:{space:local('fit')},inputs:{
    boxes:{kind:'boxes',nodes:['A','B','C',null],space:local('fit')},positions:literal({type:'points2d',space:local('fit'),value:[[15,32],[40,32],[10,57],[0,0]]}),paddingX:scalar(3),paddingY:scalar(5)}});
  b.operationGraph!.bindings.push({target:'fit',property:'geometry',value:{operation:'fitBounds',socket:'path'}});
  const f=prepareScene(b).sample(0),g=(f.nodes[3] as PathNode).geometry!.contours[0];
  assert.deepEqual(g.start,[7,15]);assert.deepEqual(g.segments[1].to,[73,65]);
});

test('layout snapshots and reverse seeks do not retain prior output or caller mutations',()=>{
  const b=fixture(),op=layout(b);op.inputs.gapX={kind:'expression',expression:'10bp+time/1s*5bp',unit:'bp'};
  const run=prepareScene(b),first=run.sample(0),saved=structuredClone(first);assert.deepEqual(pose(run.sample(2),'B'),[50,32]);
  pose(first,'A')[0]=999;(b.resources.A as VectorResource).metrics.width=999;(b.nodes[0] as TexNode).x=-999;
  assert.deepEqual(run.sample(0),saved);assert.equal(renderSvg(run.sample(0)),renderSvg(saved));
});

test('metric feedback, dynamic pose writers and invalid placement charts fail before evaluation',()=>{
  const cyclic=fixture();layout(cyclic);cyclic.operationGraph!.bindings.push({target:'A',property:'scale',value:{operation:'layout',socket:'columns'}});assert.throws(()=>prepareScene(cyclic),/CYCLE/);
  const conflict=fixture();layout(conflict);conflict.tracks.push({target:'A',property:'x',keys:[[0,4],[2,10]]});assert.throws(()=>prepareScene(conflict),/WRITER|CONFLICT/);
  const mismatch=fixture();layout(mismatch);mismatch.operationGraph!.operations.find(o=>o.id==='placeA')!.spaces.parent=scene;
  assert.ok(validateBundle(mismatch).some(d=>d.code==='OPERATION_SPACE_MISMATCH'));
});

test('all typed layout profiles reject invalid units, modes, positions and indices with source spans',()=>{
  const span={file:'layout.tex',start:{line:2,column:1},end:{line:2,column:9}};
  const op:Operation={id:'layout',operator:'matrixBoxLayout',version:1,spaces:{space:scene},inputs:{},sourceSpan:span};
  const inputs:Record<string,LiteralValue>={boxes:{type:'boxes2d',space:scene,value:[{bounds:[0,-8,10,10],baseline:0}]},origin:{type:'vec2',role:'point',space:scene,value:[0,0]}};
  for(const bad of [{columns:{type:'scalar',unit:'bp',value:2}},{overflow:{type:'scalar',unit:'1',value:2}},{gapX:{type:'scalar',unit:'bp',value:-2}},
    {origin:{type:'vec2',role:'point',space:local('A'),value:[0,0]}},{extra:{type:'scalar',value:1}}])
    assert.throws(()=>executeLayoutOperation(op,{...inputs,...bad} as any),(e:any)=>{assert.deepEqual(e.diagnostics[0].sourceSpan,span);return true;});
  const place:Operation={...op,operator:'boxPlacement',spaces:{space:scene,node:local('A'),parent:parent('A')}};
  assert.throws(()=>executeLayoutOperation(place,{positions:{type:'points2d',space:scene,value:[]},mapping:{type:'transform2d',from:scene,to:parent('A'),value:[1,0,0,1,0,0]}}),/index/);
  assert.equal(executeLayoutOperation({...op,version:2},{}),undefined);
});

test('row wrap, alignment and fit compose through portable typed outputs without geometry replacement',()=>{
  const op:Operation={id:'flow',operator:'distributeBoxLayout',version:1,spaces:{space:scene},inputs:{}};
  const boxes:LiteralValue={type:'boxes2d',space:scene,value:[{bounds:[0,-8,30,10],baseline:0},{bounds:[0,-12,40,16],baseline:0},{bounds:[0,-6,20,9],baseline:0}]};
  const flow=executeLayoutOperation(op,{boxes,origin:{type:'vec2',role:'point',space:scene,value:[5,10]},gap:{type:'scalar',unit:'bp',value:10},crossGap:{type:'scalar',unit:'bp',value:5},maxWidth:{type:'scalar',unit:'bp',value:80},overflow:{type:'scalar',unit:'1',value:2},align:{type:'scalar',unit:'1',value:3}})!;
  assert.deepEqual(flow.positions.value,[[5,22],[45,22],[5,37]]);
  const aligned=executeLayoutOperation({...op,operator:'alignBoxLayout'},{boxes,positions:flow.positions,axis:{type:'scalar',unit:'1',value:1},align:{type:'scalar',unit:'1',value:3},at:{type:'scalar',unit:'bp',value:50}})!;
  assert.deepEqual(aligned.positions.value,[[5,50],[45,50],[5,50]]);
  const fit=executeLayoutOperation({...op,operator:'fitBoxBounds'},{boxes,positions:aligned.positions})!;assert.equal(fit.width.value,80);assert.equal(fit.height.value,16);
});
