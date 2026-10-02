import type {PathGeometry} from '../path-geometry.js';

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
export type ValueType = 'scalar' | 'vec2' | 'path2d' | 'transform2d';
/** Scene coordinates exclude the camera. Local spaces are distinct even at identity. */
export type SpaceRef = {kind: 'scene'} | {kind: 'local'; node: string};
export type Vec2Role = 'point' | 'vector';
/** Space names in definitions are variables bound by Operation.spaces. */
export type SocketType =
  | {type: 'scalar'}
  | {type: 'vec2'; role: Vec2Role; space: string}
  | {type: 'path2d'; space: string}
  | {type: 'transform2d'; from: string; to: string};
export type LiteralValue =
  | {type: 'scalar'; value: number}
  | {type: 'vec2'; role: Vec2Role; space: SpaceRef; value: [number, number]}
  | {type: 'path2d'; space: SpaceRef; value: PathGeometry}
  /** SVG affine convention [a,b,c,d,e,f]; maps from -> to, no inverse implied. */
  | {type: 'transform2d'; from: SpaceRef; to: SpaceRef; value: [number, number, number, number, number, number]};
export interface OutputRef {operation: string; socket: string}
export type InputRef = {kind: 'literal'; value: LiteralValue} | {kind: 'output'; ref: OutputRef};
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
