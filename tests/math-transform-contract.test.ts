import test from 'node:test';
import assert from 'node:assert/strict';
import {lowerTimeline} from '../src/timeline/compile.js';
import {createEvaluator} from '../src/evaluate.js';
import {validateMathTransformProgram} from '../src/timeline/math-transform.js';
import {validateBundle,type Bundle,type TexNode,type Node,type VectorResource} from '../src/schema.js';

function fixture(opacity=1):Bundle {
  return {version:'0.3',title:'Math transform native contract',duration:2,units:'bp',viewport:{width:50,height:50},camera:{x:0,y:0,zoom:1},tracks:[],relations:[],
    nodes:[{id:'source',kind:'tex',resourceId:'formula',x:0,y:0,visible:false,style:{fill:'#fff',opacity}},
      {id:'destination',kind:'tex',resourceId:'formula',x:0,y:0,visible:false,style:{fill:'#fff',opacity}}],
    resources:{formula:{kind:'vector',metrics:{width:10,height:10,depth:0},inkBounds:[0,0,10,10],sourceTex:'x',
      items:[{kind:'path',d:'M0 0 H10 V10 H0 Z',style:{fill:'#fff'}}],
      textParts:{version:1,parts:[{id:'x',sourceRange:{start:0,end:1},paintPaths:[[0]]}]}}}};
}
function lower(bundle=fixture(),keep=false):Bundle {
  return lowerTimeline({version:1,root:{kind:'math-transform',id:'change',source:'source',destination:'destination',duration:2,
    correspondence:{approved:true,retention:keep?'keep-source':'replace',unmatched:'error',labels:{source:'x',target:'another x'},
      pairs:[{source:'x',target:'x',mode:keep?'copy':'replace',sourceAnchor:[0,0],targetAnchor:[0,0]}]}}},bundle);
}

test('keep-source endpoint retains independently composited native endpoint opacity when formulas overlap',()=>{
  const frame=createEvaluator(lower(fixture(.5),true))(2),nodes=new Map(frame.nodes.map(node=>[node.id,node]));
  // Every visible paint here is the same opaque square at (0,0). Compute its
  // interior alpha from the ordinary scene hierarchy, independently of reports.
  const alpha=(node:Node):number=>{
    if(node.visible===false)return 0;
    let paint=0;
    if(node.kind==='group')for(const child of frame.nodes.filter(child=>child.parent===node.id))paint=1-(1-paint)*(1-alpha(child));
    else if(node.kind==='tex')paint=(frame.resources[node.resourceId] as VectorResource).items.length?1:0;
    return paint*(node.style?.opacity??1);
  };
  assert.equal(alpha(nodes.get('change')!),1-(1-.5)*(1-.5),'Two retained native .5-opacity formulas must composite to .75 where they overlap');
});

test('generated instance paint overrides cannot bypass exact native endpoint validation',()=>{
  const bundle=lower(),instance=bundle.nodes.find(node=>node.id==='change')!;
  instance.style={...instance.style,fillOpacity:0};
  assert.ok(validateBundle(bundle).some(d=>d.severity==='error'),'A static helper container override would erase the accepted native endpoint');
});

test('finite opposite-sign endpoint placement interpolates without overflowing its representable midpoint',()=>{
  const input=fixture();(input.nodes[0] as TexNode).x=-1e308;(input.nodes[1] as TexNode).x=1e308;
  const frame=createEvaluator(lower(input))(1),moving=frame.nodes.find(node=>node.id==='change:pair:0:source') as TexNode;
  assert.equal(moving.x,0);assert.ok(Number.isFinite(moving.y));
});

test('standalone math validation returns a context diagnostic for a null bundle',()=>{
  const diagnostics=validateMathTransformProgram({version:1,operations:[]},null as any);
  assert.ok(diagnostics.some(d=>d.code==='MATH_TRANSFORM_CONTEXT'&&d.severity==='error'));
});

test('dynamic helper transforms and instance paint overrides cannot bypass reserved native paint ownership',()=>{
  const translated=lower();translated.tracks.push({target:'change:pair:0:source',property:'transform.translate',keys:[[0,[0,0]],[2,[10,0]]]});
  const repainted=lower();repainted.expressions={version:1,parameters:{},bindings:[{target:'change',property:'style.fillOpacity',expression:'0'}]};
  for(const invalid of [translated,repainted])assert.throws(()=>createEvaluator(invalid),
    (error:any)=>error.diagnostics?.some((d:any)=>d.code==='OPERATION_WRITER_CONFLICT'));
});
