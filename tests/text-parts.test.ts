import test from 'node:test';
import assert from 'node:assert/strict';
import {selectTextParts,validateTextParts,type TextParts,type TextPartQuery} from '../src/ir/text-parts.js';
import type {VectorResource} from '../src/schema.js';
const exact:TextPartQuery={ids:['left-x'],scope:'exact',overlap:'error'};
function fixture():VectorResource&{textParts:TextParts}{
  return {kind:'vector',metrics:{width:40,height:10,depth:3},inkBounds:[0,-10,40,13],sourceTex:'x + x🙂',
    items:[{kind:'group',transform:[1,0,0,1,10,20],style:{fill:'#123456',opacity:.4},clip:{d:'M0 0 H40 V20 H0 Z',transform:[1,0,0,1,2,3]},children:[
      {kind:'path',d:'M0 0 L3 -5',transform:[2,0,0,2,1,0]},
      {kind:'group',transform:[0,1,-1,0,4,5],style:{stroke:'#abcdef',opacity:.7},children:[
        {kind:'path',d:'M0 0 H4'},
        {kind:'path',d:'M6 0 L9 -5',style:{fill:'#fedcba'}}]},
      {kind:'path',d:'M30 0 L31 0'}]}],
    textParts:{version:1,parts:[
      {id:'expression',sourceRange:{start:0,end:6},paintPaths:[],logicalBox:[0,-10,40,13]},
      {id:'left-x',parent:'expression',role:'variable',sourceRange:{start:0,end:1},paintPaths:[[0,0]]},
      {id:'plus',parent:'expression',sourceRange:{start:2,end:3},paintPaths:[[0,1,0]]},
      {id:'right-x',parent:'expression',sourceRange:{start:4,end:5},paintPaths:[[0,1,1]]},
      {id:'phantom',parent:'expression',sourceRange:{start:5,end:6},paintPaths:[]}]}};
}
function rejects(fn:()=>unknown,code:string){assert.throws(fn,(e:any)=>Array.isArray(e.diagnostics)&&e.diagnostics.some((d:any)=>d.code===code));}
const codes=(r:ReturnType<typeof fixture>)=>validateTextParts(r.textParts,r).map(d=>d.code);

test('authored semantic IDs distinguish repeated symbols and preserve native paint coordinates',()=>{
  const r=fixture();assert.deepEqual(validateTextParts(r.textParts,r),[]);
  const left=selectTextParts(r,exact),right=selectTextParts(r,{...exact,ids:['right-x']});
  assert.deepEqual(left.partIds,['left-x']);assert.deepEqual(left.paintPaths,[[0,0]]);
  assert.equal(left.leaves[0].partId,'left-x');assert.deepEqual(left.leaves[0].transform,[2,0,0,2,11,20]);
  assert.deepEqual(right.paintPaths,[[0,1,1]]);assert.deepEqual(right.leaves[0].transform,[0,1,-1,0,14,25]);
  assert.equal(right.leaves[0].item.d,'M6 0 L9 -5');assert.equal(right.items[0].children![0].children![0].d,'M6 0 L9 -5');
  assert.deepEqual(r.metrics,{width:40,height:10,depth:3});
});

test('pruned selection retains nested clip, transform, style and isolated opacity ancestry',()=>{
  const r=fixture(),selected=selectTextParts(r,{...exact,ids:['right-x']});
  assert.deepEqual(selected.leaves[0].ancestors.map(a=>a.paintPath),[[0],[0,1]]);
  assert.deepEqual(selected.items[0].clip,r.items[0].clip);
  assert.deepEqual(selected.items[0].style,{fill:'#123456',opacity:.4});
  assert.deepEqual(selected.items[0].children![0].style,{stroke:'#abcdef',opacity:.7});
  assert.deepEqual(selected.leaves[0].item.style,{fill:'#fedcba'});
  assert.equal(selected.items[0].children!.length,1);assert.equal(selected.items[0].children![0].children!.length,1);
});

test('exact ownership and descendant scope are explicit; overlap requires an explicit policy',()=>{
  const r=fixture(),parent=selectTextParts(r,{...exact,ids:['expression']});assert.deepEqual(parent.items,[]);
  const whole=selectTextParts(r,{...exact,ids:['expression'],scope:'descendants'});
  assert.deepEqual(whole.partIds,['expression','left-x','plus','right-x','phantom']);
  assert.deepEqual(whole.paintPaths,[[0,0],[0,1,0],[0,1,1]]);assert.equal(whole.items[0].children!.length,2);
  rejects(()=>selectTextParts(r,{...exact,ids:['expression','left-x'],scope:'descendants'}),'TEXT_PART_OVERLAP');
  const ancestor=selectTextParts(r,{ids:['left-x','expression'],scope:'descendants',overlap:'ancestor-wins'});
  assert.deepEqual(ancestor.paintPaths,whole.paintPaths);assert.deepEqual(ancestor.requestedIds,['left-x','expression']);
  const direct=selectTextParts(r,{...exact,ids:['expression','left-x']});assert.deepEqual(direct.paintPaths,[[0,0]]);
});

test('phantom and empty selections have no fabricated bounds or paint',()=>{
  const r=fixture(),phantom=selectTextParts(r,{...exact,ids:['phantom']}),empty=selectTextParts(r,{...exact,ids:[]});
  assert.deepEqual(phantom.items,[]);assert.deepEqual(phantom.leaves,[]);assert.equal(phantom.parts[0].logicalBox,undefined);
  assert.deepEqual(empty.partIds,[]);assert.deepEqual(empty.items,[]);
});

test('source ranges use Unicode code points and optional measured boxes are not inferred from ink',()=>{
  const r=fixture();assert.deepEqual(codes(r),[]);r.textParts.parts[4].sourceRange!.end=7;
  assert.ok(codes(r).includes('TEXT_PART_SOURCE_RANGE'));
  const child=fixture();child.textParts.parts[1].sourceRange={start:0,end:7};assert.ok(codes(child).includes('TEXT_PART_SOURCE_RANGE'));
  const nested=fixture();nested.textParts.parts[0].sourceRange!.start=1;assert.ok(codes(nested).includes('TEXT_PART_SOURCE_NESTING'));
  const external=fixture();delete external.sourceTex;
  external.textParts.parts.forEach(p=>{delete p.sourceRange;p.sourceSpan={file:'source.tex',start:{line:1,column:1},end:{line:1,column:2}};});
  assert.deepEqual(codes(external),[]);
  delete external.textParts.parts[0].sourceSpan;assert.ok(codes(external).includes('TEXT_PART_SOURCE'));
  const box=fixture();box.textParts.parts[0].logicalBox=[0,0,-1,1];assert.ok(codes(box).includes('TEXT_PART_LOGICAL_BOX'));
});

test('IDs, ancestry, leaf ownership and addresses are validated strictly',()=>{
  const modifications:((r:ReturnType<typeof fixture>)=>void)[]=[
    r=>{r.textParts.parts[1].id='expression';},r=>{r.textParts.parts[1].id=' x ';},
    r=>{r.textParts.parts[1].parent='missing';},r=>{r.textParts.parts[0].parent='left-x';},
    r=>{r.textParts.parts[1].paintPaths=[[0]];},r=>{r.textParts.parts[1].paintPaths=[[0,0,0]];},
    r=>{r.textParts.parts[1].paintPaths=[[99]];},r=>{r.textParts.parts[1].paintPaths=[[-1]];},
    r=>{r.textParts.parts[1].paintPaths=[[0,1.5]];},r=>{r.textParts.parts[1].paintPaths=[[0,0],[0,0]];},
    r=>{r.textParts.parts[0].paintPaths=[[0,0]];},r=>{(r.textParts.parts[0] as any).glyphIndex=0;},
  ];
  for(const change of modifications){const r=fixture();change(r);assert.ok(codes(r).length>0);}
  const r=fixture();rejects(()=>selectTextParts(r,{...exact,ids:['missing']}),'TEXT_PART_UNKNOWN');
  rejects(()=>selectTextParts(r,{...exact,ids:['left-x','left-x']}),'TEXT_PART_QUERY');
  rejects(()=>selectTextParts(r,{ids:['left-x']} as any),'TEXT_PART_QUERY');
});

test('selections are detached, deeply immutable and remain stable after source mutations',()=>{
  const r=fixture(),before=structuredClone(r),selected=selectTextParts(r,{...exact,ids:['expression'],scope:'descendants'});
  assert.deepEqual(r,before);const expected=structuredClone(selected);
  r.items[0].children![0].d='M900 900';r.items[0].style!.fill='#000';r.textParts.parts[1].id='edited';
  assert.deepEqual(selected,expected);assert.ok(Object.isFrozen(selected.leaves[0].ancestors[0].style));
  assert.throws(()=>{(selected.items[0].children![0] as any).d='changed';},TypeError);
});

test('hostile data, malformed resources and bounded metadata produce diagnostics without executing accessors',()=>{
  const r=fixture();let reads=0;
  const hostile={version:1,get parts(){reads++;return [];}};
  assert.ok(validateTextParts(hostile,r).length);assert.equal(reads,0);
  const hostileResource={...r,get items(){reads++;return [];}};
  rejects(()=>selectTextParts(hostileResource,exact),'NON_JSON_VALUE');assert.equal(reads,0);
  rejects(()=>selectTextParts(null as any,exact),'TEXT_PART_RESOURCE');
  const malformed=fixture();malformed.items[0].children![0].transform=[NaN,0,0,1,0,0];assert.ok(codes(malformed).length);
  const tooMany=fixture();tooMany.textParts.parts=Array.from({length:4097},(_,i)=>({id:`p${i}`,sourceRange:{start:0,end:0},paintPaths:[]}));assert.ok(codes(tooMany).includes('TEXT_PART_LIMIT'));
  const deep=fixture();deep.textParts.parts=Array.from({length:65},(_,i)=>({id:`p${i}`,...(i?{parent:`p${i-1}`} :{}),sourceRange:{start:0,end:0},paintPaths:[]}));assert.ok(codes(deep).includes('TEXT_PART_LIMIT'));
});

test('only selected transform chains are accumulated and nonfinite selected transforms fail explicitly',()=>{
  const r=fixture();r.items[0].transform=[1e308,0,0,1,0,0];r.items[0].children![0].transform=[1e308,0,0,1,0,0];
  rejects(()=>selectTextParts(r,exact),'TEXT_PART_TRANSFORM');assert.deepEqual(selectTextParts(r,{...exact,ids:[]}).items,[]);
});
