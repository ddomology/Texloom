import {OperationValidationError, type DeepReadonly, type SourceSpan} from '../ir/operations.js';
import {freezeSnapshot} from '../operations/values.js';
import {parseExpression} from './parser.js';
import type {CompiledExpression, Dimension, ExpressionContext, ExpressionNode, ExpressionType,
  ExpressionValue, ParameterDefinition, Unit} from './ast.js';

type Node = DeepReadonly<ExpressionNode>;
const own=(object:object,key:string)=>Object.prototype.hasOwnProperty.call(object,key);
const zero=():Dimension=>({length:0,time:0,angle:0});
const dimensions:Record<Unit,Dimension>={
  '1':{length:0,time:0,angle:0},bp:{length:1,time:0,angle:0},s:{length:0,time:1,angle:0},rad:{length:0,time:0,angle:1},
};
const sameDimension=(a:DeepReadonly<Dimension>,b:DeepReadonly<Dimension>)=>a.length===b.length&&a.time===b.time&&a.angle===b.angle;
const unitless=(d:DeepReadonly<Dimension>)=>sameDimension(d,zero());
const scalarType=(dimension:Dimension=zero()):ExpressionType=>({kind:'scalar',dimension});
const sameType=(a:DeepReadonly<ExpressionType>,b:DeepReadonly<ExpressionType>)=>a.kind===b.kind&&
  (a.kind==='boolean'||b.kind==='boolean'||sameDimension(a.dimension,b.dimension));

function fail(node:Node,code:string,message:string):never {
  throw new OperationValidationError([{severity:'error',code,message,path:'$.expression',sourceSpan:{
    file:node.location.sourceSpan.file,start:{...node.location.sourceSpan.start},end:{...node.location.sourceSpan.end},
  }}]);
}
function dimension(node:Node,a:DeepReadonly<Dimension>,b:DeepReadonly<Dimension>,sign:number):Dimension {
  const result={length:a.length+sign*b.length,time:a.time+sign*b.time,angle:a.angle+sign*b.angle};
  if(!Object.values(result).every(Number.isSafeInteger))fail(node,'EXPRESSION_UNIT','Dimension exponents must be safe integers.');
  return result;
}
const children=(node:Node):readonly Node[]=>node.kind==='unary'?[node.operand]:node.kind==='binary'?[node.left,node.right]:
  node.kind==='call'?node.arguments:node.kind==='conditional'?[node.condition,node.consequent,node.alternate]:[];
const staticTree=(node:Node):boolean=>node.kind==='identifier'?node.name==='pi':children(node).every(staticTree);

function checked(node:Node,value:ExpressionValue):ExpressionValue {
  if(typeof value==='boolean')return value;
  if(typeof value==='number'&&Number.isFinite(value))return value;
  if(Array.isArray(value)&&value.length===2&&value.every(v=>typeof v==='number'&&Number.isFinite(v)))return value;
  fail(node,'EXPRESSION_NONFINITE','Expression produced a nonfinite or invalid value.');
}

/** Runtime evaluation is lazy at every conditional boundary. */
function compute(root:Node,context:ExpressionContext,parameterTypes:Readonly<Record<string,DeepReadonly<ExpressionType>>>={}):ExpressionValue {
  let visits=0;
  const number=(node:Node,value:ExpressionValue):number=>{
    if(typeof value!=='number')fail(node,'EXPRESSION_TYPE','Expected a scalar value.');
    return value;
  };
  const bool=(node:Node,value:ExpressionValue):boolean=>{
    if(typeof value!=='boolean')fail(node,'EXPRESSION_TYPE','Expected a boolean value.');
    return value;
  };
  const vector=(node:Node,value:ExpressionValue):[number,number]=>{
    if(!Array.isArray(value)||value.length!==2)fail(node,'EXPRESSION_TYPE','Expected a vec2 value.');
    return value as [number,number];
  };
  const visit=(node:Node,depth=1):ExpressionValue=>{
    if(++visits>8192||depth>128)fail(node,'EXPRESSION_LIMIT','Expression evaluation budget exceeded.');
    const read=(child:Node)=>visit(child,depth+1);
    let value:ExpressionValue;
    switch(node.kind) {
      case 'number':value=node.value;break;
      case 'boolean':value=node.value;break;
      case 'identifier':
        if(node.name==='pi')value=Math.PI;
        else if(node.name==='time')value=context.time;
        else {
          if(!context.parameters||!own(context.parameters,node.name))fail(node,'EXPRESSION_CONTEXT',`Missing parameter ${node.name}.`);
          const supplied=context.parameters[node.name];
          const expected=own(parameterTypes,node.name)?parameterTypes[node.name]:undefined;
          if(expected) {
            const kind=typeof supplied==='boolean'?'boolean':typeof supplied==='number'?'scalar':Array.isArray(supplied)?'vec2':'invalid';
            if(kind!==expected.kind)fail(node,'EXPRESSION_TYPE',`Parameter ${node.name} must be ${expected.kind}.`);
          }
          value=Array.isArray(supplied)?[supplied[0],supplied[1]]:supplied;
          if(Array.isArray(supplied)&&supplied.length!==2)fail(node,'EXPRESSION_TYPE',`Parameter ${node.name} must contain two coordinates.`);
        }
        break;
      case 'unary': {
        const input=read(node.operand);
        if(node.operator==='!')value=!bool(node,input);
        else if(typeof input==='number')value=node.operator==='-'?-input:input;
        else if(Array.isArray(input))value=node.operator==='-'?[-input[0],-input[1]]:[...input];
        else fail(node,'EXPRESSION_TYPE','Unary arithmetic requires scalar or vec2.');
        break;
      }
      case 'conditional':value=read(bool(node.condition,read(node.condition))?node.consequent:node.alternate);break;
      case 'binary': {
        const left=read(node.left),operator=node.operator;
        if(operator==='&&') {value=bool(node.left,left)&&bool(node.right,read(node.right));break;}
        if(operator==='||') {value=bool(node.left,left)||bool(node.right,read(node.right));break;}
        const right=read(node.right);
        if(operator==='=='||operator==='!=') {
          const equal=Array.isArray(left)&&Array.isArray(right)?left[0]===right[0]&&left[1]===right[1]:left===right;
          value=operator==='=='?equal:!equal;break;
        }
        if(['<','<=','>','>='].includes(operator)) {
          const a=number(node.left,left),b=number(node.right,right);
          value=operator==='<'?a<b:operator==='<='?a<=b:operator==='>'?a>b:a>=b;break;
        }
        if(operator==='+'||operator==='-') {
          const sign=operator==='+'?1:-1;
          if(typeof left==='number'&&typeof right==='number')value=left+sign*right;
          else {const a=vector(node.left,left),b=vector(node.right,right);value=[a[0]+sign*b[0],a[1]+sign*b[1]];}
        } else if(operator==='*') {
          if(typeof left==='number'&&typeof right==='number')value=left*right;
          else if(typeof left==='number') {const b=vector(node.right,right);value=[left*b[0],left*b[1]];}
          else {const a=vector(node.left,left),b=number(node.right,right);value=[a[0]*b,a[1]*b];}
        } else if(operator==='/') {
          const divisor=number(node.right,right);
          if(divisor===0)fail(node,'EXPRESSION_DOMAIN','Division by zero is undefined.');
          if(typeof left==='number')value=left/divisor;
          else {const a=vector(node.left,left);value=[a[0]/divisor,a[1]/divisor];}
        } else if(operator==='^') {
          value=Math.pow(number(node.left,left),number(node.right,right));
          if(Number.isNaN(value))fail(node,'EXPRESSION_DOMAIN','Power is undefined in the real scalar domain.');
        } else fail(node,'EXPRESSION_SYNTAX',`Unsupported operator ${operator}.`);
        break;
      }
      case 'call': {
        const args=node.arguments;
        if(node.name==='mask'||node.name==='if') {value=read(bool(args[0],read(args[0]))?args[1]:args[2]);break;}
        if(node.name==='vec2')value=[number(args[0],read(args[0])),number(args[1],read(args[1]))];
        else if(node.name==='sin'||node.name==='cos')value=Math[node.name](number(args[0],read(args[0])));
        else if(node.name==='dot') {
          const a=vector(args[0],read(args[0])),b=vector(args[1],read(args[1]));value=a[0]*b[0]+a[1]*b[1];
        } else if(node.name==='length'||node.name==='normalize') {
          const a=vector(args[0],read(args[0])),length=Math.hypot(a[0],a[1]);
          if(!Number.isFinite(length))fail(node,'EXPRESSION_NONFINITE','Vector length is nonfinite.');
          if(node.name==='length')value=length;
          else {if(length===0)fail(node,'EXPRESSION_DOMAIN','normalize(0) is undefined.');value=[a[0]/length,a[1]/length];}
        } else fail(node,'EXPRESSION_FUNCTION',`Unknown function ${node.name}.`);
        break;
      }
    }
    return checked(node,value);
  };
  return visit(root);
}

/** A fixed branch may select a constant even when the unused branch reads time. */
function constantAtCompileTime(node:Node):boolean {
  if(node.kind==='identifier')return node.name==='pi';
  if(node.kind==='conditional'||node.kind==='call'&&(node.name==='mask'||node.name==='if')) {
    const [condition,consequent,alternate]=node.kind==='conditional'
      ?[node.condition,node.consequent,node.alternate]:node.arguments;
    if(!constantAtCompileTime(condition))return false;
    const selected=compute(condition,{time:0,parameters:{}});
    return typeof selected==='boolean'&&constantAtCompileTime(selected?consequent:alternate);
  }
  if(node.kind==='binary'&&(node.operator==='&&'||node.operator==='||')) {
    if(!constantAtCompileTime(node.left))return false;
    const left=compute(node.left,{time:0,parameters:{}});
    if(node.operator==='&&'&&left===false||node.operator==='||'&&left===true)return true;
    return constantAtCompileTime(node.right);
  }
  return children(node).every(constantAtCompileTime);
}

/** Validate every branch, then fold only reachable, genuinely constant expressions. */
export function compileExpression(text:string,parameters:Readonly<Record<string,ParameterDefinition>>={},sourceSpan?:SourceSpan,
  variables:Readonly<Record<string,ExpressionType>>={}):CompiledExpression {
  const ast=parseExpression(text,sourceSpan), types=new Map<Node,ExpressionType>();
  const parameterTypes:Record<string,ExpressionType>=Object.create(null);
  const reservedVariables=new Set(['time','pi','true','false','vec2','sin','cos','dot','length','normalize','mask','if']);
  for(const [name,type] of Object.entries(variables)) {
    if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)||reservedVariables.has(name)||own(parameters,name))
      fail(ast,'EXPRESSION_VARIABLE',`Invalid, reserved or colliding variable ${name}.`);
    if(!type||!['scalar','vec2','boolean'].includes(type.kind)||type.kind!=='boolean'&&
        (!type.dimension||!['length','time','angle'].every(key=>Number.isSafeInteger(type.dimension[key as keyof typeof type.dimension]))))
      fail(ast,'EXPRESSION_VARIABLE',`Invalid expression type for variable ${name}.`);
  }
  const numeric=(node:Node,type:ExpressionType,kind?:'scalar'|'vec2'):{kind:'scalar'|'vec2';dimension:Dimension}=>{
    if(type.kind==='boolean'||kind&&type.kind!==kind)fail(node,'EXPRESSION_TYPE',`Expected ${kind??'scalar or vec2'}.`);
    return type;
  };
  const boolean=(node:Node,type:ExpressionType)=>{if(type.kind!=='boolean')fail(node,'EXPRESSION_TYPE','Expected boolean.');};
  const matching=(node:Node,a:ExpressionType,b:ExpressionType)=>{
    if(a.kind!==b.kind)fail(node,'EXPRESSION_TYPE','Values must have matching types.');
    if(!sameType(a,b))fail(node,'EXPRESSION_UNIT','Values must have matching dimensions.');
  };
  const infer=(node:Node):ExpressionType=>{
    let type:ExpressionType;
    switch(node.kind) {
      case 'number':type=scalarType({...dimensions[node.unit]});break;
      case 'boolean':type={kind:'boolean'};break;
      case 'identifier': {
        if(node.name==='pi')type=scalarType();
        else if(node.name==='time')type=scalarType({...dimensions.s});
        else if(own(variables,node.name)) {
          type=structuredClone(variables[node.name]);
          parameterTypes[node.name]=type;
        }
        else {
          if(!parameters||!own(parameters,node.name))fail(node,'EXPRESSION_IDENTIFIER',`Unknown parameter ${node.name}.`);
          const parameter=parameters[node.name];
          if(!parameter||!['scalar','vec2','boolean'].includes(parameter.type))fail(node,'EXPRESSION_TYPE',`Invalid parameter type for ${node.name}.`);
          const unit=parameter.unit??'1';
          if(!own(dimensions,unit)||parameter.type==='boolean'&&unit!=='1')fail(node,'EXPRESSION_UNIT',`Invalid unit for ${node.name}.`);
          type=parameter.type==='boolean'?{kind:'boolean'}:{kind:parameter.type,dimension:{...dimensions[unit]}};
          parameterTypes[node.name]=type;
        }
        break;
      }
      case 'unary': {
        const child=infer(node.operand);
        if(node.operator==='!') {boolean(node.operand,child);type={kind:'boolean'};}
        else type=numeric(node.operand,child);
        break;
      }
      case 'conditional': {
        const condition=infer(node.condition),a=infer(node.consequent),b=infer(node.alternate);
        boolean(node.condition,condition);matching(node,a,b);type=a;break;
      }
      case 'binary': {
        const left=infer(node.left),right=infer(node.right),operator=node.operator;
        if(operator==='&&'||operator==='||') {boolean(node.left,left);boolean(node.right,right);type={kind:'boolean'};}
        else if(operator==='=='||operator==='!=') {matching(node,left,right);type={kind:'boolean'};}
        else if(['<','<=','>','>='].includes(operator)) {
          numeric(node.left,left,'scalar');numeric(node.right,right,'scalar');matching(node,left,right);type={kind:'boolean'};
        } else if(operator==='+'||operator==='-') {
          numeric(node.left,left);numeric(node.right,right);matching(node,left,right);type=left;
        } else if(operator==='*'||operator==='/') {
          const a=numeric(node.left,left),b=numeric(node.right,right);
          if(operator==='*'&&a.kind==='vec2'&&b.kind==='vec2'||operator==='/'&&b.kind==='vec2')
            fail(node,'EXPRESSION_TYPE','Use dot for vector products; division requires a scalar divisor.');
          type={kind:a.kind==='vec2'||b.kind==='vec2'?'vec2':'scalar',dimension:dimension(node,a.dimension,b.dimension,operator==='*'?1:-1)};
        } else if(operator==='^') {
          const a=numeric(node.left,left,'scalar'),b=numeric(node.right,right,'scalar');
          if(!unitless(b.dimension))fail(node.right,'EXPRESSION_UNIT','Power exponent must be dimensionless.');
          if(unitless(a.dimension))type=scalarType();
          else {
            let exponent:ExpressionValue|undefined;
            if(constantAtCompileTime(node.right))exponent=compute(node.right,{time:0,parameters:{}});
            if(typeof exponent!=='number'||!Number.isSafeInteger(exponent))fail(node.right,'EXPRESSION_POWER','Dimensional powers require a constant integer exponent.');
            const scaled={length:a.dimension.length*exponent,time:a.dimension.time*exponent,angle:a.dimension.angle*exponent};
            if(!Object.values(scaled).every(Number.isSafeInteger))fail(node,'EXPRESSION_UNIT','Dimension exponents must be safe integers.');
            type=scalarType(scaled);
          }
        } else fail(node,'EXPRESSION_SYNTAX',`Unknown operator ${operator}.`);
        break;
      }
      case 'call': {
        const count:Record<string,number>={vec2:2,sin:1,cos:1,dot:2,length:1,normalize:1,mask:3,if:3};
        if(!own(count,node.name))fail(node,'EXPRESSION_FUNCTION',`Unknown function ${node.name}.`);
        if(node.arguments.length!==count[node.name])fail(node,'EXPRESSION_ARITY',`${node.name} expects ${count[node.name]} arguments.`);
        const args=node.arguments.map(infer);
        if(node.name==='mask'||node.name==='if') {boolean(node.arguments[0],args[0]);matching(node,args[1],args[2]);type=args[1];}
        else if(node.name==='vec2') {
          const a=numeric(node.arguments[0],args[0],'scalar');numeric(node.arguments[1],args[1],'scalar');matching(node,args[0],args[1]);
          type={kind:'vec2',dimension:a.dimension};
        } else if(node.name==='sin'||node.name==='cos') {
          const a=numeric(node.arguments[0],args[0],'scalar');
          if(!unitless(a.dimension)&&!sameDimension(a.dimension,dimensions.rad))fail(node,'EXPRESSION_UNIT','Trigonometric input must be dimensionless radians or an angle.');
          type=scalarType();
        } else if(node.name==='dot') {
          const a=numeric(node.arguments[0],args[0],'vec2'),b=numeric(node.arguments[1],args[1],'vec2');
          type=scalarType(dimension(node,a.dimension,b.dimension,1));
        } else {
          const a=numeric(node.arguments[0],args[0],'vec2');
          type=node.name==='length'?scalarType(a.dimension):{kind:'vec2',dimension:zero()};
        }
        break;
      }
    }
    types.set(node,type);return type;
  };
  const type=infer(ast);
  const constant=(node:ExpressionNode,value:ExpressionValue):ExpressionNode=>{
    const type=types.get(node)!;
    if(type.kind==='boolean')return {kind:'boolean',value:value as boolean,location:node.location};
    const unit=(Object.keys(dimensions) as Unit[]).find(unit=>sameDimension(type.dimension,dimensions[unit]));
    if(!unit)return node; // Compound units have no literal spelling; retain their arithmetic AST.
    if(type.kind==='scalar')return {kind:'number',value:value as number,unit,location:node.location};
    const vector=value as [number,number];
    return {kind:'call',name:'vec2',arguments:vector.map(value=>({kind:'number',value,unit,location:node.location})),location:node.location};
  };
  const fold=(node:ExpressionNode,eager=true):ExpressionNode=>{
    let candidate:ExpressionNode=node;
    const constValue=(value:ExpressionNode):ExpressionValue|undefined=>{
      if(!staticTree(value))return;
      try{return compute(value,{time:0,parameters:{}});}
      catch(error){
        if(!eager&&error instanceof OperationValidationError&&error.diagnostics.every(d=>['EXPRESSION_DOMAIN','EXPRESSION_NONFINITE'].includes(d.code)))return;
        throw error;
      }
    };
    if(node.kind==='unary')candidate={...node,operand:fold(node.operand,eager)};
    else if(node.kind==='binary') {
      const left=fold(node.left,eager),value=constValue(left);
      if(node.operator==='&&'&&value===false||node.operator==='||'&&value===true)return constant(node,value as boolean);
      const rightEager=eager&&(!(node.operator==='&&'||node.operator==='||')||typeof value==='boolean');
      candidate={...node,left,right:fold(node.right,rightEager)};
    } else if(node.kind==='conditional') {
      const condition=fold(node.condition,eager),value=constValue(condition);
      if(typeof value==='boolean') {
        const selected=fold(value?node.consequent:node.alternate,eager),result=constValue(selected);
        if(result!==undefined)return constant(node,result);
        candidate={...node,condition,...(value?{consequent:selected}:{alternate:selected})};
      } else candidate={...node,condition,consequent:fold(node.consequent,false),alternate:fold(node.alternate,false)};
    } else if(node.kind==='call') {
      if(node.name==='mask'||node.name==='if') {
        const condition=fold(node.arguments[0],eager),value=constValue(condition);
        if(typeof value==='boolean') {
          const index=value?1:2,selected=fold(node.arguments[index],eager),result=constValue(selected);
          if(result!==undefined)return constant(node,result);
          const args=[...node.arguments];args[0]=condition;args[index]=selected;candidate={...node,arguments:args};
        } else candidate={...node,arguments:[condition,...node.arguments.slice(1).map(child=>fold(child,false))]};
      } else candidate={...node,arguments:node.arguments.map(child=>fold(child,eager))};
    }
    if(staticTree(candidate)) {
      const value=constValue(candidate);
      if(value===undefined)return candidate;
      const folded=constant(node,value);
      return folded===node?candidate:folded;
    }
    return candidate;
  };
  return freezeSnapshot({ast:fold(ast),type,parameterTypes});
}

export function evaluateExpression(compiled:CompiledExpression,context:ExpressionContext):ExpressionValue {
  if(!context||!Number.isFinite(context.time))fail(compiled.ast,'EXPRESSION_CONTEXT','Context time must be finite seconds.');
  const value=compute(compiled.ast,context,compiled.parameterTypes),kind=typeof value==='boolean'?'boolean':typeof value==='number'?'scalar':'vec2';
  if(kind!==compiled.type.kind)fail(compiled.ast,'EXPRESSION_TYPE',`Expected ${compiled.type.kind} result; received ${kind}.`);
  return value;
}
