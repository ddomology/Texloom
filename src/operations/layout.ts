import {OperationValidationError,type DeepReadonly,type LiteralValue,type Operation,type OperatorDefinition,type SpaceRef} from '../ir/operations.js';
import {matrixBoxLayout,distributeBoxLayout,alignBoxLayout,fitBoxBounds,type BoxList,type BoxLayoutResult} from '../geometry/boxes.js';
import {validateJsonData,validateLiteralValue,validateSpaceRef} from './values.js';
import {sameSpace} from '../geometry/spaces.js';
import type {PathBounds,PathGeometry,PathPoint} from '../path-geometry.js';

const profiles={
  matrixBoxLayout:{columns:1,gapX:20,gapY:20,alignX:1,alignY:0,maxWidth:0,maxHeight:0,overflow:0},
  distributeBoxLayout:{axis:0,gap:20,crossGap:20,align:1,maxWidth:0,maxHeight:0,overflow:0},
  alignBoxLayout:{axis:0,align:1,at:0},fitBoxBounds:{paddingX:0,paddingY:0},boxPlacement:{index:0},
};
type Name=keyof typeof profiles;
const units=new Set(['columns','alignX','alignY','overflow','axis','align','index']);
const unit=(name:string):'1'|'bp'=>units.has(name)?'1':'bp';
const numericInputs=(defaults:Record<string,number>)=>Object.fromEntries(Object.entries(defaults).map(([key,value])=>[key,{
  value:{type:'scalar' as const,unit:unit(key)},default:{type:'scalar' as const,value,unit:unit(key)},
}]));
const boxes={value:{type:'boxes2d' as const,space:'space'},required:true as const};
const positions={value:{type:'points2d' as const,space:'space'},required:true as const};
const origin={value:{type:'vec2' as const,role:'point' as const,space:'space'},required:true as const};
const boundOutputs={path:{type:'path2d' as const,space:'space'},origin:{type:'vec2' as const,role:'point' as const,space:'space'},
  width:{type:'scalar' as const,unit:'bp' as const},height:{type:'scalar' as const,unit:'bp' as const}};
const layoutOutputs={...boundOutputs,positions:{type:'points2d' as const,space:'space'},rows:{type:'scalar' as const,unit:'1' as const},columns:{type:'scalar' as const,unit:'1' as const}};
export const layoutOperatorDefinitions:OperatorDefinition[]=[
  {name:'matrixBoxLayout',version:1,spaces:['space'],pure:true,deterministic:true,inputs:{boxes,origin,...numericInputs(profiles.matrixBoxLayout)},outputs:layoutOutputs},
  {name:'distributeBoxLayout',version:1,spaces:['space'],pure:true,deterministic:true,inputs:{boxes,origin,...numericInputs(profiles.distributeBoxLayout)},outputs:layoutOutputs},
  {name:'alignBoxLayout',version:1,spaces:['space'],pure:true,deterministic:true,inputs:{boxes,positions,...numericInputs(profiles.alignBoxLayout)},outputs:layoutOutputs},
  {name:'fitBoxBounds',version:1,spaces:['space'],pure:true,deterministic:true,inputs:{boxes,positions,...numericInputs(profiles.fitBoxBounds)},outputs:boundOutputs},
  {name:'boxPlacement',version:1,spaces:['space','node','parent'],pure:true,deterministic:true,
    inputs:{positions,...numericInputs(profiles.boxPlacement),mapping:{value:{type:'transform2d',from:'space',to:'parent'},required:true}},
    outputs:{transform:{type:'transform2d',from:'node',to:'parent'},x:{type:'scalar',unit:'bp'},y:{type:'scalar',unit:'bp'}}},
];
export const isLayoutOperator=(name:string,version:number)=>version===1&&Object.hasOwn(profiles,name);

/** Pure typed facade. Measurement and dependencies belong to the boxes input. */
export function executeLayoutOperation(op:DeepReadonly<Operation>,values:Readonly<Record<string,LiteralValue>>):Record<string,LiteralValue>|undefined {
  if(!isLayoutOperator(op.operator,op.version))return;
  function fail(code:string,message:string,suffix=''):never {throw new OperationValidationError([{severity:'error',code,
    message:`${op.operator}@1 (${op.id}): ${message}`,path:`$.operations[${JSON.stringify(op.id)}]${suffix}`,
    ...(op.sourceSpan?{sourceSpan:structuredClone(op.sourceSpan)}:{})}]);}
  try{
    const errors=validateJsonData(values,'$.inputs');if(errors.length)fail(errors[0].code,errors[0].message,'.inputs');
    if(!values||typeof values!=='object'||Array.isArray(values))fail('LAYOUT_INPUT','Expected an input record.');
    const name=op.operator as Name,defaults=profiles[name];
    const allowed=[...Object.keys(defaults),...(name==='boxPlacement'?['positions','mapping']:name==='alignBoxLayout'||name==='fitBoxBounds'?['boxes','positions']:['boxes','origin'])];
    for(const key of Object.keys(values))if(!allowed.includes(key))fail('UNKNOWN_PROPERTY',`Unknown input ${key}.`,'.inputs.'+key);
    const space=(key:string):SpaceRef=>{const value=op.spaces?.[key];if(validateSpaceRef(value).length)fail('OPERATION_RUNTIME_SPACE',`Expected ${key} space.`,'.spaces.'+key);return structuredClone(value!) as SpaceRef;};
    const chart=space('space');
    const input=(key:string):LiteralValue=>{const value=values[key],ds=validateLiteralValue(value);if(ds.length)fail(ds[0].code,ds[0].message,'.inputs.'+key);return value;};
    const numbers:Record<string,number>={};
    for(const [key,fallback] of Object.entries(defaults)){
      if(!Object.hasOwn(values,key)){numbers[key]=fallback;continue;}
      const value=input(key);if(value.type!=='scalar')fail('LAYOUT_INPUT',`${key} requires a scalar.`,'.inputs.'+key);
      if((value.unit??'1')!==unit(key))fail('OPERATION_RUNTIME_UNIT',`${key} requires ${unit(key)}.`,'.inputs.'+key);numbers[key]=value.value;
    }
    const select=<const T extends string>(key:string,choices:readonly T[]):T=>{const value=numbers[key];if(!Number.isInteger(value)||value<0||value>=choices.length)fail('LAYOUT_ENUM',`${key} must be an integer in [0,${choices.length-1}].`,'.inputs.'+key);return choices[value];};
    const points=():PathPoint[]=>{const value=input('positions');if(value.type!=='points2d')fail('LAYOUT_INPUT','positions requires points2d.','.inputs.positions');
      if(!sameSpace(value.space,chart))fail('OPERATION_RUNTIME_SPACE','positions must use declared space.','.inputs.positions');return value.value;};
    const scalar=(value:number,u:'1'|'bp'):LiteralValue=>({type:'scalar',value,unit:u});
    if(name==='boxPlacement'){
      const locations=points(),index=numbers.index,parent=space('parent'),node=space('node'),mapping=input('mapping');
      if(!Number.isSafeInteger(index)||index<0||index>=locations.length)fail('LAYOUT_INDEX','index must select an existing placement.','.inputs.index');
      if(mapping.type!=='transform2d')fail('LAYOUT_INPUT','mapping requires an affine transform.','.inputs.mapping');
      if(!sameSpace(mapping.from,chart)||!sameSpace(mapping.to,parent))fail('OPERATION_RUNTIME_SPACE','mapping must map layout space to parent space.','.inputs.mapping');
      const [a,b,c,d,e,f]=mapping.value,[x,y]=locations[index],matrix:[number,number,number,number,number,number]=[a,b,c,d,a*x+c*y+e,b*x+d*y+f];
      if(!matrix.every(Number.isFinite))fail('LAYOUT_NONFINITE','Placement transform is not finite.');
      return {transform:{type:'transform2d',from:node,to:parent,value:matrix},x:scalar(0,'bp'),y:scalar(0,'bp')};
    }
    const boxInput=input('boxes');if(boxInput.type!=='boxes2d')fail('LAYOUT_INPUT','boxes requires boxes2d.','.inputs.boxes');
    if(!sameSpace(boxInput.space,chart))fail('OPERATION_RUNTIME_SPACE','boxes must use declared space.','.inputs.boxes');
    const measured=boxInput.value as BoxList;
    const boundsOutput=(bounds:DeepReadonly<PathBounds>):Record<string,LiteralValue>=>{
      const [x,y,w,h]=bounds;const geometry:PathGeometry={contours:[{id:'layout-bounds',start:[x,y],closed:true,
        segments:[{id:'top',kind:'line',to:[x+w,y]},{id:'right',kind:'line',to:[x+w,y+h]},{id:'bottom',kind:'line',to:[x,y+h]}]}]};
      if(![x,y,w,h,x+w,y+h].every(Number.isFinite))fail('LAYOUT_NONFINITE','Layout bounds are not finite.');
      return {path:{type:'path2d',space:structuredClone(chart),value:geometry},origin:{type:'vec2',role:'point',space:structuredClone(chart),value:[x,y]},width:scalar(w,'bp'),height:scalar(h,'bp')};
    };
    if(name==='fitBoxBounds')return boundsOutput(fitBoxBounds(measured,points(),numbers));
    let result:DeepReadonly<BoxLayoutResult>;
    if(name==='alignBoxLayout')result=alignBoxLayout(measured,points(),{at:numbers.at,axis:select('axis',['x','y']),align:select('align',['start','center','end','baseline'])});
    else {
      const value=input('origin');if(value.type!=='vec2'||value.role!=='point')fail('LAYOUT_INPUT','origin requires a point.','.inputs.origin');
      if(!sameSpace(value.space,chart))fail('OPERATION_RUNTIME_SPACE','origin must use declared space.','.inputs.origin');
      if(name==='matrixBoxLayout')result=matrixBoxLayout(measured,{origin:value.value,columns:numbers.columns,gapX:numbers.gapX,gapY:numbers.gapY,
        alignX:select('alignX',['start','center','end']),alignY:select('alignY',['baseline','start','center','end']),
        maxWidth:numbers.maxWidth,maxHeight:numbers.maxHeight,overflow:select('overflow',['allow','error'])});
      else result=distributeBoxLayout(measured,{origin:value.value,axis:select('axis',['x','y']),gap:numbers.gap,crossGap:numbers.crossGap,
        align:select('align',['start','center','end','baseline']),maxWidth:numbers.maxWidth,maxHeight:numbers.maxHeight,
        overflow:select('overflow',['allow','error','wrap'])});
    }
    return {...boundsOutput(result.bounds),positions:{type:'points2d',space:chart,value:structuredClone(result.positions) as PathPoint[]},rows:scalar(result.rows,'1'),columns:scalar(result.columns,'1')};
  }catch(error){if(error instanceof OperationValidationError)throw error;fail((error as {code?:string})?.code??'LAYOUT_DOMAIN',error instanceof Error?error.message:String(error));}
}
