import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluate,createEvaluator,prepareScene,validateBundle,validatePlotProgram,validateOperationGraph,validateExpressionProgram,validateDeformationProgram,validateFieldProgram,
  worldMatrix,transformPoint,type Bundle,type InputRef,type PlotOperation,type PathNode,type PathPoint,type PointNode} from '../src/index.ts';
import {prepareExecutionPlan} from '../src/operations/plan.ts';
import {renderSvg} from '../src/render-svg.ts';
const scene={kind:'scene'} as const;
const number=(value:number,unit:'1'|'bp'='1'):InputRef=>({kind:'literal',value:{type:'scalar',unit,value}});
const point=(value:[number,number]):InputRef=>({kind:'literal',value:{type:'vec2',role:'point',space:scene,value}});
function fixture():Bundle {
  return {version:'0.3',title:'Plots',duration:2,units:'bp',viewport:{width:240,height:150},camera:{x:0,y:0,zoom:1},resources:{},tracks:[],relations:[],
    nodes:[{id:'curve',kind:'path',d:'M0 0',geometry:{contours:[]},style:{stroke:'#fff',fill:'none'}}],
    plots:{version:1,operations:[{id:'function',target:'curve',mode:'function',expression:'x*x',domains:[[-1,1]],space:scene,
      inputs:{origin:point([10,20]),width:number(200,'bp'),height:number(100,'bp'),xMin:number(-1),xMax:number(1),yMin:number(0),yMax:number(1)}}]}};
}
const plot=(b:Bundle)=>b.plots!.operations[0];
const path=(frame:ReturnType<typeof evaluate>)=>frame.nodes.find(n=>n.id==='curve') as PathNode;
const vertices=(frame:ReturnType<typeof evaluate>):PathPoint[]=>path(frame).geometry!.contours.flatMap(c=>[c.start,...c.segments.map(s=>s.to)]);
const near=(a:number,b:number,epsilon=1e-8)=>assert.ok(Math.abs(a-b)<epsilon,`${a} != ${b}`);
function diagnostics(fn:()=>unknown,code:string){assert.throws(fn,(e:any)=>Array.isArray(e.diagnostics)&&e.diagnostics.some((d:any)=>d.code===code));}

test('function data is dimensionless and only mapped ordinary geometry reaches the renderer',()=>{
  const b=fixture(),before=structuredClone(b),f=evaluate(b,0);
  assert.deepEqual(validateBundle(b),[]);assert.deepEqual(b,before);
  for(const [sx,sy] of vertices(f)){const x=(sx-10)/100-1;near(sy,120-100*x*x);}
  assert.equal(f.plots!.function.qualityMetric,'observed-probes');assert.ok(f.plots!.function.segmentCount>=16);
  assert.ok(f.plots!.function.maxAcceptedError<=.5);assert.ok(renderSvg(f).includes('path'));
  assert.deepEqual(vertices(f)[0],[10,20]);assert.deepEqual(vertices(f).at(-1),[210,20]);
});

test('prepared plots seek deterministically and parameters rebuild only frame-owned geometry',()=>{
  const b=fixture();b.expressions={version:1,parameters:{amplitude:{type:'scalar',default:1,min:.1,max:2}},bindings:[]};
  plot(b).expression='amplitude*sin(x+time/1s)';const evaluator=createEvaluator(b),first=evaluator(.25,{amplitude:1.3});
  const untouched=structuredClone(first);path(first).geometry!.contours[0].start[0]=999;
  assert.deepEqual(evaluator(.25,{amplitude:1.3}),untouched);assert.notDeepEqual(vertices(evaluator(1)),vertices(untouched));
  evaluator(2);assert.deepEqual(evaluator(.25,{amplitude:1.3}),untouched);
  assert.ok(Object.isFrozen(untouched.plots)===false);assert.ok(Object.isFrozen(evaluator(0).plots));
});

test('parametric u and parameter aliases use real data coordinates and preserve loop endpoints',()=>{
  const b=fixture();Object.assign(plot(b),{mode:'parametric',xExpression:'cos(u)',yExpression:'sin(parameter)',domains:[[0,2*Math.PI]]});delete plot(b).expression;
  plot(b).inputs.yMin=number(-1);const f=evaluate(b,0);
  for(const [sx,sy] of vertices(f))near(((sx-110)/100)**2+((sy-70)/50)**2,1);
  near(vertices(f)[0][0],210);near(vertices(f).at(-1)![0],210);near(vertices(f).at(-1)![1],70);
});

test('explicit samples preserve null holes and reject data outside a logarithmic domain as gaps',()=>{
  const b=fixture(),p=plot(b);Object.assign(p,{mode:'samples',samples:[[1,1],[10,2],null,[100,3],[1000,4]]});delete p.expression;delete p.domains;
  Object.assign(p.inputs,{xMin:number(1),xMax:number(1000),xScale:number(1),yMin:number(0),yMax:number(4)});
  const f=evaluate(b,0);assert.equal(path(f).geometry!.contours.length,2);
  near(vertices(f)[1][0],10+200/3);p.samples=[[-1,0],[1,1],[10,2]];
  const masked=evaluate(b,0);assert.equal(path(masked).geometry!.contours.length,1);assert.equal(vertices(masked)[0][0],10);
});

test('mask evaluation is lazy and reciprocal explicit subdomains never bridge the pole',()=>{
  const b=fixture();plot(b).expression='1/x';plot(b).domains=[[-1,-.2],[.2,1]];
  Object.assign(plot(b).inputs,{yMin:number(-5),yMax:number(5)});
  const f=evaluate(b,0);assert.equal(path(f).geometry!.contours.length,2);
  for(const c of path(f).geometry!.contours){const xs=[c.start[0],...c.segments.map(s=>s.to[0])];assert.ok(Math.max(...xs)<110||Math.min(...xs)>110);}
  plot(b).domains=[[-1,1]];plot(b).mask='x < -0.2 || x > 0.2';
  const m=evaluate(b,0);assert.equal(path(m).geometry!.contours.length,2);assert.ok(m.plots!.function.maskedIntervals>0);
  plot(b).mask='false';assert.equal(path(evaluate(b,0)).geometry!.contours.length,0);
});

test('area shares masks between both boundaries and fills only closed common domains',()=>{
  const b=fixture();Object.assign(plot(b),{mode:'area',lower:'0',upper:'1-x*x',mask:'x < -0.2 || x > 0.2'});delete plot(b).expression;
  const f=evaluate(b,0),contours=path(f).geometry!.contours;
  assert.equal(contours.length,2);assert.ok(contours.every(c=>c.closed));
  for(const c of contours){const xs=[c.start[0],...c.segments.map(s=>s.to[0])];assert.ok(Math.max(...xs)<110||Math.min(...xs)>110);}
});

test('plot target inverse chart and animated ancestor transforms preserve scene geometry',()=>{
  const b=fixture();b.nodes.unshift({id:'group',kind:'group',transform:{translate:[50,10],rotate:20,scale:[2,.5]}});
  b.nodes.find(n=>n.id==='curve')!.parent='group';b.tracks=[{target:'group',property:'transform.rotate',keys:[[0,20],[2,55]]}];
  const f=evaluate(b,1),byId=new Map(f.nodes.map(n=>[n.id,n])),world=worldMatrix('curve',byId);
  const first=transformPoint(world,vertices(f)[0]);near(first[0],10);near(first[1],20);
  b.nodes.find(n=>n.id==='group')!.transform!.scale=[0,1];diagnostics(()=>evaluate(b,1),'SINGULAR_TRANSFORM');
});

function curveConsumer(b:Bundle){
  b.nodes.push({id:'dot',kind:'point',x:0,y:0,r:3},{id:'tip',kind:'point',x:0,y:0,r:0},{id:'tangent',kind:'line',x1:0,y1:0,x2:0,y2:0});
  b.operationGraph={version:1,operations:[{id:'sample',operator:'sampleCurve',version:2,spaces:{space:scene},inputs:{
    path:{kind:'path',node:'curve',space:scene},parameter:number(.5),mode:number(1)}},
    {id:'direction',operator:'offsetPoint',version:1,spaces:{space:scene},inputs:{origin:{kind:'output',ref:{operation:'sample',socket:'position'}},
      direction:{kind:'output',ref:{operation:'sample',socket:'tangent'}},distance:number(40)}}],
    bindings:[{target:'dot',property:'position',value:{operation:'sample',socket:'position'}},{target:'tip',property:'position',value:{operation:'direction',socket:'position'}}]};
  b.relations=[{type:'lineBetween',target:'tangent',a:'dot',b:'tip'}];
}
test('planner orders generated geometry before curve sampling, bindings and dependent tangents',()=>{
  const b=fixture();curveConsumer(b);const plan=prepareExecutionPlan(b),f=evaluate(b,0),dot=f.nodes.find(n=>n.id==='dot') as PointNode;
  assert.ok(plan.order.indexOf('plot:0')<plan.order.indexOf(JSON.stringify(['operation','sample'])));near(dot.x,110,1e-6);near(dot.y,120,1e-6);
  assert.ok(f.curves!.samples.sample.sample.position);assert.equal(f.nodes.find(n=>n.id==='tangent')!.kind,'line');
  const line=f.nodes.find(n=>n.id==='tangent') as any;near(Math.hypot(line.x2-line.x1,line.y2-line.y1),40);
});

test('plot typed inputs consume graph outputs and resolve changing scalar expressions',()=>{
  const b=fixture();b.expressions={version:1,parameters:{width:{type:'scalar',unit:'bp',default:200,min:100,max:300}},bindings:[]};
  b.operationGraph={version:1,operations:[{id:'origin',operator:'midpoint',version:1,spaces:{space:scene},inputs:{a:point([0,0]),b:point([20,40])}}],bindings:[]};
  plot(b).inputs.origin={kind:'output',ref:{operation:'origin',socket:'position'}};plot(b).inputs.width={kind:'expression',expression:'width',unit:'bp'};
  assert.deepEqual(validateOperationGraph(b.operationGraph,b),[]);assert.deepEqual(validateExpressionProgram(b.expressions,b),[]);
  assert.deepEqual(vertices(evaluate(b,0,{width:300})).at(-1),[310,20]);
  assert.ok(prepareExecutionPlan(b).order.indexOf(JSON.stringify(['operation','origin']))<prepareExecutionPlan(b).order.indexOf('plot:0'));
});

test('plot feedback through a generated path consumer is rejected before evaluating frames',()=>{
  const b=fixture();curveConsumer(b);plot(b).inputs.origin={kind:'output',ref:{operation:'sample',socket:'position'}};
  diagnostics(()=>prepareScene(b),'OPERATION_PLAN_CYCLE');
});

test('plot geometry owns all geometry slots and conflicts with tracks or other programs',()=>{
  const b=fixture();b.plots!.operations.push({...structuredClone(plot(b)),id:'other'});
  assert.ok(validateBundle(b).some(d=>d.code==='PLOT_WRITER_CONFLICT'));
  b.plots!.operations.pop();b.deformations={version:1,operations:[{id:'warp',source:'curve',target:'curve',mode:'controlDeform',expression:'position'}]};
  assert.ok(validateBundle(b).some(d=>d.code==='PLOT_WRITER_CONFLICT'));
  delete b.deformations;b.nodes.push({id:'other',kind:'path',d:'M0 0',geometry:{contours:[]}});
  b.operationGraph={version:1,operations:[{id:'reverse',operator:'reversePath',version:1,spaces:{space:{kind:'local',node:'curve'}},inputs:{path:{kind:'path',node:'other',space:{kind:'local',node:'curve'}}}}],bindings:[{target:'curve',property:'geometry',value:{operation:'reverse',socket:'path'}}]};
  assert.ok(validateBundle(b).some(d=>d.code==='PLOT_WRITER_CONFLICT'));assert.ok(validateOperationGraph(b.operationGraph,b).some(d=>d.code==='OPERATION_WRITER_CONFLICT'));
});

test('syntax, units, output references and expression source locations fail without being masked',()=>{
  const source={file:'plots-sources/curve.txt',start:{line:4,column:2},end:{line:4,column:7}};
  const b=fixture();plot(b).expression='noSuchVariable';plot(b).expressionSpans={expression:source};
  const unknown=validateBundle(b);assert.ok(unknown.some(d=>d.path==='$.plots.operations[0].expression'&&d.sourceSpan?.file===source.file));
  plot(b).expression='1bp';assert.ok(validateBundle(b).some(d=>d.code==='PLOT_EXPRESSION_TYPE'));
  plot(b).expression='x';plot(b).mask='1';assert.ok(validateBundle(b).some(d=>d.code==='PLOT_EXPRESSION_TYPE'));
  delete plot(b).mask;plot(b).inputs.tolerance=number(.5,'bp');assert.ok(validateBundle(b).some(d=>d.code==='OPERATION_UNIT_MISMATCH'));
  delete plot(b).inputs.tolerance;plot(b).inputs.width={kind:'output',ref:{operation:'missing',socket:'x'}};assert.ok(validateBundle(b).some(d=>d.code==='OPERATION_MISSING_REFERENCE'));
});

test('bounded work failures retain plot provenance and no partial geometry leaks',()=>{
  const b=fixture();plot(b).sourceSpan={file:'plot.json',start:{line:1,column:1},end:{line:1,column:30}};
  plot(b).inputs.maxSamples=number(3);const before=structuredClone(b);
  assert.throws(()=>evaluate(b,0),(e:any)=>e.diagnostics.some((d:any)=>d.code==='PLOT_BUDGET'&&d.sourceSpan.file==='plot.json'&&d.path==='$.plots.operations[0]'));
  assert.deepEqual(b,before);plot(b).inputs.maxSamples=number(16384);plot(b).inputs.maxDepth=number(1);plot(b).inputs.tolerance=number(1e-10);
  diagnostics(()=>evaluate(b,0),'PLOT_RESOLUTION');
});

test('strict portable schema rejects malformed modes, intervals, duplicate IDs and local collisions',()=>{
  const mutations:Array<(p:PlotOperation)=>void>=[p=>{p.domains=[[1,0]];},p=>{p.domains=[[-1,.5],[0,1]];},p=>{p.breaks=[1,0];},
    p=>{p.samples=[[0,0],[1,1]];},p=>{(p as any).extra=true;},p=>{p.expressionSpans={invalid:{file:'x',start:{line:1,column:1},end:{line:1,column:2}}};}];
  for(const mutate of mutations){const b=fixture();mutate(plot(b));assert.ok(validatePlotProgram(b.plots,b).some(d=>d.severity==='error'));}
  const b=fixture();b.expressions={version:1,parameters:{x:{type:'scalar',default:1}},bindings:[]};
  assert.ok(validateBundle(b).some(d=>d.code==='PLOT_PARAMETER_SHADOW'));
});

test('all-null sample tables have no local-variable names and still enforce budgets and geometry ownership',()=>{
  const b=fixture(),p=plot(b);Object.assign(p,{mode:'samples',samples:[null,null]});delete p.expression;delete p.domains;
  b.expressions={version:1,parameters:{x:{type:'scalar',default:3},parameter:{type:'scalar',default:2}},bindings:[]};
  const f=evaluate(b,0);assert.deepEqual(path(f).geometry,{contours:[]});assert.equal(f.plots!.function.segmentCount,0);
  p.inputs.maxSamples=number(1);diagnostics(()=>evaluate(b,0),'PLOT_BUDGET');delete p.inputs.maxSamples;
  p.inputs.tolerance=number(-1);assert.ok(validateBundle(b).some(d=>d.code==='PLOT_MODE_PROPERTY'));delete p.inputs.tolerance;
  b.plots!.operations.push({...structuredClone(p),id:'other'});assert.ok(validateBundle(b).some(d=>d.code==='PLOT_WRITER_CONFLICT'));
});

test('standalone validators report malformed deferred plots instead of reading unchecked writers',()=>{
  const b=fixture(),graph={version:1 as const,operations:[],bindings:[]};
  for(const malformed of [null,{version:1,operations:null},{version:1,operations:{}},{version:1,operations:[null]},
    {version:1,operations:[{}]},{version:1,operations:[{id:'bad',target:'curve',mode:'unknown'}]}]){
    const context={...b,plots:malformed} as Bundle;
    for(const validate of [()=>validateOperationGraph(graph,context),()=>validateExpressionProgram({version:1,parameters:{},bindings:[]},context),
      ()=>validateDeformationProgram({version:1,operations:[]},context),()=>validateFieldProgram({version:1,domains:[],operations:[],bindings:[]},context)])
      assert.ok(validate().some(d=>d.severity==='error'&&d.path?.startsWith('$.plots')));
  }
});
