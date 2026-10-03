import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareMathCorrespondence,type MathCorrespondenceOptions,type MathPartMapping} from '../src/operations/text-parts.js';
import type {VectorResource} from '../src/schema.js';

function resource():VectorResource {
  return {kind:'vector',sourceTex:'x+x🙂',metrics:{width:100,height:15,depth:3},inkBounds:[-2,-16,106,20],
    items:[{kind:'group',transform:[1,0,0,1,10,20],style:{fill:'#123456'},clip:{d:'M0 -20 H100 V20 H0 Z'},children:[
      {kind:'path',d:'M0 0 L4 -5'},
      {kind:'group',transform:[2,0,0,2,5,0],style:{fill:'#abcdef'},children:[{kind:'path',d:'M1 0 H3'},{kind:'path',d:'M5 0 L9 -5'}]},
      {kind:'path',d:'M30 0 H40'}]}],
    textParts:{version:1,parts:[{id:'whole',sourceRange:{start:0,end:4},paintPaths:[],logicalBox:[10,5,90,18]},
      {id:'first',parent:'whole',sourceRange:{start:0,end:1},paintPaths:[[0,0]],logicalBox:[10,15,4,5]},
      {id:'plus',parent:'whole',sourceRange:{start:1,end:2},paintPaths:[[0,1,0]]},
      {id:'second',parent:'whole',sourceRange:{start:2,end:3},paintPaths:[[0,1,1]],logicalBox:[25,10,8,10]},
      {id:'phantom',sourceRange:{start:3,end:4},paintPaths:[]}]}};
}
const pair=(source='first',target='first',mode:'replace'|'copy'='replace'):MathPartMapping=>({source,target,mode,sourceAnchor:[12,20],targetAnchor:[22,30]});
const options=(pairs:MathPartMapping[]=[pair()]):MathCorrespondenceOptions=>({approved:true,retention:'replace',pairs,unmatched:'fade'});
function rejects(fn:()=>unknown,code:string){assert.throws(fn,(error:any)=>error.diagnostics?.some((d:any)=>d.code===code));}

test('explicit mapping preserves authored IDs, original local paint and exact endpoint resource snapshots',()=>{
  const a=resource(),b=resource();b.items[0].transform![4]=50;const originals=[structuredClone(a),structuredClone(b)];
  const result=prepareMathCorrespondence(a,b,options([pair('first','second')])),mapped=result.pairs[0];
  assert.equal(result.contract,'texloom-math-correspondence/1');assert.equal(mapped.sourcePartId,'first');assert.equal(mapped.targetPartId,'second');
  assert.equal(mapped.sourceText,'x');assert.equal(mapped.targetText,'x');assert.deepEqual(mapped.sourceAnchor,[12,20]);assert.deepEqual(mapped.targetAnchor,[22,30]);
  assert.deepEqual(mapped.sourceSelection.paintPaths,[[0,0]]);assert.deepEqual(mapped.targetSelection.paintPaths,[[0,1,1]]);
  assert.deepEqual(mapped.targetSelection.items[0].transform,[1,0,0,1,50,20]);assert.deepEqual(mapped.targetSelection.items[0].clip,b.items[0].clip);
  assert.deepEqual(mapped.targetSelection.items[0].children![0].style,{fill:'#abcdef'});
  assert.deepEqual(mapped.targetSelection.items[0].children![0].children![0].d,'M5 0 L9 -5');
  assert.deepEqual(result.source,originals[0]);assert.deepEqual(result.target,originals[1]);assert.deepEqual([a,b],originals);
});

test('native coverage includes unmarked leaves and keeps ordered remainder paint trees',()=>{
  const a=resource(),result=prepareMathCorrespondence(a,a,options());
  assert.deepEqual(result.sourceRemainder.paintPaths,[[0,1,0],[0,1,1],[0,2]]);
  assert.equal(result.sourceRemainder.items[0].children!.length,2);
  assert.deepEqual(result.sourceRemainder.items[0].children![0].transform,[2,0,0,2,5,0]);
  assert.equal(result.report.sourcePaintLeaves,4);assert.equal(result.report.sourceMappedPaintLeaves,1);assert.equal(result.report.sourceRemainderPaintLeaves,3);
  const all=options([pair('whole','whole')]);all.unmatched='error';
  rejects(()=>prepareMathCorrespondence(a,a,all),'MATH_PART_UNMATCHED');
  a.textParts!.parts[0].paintPaths=[[0,2]];const complete=prepareMathCorrespondence(a,a,all);
  assert.deepEqual(complete.sourceRemainder.items,[]);assert.equal(complete.report.sourceMappedPaintLeaves,4);
});

test('logical-center uses only the queried measured box and explicit anchors remain authored coordinates',()=>{
  const a=resource(),config=options([{...pair(),sourceAnchor:'logical-center',targetAnchor:'logical-center'}]);
  const mapped=prepareMathCorrespondence(a,a,config).pairs[0];assert.deepEqual(mapped.sourceAnchor,[12,17.5]);assert.deepEqual(mapped.targetAnchor,[12,17.5]);
  assert.notDeepEqual(mapped.sourceAnchor,[a.inkBounds[0]+a.inkBounds[2]/2,a.inkBounds[1]+a.inkBounds[3]/2]);
  config.pairs[0].source='plus';rejects(()=>prepareMathCorrespondence(a,a,config),'MATH_PART_ANCHOR');
  config.pairs[0].sourceAnchor=[-900,1000];assert.deepEqual(prepareMathCorrespondence(a,a,config).pairs[0].sourceAnchor,[-900,1000]);
  config.pairs[0].sourceAnchor='baseline' as any;rejects(()=>prepareMathCorrespondence(a,a,config),'MATH_PART_ANCHOR');
});

test('replace and keep-source have explicit copy policies with unique targets',()=>{
  const a=resource(),config=options([pair('first','first'),pair('first','second','copy')]);
  const result=prepareMathCorrespondence(a,a,config);assert.deepEqual(result.report.sourceUses,[{sourcePartId:'first',replacePairs:['math-pair-0'],copyPairs:['math-pair-1'],paintLeaves:1}]);
  assert.equal(result.report.sourceMappedPaintLeaves,1);assert.equal(result.report.targetMappedPaintLeaves,2);
  config.pairs[1].mode='replace';rejects(()=>prepareMathCorrespondence(a,a,config),'MATH_PART_COPY_POLICY');
  config.pairs.forEach(p=>{p.mode='copy';});rejects(()=>prepareMathCorrespondence(a,a,config),'MATH_PART_COPY_POLICY');
  config.retention='keep-source';assert.equal(prepareMathCorrespondence(a,a,config).retention,'keep-source');
  config.pairs[1].mode='replace';rejects(()=>prepareMathCorrespondence(a,a,config),'MATH_PART_COPY_POLICY');
  config.pairs[1].mode='copy';config.pairs[1].target='first';rejects(()=>prepareMathCorrespondence(a,a,config),'MATH_PART_TARGET_REUSE');
});

test('distinct ancestor/descendant IDs cannot silently share mapped source or target paint',()=>{
  const a=resource();
  rejects(()=>prepareMathCorrespondence(a,a,options([pair('whole','first'),pair('first','second')])),'MATH_PART_OVERLAP');
  rejects(()=>prepareMathCorrespondence(a,a,options([pair('first','whole'),pair('second','second')])),'MATH_PART_OVERLAP');
  rejects(()=>prepareMathCorrespondence(a,a,options([pair('not-an-index','first')])),'TEXT_PART_UNKNOWN');
});

test('native nonunit isolated opacity cannot be split across pair or remainder partitions',()=>{
  const a=resource();a.items[0].style!.opacity=.5;
  rejects(()=>prepareMathCorrespondence(a,resource(),options()),'MATH_PART_OPACITY_PARTITION');
  a.textParts!.parts[0].paintPaths=[[0,2]];const target=structuredClone(a);
  assert.equal(prepareMathCorrespondence(a,target,options([pair('whole','whole')])).pairs.length,1);
  const b=resource();b.items[0].children![1].style!.opacity=.7;
  rejects(()=>prepareMathCorrespondence(resource(),b,options([pair('first','plus')])),'MATH_PART_OPACITY_PARTITION');
  const leaf=resource();leaf.items[0].children![0].style={opacity:.5};
  assert.equal(prepareMathCorrespondence(leaf,leaf,options()).pairs[0].sourceSelection.items[0].children![0].style!.opacity,.5);
});

test('phantom selections and fully unmatched unmarked resources remain explicit without guessed bounds',()=>{
  const a=resource(),config=options([pair('phantom','phantom')]),result=prepareMathCorrespondence(a,a,config);
  assert.deepEqual(result.pairs[0].sourceSelection.items,[]);assert.equal(result.pairs[0].sourceText,'🙂');
  assert.equal(result.report.sourceRemainderPaintLeaves,4);assert.equal(result.report.sourceMappedPaintLeaves,0);
  delete a.textParts;const unmarked=prepareMathCorrespondence(a,a,options([]));
  assert.deepEqual(unmarked.sourceRemainder.items,a.items);assert.equal(unmarked.report.sourcePaintLeaves,4);
});

test('prepared correspondence and selections are deeply detached frozen snapshots',()=>{
  const a=resource(),b=resource(),result=prepareMathCorrespondence(a,b,options()),snapshot=structuredClone(result);
  a.items[0].transform![4]=999;b.textParts!.parts[1].id='changed';
  assert.deepEqual(result,snapshot);assert.ok(Object.isFrozen(result.pairs[0].sourceSelection.items[0].clip));
  assert.throws(()=>{(result.sourceRemainder.items[0].transform as any)[0]=3;},TypeError);
});

test('approval, missing anchors, malformed JSON and bounded pair counts fail before preparation',()=>{
  const a=resource();rejects(()=>prepareMathCorrespondence(a,a,{...options(),approved:false} as any),'MATH_PART_APPROVAL');
  const missing=options();delete (missing.pairs[0] as any).sourceAnchor;rejects(()=>prepareMathCorrespondence(a,a,missing),'MATH_PART_ANCHOR');
  rejects(()=>prepareMathCorrespondence(a,a,{...options(),pairs:Array.from({length:257},()=>pair())}),'MATH_PART_LIMIT');
  rejects(()=>prepareMathCorrespondence(a,a,{...options(),autoMatch:true} as any),'MATH_PART_PROPERTY');
  let reads=0;const hostile={...options(),get pairs(){reads++;return [];}};
  rejects(()=>prepareMathCorrespondence(a,a,hostile),'NON_JSON_VALUE');assert.equal(reads,0);
});
