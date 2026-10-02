import test from 'node:test';
import assert from 'node:assert/strict';
import {validateBundle,type Bundle,type PathNode} from '../src/schema.js';
import {validateMorphProgram,prepareMorphProgram} from '../src/timeline/morph.js';
import {validateOperationGraph} from '../src/operations/validate.js';
import {validateExpressionProgram} from '../src/fields/program.js';
import {validateFieldProgram} from '../src/fields/program-fields.js';
import {validateDeformationProgram} from '../src/operations/deform.js';
import {validatePlotProgram} from '../src/operations/plot.js';
import {prepareCorrespondence} from '../src/geometry/correspondence.js';
import type {PathGeometry,PathContour,PathPoint} from '../src/path-geometry.js';
const scene={kind:'scene'} as const;
const scalar=(value:number,unit:'1'|'bp'='1')=>({kind:'literal' as const,value:{type:'scalar' as const,unit,value}});
const line=(id='main'):PathContour=>({id,start:[0,0],segments:[{id:'edge',kind:'line',to:[20,0]}]});
function fixture():Bundle {
  const path=(id:string,parent?:string):PathNode=>({id,kind:'path',d:'M0 0 L20 0',geometry:{contours:[line()]},style:{fill:'none',stroke:'#fff'},...(parent?{parent}:{})});
  return {version:'0.3',title:'Morph validation',duration:3,units:'bp',viewport:{width:120,height:80},camera:{x:0,y:0,zoom:1},resources:{},tracks:[],relations:[],
    nodes:[path('source'),path('destination'),{id:'change',kind:'group',morphProgress:.5},path('change:shape','change'),path('change:leaving','change'),path('change:entering','change')],
    morphs:{version:1,operations:[{id:'change',source:'source',destination:'destination',instance:'change',correspondence:{approved:true,contours:[{source:'main',target:'main',segments:[{source:'edge',target:'edge'}]}]}}]}};
}
const node=(b:Bundle,id:string)=>b.nodes.find(n=>n.id===id)!;
const path=(b:Bundle,id:string)=>node(b,id) as PathNode;
const conflict=(diagnostics:ReturnType<typeof validateBundle>)=>assert.ok(diagnostics.some(d=>d.code==='MORPH_WRITER_CONFLICT'),JSON.stringify(diagnostics));

test('standalone graph, expression, deformation and plot validators honor morph helper ownership',()=>{
  const b=fixture();assert.deepEqual(validateBundle(b),[]);
  const graph={version:1 as const,operations:[{id:'reverse',operator:'reversePath',version:1,spaces:{space:{kind:'local' as const,node:'change:shape'}},inputs:{path:{kind:'path' as const,node:'source',space:{kind:'local' as const,node:'change:shape'}}}}],
    bindings:[{target:'change:shape',property:'geometry',value:{operation:'reverse',socket:'path'}}]};
  conflict(validateOperationGraph(graph,b));
  conflict(validateExpressionProgram({version:1,parameters:{},bindings:[{target:'change:leaving',property:'style.opacity',expression:'0.5'}]},b));
  conflict(validateDeformationProgram({version:1,operations:[{id:'warp',source:'source',target:'change:entering',mode:'controlDeform',expression:'position'}]},b));
  conflict(validatePlotProgram({version:1,operations:[{id:'plot',target:'change:shape',mode:'function',expression:'x',domains:[[0,1]],space:scene,
    inputs:{origin:{kind:'literal',value:{type:'vec2',role:'point',space:scene,value:[0,0]}},width:scalar(20,'bp'),height:scalar(20,'bp'),xMin:scalar(0),xMax:scalar(1),yMin:scalar(0),yMax:scalar(1)}}]},b));
});

test('all standalone validation entry points diagnose malformed morph context without dereferencing it',()=>{
  for(const morphs of [null,{}, {version:1,operations:null},{version:1,operations:{}},{version:1,operations:[null]}]){
    const b={...fixture(),morphs} as Bundle;
    const validators=[()=>validateOperationGraph({version:1,operations:[],bindings:[]},b),
      ()=>validateExpressionProgram({version:1,parameters:{},bindings:[]},b),
      ()=>validateFieldProgram({version:1,domains:[],operations:[],bindings:[]},b),
      ()=>validateDeformationProgram({version:1,operations:[]},b),()=>validatePlotProgram({version:1,operations:[]},b)];
    for(const validate of validators)assert.ok(validate().some(d=>d.severity==='error'),JSON.stringify(morphs));
  }
});

test('unmatched stroke-only restriction checks actual helper overrides and inherited instance paint',()=>{
  const b=fixture();path(b,'source').geometry!.contours.push(line('extra'));b.morphs!.operations[0].correspondence.unmatched='fade';
  assert.deepEqual(validateBundle(b),[]);
  for(const id of ['change:shape','change:leaving','change:entering']){
    const changed=structuredClone(b);node(changed,id).style!.fill='#fff';
    assert.ok(validateBundle(changed).some(d=>d.code==='MORPH_UNMATCHED_FILL'));
  }
  const inherited=structuredClone(b);delete node(inherited,'change:leaving').style!.fill;node(inherited,'change').style={fill:'#fff'};
  assert.ok(validateMorphProgram(inherited.morphs,inherited).some(d=>d.code==='MORPH_UNMATCHED_FILL'));
});

test('mixed closed reversal cannot bypass nonzero fill protection using a helper paint override',()=>{
  const polygon=(id:string,points:PathPoint[]):PathContour=>({id,start:points[0],closed:true,segments:points.slice(1).map((to,i)=>({id:`e${i}`,kind:'line',to}))});
  const outer=polygon('outer',[[0,0],[20,0],[20,20],[0,20]]),hole=polygon('hole',[[4,4],[4,16],[16,16],[16,4]]);
  const reverseHole=polygon('hole',[[16,4],[16,16],[4,16],[4,4]]),b=fixture();
  path(b,'source').geometry={contours:[outer,hole]};path(b,'destination').geometry={contours:[outer,reverseHole]};
  b.morphs!.operations[0].correspondence.contours=[{source:'outer',target:'outer',segments:[0,1,2].map(i=>({source:`e${i}`,target:`e${i}`}))},
    {source:'hole',target:'hole',reverseTarget:true,segments:[0,1,2].map(i=>({source:`e${i}`,target:`e${2-i}`}))}];
  assert.deepEqual(validateBundle(b),[]);
  node(b,'change:shape').style!.fill='#fff';assert.ok(validateBundle(b).some(d=>d.code==='MORPH_HOLE_WINDING'));
  node(b,'change:shape').style!.fillRule='evenodd';assert.deepEqual(validateBundle(b),[]);
});

test('authored endpoint geometry remains a static snapshot even when other programs update it',()=>{
  const b=fixture();b.deformations={version:1,operations:[{id:'warp',source:'source',target:'source',mode:'controlDeform',expression:'position'}]};
  assert.deepEqual(validateBundle(b),[]);const prepared=prepareMorphProgram(b.morphs!,b),nodes=new Map(structuredClone(b.nodes).map(n=>[n.id,n]));
  (nodes.get('source') as PathNode).geometry!.contours[0].start=[900,900];prepared.operations[0].apply(nodes);
  assert.deepEqual((nodes.get('change:shape') as PathNode).geometry!.contours[0].start,[0,0]);
});

test('reported total output and the segment cap include unmatched contours after resampling',()=>{
  const source:PathGeometry={contours:Array.from({length:8},(_,i)=>line(`c${i}`))},target=structuredClone(source);
  const options={approved:true as const,contours:source.contours.map(c=>({source:c.id,target:c.id})),resample:{count:4096},unmatched:'fade' as const};
  source.contours.push({id:'extra',start:[0,0],segments:Array.from({length:8},(_,i)=>({id:`extra${i}`,kind:'line' as const,to:[i+1,0] as PathPoint}))});
  assert.equal(prepareCorrespondence(source,target,options).report.outputSegments,32768);
  source.contours.at(-1)!.segments.push({id:'overflow',kind:'line',to:[9,0]});
  assert.throws(()=>prepareCorrespondence(source,target,options),(error:any)=>error.code==='CORRESPONDENCE_BUDGET');
});
