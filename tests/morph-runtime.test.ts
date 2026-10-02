import test from 'node:test';
import assert from 'node:assert/strict';
import {compileTimeline,lowerTimeline} from '../src/timeline/compile.js';
import {createEvaluator} from '../src/evaluate.js';
import {validateBundle,type Bundle,type PathNode,type PointNode,type GroupNode,type Diagnostic} from '../src/schema.js';
import {validateOperationGraph} from '../src/operations/validate.js';
import {validateMorphProgram} from '../src/timeline/morph.js';
import type {CorrespondenceOptions} from '../src/geometry/correspondence.js';
import type {PathGeometry,PathContour,PathPoint} from '../src/path-geometry.js';
const scene={kind:'scene'} as const;
const program=(root:any)=>({version:1 as const,root});
const sequence=(...children:any[])=>({kind:'sequence',children});
const mapping:CorrespondenceOptions={approved:true,contours:[{source:'main',target:'main',segments:[{source:'edge',target:'edge'}]}]};
const morph=(id='change',correspondence:CorrespondenceOptions=mapping)=>({kind:'morph',id,source:'source',destination:'destination',duration:2,correspondence});
const line=():PathGeometry=>({contours:[{id:'main',start:[0,0],segments:[{id:'edge',kind:'line',to:[12,0]}]}]});
const curve=():PathGeometry=>({contours:[{id:'main',start:[0,0],segments:[{id:'edge',kind:'cubic',c1:[0,12],c2:[12,12],to:[12,0]}]}]});
function fixture():Bundle {
 return {version:'0.3',title:'Geometry transition runtime',duration:8,units:'bp',viewport:{width:400,height:300},camera:{x:0,y:0,zoom:1},resources:{},tracks:[],relations:[],nodes:[
  {id:'stage',kind:'group',transform:{translate:[100,50],scale:[2,3]}},
  {id:'other',kind:'group',transform:{translate:[900,900],scale:[10,10]}},
  {id:'source',kind:'path',parent:'stage',d:'M0 0 L12 0',geometry:line(),transform:{translate:[10,20],scale:[2,1]},style:{fill:'none',stroke:'#fff',opacity:.6}},
  {id:'destination',kind:'path',parent:'other',d:'M0 0 C0 12 12 12 12 0',geometry:curve(),transform:{translate:[999,999],scale:[9,9]},style:{fill:'none',stroke:'#f00'}},
  {id:'P',kind:'point',x:0,y:0,r:2,progress:.5}]};
}
const node=<T>(frame:{nodes:{id:string}[]},id:string)=>frame.nodes.find(n=>n.id===id) as T;
const near=(a:readonly number[],b:readonly number[])=>a.forEach((v,i)=>assert.ok(Math.abs(v-b[i])<1e-8,`${a} != ${b}`));
function rejects(fn:()=>unknown,pattern:RegExp):void {
 assert.throws(fn,(e:unknown)=>e instanceof Error&&e.name!=='TypeError'&&pattern.test(JSON.stringify((e as {diagnostics?:Diagnostic[]}).diagnostics??e.message)));
}
const codes=(bundle:unknown)=>validateBundle(bundle).filter(d=>d.severity==='error').map(d=>d.code);

test('timeline morph creates a separate delayed instance, keeps exact endpoint snapshots and preserves source paint opacity once',()=>{
 const source=fixture(),before=structuredClone(source),ast=program(sequence({kind:'wait',duration:1},morph())),compiled=compileTimeline(ast,source),bundle=lowerTimeline(ast,source);
 assert.deepEqual(source,before);assert.equal(compiled.generatedNodes?.length,4);assert.equal(bundle.morphs?.operations[0].instance,'change');
 for(const id of ['change','change:shape','change:leaving','change:entering'])assert.ok(bundle.nodes.some(n=>n.id===id));
 const run=createEvaluator(bundle);
 assert.equal(node<GroupNode>(run(.999),'change').style?.opacity,0);assert.equal(node<GroupNode>(run(1),'change').style?.opacity,.6);
 assert.deepEqual(node<PathNode>(run(1),'change:shape').geometry,line());assert.deepEqual(node<PathNode>(run(3),'change:shape').geometry,curve());
 const middle=run(2),shape=node<PathNode>(middle,'change:shape'),group=node<GroupNode>(middle,'change');
 assert.equal((group.style?.opacity??1)*(shape.style?.opacity??1),.6);assert.equal(middle.morphs?.change.progress,.5);
 const segment=shape.geometry!.contours[0].segments[0];assert.equal(segment.kind,'cubic');if(segment.kind==='cubic'){near(segment.c1,[2,6]);near(segment.c2,[10,6]);}
 for(const t of [0,1,2,3,8])assert.deepEqual(node<PathNode>(run(t),'source').geometry,line());
 assert.equal(node<GroupNode>(middle,'change').parent,'stage');assert.deepEqual(node<GroupNode>(middle,'change').transform,node<PathNode>(source,'source').transform);
});

test('morphing local geometry precedes the instance and ancestor transforms and feeds dependent points in that order',()=>{
 const bundle=lowerTimeline(program({kind:'parallel',children:[morph(),{kind:'tween',target:'change',property:'transform.translate',duration:2,to:[30,40]}]}),fixture());
 bundle.relations=[{type:'pointOnPath',target:'P',source:'change:shape',mode:'parameter'}];
 const f=createEvaluator(bundle)(1),p=node<PointNode>(f,'P');
 // Local cubic midpoint (6,4.5), then scale(2,1)+translate(20,30), then stage scale(2,3)+translate(100,50).
 near([p.x,p.y],[164,153.5]);assert.ok(p.x<400,'Destination parent/transform must not be accidentally baked into authored-local morphing');
});

test('authored source and destination geometry snapshots do not inherit later source control animation',()=>{
 const input=fixture();input.tracks=[{target:'source',property:'geometry.main.edge.to',keys:[[0,[12,0]],[2,[120,0]]]}];
 const bundle=lowerTimeline(program(morph()),input),run=createEvaluator(bundle);
 near(node<PathNode>(run(1),'source').geometry!.contours[0].segments[0].to,[66,0]);
 near(node<PathNode>(run(1),'change:shape').geometry!.contours[0].segments[0].to,[12,0]);
 const first=run(1);run(8);run(0);assert.deepEqual(run(1),first);
 node<PathNode>(first,'change:shape').geometry!.contours[0].start[0]=999;assert.equal(node<PathNode>(run(1),'change:shape').geometry!.contours[0].start[0],0);
});

test('clone snapshots have independent identity, geometry and transforms and hidden templates appear at the exact clone time',()=>{
 const source=fixture();node<PathNode>(source,'source').visible=false;
 const ast=program(sequence({kind:'wait',duration:1},{kind:'clone',id:'copy',source:'source'},
  {kind:'parallel',children:[{kind:'tween',target:'copy',property:'transform.translate',duration:2,to:[50,60]},
   {kind:'tween',target:'copy',property:'geometry.main.edge.to',duration:2,to:[24,12]}]}));
 const bundle=lowerTimeline(ast,source),run=createEvaluator(bundle);
 const before=node<PathNode>(run(.5),'copy'),start=node<PathNode>(run(1),'copy'),middle=node<PathNode>(run(2),'copy');
 assert.equal(before.style?.opacity,0);assert.equal(start.visible,true);assert.equal(start.style?.opacity,.6);assert.deepEqual(start.geometry,line());
 near(middle.transform!.translate!,[30,40]);near(middle.geometry!.contours[0].segments[0].to,[18,6]);
 const original=node<PathNode>(run(2),'source');assert.equal(original.visible,false);assert.deepEqual(original.geometry,line());near(original.transform!.translate!,[10,20]);
 const transition=middle.source?.transition as {source:string;instance:string};assert.equal(transition.source,'source');assert.equal(transition.instance,'copy');
});

test('enter and exit use authored initial hiding and provide independent fade or reveal tracks',()=>{
 for(const mode of ['fade','create'] as const){const b=fixture(),path=node<PathNode>(b,'source');if(mode==='fade')path.style!.opacity=0;else path.reveal=0;
  const run=createEvaluator(lowerTimeline(program(sequence({kind:'wait',duration:1},{kind:'enter',target:'source',duration:2,mode},
   {kind:'wait',duration:1},{kind:'exit',target:'source',duration:2,mode})),b));
  const value=(t:number)=>{const n=node<PathNode>(run(t),'source');return mode==='fade'?n.style!.opacity:n.reveal;};
  for(const [t,expected] of [[0,0],[1,0],[2,.5],[3,1],[4,1],[5,.5],[6,0],[8,0]])assert.equal(value(t),expected);
 }
});

test('unmatched contour fade/create uses stable helper nodes and the complete exact geometry only at endpoints',()=>{
 const b=fixture();node<PathNode>(b,'source').geometry!.contours.push({id:'left',start:[30,0],segments:[{id:'side',kind:'line',to:[30,12]}]});
 node<PathNode>(b,'destination').geometry!.contours.push({id:'right',start:[60,0],segments:[{id:'side',kind:'line',to:[60,12]}]});
 for(const unmatched of ['fade','create'] as const){const run=createEvaluator(lowerTimeline(program(morph('change',{...mapping,unmatched})),b)),f=run(.5);
  assert.equal(node<PathNode>(f,'change:shape').geometry!.contours.length,1);assert.equal(node<PathNode>(f,'change:leaving').geometry!.contours.length,1);assert.equal(node<PathNode>(f,'change:entering').geometry!.contours.length,1);
  const leaving=node<PathNode>(f,'change:leaving'),entering=node<PathNode>(f,'change:entering');
  if(unmatched==='fade')near([leaving.style!.opacity!,entering.style!.opacity!],[.75,.25]);else near([leaving.reveal!,entering.reveal!],[.75,.25]);
  for(const t of [0,2]){const end=run(t);assert.equal(node<PathNode>(end,'change:shape').geometry!.contours.length,2);assert.equal(node<PathNode>(end,'change:leaving').geometry!.contours.length,0);assert.equal(node<PathNode>(end,'change:entering').geometry!.contours.length,0);}
 }
});

test('computed progress executes before morph output and every geometry consumer rather than relying on declaration order',()=>{
 const b=lowerTimeline(program(morph()),fixture());b.tracks=b.tracks.filter(t=>t.property!=='morphProgress');
 b.operationGraph={version:1,operations:[{id:'clock',operator:'scalarValue',version:1,spaces:{},inputs:{value:{kind:'expression',expression:'time/2s',unit:'1'}}}],bindings:[{target:'change',property:'morphProgress',value:{operation:'clock',socket:'value'}}]};
 b.relations=[{type:'pointOnPath',target:'P',source:'change:shape',mode:'parameter'}];
 const frame=createEvaluator(b)(1);near([node<PointNode>(frame,'P').x,node<PointNode>(frame,'P').y],[144,123.5]);assert.equal(frame.morphs?.change.progress,.5);
});

test('geometry ownership rejects control tracks and deformations while independent transform and reveal tracks remain valid',()=>{
 const b=lowerTimeline(program(morph()),fixture());
 const controls=structuredClone(b);controls.tracks.push({target:'change:shape',property:'geometry.main.edge.to',keys:[[0,[12,0]],[2,[24,0]]]});
 assert.ok(codes(controls).some(c=>/CONFLICT|WRITER/.test(c)));rejects(()=>createEvaluator(controls),/CONFLICT|WRITER/);
 const deformation=structuredClone(b);deformation.deformations={version:1,operations:[{id:'warp',source:'source',target:'change:shape',mode:'controlDeform',expression:'position'}]};
 assert.ok(codes(deformation).some(c=>/CONFLICT|WRITER/.test(c)));
 const allowed=structuredClone(b);allowed.tracks.push({target:'change:shape',property:'reveal',keys:[[0,0],[2,1]]});assert.deepEqual(codes(allowed),[]);
 const helpers=structuredClone(b);helpers.tracks.push({target:'change:leaving',property:'style.opacity',keys:[[0,1]]});assert.ok(codes(helpers).some(c=>/CONFLICT|WRITER/.test(c)));
});

test('unmatched fills and selective filled-hole reversal require explicit valid paint policies',()=>{
 const b=fixture();node<PathNode>(b,'source').geometry!.contours.push({id:'extra',start:[30,0],segments:[]});node<PathNode>(b,'source').style!.fill='#fff';
 rejects(()=>lowerTimeline(program(morph('change',{...mapping,unmatched:'fade'})),b),/MORPH_UNMATCHED_FILL/);
 const poly=(id:string,points:PathPoint[]):PathContour=>({id,start:points[0],closed:true,segments:points.slice(1).map((to,i)=>({id:`e${i}`,kind:'line',to}))});
 const outer=poly('outer',[[0,0],[12,0],[12,12],[0,12]]),hole=poly('hole',[[3,3],[3,9],[9,9],[9,3]]),oppositeHole=poly('hole',[[9,3],[9,9],[3,9],[3,3]]);
 const filled=fixture();node<PathNode>(filled,'source').geometry={contours:[outer,hole]};node<PathNode>(filled,'destination').geometry={contours:[structuredClone(outer),oppositeHole]};node<PathNode>(filled,'source').style!.fill='#fff';node<PathNode>(filled,'destination').style!.fill='#fff';
 const opts:CorrespondenceOptions={approved:true,contours:[{source:'outer',target:'outer',segments:[0,1,2].map(i=>({source:`e${i}`,target:`e${i}`}))},{source:'hole',target:'hole',reverseTarget:true,segments:[0,1,2].map(i=>({source:`e${i}`,target:`e${2-i}`}))}]};
 rejects(()=>lowerTimeline(program(morph('change',opts)),filled),/MORPH_HOLE_WINDING/);
});

test('instance collisions, generated endpoint feedback and malformed interchange programs fail with diagnostics',()=>{
 rejects(()=>lowerTimeline(program(morph('source')),fixture()),/INSTANCE/);
 const collision=fixture();collision.nodes.push({id:'change:shape',kind:'point',x:0,y:0,r:1});rejects(()=>lowerTimeline(program(morph()),collision),/INSTANCE/);
 rejects(()=>lowerTimeline(program(sequence(morph(),{kind:'morph',id:'second',source:'change:shape',destination:'destination',duration:1,correspondence:mapping})),fixture()),/INSTANCE|ENDPOINT/);
 const b=lowerTimeline(program(morph()),fixture());const bad=structuredClone(b);bad.morphs!.operations[0].source='change:shape';assert.ok(codes(bad).some(c=>/ENDPOINT/.test(c)));
 const malformed=structuredClone(b);malformed.morphs!.operations=[null] as any;assert.ok(codes(malformed).length>0);assert.ok(validateMorphProgram(malformed.morphs,malformed).length>0);
 malformed.operationGraph={version:1,operations:[],bindings:[]};assert.ok(validateOperationGraph(malformed.operationGraph,malformed).length>0);
});
