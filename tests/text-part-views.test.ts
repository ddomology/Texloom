import test from 'node:test';
import assert from 'node:assert/strict';
import {lowerTextPartViews,type TextPartViewRecord} from '../src/ir/text-part-views.js';
import {validateBundle,type Bundle,type TexNode,type VectorResource} from '../src/schema.js';
import {createEvaluator} from '../src/evaluate.js';

function fixture():Bundle {
  return {version:'0.3',title:'Part views',duration:3,units:'bp',viewport:{width:200,height:100},camera:{x:0,y:0,zoom:1},relations:[],tracks:[],
    nodes:[{id:'group',kind:'group',transform:{translate:[5,7]}},{id:'formula',kind:'tex',parent:'group',resourceId:'math',x:30,y:40,scale:1.5,
      transform:{rotate:.2,translate:[2,3]},clip:{d:'M0 0 H100 V100 H0 Z'},style:{fill:'#123456',opacity:.3}}],
    resources:{math:{kind:'vector',sourceTex:'x+y',metrics:{width:50,height:12,depth:3},inkBounds:[-1,-12,53,16],glyphs:[{outlineId:'x'}],
      capabilities:['glyph-outlines','semantic-text-parts'],items:[{kind:'group',transform:[1,0,0,1,10,20],style:{fill:'currentColor',opacity:.8},children:[
        {kind:'path',d:'M0 0 L5 5',style:{fill:'#000'}},{kind:'group',style:{fill:'none',stroke:'#fff'},children:[{kind:'path',d:'M10 0 H20'}]}]}],
      textParts:{version:1,parts:[{id:'whole',sourceRange:{start:0,end:3},paintPaths:[]},
        {id:'x',parent:'whole',sourceRange:{start:0,end:1},paintPaths:[[0,0]]},
        {id:'y',parent:'whole',sourceRange:{start:2,end:3},paintPaths:[[0,1,0]]},
        {id:'empty',sourceRange:{start:0,end:0},paintPaths:[]}]}}}};
}
const record=(extra:Partial<TextPartViewRecord>={}):TextPartViewRecord=>({id:'highlight',sourceId:'formula',query:{ids:['whole'],scope:'descendants',overlap:'error'},style:{fill:'#ffcc00',opacity:.75},...extra});
const rejected=(fn:()=>unknown,code:string)=>assert.throws(fn,(error:any)=>error.diagnostics?.some((diagnostic:any)=>diagnostic.code===code));

test('views clone authored placement while preserving native paint and full alignment metrics',()=>{
  const source=fixture(),before=structuredClone(source),result=lowerTextPartViews(source,[record()]);
  assert.deepEqual(source,before);assert.deepEqual(validateBundle(result),[]);
  const node=result.nodes.at(-1) as TexNode,original=source.nodes[1] as TexNode;
  for(const key of ['x','y','scale','parent','transform','clip'] as const)assert.deepEqual(node[key],original[key]);
  assert.equal(node.id,'highlight');assert.equal(node.resourceId,'highlight-parts');assert.deepEqual(node.style,{fill:'#ffcc00',opacity:.75});
  const vector=result.resources[node.resourceId] as VectorResource,originalResource=source.resources.math as VectorResource;
  assert.deepEqual(vector.metrics,originalResource.metrics);assert.deepEqual(vector.inkBounds,originalResource.inkBounds);
  assert.equal(vector.textParts,undefined);assert.equal(vector.glyphs,undefined);assert.ok(!vector.capabilities!.includes('semantic-text-parts'));
  assert.equal(vector.items[0].children![0].d,originalResource.items[0].children![0].d);
  assert.deepEqual(vector.items[0].transform,[1,0,0,1,10,20]);assert.equal(vector.items[0].style!.opacity,.8);
  assert.equal(vector.items[0].children![0].style!.fill,'#ffcc00');
  assert.equal(vector.items[0].children![1].children![0].style!.fill,'none');
  const provenance=(vector as any).provenance.textPartView;
  assert.equal(provenance.originalResourceId,'math');assert.deepEqual(provenance.partIds,['whole','x','y']);assert.equal(provenance.metricsPolicy,'source-resource');
  node.transform!.translate![0]=999;vector.items[0].transform![4]=999;assert.deepEqual(source,before);
});

test('empty parts produce invisible ordinary resources without inventing a selected bound',()=>{
  const b=fixture(),result=lowerTextPartViews(b,[record({query:{ids:['empty'],scope:'exact',overlap:'error'}})]);
  const vector=result.resources['highlight-parts'] as VectorResource;
  assert.deepEqual(vector.items,[]);assert.deepEqual(vector.metrics,(b.resources.math as VectorResource).metrics);
  assert.deepEqual(vector.inkBounds,(b.resources.math as VectorResource).inkBounds);assert.deepEqual(validateBundle(result),[]);
});

test('views capture source-local authored values and do not add a live source dependency',()=>{
  const b=fixture();b.tracks=[{target:'formula',property:'x',keys:[[0,30],[3,90]]}];
  const result=lowerTextPartViews(b,[record()]),frame=createEvaluator(result)(1);
  assert.equal((frame.nodes.find(n=>n.id==='formula') as TexNode).x,50);
  assert.equal((frame.nodes.find(n=>n.id==='highlight') as TexNode).x,30);assert.equal(result.tracks.length,1);
});

test('duplicate nodes, resource collisions, unknown sources and invalid selections fail before publication',()=>{
  const b=fixture(),before=structuredClone(b);
  rejected(()=>lowerTextPartViews(b,[record(),record()]),'TEXT_PART_VIEW_ID');
  rejected(()=>lowerTextPartViews(b,[record({id:'formula'})]),'TEXT_PART_VIEW_ID');
  rejected(()=>lowerTextPartViews(b,[record({sourceId:'group'})]),'TEXT_PART_VIEW_SOURCE');
  rejected(()=>lowerTextPartViews(b,[record({sourceId:'missing'})]),'TEXT_PART_VIEW_SOURCE');
  rejected(()=>lowerTextPartViews(b,[record({query:{ids:['unknown'],scope:'exact',overlap:'error'}})]),'TEXT_PART_UNKNOWN');
  rejected(()=>lowerTextPartViews(b,[record(),record({id:'second',sourceId:'highlight'})]),'TEXT_PART_VIEW_SOURCE');
  assert.deepEqual(b,before);
  b.resources['highlight-parts']=structuredClone(b.resources.math);rejected(()=>lowerTextPartViews(b,[record()]),'TEXT_PART_VIEW_RESOURCE');
});

test('style, source diagnostics and descriptor validation remain strict',()=>{
  const b=fixture(),sourceSpan={file:'views.tex',start:{line:8,column:2},end:{line:8,column:30}};
  rejected(()=>lowerTextPartViews(b,[record({style:{opacity:1.1}})]),'TEXT_PART_VIEW_STYLE');
  rejected(()=>lowerTextPartViews(b,[record({style:{stroke:'#fff'} as any})]),'TEXT_PART_VIEW_STYLE');
  assert.throws(()=>lowerTextPartViews(b,[record({style:{fill:'#x'},sourceSpan})]),(error:any)=>error.diagnostics?.some((d:any)=>d.code==='PAINT_COLOR'&&d.sourceSpan?.file==='views.tex'));
  let reads=0;const hostile={...record(),get sourceId(){reads++;return 'formula';}};
  rejected(()=>lowerTextPartViews(b,[hostile]),'NON_JSON_VALUE');assert.equal(reads,0);
  assert.deepEqual(lowerTextPartViews(b,[]),b);
});
