import type {PathGeometry} from '../path-geometry.js';
import type {Unit} from '../fields/ast.js';
import type {Primitive2D} from '../geometry/primitives.js';
import type {AnchorName} from './text.js';
import type {CurveProvenance} from '../geometry/curves.js';
import type {IntersectionSet} from '../geometry/intersections.js';
import type {LayoutBox} from '../geometry/boxes.js';

/** Lines/columns are 1-based; end is exclusive. Columns count Unicode code points. */
export interface SourceSpan {
  file: string;
  start: {line: number; column: number};
  end: {line: number; column: number};
}
export interface Diagnostic {
  severity: 'error' | 'warning'; code: string; message: string; path?: string;
  sourceSpan?: SourceSpan;
  related?: {message: string; path?: string; sourceSpan?: SourceSpan}[];
}
export type ValueType = 'scalar' | 'vec2' | 'points2d' | 'boxes2d' | 'shape2d' | 'path2d' | 'intersections2d' | 'transform2d';
/** Scene coordinates exclude the camera. Local spaces are distinct even at identity. */
export type SpaceRef = {kind: 'scene'} | {kind: 'local'|'parent'|'plot'; node: string};
export type Vec2Role = 'point' | 'vector';
/** Space names in definitions are variables bound by Operation.spaces. */
export type SocketType =
  | {type: 'scalar'; unit?:Unit}
  | {type: 'vec2'; role: Vec2Role; space: string}
  | {type: 'points2d'|'boxes2d'|'shape2d'|'intersections2d'; space: string}
  | {type: 'path2d'; space: string}
  | {type: 'transform2d'; from: string; to: string};
export type LiteralValue =
  | {type: 'scalar'; value: number; unit?:Unit}
  | {type: 'vec2'; role: Vec2Role; space: SpaceRef; value: [number, number]}
  | {type: 'points2d'; space: SpaceRef; value: [number,number][]}
  /** Intrinsic content metrics in the declared layout chart; null reserves an empty slot. */
  | {type: 'boxes2d'; space: SpaceRef; value: (LayoutBox|null)[]}
  | {type: 'shape2d'; space: SpaceRef; value: Primitive2D}
  | {type: 'path2d'; space: SpaceRef; value: PathGeometry; provenance?:CurveProvenance}
  | {type: 'intersections2d'; space: SpaceRef; value: IntersectionSet}
  /** SVG affine convention [a,b,c,d,e,f]; maps from -> to, no inverse implied. */
  | {type: 'transform2d'; from: SpaceRef; to: SpaceRef; value: [number, number, number, number, number, number]};
export interface OutputRef {operation: string; socket: string}
export type AnchorSource = {kind:'node';node:string;innerSep?:[number,number];outerSep?:[number,number]}
  | {kind:'shape';ref:OutputRef;outerSep?:[number,number]};
export type AnchorInput = {kind:'anchor';source:AnchorSource;query:{kind:'named';name:AnchorName}|{kind:'border';towards:InputRef};space:SpaceRef};
export type TextPlacementInput = {kind:'textPlacement';node:string;anchor:AnchorName;point:InputRef;innerSep?:[number,number];outerSep?:[number,number]};
/** Metrics-only label anchor, independent of the node's pose being written. */
export type TextAnchorInput = {kind:'textAnchor';node:string;anchor:AnchorName;innerSep?:[number,number];outerSep?:[number,number]};
export type InputRef = {kind: 'literal'; value: LiteralValue} | {kind: 'output'; ref: OutputRef}
  | AnchorInput | TextPlacementInput | TextAnchorInput
  | {kind:'path';node:string;space:SpaceRef}
  | {kind:'node';node:string;property:'position';space:SpaceRef}
  | {kind:'expression';expression:string;unit:Unit;sourceSpan?:SourceSpan}
  | {kind:'pointExpression';expression:string;space:SpaceRef;sourceSpan?:SourceSpan}
  | {kind:'property';node:string;property:string;unit:Unit}
  | {kind:'points';space:SpaceRef;items:InputRef[]}
  /** Measures content only, excluding each node's authored position and transform. */
  | {kind:'boxes';space:SpaceRef;nodes:(string|null)[]}
  | {kind:'spaceTransform';from:SpaceRef;to:SpaceRef};
export interface InputSocket {value: SocketType; required?: true; default?: LiteralValue}
/** Metadata only. Implementations, closures and code never travel in the bundle. */
export interface OperatorDefinition {
  name: string; version: number; spaces: string[];
  inputs: Record<string, InputSocket>; outputs: Record<string, SocketType>;
  pure: true; deterministic: true;
}
export interface Operation {
  id: string; operator: string; version: number;
  spaces: Record<string, SpaceRef>; inputs: Record<string, InputRef>;
  sourceSpan?: SourceSpan;
}
export interface OperationBinding {
  target: string; property: string; value: OutputRef; sourceSpan?: SourceSpan;
}
/** Portable declarations, lowered separately into a deterministic execution plan. */
export interface OperationGraph {version: 1; operations: Operation[]; bindings: OperationBinding[]}
export type DeepReadonly<T> = T extends object ? {readonly [K in keyof T]: DeepReadonly<T[K]>} : T;
export interface PreparedOperationGraph {
  readonly contract: 'texloom-operations/1';
  readonly graph: DeepReadonly<OperationGraph>;
  /** Dependencies first; independent ready operations use lexical ID order. */
  readonly order: readonly string[];
  readonly definitions: readonly DeepReadonly<OperatorDefinition>[];
}
export class OperationValidationError extends Error {
  constructor(public readonly diagnostics: Diagnostic[]) {
    super(diagnostics.map(d => `${d.code}${d.path ? ` at ${d.path}` : ''}: ${d.message}`).join('\n'));
    this.name = 'OperationValidationError';
  }
}
