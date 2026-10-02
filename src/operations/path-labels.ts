import {OperationValidationError,type DeepReadonly,type LiteralValue,type Operation,type OperatorDefinition,type SpaceRef} from '../ir/operations.js';
import {sampleCurveGeometry} from '../geometry/curves.js';
import {validateJsonData,validateLiteralValue,validateSpaceRef} from './values.js';

const scalar=(unit:'1'|'bp',value:number):OperatorDefinition['inputs'][string]=>({
  value:{type:'scalar',unit},default:{type:'scalar',unit,value},
});
export const pathLabelOperatorDefinitions:OperatorDefinition[]=[{
  name:'placePathLabel',version:1,spaces:['space','label'],pure:true,deterministic:true,
  inputs:{path:{value:{type:'path2d',space:'space'},required:true},anchor:{value:{type:'vec2',role:'point',space:'label'},required:true},
    parameter:scalar('1',.5),mode:scalar('1',1),offset:scalar('bp',0),rotation:scalar('1',0),
    contour:scalar('1',-1),tolerance:scalar('bp',.05),scaleX:scalar('1',1),scaleY:scalar('1',1)},
  outputs:{transform:{type:'transform2d',from:'label',to:'space'},x:{type:'scalar',unit:'bp'},y:{type:'scalar',unit:'bp'},
    position:{type:'vec2',role:'point',space:'space'},angle:{type:'scalar',unit:'rad'},
    distance:{type:'scalar',unit:'bp'},totalLength:{type:'scalar',unit:'bp'}},
}];
export const isPathLabelOperator=(name:string,version:number):boolean=>name==='placePathLabel'&&version===1;
type Authored=DeepReadonly<Operation>;
type Inputs=Readonly<Record<string,LiteralValue>>;
function fail(op:Authored,code:string,message:string,suffix=''):never {
  throw new OperationValidationError([{severity:'error',code,message:`${op.operator}@${op.version} (${op.id}): ${message}`,
    path:`$.operations[${JSON.stringify(op.id)}]${suffix}`,...(op.sourceSpan?{sourceSpan:structuredClone(op.sourceSpan)}:{})}]);
}
const sameSpace=(a:SpaceRef,b:DeepReadonly<SpaceRef>):boolean=>a.kind===b.kind&&(a.kind==='scene'||b.kind!=='scene'&&a.node===b.node);
function space(op:Authored,name:string):SpaceRef {
  const value=op.spaces&&Object.hasOwn(op.spaces,name)?op.spaces[name]:undefined;
  if(validateSpaceRef(value).length)fail(op,'OPERATION_RUNTIME_SPACE',`Missing valid ${name} space.`,`.spaces.${name}`);
  return structuredClone(value!);
}
function literal(op:Authored,inputs:Inputs,name:string):LiteralValue {
  const value=Object.hasOwn(inputs,name)?inputs[name]:undefined;
  if(!value)fail(op,'OPERATION_RUNTIME_TYPE',`Missing input ${name}.`,`.inputs.${name}`);
  const errors=validateLiteralValue(value,`$.inputs.${name}`);
  if(errors.length)fail(op,errors[0].code,errors[0].message,errors[0].path?.replace(/^\$/,'')??`.inputs.${name}`);
  return value;
}
function number(op:Authored,inputs:Inputs,name:string,unit:'1'|'bp',fallback:number):number {
  if(!Object.hasOwn(inputs,name))return fallback;
  const value=literal(op,inputs,name);
  if(value.type!=='scalar')fail(op,'OPERATION_RUNTIME_TYPE',`Input ${name} requires a scalar.`,`.inputs.${name}`);
  if((value.unit??'1')!==unit)fail(op,'OPERATION_RUNTIME_UNIT',`Input ${name} requires ${unit} units.`,`.inputs.${name}.unit`);
  return value.value;
}

/** Place a resource-local anchor in the path's chart; no node/resource lookup occurs here. */
export function executePathLabelOperation(op:Authored,inputs:Inputs):Record<string,LiteralValue>|undefined {
  if(!isPathLabelOperator(op.operator,op.version))return;
  try {
    const errors=validateJsonData(inputs,'$.inputs');
    if(errors.length)fail(op,errors[0].code,errors[0].message,errors[0].path?.replace(/^\$/,'')??'.inputs');
    if(inputs===null||typeof inputs!=='object'||Array.isArray(inputs))fail(op,'OPERATION_RUNTIME_TYPE','Expected an input record.','.inputs');
    const allowed=['path','anchor','parameter','mode','offset','rotation','contour','tolerance','scaleX','scaleY'];
    for(const key of Object.keys(inputs))if(!allowed.includes(key))fail(op,'UNKNOWN_PROPERTY',`Unknown path-label input ${key}.`,`.inputs.${key}`);
    const chart=space(op,'space'),label=space(op,'label'),path=literal(op,inputs,'path'),anchor=literal(op,inputs,'anchor');
    if(path.type!=='path2d')fail(op,'OPERATION_RUNTIME_TYPE','Input path requires an editable path.','.inputs.path');
    if(!sameSpace(path.space,chart))fail(op,'OPERATION_RUNTIME_SPACE','Path must use the declared path space.','.inputs.path.space');
    if(anchor.type!=='vec2'||anchor.role!=='point')fail(op,'OPERATION_RUNTIME_TYPE','Input anchor requires a point.','.inputs.anchor');
    if(!sameSpace(anchor.space,label))fail(op,'OPERATION_RUNTIME_SPACE','Anchor must use the declared label space.','.inputs.anchor.space');
    const parameter=number(op,inputs,'parameter','1',.5),mode=number(op,inputs,'mode','1',1),offset=number(op,inputs,'offset','bp',0);
    const rotation=number(op,inputs,'rotation','1',0),contour=number(op,inputs,'contour','1',-1),tolerance=number(op,inputs,'tolerance','bp',.05);
    const sx=number(op,inputs,'scaleX','1',1),sy=number(op,inputs,'scaleY','1',1);
    if(parameter<0||parameter>1)fail(op,'PATH_LABEL_PARAMETER','Parameter must be in [0,1].','.inputs.parameter');
    if(mode!==0&&mode!==1)fail(op,'PATH_LABEL_MODE','Mode must be 0 (parameter) or 1 (length fraction).','.inputs.mode');
    if(rotation!==0&&rotation!==1&&rotation!==2)fail(op,'PATH_LABEL_ROTATION','Rotation must be 0 (horizontal), 1 (tangent), or 2 (upright).','.inputs.rotation');
    if(!Number.isSafeInteger(contour)||contour< -1||contour>=path.value.contours.length&&contour!==-1)
      fail(op,'PATH_LABEL_CONTOUR','Contour must be -1 (whole path) or an existing contour index.','.inputs.contour');
    if(tolerance<=0)fail(op,'PATH_LABEL_TOLERANCE','Tolerance must be positive.','.inputs.tolerance');
    if(sx===0||sy===0)fail(op,'PATH_LABEL_SCALE','Label scale must be nonzero.',sx===0?'.inputs.scaleX':'.inputs.scaleY');
    const sample=sampleCurveGeometry(path.value,parameter,{mode:mode===0?'parameter':'length',tolerance,
      scope:contour===-1?{kind:'whole'}:{kind:'contour',contourId:path.value.contours[contour].id}},path.provenance);
    const magnitude=Math.hypot(...sample.tangent);
    if(!Number.isFinite(magnitude)||magnitude===0)fail(op,'PATH_LABEL_TANGENT','A finite nonzero path tangent is required.','.inputs.path');
    const tx=sample.tangent[0]/magnitude,ty=sample.tangent[1]/magnitude;
    const position:[number,number]=[sample.position[0]-offset*ty,sample.position[1]+offset*tx];
    let angle=0;
    if(rotation!==0){
      angle=Math.atan2(ty,tx);
      if(rotation===2){if(angle>=Math.PI/2)angle-=Math.PI;else if(angle< -Math.PI/2)angle+=Math.PI;}
      if(sx<0)angle-=Math.PI;
    }
    const cosine=Math.cos(angle),sine=Math.sin(angle),a=cosine*sx,b=sine*sx,c=-sine*sy,d=cosine*sy;
    const matrix:[number,number,number,number,number,number]=[a,b,c,d,
      position[0]-a*anchor.value[0]-c*anchor.value[1],position[1]-b*anchor.value[0]-d*anchor.value[1]];
    if([...position,...matrix,angle,sample.length,sample.totalLength].some(v=>!Number.isFinite(v)))
      fail(op,'OPERATION_NONFINITE_OUTPUT','Path-label placement produces a nonfinite output.','.outputs');
    return {transform:{type:'transform2d',from:label,to:chart,value:matrix},x:{type:'scalar',unit:'bp',value:0},y:{type:'scalar',unit:'bp',value:0},
      position:{type:'vec2',role:'point',space:structuredClone(chart),value:position},angle:{type:'scalar',unit:'rad',value:angle},
      distance:{type:'scalar',unit:'bp',value:sample.length},totalLength:{type:'scalar',unit:'bp',value:sample.totalLength}};
  }catch(error){
    if(error instanceof OperationValidationError)throw error;
    fail(op,(error as {code?:string})?.code??'PATH_LABEL_DOMAIN',error instanceof Error?error.message:String(error));
  }
}
