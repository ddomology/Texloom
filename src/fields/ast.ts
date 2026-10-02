import type {SourceSpan, DeepReadonly} from '../ir/operations.js';

export type Unit = '1' | 'bp' | 's' | 'rad';
export interface Dimension {length: number; time: number; angle: number}
export type ExpressionType = {kind:'scalar'|'vec2'; dimension:Dimension} | {kind:'boolean'};
export type ExpressionValue = number | boolean | [number,number];
export interface ParameterDefinition {
  type:'scalar'|'boolean'|'vec2'; unit?:Unit; default:ExpressionValue;
  /** Optional inclusive scalar bounds; units are the parameter's declared unit. */
  min?:number; max?:number;
}
export interface ExpressionBinding {
  target:string; property:string; expression:string; sourceSpan?:SourceSpan;
}
export interface ExpressionProgram {
  version:1; parameters:Record<string,ParameterDefinition>; bindings:ExpressionBinding[];
}
/** Offsets count Unicode code points in the expression; span uses 1-based source coordinates. */
export interface ExpressionLocation {start:number; end:number; sourceSpan:SourceSpan}
export type ExpressionNode = {location:ExpressionLocation} & (
  {kind:'number'; value:number; unit:Unit} |
  {kind:'boolean'; value:boolean} |
  {kind:'identifier'; name:string} |
  {kind:'unary'; operator:string; operand:ExpressionNode} |
  {kind:'binary'; operator:string; left:ExpressionNode; right:ExpressionNode} |
  {kind:'call'; name:string; arguments:ExpressionNode[]} |
  {kind:'conditional'; condition:ExpressionNode; consequent:ExpressionNode; alternate:ExpressionNode}
);
export interface CompiledExpression {
  readonly ast:DeepReadonly<ExpressionNode>;
  readonly type:DeepReadonly<ExpressionType>;
  /** Referenced parameter contracts; consumed lazily, independent of compiler state. */
  readonly parameterTypes:Readonly<Record<string,DeepReadonly<ExpressionType>>>;
}
export interface ExpressionContext {time:number; parameters:Readonly<Record<string,ExpressionValue>>}
