import type {DeepReadonly, SourceSpan} from '../ir/operations.js';
import type {ExpressionType, ExpressionValue} from './ast.js';

export type FieldDomain = 'path-control'|'curve-sample';
export interface FieldSample {id:string; parameter:number}
export interface FieldDomainDeclaration {
  id:string; geometry:string; domain:FieldDomain; samples?:FieldSample[];
}
export interface GeometryHandle {id:string}
/** key includes geometry identity, domain and element topology, never coordinates. */
export interface FieldDomainHandle {id:string; kind:FieldDomain; key:string}
export interface FieldElement {
  id:string; index:number; parameter:number;
  position:[number,number]; originalPosition:[number,number];
}
export interface FieldContext {
  geometry:GeometryHandle; domain:FieldDomainHandle; time:number;
  elements:FieldElement[];
}
export interface FieldAttribute {
  domain:FieldDomainHandle; geometry:GeometryHandle;
  type:ExpressionType; values:Record<string,ExpressionValue>;
}
export interface FieldOperation {
  id:string; domain:string; kind:'capture'|'evaluate'|'setPosition';
  expression:string; position?:'current'|'original'; sourceSpan?:SourceSpan;
}
export interface FieldBinding {
  domain:string; field:string; property:'position'|'r'|'style.opacity'|'style.fill'|'visible';
  targets:{element:string; target:string}[];
  /** Explicit clamped interpolation of encoded sRGB channels for scalar [0,1] fields. */
  ramp?:{from:string; to:string}; sourceSpan?:SourceSpan;
}
export interface FieldProgram {
  version:1; domains:FieldDomainDeclaration[]; operations:FieldOperation[]; bindings:FieldBinding[];
}
export interface FieldEvaluation {
  contexts:Readonly<Record<string,DeepReadonly<FieldContext>>>;
  attributes:Readonly<Record<string,DeepReadonly<FieldAttribute>>>;
}
