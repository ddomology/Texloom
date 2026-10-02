import {OperationValidationError, type SourceSpan} from '../ir/operations.js';
import {validateSourceSpan} from '../operations/values.js';
import type {ExpressionLocation, ExpressionNode, Unit} from './ast.js';

interface Token {kind:'number'|'identifier'|'symbol'|'eof'; text:string; start:number; end:number; value?:number; unit?:Unit}
const MAX_TEXT = 16384, MAX_TOKENS = 4096, MAX_DEPTH = 128;

/** Parse a small expression language; offsets and columns count Unicode code points. */
export function parseExpression(text: string, sourceSpan?: SourceSpan): ExpressionNode {
  const initial = sourceSpan ?? {file:'<expression>',start:{line:1,column:1},end:{line:1,column:1}};
  if (sourceSpan && validateSourceSpan(sourceSpan).length) throw new OperationValidationError([
    {severity:'error',code:'EXPRESSION_SOURCE',message:'Invalid expression source span.',path:'$.expression.sourceSpan'},
  ]);
  const chars = typeof text === 'string' ? Array.from(text) : [];
  const positions: {line:number;column:number}[] = [];
  let line = initial.start.line, column = initial.start.column;
  for (let i = 0; i <= chars.length; i++) {
    positions.push({line,column});
    if (chars[i] === '\r') {line++;column=1;}
    else if (chars[i] === '\n') {if (chars[i-1] !== '\r') line++;column=1;}
    else column++;
  }
  const location = (start:number,end:number): ExpressionLocation => ({start,end,sourceSpan:{file:initial.file,
    start:{...(positions[start] ?? initial.start)},end:{...(positions[end] ?? positions[positions.length-1])}}});
  const fail = (code:string,message:string,start=0,end=start): never => {
    throw new OperationValidationError([{severity:'error',code,message,path:'$.expression',sourceSpan:location(start,end).sourceSpan}]);
  };
  if (typeof text !== 'string') fail('EXPRESSION_SYNTAX','Expression must be text.');
  if (chars.length > MAX_TEXT) fail('EXPRESSION_LIMIT',`Expression exceeds ${MAX_TEXT} code points.`,0,chars.length);
  const tokens:Token[]=[];
  const add = (token:Token) => {
    if (tokens.length >= MAX_TOKENS) fail('EXPRESSION_LIMIT',`Expression exceeds ${MAX_TOKENS} tokens.`,token.start,token.end);
    tokens.push(token);
  };
  let cursor=0;
  while(cursor<chars.length) {
    if (/\s/u.test(chars[cursor])) {cursor++;continue;}
    const start=cursor, remaining=chars.slice(cursor).join('');
    if (/[0-9]/.test(chars[cursor]) || chars[cursor]==='.' && /[0-9]/.test(chars[cursor+1] ?? '')) {
      const match=/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(remaining)!;
      cursor+=match[0].length;
      const value=Number(match[0]);
      if(!Number.isFinite(value)) fail('EXPRESSION_NONFINITE','Numeric literal must be finite.',start,cursor);
      let unit:Unit='1';
      const suffix=/^[A-Za-z_][A-Za-z0-9_]*/.exec(chars.slice(cursor).join(''))?.[0];
      if(suffix) {
        if(!['bp','s','rad'].includes(suffix)) fail('EXPRESSION_TOKEN',`Unknown numeric unit ${suffix}.`,cursor,cursor+suffix.length);
        unit=suffix as Unit;cursor+=suffix.length;
      }
      add({kind:'number',text:chars.slice(start,cursor).join(''),start,end:cursor,value,unit});continue;
    }
    const identifier=/^[A-Za-z_][A-Za-z0-9_]*/.exec(remaining)?.[0];
    if(identifier) {cursor+=identifier.length;add({kind:'identifier',text:identifier,start,end:cursor});continue;}
    const pair=chars.slice(cursor,cursor+2).join('');
    if(['<=','>=','==','!=','&&','||'].includes(pair)) {cursor+=2;add({kind:'symbol',text:pair,start,end:cursor});continue;}
    if('+-*/^!<>()?,:'.includes(chars[cursor])) {cursor++;add({kind:'symbol',text:chars[start],start,end:cursor});continue;}
    fail('EXPRESSION_TOKEN',`Unexpected token ${JSON.stringify(chars[cursor])}.`,start,start+1);
  }
  tokens.push({kind:'eof',text:'',start:chars.length,end:chars.length});
  let next=0, depth=0;
  const peek=()=>tokens[next];
  const take=(text:string)=>peek().text===text ? tokens[next++] : undefined;
  const expect=(text:string)=>{if(!take(text))fail('EXPRESSION_SYNTAX',`Expected ${text}.`,peek().start,peek().end);};
  const enter=<T>(body:()=>T):T=>{
    if(++depth>MAX_DEPTH)fail('EXPRESSION_LIMIT',`Expression nesting exceeds ${MAX_DEPTH}.`,peek().start,peek().end);
    try{return body();}finally{depth--;}
  };
  const joined=(a:ExpressionNode,b:ExpressionNode)=>location(a.location.start,b.location.end);
  const binary=(child:()=>ExpressionNode,operators:string[]):ExpressionNode=>{
    let node=child();
    while(operators.includes(peek().text)) {const operator=tokens[next++].text,right=child();node={kind:'binary',operator,left:node,right,location:joined(node,right)};}
    return node;
  };
  const primary=():ExpressionNode=>{
    const token=tokens[next++];
    if(token.kind==='number')return {kind:'number',value:token.value!,unit:token.unit!,location:location(token.start,token.end)};
    if(token.kind==='identifier') {
      if(take('(')) {
        const args:ExpressionNode[]=[];
        if(!take(')')) {do{args.push(conditional());}while(take(','));expect(')');}
        return {kind:'call',name:token.text,arguments:args,location:location(token.start,tokens[next-1].end)};
      }
      if(token.text==='true'||token.text==='false')return {kind:'boolean',value:token.text==='true',location:location(token.start,token.end)};
      return {kind:'identifier',name:token.text,location:location(token.start,token.end)};
    }
    if(token.text==='(') {const child=conditional();expect(')');return {...child,location:location(token.start,tokens[next-1].end)};}
    return fail('EXPRESSION_SYNTAX','Expected a number, identifier or parenthesized expression.',token.start,token.end);
  };
  const power=():ExpressionNode=>{
    const left=primary();
    if(take('^')) {const right=enter(unary);return {kind:'binary',operator:'^',left,right,location:joined(left,right)};}
    return left;
  };
  const unary=():ExpressionNode=>{
    if(['+','-','!'].includes(peek().text)) {const operator=tokens[next++],operand=enter(unary);return {kind:'unary',operator:operator.text,operand,location:location(operator.start,operand.location.end)};}
    return power();
  };
  const product=()=>binary(unary,['*','/']);
  const sum=()=>binary(product,['+','-']);
  const comparison=()=>binary(sum,['<','<=','>','>=']);
  const equality=()=>binary(comparison,['==','!=']);
  const conjunction=()=>binary(equality,['&&']);
  const disjunction=()=>binary(conjunction,['||']);
  const conditional=():ExpressionNode=>enter(()=>{
    const condition=disjunction();
    if(!take('?'))return condition;
    const consequent=conditional();expect(':');const alternate=conditional();
    return {kind:'conditional',condition,consequent,alternate,location:joined(condition,alternate)};
  });
  const root=conditional();
  if(peek().kind!=='eof')fail('EXPRESSION_SYNTAX','Unexpected trailing input.',peek().start,peek().end);
  // Long left-associated chains do not recurse while parsing, but still count
  // toward the AST-depth budget required by subsequent visitors.
  const queue:{node:ExpressionNode;depth:number}[]=[{node:root,depth:1}];
  while(queue.length) {
    const {node,depth}=queue.pop()!;
    if(depth>MAX_DEPTH)fail('EXPRESSION_LIMIT',`Expression tree exceeds depth ${MAX_DEPTH}.`,node.location.start,node.location.end);
    const children=node.kind==='unary'?[node.operand]:node.kind==='binary'?[node.left,node.right]:node.kind==='call'?node.arguments:
      node.kind==='conditional'?[node.condition,node.consequent,node.alternate]:[];
    children.forEach(child=>queue.push({node:child,depth:depth+1}));
  }
  return root;
}
