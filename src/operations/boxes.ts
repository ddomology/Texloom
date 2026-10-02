import type {Bundle,Node} from '../schema.js';
import {OperationValidationError,type DeepReadonly,type InputRef,type LiteralValue} from '../ir/operations.js';
import {assertBoxList,type LayoutBox} from '../geometry/boxes.js';
import type {PropertyAccess} from './properties.js';

type BoxesInput=DeepReadonly<Extract<InputRef,{kind:'boxes'}>>;
function fail(code:string,message:string):never {
  throw new OperationValidationError([{severity:'error',code,message}]);
}

/** Intrinsic logical content in bp, independent of the authored node pose.
 * PGF metadata is authoritative: moving captured child artwork independently
 * does not remeasure it. Regenerate the capture when its content changes. */
export function measureNodeBox(node:Node|undefined,resources:Bundle['resources']):LayoutBox {
  let box:LayoutBox;
  if(node?.kind==='tex') {
    const resource=resources[node.resourceId],scale=node.scale??1;
    if(resource?.kind!=='vector')fail('BOX_RESOURCE','A measured TeX node requires a vector resource.');
    if(!Number.isFinite(scale)||scale<=0)fail('BOX_SCALE','Measured TeX scale must be positive and finite.');
    const {width,height,depth}=resource.metrics;
    if(![width,height,depth].every(value=>Number.isFinite(value)&&value>=0))
      fail('BOX_METRICS','TeX width, height and depth must be finite nonnegative logical metrics.');
    box={bounds:[0,-height*scale,width*scale,(height+depth)*scale],baseline:0};
  }else if(node?.kind==='group') {
    const metrics=node.anchorMetrics,base=node.anchors?.base;
    if(!metrics||metrics.kind!=='pgf'||!base||base.length!==2||!base.every(Number.isFinite))
      fail('BOX_METRICS','A measured group requires PGF logical text metrics and its measured base anchor.');
    box={bounds:[...metrics.logicalTextBox],baseline:base[1]};
  }else fail('BOX_NODE','Box measurement supports TeX nodes and groups with PGF logical text metrics.');
  try {assertBoxList([box]);}catch(error) {fail('BOX_METRICS',error instanceof Error?error.message:String(error));}
  return box;
}

/** Pose writes never become metric reads; live TeX scale writers do. */
export function boxInputReads(input:BoxesInput,nodes:ReadonlyMap<string,Node>):PropertyAccess[] {
  return input.nodes.flatMap(id=>id===null?[]:nodes.get(id)?.kind==='tex'
    ?[{node:id,property:'scale'}]:[{node:id,property:'anchors'},{node:id,property:'anchorMetrics'}]);
}

export function resolveBoxesInput(input:BoxesInput,nodes:ReadonlyMap<string,Node>,resources:Bundle['resources']):LiteralValue {
  return {type:'boxes2d',space:structuredClone(input.space),
    value:input.nodes.map(id=>id===null?null:measureNodeBox(nodes.get(id),resources))};
}
