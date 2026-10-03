import test from 'node:test';
import assert from 'node:assert/strict';
import {createEvaluator,type Bundle,type PathNode,validateBundle} from '../src/index.js';
import {preparePresentationProgram,validatePresentationProgram,validatePresentationProgramInContext,presentationEventSeed,type PresentationProgram} from '../src/ir/presentation-intent.js';
const fixture=():Bundle=>({version:'0.3',title:'Intent',duration:10,units:'bp',viewport:{width:300,height:200},camera:{x:999,y:-999,zoom:4,rotation:1},resources:{},tracks:[],relations:[],
 nodes:[{kind:'path',id:'line',d:'M0 0L100 0',geometry:{contours:[{id:'path',start:[0,0],segments:[{kind:'line',id:'segment',to:[100,0]}]}]}},
 {kind:'point',id:'dot',x:20,y:30,r:3}],presentation:{version:1,seed:28,events:[
 {kind:'draw',id:'write',target:'line',start:1,end:3,mode:'stroke',pathId:'path'},
 {kind:'erase',id:'wipe',targets:['line'],start:5,end:7}]}});
const state=(frame:ReturnType<ReturnType<typeof createEvaluator>>,target='line')=>frame.presentation!.targets.find(t=>t.target===target)!;
const near=(actual:readonly number[],expected:readonly number[])=>actual.forEach((v,i)=>assert.ok(Math.abs(v-expected[i])<1e-9,`${actual} != ${expected}`));
const code=(re:RegExp)=>(e:any)=>e.name!=='TypeError'&&re.test(JSON.stringify(e.diagnostics??e.message));
test('presentation uses exact absolute boundaries, including begin, completion and held erasure',()=>{
 const run=createEvaluator(fixture());
 for(const [time,phase,status,draw,erase] of [[0,'before','hidden',0,0],[1,'begin','drawing',0,0],[2,'active','drawing',.5,0],[3,'complete','held',1,0],[4,'held','held',1,0],[5,'held','erasing',1,0],[6,'held','erasing',1,.5],[7,'held','erased',1,1],[10,'held','erased',1,1]] as const){
  const frame=run(time);assert.equal(frame.presentation!.events[0].phase,phase);assert.equal(state(frame).state,status);assert.equal(state(frame).drawProgress,draw);assert.equal(state(frame).eraseProgress,erase);
 }
 assert.equal(state(run(1)).pose!.contact,true);assert.equal(state(run(3)).pose!.contact,false);assert.equal(state(run(6)).pose!.contact,false);
 near(state(run(2)).pose!.local,[50,0]);assert.deepEqual(state(run(2)).strokePrefix!.contours[0].segments[0].to,[50,0]);
});
test('numeric geometry and native resource rendering inputs remain unchanged; metadata is detached and frozen',()=>{
 const input=fixture(),before=structuredClone(input),plain=structuredClone(input);delete plain.presentation;
 const withIntent=createEvaluator(input),native=createEvaluator(plain);
 for(const t of [0,1,2,3,6,8]){const {presentation,...frame}=withIntent(t);assert.deepEqual(frame,native(t));assert.ok(Object.isFrozen(presentation));assert.ok(Object.isFrozen(presentation!.targets[0].localBounds));}
 assert.deepEqual(input,before);const frame=withIntent(2);assert.throws(()=>{(frame.presentation!.targets[0].pose!.local as any)[0]=999;});
 input.presentation!.seed=999;(input.nodes[0] as PathNode).geometry!.contours[0].start=[999,999];assert.deepEqual(withIntent(2),frame);
});
test('pose follows evaluated geometry and ancestor transforms exactly once and ignores camera',()=>{
 const input=fixture();input.nodes.unshift({kind:'group',id:'outer',transform:{translate:[7,11],rotate:Math.PI/2,scale:[2,3]}});
 const node=input.nodes.find(n=>n.id==='line')!;node.parent='outer';node.transform={translate:[5,0]};
 input.tracks=[{target:'line',property:'geometry.path.segment.to',keys:[[0,[100,0]],[10,[200,0]]]}];
 const run=createEvaluator(input),sample=state(run(2));near(sample.pose!.local,[60,0]);near(sample.pose!.world,[7,141]);near(sample.pose!.tangentWorld!,[0,1]);
 input.camera={x:-1000,y:1000,zoom:100,rotation:-2};assert.deepEqual(state(createEvaluator(input)(2)),sample);
});
test('glyph-outline metadata is an ink-box sweep in the paint callback chart, with native TeX placement',()=>{
 const input=fixture();input.resources.text={kind:'vector',items:[{kind:'path',d:'M-2 -8L18 -8L18 2Z'}],metrics:{width:20,height:8,depth:2},inkBounds:[-2,-8,20,10]};
 input.nodes.push({kind:'tex',id:'text',resourceId:'text',x:40,y:30,scale:2,transform:{translate:[100,5]}});
 input.presentation!.events.push({kind:'draw',id:'words',target:'text',start:1,end:3,mode:'glyph-outline'});
 const entry=state(createEvaluator(input)(2),'text');assert.deepEqual(entry.localBounds,[36,14,40,20]);near(entry.pose!.local,[56,24]);near(entry.pose!.world,[156,29]);assert.equal(entry.strokePrefix,undefined);
});
test('explicit and inherited stroke widths conservatively pad bounds; hidden ancestors suppress contact',()=>{
 const input=fixture();input.nodes.unshift({kind:'group',id:'paint',style:{strokeWidth:2,miterLimit:6,lineJoin:'miter'}});input.nodes[1].parent='paint';
 const sample=state(createEvaluator(input)(2));assert.deepEqual(sample.localBounds,[-6,-6,112,12]);
 for(const style of [{opacity:0},{}]){const copy=structuredClone(input),parent=copy.nodes[0];parent.style={...parent.style,...style};if(!('opacity' in style))parent.visible=false;assert.equal(state(createEvaluator(copy)(2)).pose!.contact,false);}
});
test('zero-duration draws and erases are complete at their exact instant; erase-only leaves start held',()=>{
 const input=fixture();input.presentation!.events=[{kind:'draw',id:'instant',target:'line',start:2,end:2,mode:'stroke'},{kind:'erase',id:'erase',targets:['line','dot'],start:4,end:4}];
 const run=createEvaluator(input);assert.equal(state(run(2)).state,'held');assert.equal(run(2).presentation!.events[0].phase,'complete');assert.equal(state(run(4)).state,'erased');assert.equal(state(run(0),'dot').state,'held');
 assert.equal(state(run(2)).pose!.contact,false);
});
test('all authored descriptors and seeded variations survive reverse seeks and common FPS times',()=>{
 const run=createEvaluator(fixture()),before=run(0).presentation!;assert.equal(before.events.length,2);assert.equal(before.events[1].start,5);
 const values=new Map<number,unknown>();for(let i=0;i<=300;i++)values.set(i,run(i/30).presentation);
 for(let i=600;i>=0;i-=2)assert.deepEqual(run(i/60).presentation,values.get(i/2));
 assert.equal(before.events[0].eventSeed,presentationEventSeed(28,'write'));assert.notEqual(before.events[0].eventSeed,presentationEventSeed(29,'write'));assert.notEqual(before.events[0].eventSeed,before.events[1].eventSeed);
});
test('strict boundaries reject invalid IDs, modes, timing, unknown fields, overlapping lifecycle and budgets',()=>{
 const edits:((p:PresentationProgram)=>void)[]=[p=>{(p as any).extra=true;},p=>{p.seed=-1;},p=>{p.events[0].end=11;},p=>{p.events[0].start=4;},p=>{(p.events[0] as any).target='missing';},p=>{(p.events[0] as any).mode='glyph-outline';},p=>{(p.events[0] as any).tool='eraser';},p=>{(p.events[0] as any).contact='tap';},p=>{(p.events[0] as any).pathId='missing';},p=>{p.events[1].id='write';},p=>{p.events[1].start=2;},p=>{(p.events[1] as any).targets=['line','line'];},p=>{p.events.push({...p.events[0],id:'again'});},p=>{p.events=Array.from({length:4097},(_,i)=>({...p.events[0],id:`event-${i}`}));}];
 for(const edit of edits){const input=fixture();edit(input.presentation!);assert.ok(validateBundle(input).some(e=>e.severity==='error'));assert.throws(()=>createEvaluator(input),code(/PRESENTATION/));}
 const input=fixture();(input.nodes[0] as PathNode).geometry!.contours.push({id:'other',start:[0,0],segments:[]});assert.throws(()=>createEvaluator(input),code(/single-contour/));
});
test('accessor inputs never execute, invalid standalone contexts give diagnostics and warnings do not block valid scenes',()=>{
 const input=fixture();let reads=0;const program={version:1,seed:28,get events(){reads++;return [];}};
 assert.ok(validatePresentationProgram(program,input).some(e=>e.severity==='error'));assert.equal(reads,0);
 assert.ok(validatePresentationProgram(input.presentation,null).some(e=>e.severity==='error'));
 assert.ok(validatePresentationProgramInContext(input.presentation,null as any).some(e=>e.severity==='error'));
 input.diagnostics=[{severity:'warning',code:'EXAMPLE',message:'A retained author note.'}];assert.equal(preparePresentationProgram(input.presentation!,input).program.seed,28);
});
test('degenerate geometry and collapsed transforms never invent tool direction or contact',()=>{
 const input=fixture();(input.nodes[0] as PathNode).geometry!.contours[0].segments[0].to=[0,0];const entry=state(createEvaluator(input)(2));assert.equal(entry.pose!.contact,false);assert.equal(entry.pose!.tangentLocal,undefined);near(entry.pose!.local,[0,0]);
 const collapsed=fixture();collapsed.nodes[0].transform={scale:[0,0]};assert.equal(state(createEvaluator(collapsed)(2)).pose!.contact,false);
 const huge=fixture();(huge.nodes[0] as PathNode).geometry!.contours[0].segments[0].to=[1e-308,0];huge.nodes[0].parent='large';huge.nodes[0].transform={scale:[1.7e308,1],rotate:Math.PI/4};huge.nodes.push({kind:'group',id:'large',transform:{scale:[1.2,1.2]}});
 const pose=state(createEvaluator(huge)(2)).pose!;near(pose.tangentWorld!,[Math.SQRT1_2,Math.SQRT1_2]);assert.equal(pose.contact,true);
});
