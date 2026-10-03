import test from 'node:test';
import assert from 'node:assert/strict';
import {lowerTimeline} from '../src/timeline/compile.js';
import {createEvaluator} from '../src/evaluate.js';
import {prepareExecutionPlan} from '../src/operations/plan.js';
import {renderSvg} from '../src/render-svg.js';
import {validateBundle,type Bundle,type TexNode,type GroupNode,type VectorResource,type Diagnostic} from '../src/schema.js';
import type {MathCorrespondenceOptions} from '../src/operations/text-parts.js';

const node=<T>(frame:{nodes:{id:string}[]},id:string)=>frame.nodes.find(n=>n.id===id) as T;
const near=(actual:readonly number[],expected:readonly number[])=>actual.forEach((v,i)=>assert.ok(Math.abs(v-expected[i])<1e-10,`${actual} != ${expected}`));
const codes=(bundle:unknown)=>validateBundle(bundle).filter(d=>d.severity==='error').map(d=>d.code);
function rejects(fn:()=>unknown,pattern:RegExp):void {
  assert.throws(fn,(e:unknown)=>e instanceof Error&&e.name!=='TypeError'&&pattern.test(JSON.stringify((e as {diagnostics?:Diagnostic[]}).diagnostics??e.message)));
}
function resource(target=false):VectorResource {
  const left=target?2:1,right=target?22:11;
  return {kind:'vector',sourceTex:'x+x',metrics:{width:target?26:14,height:8,depth:2},inkBounds:[0,-8,target?26:14,10],
    items:[{kind:'path',d:`M${left} -2 H${left+2} V2 H${left} Z`,style:{fill:'#dce6ed'}},
      {kind:'path',d:`M${right} -2 H${right+2} V2 H${right} Z`,style:{fill:'#eca74e'}},
      {kind:'path',d:target?'M10 0 H14':'M5 0 H8',style:{fill:'none',stroke:'#fff',strokeWidth:.5}}],
    textParts:{version:1,parts:[
      {id:target?'a':'left',sourceRange:{start:0,end:1},paintPaths:[[0]],logicalBox:[left,-2,2,4]},
      {id:target?'b':'right',sourceRange:{start:2,end:3},paintPaths:[[1]],logicalBox:[right,-2,2,4]}]}};
}
function fixture():Bundle {
  return {version:'0.3',title:'Semantic formula transition runtime',duration:8,units:'bp',viewport:{width:400,height:200},camera:{x:0,y:0,zoom:1},
    resources:{before:resource(),after:resource(true)},tracks:[],relations:[],nodes:[
      {id:'stage',kind:'group',transform:{translate:[30,15],scale:[1.1,.9]},style:{opacity:.8}},
      {id:'source',kind:'tex',parent:'stage',resourceId:'before',x:10,y:20,scale:2,visible:false,transform:{rotate:.1},clip:{d:'M-100 -100 H400 V200 H-100 Z'},style:{opacity:.7}},
      {id:'destination',kind:'tex',parent:'stage',resourceId:'after',x:110,y:40,scale:3,visible:false,transform:{rotate:.1},clip:{d:'M-100 -100 H400 V200 H-100 Z'},style:{opacity:.7}}]};
}
const correspondence=():MathCorrespondenceOptions=>({approved:true,retention:'replace',unmatched:'fade',pairs:[
  {source:'left',target:'a',mode:'replace',sourceAnchor:[1,0],targetAnchor:[2,-4]},
  {source:'right',target:'b',mode:'replace',sourceAnchor:[11,0],targetAnchor:[22,4]}]});
const action=(id='change',options=correspondence())=>({kind:'math-transform',id,source:'source',destination:'destination',duration:2,
  correspondence:{...options,labels:{source:'x plus x',target:'two positioned copies of x'}}});
const program=(root:any)=>({version:1 as const,root});
const sequence=(...children:any[])=>({kind:'sequence',children});
const lower=(root:any,input=fixture())=>lowerTimeline(program(root),input);

test('math progress is a bounded numeric group property and remains optional on legacy groups',()=>{
  const input=fixture();input.nodes.push({id:'progress',kind:'group',mathProgress:0});
  input.tracks=[{target:'progress',property:'mathProgress',keys:[[0,0],[2,1]]}];
  assert.deepEqual(codes(input),[]);assert.equal(node<GroupNode>(createEvaluator(input)(1),'progress').mathProgress,.5);
  for(const invalid of [-.1,1.1,NaN,Infinity]){
    const malformed=structuredClone(input);node<GroupNode>(malformed,'progress').mathProgress=invalid;assert.ok(codes(malformed).length>0);
  }
  const invalidTrack=structuredClone(input);invalidTrack.tracks[0].keys[1][1]=1.01;assert.ok(codes(invalidTrack).length>0);
  const legacy=fixture();assert.deepEqual(codes(legacy),[]);
});

test('SVG describes only active semantic transitions, escapes labels and preserves exact legacy output otherwise',()=>{
  const frame=createEvaluator(fixture())(1),legacy=renderSvg(frame,{idPrefix:'fixture'});
  const report={progress:.5,state:'transition' as const,active:false,sourceText:'x < y',targetText:'a & b',description:'From x < y to a & b "now".',retention:'replace' as const};
  frame.mathTransforms={change:report};assert.equal(renderSvg(frame,{idPrefix:'fixture'}),legacy);
  frame.mathTransforms={change:{...report,active:true},hidden:{...report,description:'HIDDEN'}};
  const accessible=renderSvg(frame,{idPrefix:'fixture'});
  assert.ok(accessible.includes('aria-describedby="fixture-math-description"'));
  assert.ok(accessible.includes('<desc id="fixture-math-description">From x &lt; y to a &amp; b &quot;now&quot;.</desc>'));
  assert.ok(!accessible.includes('HIDDEN'));assert.ok(accessible.includes('aria-label="Texloom scene at 1 seconds"'));
});

test('delayed formula instances take over exact native resources at endpoints and hoist shared endpoint opacity once',()=>{
  const input=fixture(),before=structuredClone(input),bundle=lower(sequence({kind:'wait',duration:1},action()),input),run=createEvaluator(bundle);
  assert.deepEqual(input,before);assert.equal(bundle.mathTransforms?.operations[0].instance,'change');
  assert.equal(node<GroupNode>(run(.999),'change').style?.opacity,0);assert.equal(run(.999).mathTransforms?.change.active,false);
  for(const [time,side,id] of [[1,'source','source'],[3,'target','destination'],[8,'target','destination']] as const){
    const frame=run(time),native=node<TexNode>(input,id),helper=node<TexNode>(frame,`change:${side}`),group=node<GroupNode>(frame,'change');
    assert.equal(helper.resourceId,native.resourceId);assert.deepEqual(frame.resources[helper.resourceId],input.resources[native.resourceId]);
    near([helper.x,helper.y,helper.scale??1],[native.x,native.y,native.scale??1]);
    assert.equal(helper.style?.opacity,1);assert.equal(group.style?.opacity,.7);assert.equal(group.parent,'stage');
    assert.deepEqual(group.transform,native.transform);assert.deepEqual(group.clip,native.clip);
    assert.equal(frame.mathTransforms?.change.state,side);assert.equal(frame.mathTransforms?.change.active,true);
    assert.equal(frame.mathTransforms?.change.progress,side==='source'?0:1);
    for(const n of frame.nodes.filter(n=>n.parent==='change'&&n.id!==helper.id))assert.equal(n.style?.opacity,0,`Endpoint has extra paint: ${n.id}`);
  }
});

test('part anchors interpolate in endpoint placement coordinates while selected native outlines remain unchanged',()=>{
  const input=fixture(),run=createEvaluator(lower(action(),input)),frame=run(.5),p=.25,scale=2.25;
  const source=node<TexNode>(frame,'change:pair:0:source'),target=node<TexNode>(frame,'change:pair:0:target');
  // Authored anchors: (10,20)+2(1,0)=(12,20), (110,40)+3(2,-4)=(116,28).
  const anchor=[38,22];
  near([source.x,source.y,source.scale??1],[anchor[0]-scale,anchor[1],scale]);
  near([target.x,target.y,target.scale??1],[anchor[0]-2*scale,anchor[1]+4*scale,scale]);
  assert.equal(source.style?.opacity,1-p);assert.equal(target.style?.opacity,p);
  assert.deepEqual((frame.resources[source.resourceId] as VectorResource).items,[resource().items[0]]);
  assert.deepEqual((frame.resources[target.resourceId] as VectorResource).items,[resource(true).items[0]]);
  assert.equal(node<TexNode>(frame,'change:source-rest').style?.opacity,.75);
  assert.equal(node<TexNode>(frame,'change:target-rest').style?.opacity,.25);
  assert.equal(node<TexNode>(frame,'change:source').style?.opacity,0);assert.equal(node<TexNode>(frame,'change:target').style?.opacity,0);
  assert.equal(frame.mathTransforms?.change.state,'transition');
});

test('authored endpoints remain snapshots and arbitrary reverse seeks cannot leak mutated instance state',()=>{
  const input=fixture();input.tracks=[{target:'source',property:'x',keys:[[0,10],[2,210]]}];
  const bundle=lower(action(),input),before=structuredClone(bundle),run=createEvaluator(bundle),middle=run(1);
  assert.equal(node<TexNode>(middle,'source').x,110);assert.equal(node<TexNode>(middle,'change:source').x,10);
  const expected=structuredClone(middle);node<TexNode>(middle,'change:pair:0:source').x=999;
  for(const time of [8,0,.125,1.999,2,1])run(time);
  assert.deepEqual(run(1),expected);assert.deepEqual(bundle,before);
  node<TexNode>(bundle,'source').x=-999;(bundle.resources.before as VectorResource).items[0].d='M0 0';
  assert.deepEqual(run(1),expected,'Evaluator must detach its caller-owned scene and native resources');
});

test('formula endpoint templates require hidden authored nodes with compatible parent, transform, clip and isolated opacity',()=>{
  for(const change of [
    (b:Bundle)=>{node<TexNode>(b,'source').visible=true;},
    (b:Bundle)=>{delete node<TexNode>(b,'destination').parent;},
    (b:Bundle)=>{node<TexNode>(b,'destination').transform={rotate:.2};},
    (b:Bundle)=>{delete node<TexNode>(b,'destination').clip;},
    (b:Bundle)=>{node<TexNode>(b,'destination').style!.opacity=.5;},
  ]){const b=fixture();change(b);rejects(()=>lower(action(),b),/MATH_|ENDPOINT|PLACEMENT|OPACITY/);}
  const collision=fixture();collision.nodes.push({id:'change:pair:0:source',kind:'group'});rejects(()=>lower(action(),collision),/MATH_|INSTANCE|COLLISION/);
});

test('explicit copy fans out from one primary replacement while keep-source retains the full original once',()=>{
  const input=fixture(),target=input.resources.after as VectorResource;
  target.items.push({kind:'path',d:'M32 -3 H36 V3 H32 Z'});
  target.textParts!.parts.push({id:'c',sourceRange:{start:2,end:3},paintPaths:[[3]]});
  const options=correspondence();options.pairs.push({source:'left',target:'c',mode:'copy',sourceAnchor:[1,0],targetAnchor:[32,0]});
  const frame=createEvaluator(lower(action('change',options),input))(.5);
  near([node<TexNode>(frame,'change:pair:2:source').style!.opacity!,node<TexNode>(frame,'change:pair:2:target').style!.opacity!],[.1875,.0625]);
  assert.equal(node<TexNode>(frame,'change:pair:0:source').style?.opacity,.75);
  const keep={...options,retention:'keep-source' as const,pairs:options.pairs.map(p=>({...p,mode:'copy' as const}))};
  const retained=createEvaluator(lower(action('change',keep),input));
  for(const time of [0,.5,1,2,8])assert.equal(node<TexNode>(retained(time),'change:source').style?.opacity,1);
  assert.equal(node<TexNode>(retained(2),'change:target').style?.opacity,1);
  const invalid=correspondence();invalid.pairs[0].mode='copy';rejects(()=>lower(action('change',invalid)),/MATH_PART_COPY_POLICY/);
});

test('identical native glyph branches move without a double-crossfade opacity dip',()=>{
  const input=fixture();node<TexNode>(input,'destination').resourceId='before';
  const options=correspondence();options.pairs.forEach(p=>{p.target=p.source;p.targetAnchor=structuredClone(p.sourceAnchor);});
  const run=createEvaluator(lower(action('change',options),input));
  for(const t of [.01,.5,1,1.99]){
    const frame=run(t);assert.equal(node<TexNode>(frame,'change:pair:0:source').style?.opacity,1);
    assert.equal(node<TexNode>(frame,'change:pair:0:target').style?.opacity,0);
  }
});

test('isolated native opacity groups move intact and cannot be split across correspondence branches',()=>{
  const input=fixture();
  for(const name of ['before','after']){
    const r=input.resources[name] as VectorResource;
    r.items=[{kind:'group',style:{opacity:.4},clip:{d:'M-10 -10 H50 V10 H-10 Z'},children:r.items}];
    r.textParts!.parts.forEach(p=>p.paintPaths=p.paintPaths.map(path=>[0,...path]));
  }
  rejects(()=>lower(action(),input),/MATH_PART_OPACITY_PARTITION/);
  for(const name of ['before','after']){
    const r=input.resources[name] as VectorResource;
    r.textParts!.parts=[{id:'whole',sourceRange:{start:0,end:3},paintPaths:[[0,0],[0,1],[0,2]]}];
  }
  const options:MathCorrespondenceOptions={approved:true,retention:'replace',unmatched:'error',pairs:[{source:'whole',target:'whole',mode:'replace',sourceAnchor:[0,0],targetAnchor:[0,0]}]};
  const run=createEvaluator(lower(action('change',options),input));
  for(const [time,side,resourceName] of [[0,'source','before'],[2,'target','after']] as const){
    const f=run(time),n=node<TexNode>(f,`change:${side}`);assert.deepEqual(f.resources[n.resourceId],input.resources[resourceName]);
  }
  const middle=run(1),selected=node<TexNode>(middle,'change:pair:0:source');
  assert.deepEqual((middle.resources[selected.resourceId] as VectorResource).items,(input.resources.before as VectorResource).items);
});

test('computed progress and ancestor visibility execute before semantic reports and helper ownership remains exclusive',()=>{
  const bundle=lower(action());bundle.tracks=bundle.tracks.filter(t=>t.property!=='mathProgress');
  bundle.operationGraph={version:1,operations:[{id:'clock',operator:'scalarValue',version:1,spaces:{},inputs:{value:{kind:'expression',expression:'time/2s',unit:'1'}}}],
    bindings:[{target:'change',property:'mathProgress',value:{operation:'clock',socket:'value'}}]};
  bundle.expressions={version:1,parameters:{},bindings:[{target:'stage',property:'visible',expression:'time < 1.5s'}]};
  const plan=prepareExecutionPlan(bundle),at=plan.order.indexOf('math-transform:0');
  assert.ok(at>plan.order.indexOf('binding:0'));assert.ok(at>plan.order.indexOf('expression:0'));
  const run=createEvaluator(bundle),visible=run(1),hidden=run(1.5);
  assert.equal(visible.mathTransforms?.change.progress,.5);assert.equal(visible.mathTransforms?.change.active,true);
  assert.equal(hidden.mathTransforms?.change.progress,.75);assert.equal(hidden.mathTransforms?.change.active,false);
  assert.ok(!renderSvg(hidden).includes('<desc'));
  for(const property of ['x','scale','style.opacity']){
    const invalid=lower(action());invalid.tracks.push({target:'change:pair:0:source',property,keys:[[0,property==='scale'?2:0]]});
    rejects(()=>createEvaluator(invalid),/CONFLICT|WRITER/);
  }
});

test('semantic descriptions follow exact source, transition and target states and explicit chained handoff visibility',()=>{
  const run=createEvaluator(lower(sequence(action(),{kind:'set',target:'change',property:'style.opacity',value:0},action('second'))));
  for(const [time,state] of [[0,'source'],[1,'transition']] as const){
    const f=run(time),report=f.mathTransforms!.change;assert.equal(report.state,state);
    assert.equal(report.sourceText,'x plus x');assert.equal(report.targetText,'two positioned copies of x');
    assert.ok(renderSvg(f).includes(report.description));
  }
  const handoff=run(2);assert.equal(handoff.mathTransforms?.change.active,false);assert.equal(handoff.mathTransforms?.second.active,true);
  assert.equal(handoff.mathTransforms?.second.state,'source');assert.equal(run(4).mathTransforms?.second.state,'target');
  assert.equal(run(8).mathTransforms?.second.active,true);
});
