import {OperationValidationError, type DeepReadonly, type SourceSpan} from '../ir/operations.js';
import {freezeSnapshot, validateJsonData} from '../operations/values.js';
import {compileExpression, evaluateExpression} from '../fields/scalar.js';
import type {CompiledExpression, ExpressionNode, ExpressionType, ExpressionValue, ParameterDefinition} from '../fields/ast.js';

type Ast = DeepReadonly<ExpressionNode>;
export interface CompiledDeformation extends CompiledExpression {
  readonly parameterDefinitions: Readonly<Record<string, DeepReadonly<ParameterDefinition>>>;
}
export interface DeformationLocals {position:readonly [number,number];parameter:number;index?:number;count?:number}
export function deformationError(compiled:CompiledExpression,code:string,message:string,node:Ast=compiled.ast):never {
  throw new OperationValidationError([{severity:'error',code,message,path:'$.deformation.expression',sourceSpan:structuredClone(node.location.sourceSpan)}]);
}
const own=(value:object,key:string)=>Object.prototype.hasOwnProperty.call(value,key);
const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value);
const variables:Record<string,ExpressionType>={position:{kind:'vec2',dimension:{length:1,time:0,angle:0}},
  parameter:{kind:'scalar',dimension:{length:0,time:0,angle:0}},index:{kind:'scalar',dimension:{length:0,time:0,angle:0}},count:{kind:'scalar',dimension:{length:0,time:0,angle:0}}};
function matches(value:unknown,definition:DeepReadonly<ParameterDefinition>):boolean {
  return definition.type==='boolean'?typeof value==='boolean':definition.type==='vec2'
    ?Array.isArray(value)&&value.length===2&&value.every(finite)
    :finite(value)&&(definition.min===undefined||value>=definition.min)&&(definition.max===undefined||value<=definition.max);
}
export function compileDeformation(text:string,parameterDefinitions:Readonly<Record<string,ParameterDefinition>>={},sourceSpan?:SourceSpan):CompiledDeformation {
  const errors=validateJsonData(parameterDefinitions,'$.deformation.parameters');
  if(errors.length)throw new OperationValidationError(errors);
  if(!parameterDefinitions||typeof parameterDefinitions!=='object'||Array.isArray(parameterDefinitions))throw new OperationValidationError([
    {severity:'error',code:'DEFORMATION_PARAMETERS',message:'Expected parameter declarations.',path:'$.deformation.parameters'}]);
  const compiled=compileExpression(text,parameterDefinitions,sourceSpan,variables);
  for(const [name,definition] of Object.entries(parameterDefinitions)) {
    if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)||['pi','time','true','false','sin','cos','vec2','dot','length','normalize','mask','if'].includes(name)||
      !definition||typeof definition!=='object'||!['scalar','vec2','boolean'].includes(definition.type)||
      Object.keys(definition).some(key=>!['type','unit','default','min','max'].includes(key))||
      definition.unit!==undefined&&(!['1','bp','s','rad'].includes(definition.unit)||definition.type==='boolean')||
      (definition.min!==undefined||definition.max!==undefined)&&(definition.type!=='scalar'||definition.min!==undefined&&!finite(definition.min)||definition.max!==undefined&&!finite(definition.max))||
      definition.min!==undefined&&definition.max!==undefined&&definition.min>definition.max||!matches(definition.default,definition))
      deformationError(compiled,'DEFORMATION_PARAMETERS',`Invalid parameter declaration ${name}.`);
  }
  const type=compiled.type;
  if(type.kind!=='vec2'||type.dimension.length!==1||type.dimension.time!==0||type.dimension.angle!==0)
    deformationError(compiled,'DEFORMATION_TYPE','Deformation must return a vec2 position in bp.');
  return freezeSnapshot({...compiled,parameterDefinitions});
}
export function deformationParameters(compiled:CompiledDeformation,overrides:Readonly<Record<string,ExpressionValue>>={}):Record<string,ExpressionValue> {
  const errors=validateJsonData(overrides,'$.deformation.parameters');if(errors.length)throw new OperationValidationError(errors);
  if(!overrides||typeof overrides!=='object'||Array.isArray(overrides))deformationError(compiled,'DEFORMATION_PARAMETERS','Expected parameter values.');
  const result:Record<string,ExpressionValue>=Object.create(null);
  for(const name of Object.keys(overrides))if(!own(compiled.parameterDefinitions,name))deformationError(compiled,'DEFORMATION_PARAMETERS',`Unknown parameter ${name}.`);
  for(const [name,definition] of Object.entries(compiled.parameterDefinitions)) {
    const value=own(overrides,name)?overrides[name]:definition.default;
    if(!matches(value,definition))deformationError(compiled,'DEFORMATION_PARAMETERS',`Parameter ${name} violates its type or bounds.`);
    result[name]=structuredClone(value) as ExpressionValue;
  }
  return result;
}
export function evaluateDeformation(compiled:CompiledDeformation,time:number,parameters:Readonly<Record<string,ExpressionValue>>,locals:DeformationLocals):[number,number] {
  return evaluateExpression(compiled,{time,parameters:{...parameters,...locals,position:[...locals.position]}}) as [number,number];
}

/** An affine form is c + x*ax + y*ay. No sampling is used to infer linearity. */
type Affine=[number,number,number];
type AffineValue=Affine|[Affine,Affine]|boolean;
const scalar=(value:AffineValue):value is Affine=>Array.isArray(value)&&typeof value[0]==='number';
const vector=(value:AffineValue):value is [Affine,Affine]=>Array.isArray(value)&&Array.isArray(value[0]);
const constant=(value:Affine)=>value[1]===0&&value[2]===0;
/** The full tree was unit-checked at compile time. Runtime subtree evaluation
 * still needs its own result-kind guard, not the full deformation's vec2 guard. */
function evaluateSubexpression(compiled:CompiledDeformation,node:Ast,time:number,parameters:Readonly<Record<string,ExpressionValue>>):ExpressionValue {
  const kind=(n:Ast):ExpressionType['kind']=>{
    if(n.kind==='number')return 'scalar';if(n.kind==='boolean')return 'boolean';
    if(n.kind==='identifier')return n.name==='time'||n.name==='pi'?'scalar':compiled.parameterTypes[n.name].kind;
    if(n.kind==='conditional')return kind(n.consequent);
    if(n.kind==='unary')return n.operator==='!'?'boolean':kind(n.operand);
    if(n.kind==='call')return n.name==='mask'||n.name==='if'?kind(n.arguments[1]):n.name==='vec2'||n.name==='normalize'?'vec2':'scalar';
    if(['&&','||','==','!=','<','<=','>','>='].includes(n.operator))return 'boolean';
    return kind(n.left)==='vec2'||kind(n.right)==='vec2'?'vec2':'scalar';
  };
  const resultKind=kind(node),type:ExpressionType=resultKind==='boolean'?{kind:'boolean'}:{kind:resultKind,dimension:{length:0,time:0,angle:0}};
  return evaluateExpression({...compiled,ast:node,type},{time,parameters});
}
export function affineDeformation(compiled:CompiledDeformation,time:number,parameters:Readonly<Record<string,ExpressionValue>>):readonly [Affine,Affine]|undefined {
  if(['parameter','index','count'].some(name=>own(compiled.parameterTypes,name)))return;
  const add=(a:Affine,b:Affine,s=1):Affine=>[a[0]+s*b[0],a[1]+s*b[1],a[2]+s*b[2]];
  const scale=(a:Affine,s:number):Affine=>[a[0]*s,a[1]*s,a[2]*s];
  const multiply=(a:Affine,b:Affine):Affine|undefined=>constant(a)?scale(b,a[0]):constant(b)?scale(a,b[0]):undefined;
  const independent=(node:Ast):boolean=>node.kind==='identifier'?node.name!=='position':children(node).every(independent);
  const visit=(node:Ast):AffineValue|undefined=>{
    if(independent(node)) {
      const value=evaluateSubexpression(compiled,node,time,parameters);
      return typeof value==='boolean'?value:typeof value==='number'?[value,0,0]:[[value[0],0,0],[value[1],0,0]];
    }
    if(node.kind==='identifier')return [[0,1,0],[0,0,1]];
    if(node.kind==='unary') {
      const a=visit(node.operand);if(a===undefined||typeof a==='boolean')return;
      const s=node.operator==='-'?-1:1;return scalar(a)?scale(a,s):[scale(a[0],s),scale(a[1],s)];
    }
    if(node.kind==='conditional'||node.kind==='call'&&(node.name==='mask'||node.name==='if')) {
      const [condition,a,b]=node.kind==='conditional'?[node.condition,node.consequent,node.alternate]:node.arguments;
      if(!independent(condition))return;
      return visit(evaluateSubexpression(compiled,condition,time,parameters)?a:b);
    }
    if(node.kind==='binary') {
      const a=visit(node.left),b=visit(node.right);if(a===undefined||b===undefined||typeof a==='boolean'||typeof b==='boolean')return;
      if(node.operator==='+'||node.operator==='-') {const s=node.operator==='+'?1:-1;
        return scalar(a)&&scalar(b)?add(a,b,s):vector(a)&&vector(b)?[add(a[0],b[0],s),add(a[1],b[1],s)]:undefined;}
      if(node.operator==='*') {
        if(scalar(a)&&scalar(b))return multiply(a,b);
        const v=vector(a)?a:vector(b)?b:undefined,c=scalar(a)?a:scalar(b)?b:undefined;
        if(v&&c&&constant(c))return [scale(v[0],c[0]),scale(v[1],c[0])];
      }
      if(node.operator==='/'&&scalar(b)&&constant(b)&&b[0]!==0)return scalar(a)?scale(a,1/b[0]):[scale(a[0],1/b[0]),scale(a[1],1/b[0])];
      return;
    }
    if(node.kind==='call') {
      if(node.name==='vec2') {const a=visit(node.arguments[0]),b=visit(node.arguments[1]);if(a&&b&&scalar(a)&&scalar(b))return [a,b];}
      if(node.name==='dot') {const a=visit(node.arguments[0]),b=visit(node.arguments[1]);if(a&&b&&vector(a)&&vector(b)) {
        const x=multiply(a[0],b[0]),y=multiply(a[1],b[1]);if(x&&y)return add(x,y);}}
    }
    return;
  };
  const result=visit(compiled.ast);
  return result&&vector(result)&&result.flat().every(Number.isFinite)?result:undefined;
}
function children(node:Ast):readonly Ast[] {return node.kind==='unary'?[node.operand]:node.kind==='binary'?[node.left,node.right]:node.kind==='call'?node.arguments:
  node.kind==='conditional'?[node.condition,node.consequent,node.alternate]:[];}

export type Interval=readonly [number,number];
export type Rectangle=readonly [Interval,Interval];
type Range={kind:'scalar';range:Interval}|{kind:'vec2';range:Rectangle}|{kind:'boolean';value:boolean};
/** An interval containing a potential singularity may become decidable after subdivision. */
export class DeformationIntervalUncertain extends Error {constructor(public readonly node:Ast,message:string){super(message);}}
const bytes=new DataView(new ArrayBuffer(8));
export function outward(value:number,direction:-1|1):number {
  if(!Number.isFinite(value))return value;
  if(value===0)return direction<0?-Number.MIN_VALUE:Number.MIN_VALUE;
  bytes.setFloat64(0,value,false);let bits=bytes.getBigUint64(0,false);bits+=BigInt((value>0?direction:-direction));bytes.setBigUint64(0,bits,false);return bytes.getFloat64(0,false);
}
const enclose=(lo:number,hi:number):Interval=>[outward(lo,-1),outward(hi,1)];
const plus=(a:Interval,b:Interval):Interval=>enclose(a[0]+b[0],a[1]+b[1]);
const minus=(a:Interval,b:Interval):Interval=>enclose(a[0]-b[1],a[1]-b[0]);
const times=(a:Interval,b:Interval):Interval=>{const values=[a[0]*b[0],a[0]*b[1],a[1]*b[0],a[1]*b[1]];return enclose(Math.min(...values),Math.max(...values));};
const absMin=(a:Interval)=>a[0]<=0&&a[1]>=0?0:Math.min(Math.abs(a[0]),Math.abs(a[1]));
const absMax=(a:Interval)=>Math.max(Math.abs(a[0]),Math.abs(a[1]));
/**
 * Conservative real-arithmetic envelopes with outward-rounded basic arithmetic.
 * Trig/hypot use an explicit floating-point guard around host Math results; this
 * is a geometric approximation certificate, not a formally verified libm proof.
 */
export function boundDeformation(compiled:CompiledDeformation,position:Rectangle,parameter:Interval,time:number,parameters:Readonly<Record<string,ExpressionValue>>):Rectangle {
  const fail=(node:Ast,message:string):never=>deformationError(compiled,'DEFORMATION_INTERVAL_UNSUPPORTED',message,node);
  const number=(node:Ast,value:Range):Interval=>value.kind==='scalar'?value.range:fail(node,'Expected a scalar interval.');
  const vec=(node:Ast,value:Range):Rectangle=>value.kind==='vec2'?value.range:fail(node,'Expected a vector interval.');
  const uncertain=(node:Ast,message:string):never=>{throw new DeformationIntervalUncertain(node,message);};
  const divide=(node:Ast,a:Interval,b:Interval):Interval=>b[0]<=0&&b[1]>=0?uncertain(node,'Divisor interval contains zero.'):times(a,enclose(1/b[1],1/b[0]));
  const s=(range:Interval):Range=>({kind:'scalar',range}),v=(range:Rectangle):Range=>({kind:'vec2',range});
  const independent=(node:Ast):boolean=>node.kind==='identifier'?!['position','parameter','index','count'].includes(node.name):children(node).every(independent);
  const visit=(node:Ast):Range=>{
    if(independent(node)) {
      const value=evaluateSubexpression(compiled,node,time,parameters);
      return typeof value==='boolean'?{kind:'boolean',value}:typeof value==='number'?s([value,value]):v([[value[0],value[0]],[value[1],value[1]]]);
    }
    if(node.kind==='identifier')return node.name==='position'?v(position):node.name==='parameter'?s(parameter):fail(node,'index/count are control-domain variables.');
    if(node.kind==='unary') {
      const a=visit(node.operand);if(a.kind==='boolean')return fail(node,'Spatial boolean expressions are unsupported.');
      const negate=(x:Interval):Interval=>[-x[1],-x[0]];
      return node.operator==='+'?a:a.kind==='scalar'?s(negate(a.range)):v([negate(a.range[0]),negate(a.range[1])]);
    }
    if(node.kind==='conditional'||node.kind==='call'&&(node.name==='mask'||node.name==='if')) {
      const [condition,a,b]=node.kind==='conditional'?[node.condition,node.consequent,node.alternate]:node.arguments;
      if(!independent(condition))return fail(condition,'Pointwise branch conditions must be independent of position and parameter.');
      return visit(evaluateSubexpression(compiled,condition,time,parameters)?a:b);
    }
    if(node.kind==='binary') {
      const a=visit(node.left),b=visit(node.right),op=node.operator;
      if(op==='+'||op==='-') {const f=op==='+'?plus:minus;return a.kind==='scalar'?s(f(a.range,number(node.right,b))):a.kind==='vec2'?
        v([f(a.range[0],vec(node.right,b)[0]),f(a.range[1],vec(node.right,b)[1])]):fail(node,'Unsupported boolean arithmetic.');}
      if(op==='*') {if(a.kind==='scalar'&&b.kind==='scalar')return s(times(a.range,b.range));
        const vector=a.kind==='vec2'?a:b,scale=a.kind==='scalar'?a:b;
        const p=vec(node,vector),c=number(node,scale);return v([times(p[0],c),times(p[1],c)]);}
      if(op==='/') {const divisor=number(node.right,b);return a.kind==='scalar'?s(divide(node,a.range,divisor)):
        v([divide(node,vec(node.left,a)[0],divisor),divide(node,vec(node.left,a)[1],divisor)]);}
      if(op==='^') {
        const base=number(node.left,a),exponent=number(node.right,b);
        if(exponent[0]!==exponent[1]||!Number.isSafeInteger(exponent[0])||Math.abs(exponent[0])>1024)
          return fail(node,'Pointwise interval powers require a fixed integer exponent with magnitude at most 1024.');
        const n=exponent[0];if(n===0)return s([1,1]);
        if(n<0&&base[0]<=0&&base[1]>=0)return uncertain(node,'Negative power interval contains zero.');
        const values=[base[0]**n,base[1]**n];if(n>0&&n%2===0&&base[0]<=0&&base[1]>=0)values.push(0);
        return s(enclose(Math.min(...values),Math.max(...values)));
      }
      return fail(node,'Spatial comparisons and boolean operations are not interval-certified.');
    }
    if(node.kind==='call') {
      const args=node.arguments;
      if(node.name==='vec2')return v([number(args[0],visit(args[0])),number(args[1],visit(args[1]))]);
      if(node.name==='dot') {const a=vec(args[0],visit(args[0])),b=vec(args[1],visit(args[1]));return s(plus(times(a[0],b[0]),times(a[1],b[1])));}
      if(node.name==='sin'||node.name==='cos') {
        const a=number(args[0],visit(args[0]));
        if(a[1]-a[0]>=2*Math.PI||Math.max(Math.abs(a[0]),Math.abs(a[1]))>2**40)return s([-1,1]);
        const f=node.name==='sin'?Math.sin:Math.cos,phase=node.name==='sin'?Math.PI/2:0;
        let lo=Math.min(f(a[0]),f(a[1])),hi=Math.max(f(a[0]),f(a[1]));
        // Widen phase comparisons to cover roundoff during critical-point reduction.
        const guard=32*Number.EPSILON*Math.max(1,Math.abs(a[0]),Math.abs(a[1]));
        if(Math.ceil((a[0]-phase-guard)/(2*Math.PI))<=Math.floor((a[1]-phase+guard)/(2*Math.PI)))hi=1;
        if(Math.ceil((a[0]-phase-Math.PI-guard)/(2*Math.PI))<=Math.floor((a[1]-phase-Math.PI+guard)/(2*Math.PI)))lo=-1;
        return s([Math.max(-1,outward(lo-8*Number.EPSILON,-1)),Math.min(1,outward(hi+8*Number.EPSILON,1))]);
      }
      if(node.name==='length'||node.name==='normalize') {
        const p=vec(args[0],visit(args[0]));const low=Math.hypot(absMin(p[0]),absMin(p[1])),high=Math.hypot(absMax(p[0]),absMax(p[1]));
        const guard=8*Number.EPSILON*Math.max(high,Number.MIN_VALUE),length:Interval=[Math.max(0,outward(low-guard,-1)),outward(high+guard,1)];
        return node.name==='length'?s(length):v([divide(node,p[0],length),divide(node,p[1],length)]);
      }
    }
    return fail(node,'Unsupported interval expression.');
  };
  const result=vec(compiled.ast,visit(compiled.ast));
  if(result.flat().some(x=>!Number.isFinite(x)))throw new DeformationIntervalUncertain(compiled.ast,'Interval bound is nonfinite.');
  return result;
}
