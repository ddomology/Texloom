import {OperationValidationError,type DeepReadonly,type Diagnostic,type LiteralValue,type Operation,type OperatorDefinition,type SpaceRef} from '../ir/operations.js';

const pointSocket={type:'vec2',role:'point',space:'space'} as const;
const pointInput=()=>({value:{...pointSocket},required:true as const});
const definition=(name:string,inputs:OperatorDefinition['inputs'],project=false):OperatorDefinition=>({name,version:1,spaces:['space'],pure:true,deterministic:true,
  inputs,outputs:{position:{...pointSocket},...(project?{parameter:{type:'scalar' as const,unit:'1' as const}}:{})}});
/** Closed arithmetic vocabulary; these declarations contain no executable code. */
export const coordinateOperatorDefinitions:OperatorDefinition[]=[
  definition('midpoint',{a:pointInput(),b:pointInput()}),
  definition('lerpPoint',{a:pointInput(),b:pointInput(),factor:{value:{type:'scalar',unit:'1'},default:{type:'scalar',unit:'1',value:.5}}}),
  definition('pointTowards',{a:pointInput(),b:pointInput(),distance:{value:{type:'scalar',unit:'bp'},required:true}}),
  definition('rotatePoint',{point:pointInput(),center:pointInput(),angle:{value:{type:'scalar',unit:'rad'},required:true}}),
  definition('projectLine',{point:pointInput(),a:pointInput(),b:pointInput()},true),
  definition('projectSegment',{point:pointInput(),a:pointInput(),b:pointInput()},true),
];
const names=new Set(coordinateOperatorDefinitions.map(definition=>definition.name));
/** Runtime implementation support is independent of caller-owned metadata. */
export function isCoordinateOperator(name:string,version:number):boolean {return version===1&&names.has(name);}
type Inputs=Readonly<Record<string,LiteralValue>>;
type Authored=DeepReadonly<Operation>;
function fail(operation:Authored,code:string,message:string,suffix=''):never {
  const diagnostic:Diagnostic={severity:'error',code,message:`${operation.operator}@${operation.version} (${operation.id}): ${message}`,
    path:`$.operations[${JSON.stringify(operation.id)}]${suffix}`,...(operation.sourceSpan?{sourceSpan:structuredClone(operation.sourceSpan)}:{})};
  throw new OperationValidationError([diagnostic]);
}
const validSpace=(space:DeepReadonly<SpaceRef>|undefined):space is DeepReadonly<SpaceRef>=>space?.kind==='scene'||
  !!space&&['local','parent','plot'].includes(space.kind)&&'node'in space&&typeof space.node==='string'&&space.node.trim().length>0;
// Keep metadata imports independent of geometry -> schema -> registry; the
// registry must also initialize when consumers import this module directly.
const equalSpace=(a:DeepReadonly<SpaceRef>,b:DeepReadonly<SpaceRef>)=>a.kind===b.kind&&(a.kind==='scene'||b.kind!=='scene'&&a.node===b.node);
function point(operation:Authored,inputs:Inputs,name:string,space:DeepReadonly<SpaceRef>):[number,number] {
  const literal=Object.hasOwn(inputs,name)?inputs[name]:undefined;
  if(literal?.type!=='vec2'||literal.role!=='point')fail(operation,'OPERATION_RUNTIME_TYPE',`Input ${name} requires a point.`,`.inputs.${name}`);
  if(!Array.isArray(literal.value)||literal.value.length!==2||!literal.value.every(value=>typeof value==='number'&&Number.isFinite(value)))
    fail(operation,'OPERATION_DOMAIN',`Input ${name} requires two finite coordinates.`,`.inputs.${name}`);
  if(!validSpace(literal.space)||!equalSpace(literal.space,space))fail(operation,'OPERATION_RUNTIME_SPACE',`Input ${name} space differs from the declared space.`,`.inputs.${name}.space`);
  return [...literal.value];
}
function scalar(operation:Authored,inputs:Inputs,name:string,unit:'1'|'bp'|'rad'):number {
  const literal=Object.hasOwn(inputs,name)?inputs[name]:undefined;
  if(literal?.type!=='scalar')fail(operation,'OPERATION_RUNTIME_TYPE',`Input ${name} requires a scalar.`,`.inputs.${name}`);
  if(typeof literal.value!=='number'||!Number.isFinite(literal.value))fail(operation,'OPERATION_DOMAIN',`Input ${name} must be finite.`,`.inputs.${name}`);
  if((literal.unit??'1')!==unit)fail(operation,'OPERATION_RUNTIME_UNIT',`Input ${name} requires ${unit} units.`,`.inputs.${name}.unit`);
  return literal.value;
}
/** Convex interpolation avoids a+b and b-a overflow for finite endpoints. */
function interpolate(a:readonly [number,number],b:readonly [number,number],t:number):[number,number] {
  if(t===0)return [...a];if(t===1)return [...b];
  return [0,1].map(axis=>{
    if(a[axis]===b[axis])return a[axis];
    const delta=b[axis]-a[axis];
    return Number.isFinite(delta)?a[axis]+t*delta:(1-t)*a[axis]+t*b[axis];
  }) as [number,number];
}
/** Normalize after scaling, including finite endpoints whose difference overflows. */
function direction(operation:Authored,a:[number,number],b:[number,number]):{x:number;y:number;dx:number;dy:number;scale:number;norm:number} {
  if(a[0]===b[0]&&a[1]===b[1])fail(operation,'COORDINATE_DEGENERATE','The two reference points must differ.','.inputs.b');
  let dx=b[0]-a[0],dy=b[1]-a[1],scale=1;
  if(!Number.isFinite(dx)||!Number.isFinite(dy)) {scale=Math.max(...a.map(Math.abs),...b.map(Math.abs));dx=b[0]/scale-a[0]/scale;dy=b[1]/scale-a[1]/scale;}
  else {scale=Math.max(Math.abs(dx),Math.abs(dy));dx/=scale;dy/=scale;}
  const length=Math.hypot(dx,dy);
  if(!Number.isFinite(length)||length===0||!Number.isFinite(scale))fail(operation,'OPERATION_DOMAIN','Reference direction cannot be represented finitely.');
  return {x:dx/length,y:dy/length,dx,dy,scale,norm:length};
}
function projection(operation:Authored,p:[number,number],a:[number,number],b:[number,number]):number {
  const d=direction(operation,a,b);
  // Dot with a unit direction avoids overflow from squaring the baseline.
  // A zero component contributes exactly zero even for huge perpendicular gaps.
  const term=(axis:0|1,unit:number)=>{
    if(unit===0)return 0;
    const gap=p[axis]-a[axis];
    if(Number.isFinite(gap)) {
      const ratio=gap/d.scale/d.norm;
      return (Number.isFinite(ratio)?ratio:gap/d.norm/d.scale)*unit;
    }
    const value=p[axis]/d.scale,origin=a[axis]/d.scale,scaledGap=value-origin;
    return (Number.isFinite(scaledGap)?scaledGap/d.norm:value/d.norm-origin/d.norm)*unit;
  };
  const t=term(0,d.x)+term(1,d.y);
  if(!Number.isFinite(t))fail(operation,'OPERATION_NONFINITE_OUTPUT','Projection parameter is nonfinite.','.outputs.parameter');
  return t;
}
/** Unknown names/versions return undefined for the caller's closed dispatcher. */
export function executeCoordinateOperation(operation:Authored,inputs:Inputs):Record<string,LiteralValue>|undefined {
  if(!isCoordinateOperator(operation.operator,operation.version))return;
  const space=Object.hasOwn(operation.spaces,'space')?operation.spaces.space:undefined;
  if(!validSpace(space))fail(operation,'OPERATION_RUNTIME_SPACE','Missing valid space binding.','.spaces.space');
  let position:[number,number],parameter:number|undefined;
  if(operation.operator==='rotatePoint') {
    const p=point(operation,inputs,'point',space),center=point(operation,inputs,'center',space),angle=scalar(operation,inputs,'angle','rad');
    const cosine=Math.cos(angle),sine=Math.sin(angle),x=p[0]-center[0],y=p[1]-center[1];
    position=angle===0||p[0]===center[0]&&p[1]===center[1]?[...p]:[center[0]+cosine*x-sine*y,center[1]+sine*x+cosine*y];
  } else {
    const a=point(operation,inputs,'a',space),b=point(operation,inputs,'b',space);
    if(operation.operator==='midpoint')position=interpolate(a,b,.5);
    else if(operation.operator==='lerpPoint')position=interpolate(a,b,scalar(operation,inputs,'factor','1'));
    else if(operation.operator==='pointTowards') {
      const distance=scalar(operation,inputs,'distance','bp'),d=direction(operation,a,b);
      position=[a[0]+distance*d.x,a[1]+distance*d.y];
    } else {
      const p=point(operation,inputs,'point',space),t=projection(operation,p,a,b);
      parameter=operation.operator==='projectSegment'?Math.max(0,Math.min(1,t)):t;position=interpolate(a,b,parameter);
    }
  }
  if(!position.every(Number.isFinite))fail(operation,'OPERATION_NONFINITE_OUTPUT','Output position contains nonfinite coordinates.','.outputs.position');
  return {position:{type:'vec2',role:'point',space:structuredClone(space),value:position},
    ...(parameter===undefined?{}:{parameter:{type:'scalar',unit:'1',value:parameter}})};
}
