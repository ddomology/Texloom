import type {PathGeometry} from './path-geometry.js';
import type {ArrowOptions, ArrowGeometryResult} from './geometry/arrowheads.js';
import {validatePathGeometry, parseGeometryProperty, geometryPointSlot} from './path-contract.js';
import type {Diagnostic, OperationGraph, SourceSpan} from './ir/operations.js';
import {validateOperationGraphInContext} from './operations/validate.js';
import {validateSourceSpan} from './operations/values.js';
import type {ExpressionProgram} from './fields/ast.js';
import {validateExpressionProgramInContext} from './fields/program.js';
import type {FieldProgram, FieldEvaluation} from './fields/types.js';
import {validateFieldProgramInContext} from './fields/program-fields.js';
import {validateDeformationProgramInContext, type DeformationProgram, type DeformationEvaluation} from './operations/deform.js';
import {validatePlotProgramInContext, type PlotProgram, type PlotEvaluation} from './operations/plot.js';
import {validateTimelineMetadata,type TimelineMetadata,type Easing} from './timeline/ast.js';
import {trackHasSingularScale} from './timeline/track.js';
import {validateMorphProgramInContext,type MorphProgram,type MorphEvaluation} from './timeline/morph.js';
import {validateMathTransformProgramInContext,type MathTransformProgram,type MathTransformEvaluation} from './timeline/math-transform.js';
import {validateTextPartsInContext,type TextParts} from './ir/text-parts.js';
import {validateTraceProgramInContext,type TraceProgram,type TraceEvaluation} from './timeline/trace.js';
import {validatePresentationProgramInContext,type PresentationProgram,type PresentationEvaluation} from './ir/presentation-intent.js';
import {validateMeshResource,type MeshResource} from './ir/mesh.js';
import {validateCurve3DResource,type Curve3DResource} from './ir/curve3d.js';
import {validateSpace3DInContext,type Space3D,type Space3DEvaluation} from './ir/scene3d.js';
import {validateSurfaceProgramInContext,surfaceValidationResources,type SurfaceProgram,type SurfaceEvaluation} from './operations/surface.js';
import {validateCurveProgram3DInContext,curveValidationResources,type CurveProgram3D,type CurveEvaluation3D} from './operations/curve3d.js';
import {validateMeshAttributeProgramInContext,meshAttributeValidationResources,type MeshAttributeProgram,type MeshAttributeEvaluation} from './operations/mesh-attributes.js';
import {validateInstanceProgramInContext,instanceValidationResources,instanceValidationSets,type InstanceProgram,type InstanceProgramSample} from './operations/instances.js';
import {validateFieldVisualizationProgramInContext,fieldVisualizationValidationResources,fieldVisualizationValidationSets,type FieldVisualizationProgram,type FieldVisualizationEvaluation} from './operations/field-visualization.js';
import {validateBakeRegistry,validateSampledFieldProgramInContext,sampledFieldValidationResources,type SampledFieldProgram,type SampledFieldEvaluation} from './operations/sampled-field.js';
import type {BakeManifest} from './resources/bake.js';
export type {Diagnostic, SourceSpan} from './ir/operations.js';
/** Portable, JSON-only scene contract. Legacy 2D dimensions are bp; space3d declares its own units. */
export interface Style {
  fill?: string; stroke?: string; strokeWidth?: number; opacity?: number; dash?: number[];
  fillOpacity?: number; strokeOpacity?: number; miterLimit?: number;
  lineCap?: 'butt' | 'round' | 'square'; lineJoin?: 'miter' | 'round' | 'bevel'; fillRule?: 'nonzero' | 'evenodd';
}
export interface Transform { translate?: [number, number]; rotate?: number; scale?: [number, number] }
export interface Clip { d: string; fillRule?: 'nonzero' | 'evenodd' }
export interface NodeBase { id: string; parent?: string; transform?: Transform; style?: Style; clip?: Clip; visible?: boolean; source?: Record<string, unknown> }
export interface MeasuredAnchorMetrics {kind:'pgf';shape:string;logicalTextBox:[number,number,number,number];
  textMetrics:{width:number;height:number;depth:number};innerSep:[number,number];outerSep:[number,number];alignment:string;revision:string}
export interface GroupNode extends NodeBase { kind: 'group'; anchors?: Record<string, [number, number]>;anchorMetrics?:MeasuredAnchorMetrics;morphProgress?:number;mathProgress?:number }
export interface ResolvedPath { start: [number, number]; c1: [number, number]; c2: [number, number]; end: [number, number] }
export interface PathNode extends NodeBase { kind: 'path'; d: string; arrowStart?: boolean; arrowEnd?: boolean; arrowSize?: number; resolvedPath?: ResolvedPath;
  geometry?: PathGeometry; reveal?: number; revealMode?: 'parameter'|'length'; pathTolerance?: number;
  arrows?: ArrowOptions; resolvedArrows?: ArrowGeometryResult }
export interface EllipseNode extends NodeBase { kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number }
export interface PointNode extends NodeBase { kind: 'point'; x: number; y: number; r: number; phase?: number; progress?: number }
export interface LineNode extends NodeBase { kind: 'line'; x1: number; y1: number; x2: number; y2: number }
export interface TexNode extends NodeBase { kind: 'tex'; resourceId: string; x: number; y: number; scale?: number }
export interface FieldNode extends NodeBase { kind: 'field'; resourceId: string; x: number; y: number; width: number; height: number; values?: number[] }
export type Node = GroupNode | PathNode | EllipseNode | PointNode | LineNode | TexNode | FieldNode;
export type Matrix = [number, number, number, number, number, number];
export interface PaintItem { kind: 'path' | 'group'; d?: string; transform?: Matrix; style?: Style; clip?: Clip & { transform?: Matrix }; children?: PaintItem[] }
export interface VectorResource { kind: 'vector'; items: PaintItem[]; metrics: { width: number; height: number; depth: number }; inkBounds: [number, number, number, number]; sourceTex?: string; glyphs?: unknown[]; capabilities?: string[];textParts?:TextParts }
export interface ScalarFieldResource { kind: 'scalar-field'; columns: number; rows: number; times: number[]; samples: number[][]; range: [number, number]; interpolation: 'linear' | 'step'; provenance?: Record<string, unknown> }
export type Resource = VectorResource | ScalarFieldResource | MeshResource | Curve3DResource;
export type TrackValue = number | number[];
export interface Track { target: string; property: string; keys: [number, TrackValue][]; interpolation?: Easing;
  /** Outgoing interval easing; omitted entries are not allowed. */
  segmentEasings?:Easing[];
  /** Incoming limit at each key; null uses its ordinary value. Index zero is null. */
  leftValues?:(TrackValue|null)[];sourceSpan?:SourceSpan }
export type Relation = (
  | { type: 'pointOnEllipse'; target: string; source: string }
  | { type: 'tangent'; target: string; source: string; point: string; length: number }
  | { type: 'attach'; target: string; source: string; offset: [number, number] }
  | { type: 'lineBetween'; target: string; a: string; b: string }
  | { type: 'pointOnPath'; target: string; source: string; mode?: 'parameter'|'length'; tolerance?: number }
  | { type: 'pathDirection'; target: string; source: string; point: string; length: number; normal?: boolean }
  | { type: 'connect'; target: string; from: { node: string; anchor: string }; to: { node: string; anchor: string }; bend?: number }
  | { type: 'pathLabel'; target: string; path: string; position: number; offset: number; rotate?: boolean }
  ) & {sourceSpan?: SourceSpan};
export interface Camera { x: number; y: number; zoom: number; rotation?: number }
export interface Bundle {
  version: '0.1' | '0.2' | '0.3'; title: string; duration: number; units: 'bp'; viewport: { width: number; height: number };
  nodes: Node[]; resources: Record<string, Resource>; tracks: Track[]; relations: Relation[]; camera: Camera;
  document?: { blocks: unknown[] }; provenance?: Record<string, unknown>; diagnostics?: Diagnostic[];
  /** Typed declarations validated at preparation and executed by the shared plan. */
  operationGraph?: OperationGraph;
  expressions?: ExpressionProgram;
  fields?: FieldProgram;
  deformations?: DeformationProgram;
  plots?: PlotProgram;
  timeline?: TimelineMetadata;
  morphs?: MorphProgram;
  mathTransforms?: MathTransformProgram;
  traces?: TraceProgram;
  presentation?: PresentationProgram;
  /** Explicit 3D world chart, independent of the legacy document bp coordinates. */
  space3d?: Space3D;
  surfaces?:SurfaceProgram;
  curves3d?:CurveProgram3D;
  meshAttributes?:MeshAttributeProgram;
  bakes?:Record<string,BakeManifest>;
  sampledFields?:SampledFieldProgram;
  fieldVisualization?:FieldVisualizationProgram;
  instances?:InstanceProgram;
}
export interface EvaluatedFrame {
  time: number; viewport: Bundle['viewport']; camera: Camera; nodes: Node[]; resources: Record<string, Resource>;
  fields?:FieldEvaluation; deformations?:DeformationEvaluation;plots?:PlotEvaluation;morphs?:MorphEvaluation;
  mathTransforms?:MathTransformEvaluation;traces?:TraceEvaluation;
  presentation?:import('./ir/operations.js').DeepReadonly<PresentationEvaluation>;
  space3d?:import('./ir/operations.js').DeepReadonly<Space3DEvaluation>;
  surfaces?:import('./ir/operations.js').DeepReadonly<SurfaceEvaluation>;
  curves3d?:import('./ir/operations.js').DeepReadonly<CurveEvaluation3D>;
  meshAttributes?:import('./ir/operations.js').DeepReadonly<MeshAttributeEvaluation>;
  sampledFields?:import('./ir/operations.js').DeepReadonly<SampledFieldEvaluation>;
  fieldVisualization?:import('./ir/operations.js').DeepReadonly<FieldVisualizationEvaluation>;
  instanceSets?:InstanceProgramSample['instanceSets'];
  shapes?:import('./operations/shapes.js').ShapeEvaluation;anchors?:import('./operations/anchors.js').AnchorEvaluation;
  curves?:import('./operations/curves.js').CurveEvaluation;intersections?:import('./operations/intersections.js').IntersectionEvaluation;
}

type Obj = Record<string, any>;
const object = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);
const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const nonempty = (x: unknown): x is string => typeof x === 'string' && x.length > 0;
const own = (x: object, key: string) => Object.prototype.hasOwnProperty.call(x, key);

interface PropertySpec { size?: number; min?: number; strictMin?: number; max?: number }
const common: Record<string, PropertySpec> = {
  'transform.translate': { size: 2 }, 'transform.scale': { size: 2 }, 'transform.rotate': {},
  'style.opacity': { min: 0, max: 1 }, 'style.fillOpacity': { min: 0, max: 1 },
  'style.strokeOpacity': { min: 0, max: 1 }, 'style.strokeWidth': { min: 0 }, 'style.miterLimit': { min: 1 },
};
const scalarProperties: Record<string, Record<string, PropertySpec>> = {
  group: {morphProgress:{min:0,max:1},mathProgress:{min:0,max:1}}, path: {reveal:{min:0,max:1},'arrows.start':{min:0,max:2},'arrows.end':{min:0,max:2},
    'arrows.length':{strictMin:0},'arrows.width':{strictMin:0},'arrows.inset':{min:0},
    'arrows.shortenStart':{min:0},'arrows.shortenEnd':{min:0},'arrows.tolerance':{strictMin:0}}, ellipse: { cx: {}, cy: {}, rx: { strictMin: 0 }, ry: { strictMin: 0 } },
  point: { x: {}, y: {}, r: { min: 0 }, phase: {}, progress:{min:0,max:1} }, line: { x1: {}, y1: {}, x2: {}, y2: {} },
  tex: { x: {}, y: {}, scale: { strictMin: 0 } }, field: { x: {}, y: {}, width: { strictMin: 0 }, height: { strictMin: 0 } },
  camera: { x: {}, y: {}, zoom: { strictMin: 0 }, rotation: {} },
};
export function propertySpec(kind: string, property: string): PropertySpec | undefined {
  if(kind==='path'&&parseGeometryProperty(property))return {size:2};
  const direct = scalarProperties[kind];
  return direct && own(direct, property) ? direct[property] : kind !== 'camera' && own(common, property) ? common[property] : undefined;
}
export function relationOutputs(relation: Relation): string[] {
  if(relation.type==='pointOnPath')return ['x','y'];
  if (relation.type === 'connect') return ['d'];
  if (relation.type === 'pathLabel') return ['x', 'y', ...(relation.rotate ? ['transform.rotate'] : [])];
  return relation.type === 'pointOnEllipse' || relation.type === 'attach' ? ['x', 'y'] : ['x1', 'y1', 'x2', 'y2'];
}
export function relationSources(relation: Relation): string[] {
  if(relation.type==='pointOnPath')return [relation.source];
  if(relation.type==='pathDirection')return [relation.source,relation.point];
  if (relation.type === 'connect') return [relation.from.node, relation.to.node];
  if (relation.type === 'pathLabel') return [relation.path];
  return relation.type === 'lineBetween' ? [relation.a, relation.b] : relation.type === 'tangent' ? [relation.source, relation.point] : [relation.source];
}

/** Validate inputs at the interchange boundary. Never evaluates arbitrary code. */
export function validateBundle(input: unknown): Diagnostic[] {
  const errors: Diagnostic[] = [];
  const error = (code: string, message: string, path: string) => errors.push({ severity: 'error', code, message, path });
  // JSON compatibility also prevents cycles in nested paint trees and hidden executable values.
  const ancestors = new Set<object>();
  const json = (value: unknown, path: string, depth = 0): void => {
    if (depth > 128) { error('JSON_DEPTH', 'Maximum JSON nesting depth is 128.', path); return; }
    if (value === null || typeof value === 'string' || typeof value === 'boolean' || finite(value)) return;
    if (typeof value !== 'object') { error('NON_JSON_VALUE', 'Expected finite JSON data, without functions or undefined.', path); return; }
    if (ancestors.has(value)) { error('JSON_CYCLE', 'Bundle data must not contain object cycles.', path); return; }
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      error('NON_JSON_OBJECT', 'Only plain JSON objects are supported.', path); return;
    }
    ancestors.add(value);
    for (const [key, child] of Object.entries(value)) json(child, `${path}.${key}`, depth + 1);
    ancestors.delete(value);
  };
  json(input, '$');
  if (errors.length) return errors;
  if (!object(input)) { error('BUNDLE_TYPE', 'Expected a bundle object.', '$'); return errors; }
  const b = input;
  const number = (value: unknown, path: string, spec: PropertySpec = {}) => {
    if (!finite(value)) { error('FINITE_NUMBER', 'Expected a finite number.', path); return false; }
    if ((spec.min !== undefined && value < spec.min) || (spec.strictMin !== undefined && value <= spec.strictMin) || (spec.max !== undefined && value > spec.max)) {
      error('NUMBER_RANGE', `Number is outside the permitted range ${JSON.stringify(spec)}.`, path); return false;
    }
    return true;
  };
  const tuple = (value: unknown, size: number, path: string) => {
    if (!Array.isArray(value) || value.length !== size) { error('TUPLE_SIZE', `Expected ${size} numeric components.`, path); return false; }
    value.forEach((n, i) => number(n, `${path}[${i}]`)); return value.every(finite);
  };
  const string = (value: unknown, path: string) => { if (!nonempty(value)) error('STRING', 'Expected a nonempty string.', path); };
  const choice = (value: unknown, options: string[], path: string) => { if (!options.includes(value as string)) error('ENUM', `Expected one of ${options.join(', ')}.`, path); };
  const style = (s: unknown, path: string) => {
    if (!object(s)) { error('STYLE_TYPE', 'Expected a style object.', path); return; }
    for (const key of Object.keys(s)) {
      if (['fill', 'stroke'].includes(key)) {
        string(s[key], `${path}.${key}`);
        if (typeof s[key] === 'string' && s[key].startsWith('#') && !/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(s[key]))
          error('PAINT_COLOR', 'Invalid hexadecimal paint color.', `${path}.${key}`);
      }
      else if (['opacity', 'fillOpacity', 'strokeOpacity'].includes(key)) number(s[key], `${path}.${key}`, { min: 0, max: 1 });
      else if (key === 'strokeWidth') number(s[key], `${path}.${key}`, { min: 0 });
      else if (key === 'miterLimit') number(s[key], `${path}.${key}`, { min: 1 });
      else if (key === 'dash') {
        if (!Array.isArray(s[key])) error('DASH_TYPE', 'Expected an array of nonnegative dash lengths.', `${path}.${key}`);
        else { s[key].forEach((v: unknown, j: number) => number(v, `${path}.dash[${j}]`, { min: 0 })); if (s[key].length && s[key].every((v: number) => v === 0)) error('DASH_ZERO', 'A dash pattern cannot be entirely zero.', `${path}.dash`); }
      } else if (key === 'lineCap') choice(s[key], ['butt', 'round', 'square'], `${path}.${key}`);
      else if (key === 'lineJoin') choice(s[key], ['miter', 'round', 'bevel'], `${path}.${key}`);
      else if (key === 'fillRule') choice(s[key], ['nonzero', 'evenodd'], `${path}.${key}`);
      else error('STYLE_PROPERTY', `Unsupported style property ${key}.`, `${path}.${key}`);
    }
  };
  const clip = (c: unknown, path: string, matrix = false) => {
    if (!object(c)) { error('CLIP_TYPE', 'Expected a clip object.', path); return; }
    string(c.d, `${path}.d`);
    if (c.fillRule !== undefined) choice(c.fillRule, ['nonzero', 'evenodd'], `${path}.fillRule`);
    if (c.transform !== undefined) { if (matrix) tuple(c.transform, 6, `${path}.transform`); else error('CLIP_TRANSFORM', 'Scene clip paths use node-local coordinates; transform the node instead.', path); }
  };
  const paint = (item: unknown, path: string) => {
    if (!object(item)) { error('PAINT_TYPE', 'Expected a paint item.', path); return; }
    choice(item.kind, ['path', 'group'], `${path}.kind`);
    if (item.kind === 'path') string(item.d, `${path}.d`);
    if (item.transform !== undefined) tuple(item.transform, 6, `${path}.transform`);
    if (item.style !== undefined) style(item.style, `${path}.style`);
    if (item.clip !== undefined) clip(item.clip, `${path}.clip`, true);
    if (item.children !== undefined) {
      if (!Array.isArray(item.children)) error('PAINT_CHILDREN', 'Expected paint children array.', `${path}.children`);
      else item.children.forEach((child: unknown, j: number) => paint(child, `${path}.children[${j}]`));
      if (item.kind !== 'group') error('PATH_CHILDREN', 'Only paint groups may have children.', path);
    }
  };
  if (!['0.1','0.2','0.3'].includes(b.version)) error('VERSION', 'Supported bundle versions are 0.1, 0.2 and 0.3.', '$.version');
  if (b.units !== 'bp') error('UNITS', 'Coordinates must use bp (72 per inch).', '$.units');
  string(b.title, '$.title'); number(b.duration, '$.duration', { min: 0 });
  if (!object(b.viewport)) error('VIEWPORT', 'Viewport is required.', '$.viewport');
  else { number(b.viewport.width, '$.viewport.width', { strictMin: 0 }); number(b.viewport.height, '$.viewport.height', { strictMin: 0 }); }
  if (!object(b.camera)) error('CAMERA', 'Camera is required.', '$.camera');
  else for (const key of ['x', 'y', 'zoom', ...(b.camera.rotation !== undefined ? ['rotation'] : [])]) number(b.camera[key], `$.camera.${key}`, key === 'zoom' ? { strictMin: 0 } : {});
  if (!object(b.resources)) error('RESOURCES', 'Expected a resource dictionary.', '$.resources');
  else for (const [id, raw] of Object.entries(b.resources)) {
    const path = `$.resources.${id}`;
    if (!nonempty(id)) error('RESOURCE_ID', 'Resource IDs cannot be empty.', path);
    if (!object(raw)) { error('RESOURCE_TYPE', 'Expected a resource object.', path); continue; }
    const r = raw;
    if (r.kind === 'vector') {
      if (!Array.isArray(r.items)) error('PAINT_ITEMS', 'Expected vector paint items array.', `${path}.items`);
      else r.items.forEach((item: unknown, j: number) => paint(item, `${path}.items[${j}]`));
      if (!object(r.metrics)) error('METRICS', 'TeX width/height/depth metrics are required.', `${path}.metrics`);
      else for (const key of ['width', 'height', 'depth']) number(r.metrics[key], `${path}.metrics.${key}`);
      if (tuple(r.inkBounds, 4, `${path}.inkBounds`)) { number(r.inkBounds[2], `${path}.inkBounds[2]`, { min: 0 }); number(r.inkBounds[3], `${path}.inkBounds[3]`, { min: 0 }); }
      if (r.sourceTex !== undefined && typeof r.sourceTex !== 'string') error('SOURCE_TEX', 'sourceTex must be a string.', `${path}.sourceTex`);
      if (r.glyphs !== undefined && !Array.isArray(r.glyphs)) error('GLYPHS', 'glyphs must be an array.', `${path}.glyphs`);
      if (r.capabilities !== undefined && (!Array.isArray(r.capabilities) || !r.capabilities.every(nonempty))) error('CAPABILITIES', 'capabilities must be an array of strings.', `${path}.capabilities`);
      if(r.textParts!==undefined&&!errors.some(d=>d.severity==='error'))errors.push(...validateTextPartsInContext(r.textParts,r as VectorResource,path+'.textParts'));
    } else if (r.kind === 'scalar-field') {
      for (const key of ['columns', 'rows']) { number(r[key], `${path}.${key}`, { min: 1 }); if (!Number.isInteger(r[key])) error('GRID_INTEGER', 'Grid dimensions must be integers.', `${path}.${key}`); }
      choice(r.interpolation, ['linear', 'step'], `${path}.interpolation`);
      if (tuple(r.range, 2, `${path}.range`) && r.range[0] >= r.range[1]) error('FIELD_RANGE', 'Field range maximum must exceed minimum.', `${path}.range`);
      if (!Array.isArray(r.times) || !r.times.length) error('FIELD_TIMES', 'At least one field sample time is required.', `${path}.times`);
      else r.times.forEach((t: unknown, j: number) => { number(t, `${path}.times[${j}]`, { min: 0 }); if (j && finite(t) && t <= r.times[j - 1]) error('TIME_ORDER', 'Sample times must strictly increase.', `${path}.times[${j}]`); });
      if (!Array.isArray(r.samples) || !Array.isArray(r.times) || r.samples.length !== r.times.length) error('FIELD_SAMPLES', 'One sample array is required per sample time.', `${path}.samples`);
      else r.samples.forEach((values: unknown, j: number) => {
        if (!Array.isArray(values) || values.length !== r.columns * r.rows) error('FIELD_GRID_SIZE', 'Sample size must equal columns times rows.', `${path}.samples[${j}]`);
        else values.forEach((v, k) => number(v, `${path}.samples[${j}][${k}]`));
      });
    } else if(r.kind==='mesh') {
      if(b.version!=='0.3')error('MESH_BUNDLE_VERSION','Mesh resources require Bundle 0.3.',path);
      if(id.length>512)error('MESH_RESOURCE_ID','Mesh resource IDs cannot exceed 512 characters.',path);
      errors.push(...validateMeshResource(r,path));
    }
    else if(r.kind==='curve3d') {
      if(b.version!=='0.3')error('CURVE3D_BUNDLE_VERSION','3D curve resources require Bundle 0.3.',path);
      if(id.length>512)error('CURVE3D_RESOURCE_ID','Curve resource IDs cannot exceed 512 characters.',path);
      errors.push(...validateCurve3DResource(r,path));
    }
    else error('RESOURCE_KIND', 'Expected vector, scalar-field, mesh or curve3d resource.', `${path}.kind`);
  }
  const nodes = new Map<string, Obj>();
  if (!Array.isArray(b.nodes)) error('NODES', 'Expected a nodes array.', '$.nodes');
  else b.nodes.forEach((n: unknown, i: number) => {
    const path = `$.nodes[${i}]`;
    if (!object(n)) { error('NODE_TYPE', 'Expected a node object.', path); return; }
    string(n.id, `${path}.id`);
    if (n.id === '$camera') error('RESERVED_ID', '$camera is reserved for the camera.', `${path}.id`);
    if (nodes.has(n.id)) error('DUPLICATE_ID', `Duplicate node ID ${n.id}.`, `${path}.id`);
    else if (nonempty(n.id)) nodes.set(n.id, n);
    if (!own(scalarProperties, n.kind) || n.kind === 'camera') { error('NODE_KIND', `Unsupported node kind ${n.kind}.`, `${path}.kind`); return; }
    if (n.visible !== undefined && typeof n.visible !== 'boolean') error('VISIBLE', 'visible must be boolean.', `${path}.visible`);
    if (n.parent !== undefined) string(n.parent, `${path}.parent`);
    if (n.style !== undefined) style(n.style, `${path}.style`);
    if (n.clip !== undefined) clip(n.clip, `${path}.clip`);
    if (n.transform !== undefined) {
      if (!object(n.transform)) error('TRANSFORM', 'Expected a transform object.', `${path}.transform`);
      else for (const key of Object.keys(n.transform)) {
        if (key === 'translate' || key === 'scale') tuple(n.transform[key], 2, `${path}.transform.${key}`);
        else if (key === 'rotate') number(n.transform[key], `${path}.transform.rotate`);
        else error('TRANSFORM_PROPERTY', `Unsupported transform property ${key}.`, `${path}.transform.${key}`);
      }
    }
    for (const [key, spec] of Object.entries(scalarProperties[n.kind])) {
      if(key.startsWith('arrows.'))continue; // Optional nested profile is validated below.
      if (['phase','scale','progress','reveal','morphProgress','mathProgress'].includes(key) && n[key] === undefined) continue;
      number(n[key], `${path}.${key}`, spec);
    }
    if (n.kind === 'group' && n.anchors !== undefined) {
      if (!object(n.anchors)) error('ANCHORS', 'Expected an anchor coordinate dictionary.', `${path}.anchors`);
      else for (const [name, point] of Object.entries(n.anchors)) { string(name, `${path}.anchors`); tuple(point, 2, `${path}.anchors.${name}`); }
    }
    if(n.anchorMetrics!==undefined) {
      const a=n.anchorMetrics,at=path+'.anchorMetrics';
      if(n.kind!=='group'||!object(a))error('ANCHOR_METRICS','Anchor metrics require a group and a PGF measurement object.',at);
      else {
        for(const key of Object.keys(a))if(!['kind','shape','logicalTextBox','textMetrics','innerSep','outerSep','alignment','revision'].includes(key))error('ANCHOR_METRICS','Unknown measurement property.',at+'.'+key);
        if(a.kind!=='pgf')error('ANCHOR_METRICS','Measurement kind must be pgf.',at+'.kind');
        for(const key of ['shape','alignment','revision'])string(a[key],at+'.'+key);
        tuple(a.logicalTextBox,4,at+'.logicalTextBox');tuple(a.innerSep,2,at+'.innerSep');tuple(a.outerSep,2,at+'.outerSep');
        if(!object(a.textMetrics))error('ANCHOR_METRICS','Expected text width, height and depth.',at+'.textMetrics');
        else {
          for(const key of Object.keys(a.textMetrics))if(!['width','height','depth'].includes(key))error('ANCHOR_METRICS','Unknown text metric.',at+'.textMetrics.'+key);
          for(const key of ['width','height','depth'])number(a.textMetrics[key],at+'.textMetrics.'+key);
        }
        if(!n.anchors)error('ANCHOR_METRICS','Measured metadata requires the measured anchor dictionary.',at);
      }
    }
    if (n.kind === 'path') {
      string(n.d, `${path}.d`);
      for (const key of ['arrowStart', 'arrowEnd']) if (n[key] !== undefined && typeof n[key] !== 'boolean') error('ARROW_BOOLEAN', `${key} must be boolean.`, `${path}.${key}`);
      if (n.arrowSize !== undefined) number(n.arrowSize, `${path}.arrowSize`, { strictMin: 0 });
      if (n.resolvedPath !== undefined) error('GENERATED_GEOMETRY', 'resolvedPath is generated during evaluation; author a connect relation.', `${path}.resolvedPath`);
      if (n.resolvedArrows !== undefined) error('GENERATED_GEOMETRY', 'resolvedArrows is generated during evaluation; author arrows options.', `${path}.resolvedArrows`);
      if (n.arrows !== undefined) {
        if (!object(n.arrows)) error('ARROW_OPTIONS','Expected arrow options.',path+'.arrows');
        else for (const [key,value] of Object.entries(n.arrows)) {
          const at=path+'.arrows.'+key, spec=propertySpec('path','arrows.'+key);
          if(key==='collision')choice(value,['error','clamp'],at);
          else if(spec){number(value,at,spec);if(['start','end'].includes(key)&&![0,1,2].includes(value as number))error('ARROW_KIND','Tip kind must be 0, 1 or 2.',at);}
          else error('ARROW_OPTIONS','Unknown arrow option.',at);
        }
        if(!n.geometry)error('ARROW_GEOMETRY','Explicit arrows require editable geometry.',path+'.arrows');
        if(n.arrowStart!==undefined||n.arrowEnd!==undefined||n.arrowSize!==undefined)
          error('ARROW_PROFILE_CONFLICT','Explicit arrows and legacy arrow flags cannot be mixed.',path+'.arrows');
      }
      if(n.geometry!==undefined){
        if(b.version!=='0.3')error('PATH_VERSION','Structured path geometry requires version 0.3.',path);
        for(const d of validatePathGeometry(n.geometry))error('PATH_GEOMETRY',d.message,path+'.geometry'+d.path);
      }
      if(n.revealMode!==undefined)choice(n.revealMode,['parameter','length'],path+'.revealMode');
      if(n.pathTolerance!==undefined)number(n.pathTolerance,path+'.pathTolerance',{strictMin:0});
      if((n.reveal!==undefined||n.revealMode!==undefined||n.pathTolerance!==undefined)&&n.geometry===undefined)
        error('PATH_GEOMETRY_REQUIRED','Reveal/sampling options require structured geometry.',path);
    }
    if (n.kind === 'tex' || n.kind === 'field') {
      string(n.resourceId, `${path}.resourceId`);
      const r = object(b.resources) && own(b.resources, n.resourceId) ? b.resources[n.resourceId] : undefined;
      if (!r) error('RESOURCE_REFERENCE', `Missing resource ${n.resourceId}.`, `${path}.resourceId`);
      else if (r.kind !== (n.kind === 'tex' ? 'vector' : 'scalar-field')) error('RESOURCE_MISMATCH', `Resource type does not match ${n.kind} node.`, `${path}.resourceId`);
    }
  });
  const parentGraph = new Map<string, string[]>();
  for (const [id, n] of nodes) {
    parentGraph.set(id, n.parent ? [n.parent] : []);
    if (n.parent && !nodes.has(n.parent)) error('PARENT_REFERENCE', `Node ${id} refers to missing parent ${n.parent}.`, `$.nodes.${id}.parent`);
    else if (n.parent && nodes.get(n.parent)?.kind !== 'group') error('PARENT_KIND', 'Only group nodes may be parents.', `$.nodes.${id}.parent`);
  }
  const checkCycles = (graph: Map<string, string[]>, code: string) => {
    const active = new Set<string>(), done = new Set<string>();
    const walk = (id: string, chain: string[]) => {
      if (active.has(id)) {
        const cycle = [...chain.slice(chain.indexOf(id)), id];
        const related = Array.isArray(b.relations) ? b.relations.flatMap((r: unknown,index: number) =>
          object(r) && cycle.includes(r.target) ? [{message:`Relation writing ${r.target}.`,path:`$.relations[${index}]`,
            ...(r.sourceSpan && !validateSourceSpan(r.sourceSpan).length ? {sourceSpan:r.sourceSpan as SourceSpan} : {})}] : []) : [];
        errors.push({severity:'error',code,message:`Dependency cycle: ${cycle.join(' -> ')}.`,path:related[0]?.path ?? '$',
          ...(related.find(r => r.sourceSpan)?.sourceSpan ? {sourceSpan:related.find(r => r.sourceSpan)!.sourceSpan} : {}),
          ...(related.length ? {related} : {})});
        return;
      }
      if (done.has(id)) return;
      active.add(id); for (const dep of graph.get(id) ?? []) walk(dep, [...chain, id]); active.delete(id); done.add(id);
    };
    for (const id of graph.keys()) walk(id, []);
  };
  checkCycles(parentGraph, 'PARENT_CYCLE');
  const writers = new Map<string, string>();
  const transformTargets = new Set<string>();
  const write = (target: string, property: string, path: string) => {
    const key = JSON.stringify([target, property]);
    if (writers.has(key)) error('CONFLICTING_WRITERS', `${target}.${property} is written by both ${writers.get(key)} and ${path}.`, path);
    else writers.set(key, path);
  };
  if (!Array.isArray(b.tracks)) error('TRACKS', 'Expected tracks array.', '$.tracks');
  else b.tracks.forEach((t: unknown, i: number) => {
    const path = `$.tracks[${i}]`;
    if (!object(t)) { error('TRACK_TYPE', 'Expected track object.', path); return; }
    string(t.target, `${path}.target`); string(t.property, `${path}.property`);
    const kind = t.target === '$camera' ? 'camera' : nodes.get(t.target)?.kind;
    if (!kind) { error('TRACK_REFERENCE', `Missing target ${t.target}.`, `${path}.target`); return; }
    const spec = propertySpec(kind, t.property);
    if (!spec) error('TRACK_PROPERTY', `Property ${t.property} cannot be animated on ${kind}.`, `${path}.property`);
    if(parseGeometryProperty(t.property)&&!geometryPointSlot(nodes.get(t.target)?.geometry,t.property))
      error('PATH_CONTROL_REFERENCE','Control track must identify an existing contour/segment coordinate.',path+'.property');
    if(t.property==='reveal'&&!nodes.get(t.target)?.geometry)error('PATH_GEOMETRY_REQUIRED','Reveal track requires structured geometry.',path);
    write(t.target, t.property, path);
    if (typeof t.property === 'string' && t.property.startsWith('transform.')) transformTargets.add(t.target);
    if (t.interpolation !== undefined) choice(t.interpolation, ['linear', 'smooth', 'step'], `${path}.interpolation`);
    if(t.sourceSpan!==undefined)errors.push(...validateSourceSpan(t.sourceSpan,path+'.sourceSpan'));
    if (!Array.isArray(t.keys) || !t.keys.length) { error('TRACK_KEYS', 'At least one keyframe is required.', `${path}.keys`); return; }
    if(t.segmentEasings!==undefined){
      if(b.version!=='0.3')error('TRACK_VERSION','Segment easing requires Bundle 0.3.',path+'.segmentEasings');
      if(!Array.isArray(t.segmentEasings)||t.segmentEasings.length!==t.keys.length-1)error('TRACK_EASINGS','Expected one easing per outgoing key interval.',path+'.segmentEasings');
      else t.segmentEasings.forEach((e:unknown,j:number)=>choice(e,['linear','smooth','step'],`${path}.segmentEasings[${j}]`));
    }
    if(t.leftValues!==undefined){
      if(b.version!=='0.3')error('TRACK_VERSION','Incoming key values require Bundle 0.3.',path+'.leftValues');
      if(!Array.isArray(t.leftValues)||t.leftValues.length!==t.keys.length||t.leftValues[0]!==null)error('TRACK_LEFT_VALUES','Expected one incoming value/null per key; the first entry must be null.',path+'.leftValues');
      else t.leftValues.forEach((value:unknown,j:number)=>{
        if(value===null)return;
        if(spec?.size)tuple(value,spec.size,`${path}.leftValues[${j}]`);else if(spec)number(value,`${path}.leftValues[${j}]`,spec);
      });
    }
    let previous = -Infinity;
    t.keys.forEach((key: unknown, j: number) => {
      const kp = `${path}.keys[${j}]`;
      if (!Array.isArray(key) || key.length !== 2) { error('KEYFRAME', 'Expected [time, value].', kp); return; }
      number(key[0], `${kp}[0]`, { min: 0, max: finite(b.duration) ? b.duration : undefined });
      if (finite(key[0]) && key[0] <= previous) error('TIME_ORDER', 'Keyframe times must strictly increase.', `${kp}[0]`);
      previous = key[0];
      if (spec?.size) tuple(key[1], spec.size, `${kp}[1]`);
      else if (spec) number(key[1], `${kp}[1]`, spec);
    });
  });
  const dependencyGraph = new Map([...parentGraph].map(([id, parents]) => [id, [...parents]]));
  const connectTargets = new Set<string>();
  const inverseTargets = new Set<string>();
  if (!Array.isArray(b.relations)) error('RELATIONS', 'Expected relations array.', '$.relations');
  else b.relations.forEach((r: unknown, i: number) => {
    const path = `$.relations[${i}]`;
    if (!object(r)) { error('RELATION_TYPE', 'Expected relation object.', path); return; }
    if (r.sourceSpan !== undefined) errors.push(...validateSourceSpan(r.sourceSpan,path + '.sourceSpan'));
    if(r.type==='pointOnPath'||r.type==='pathDirection'){
      if(b.version!=='0.3')error('PATH_VERSION','Path sampling relations require version 0.3.',path);
      const expected=r.type==='pointOnPath'?{target:'point',source:'path'}:{target:'line',source:'path',point:'point'};
      for(const [key,kind]of Object.entries(expected)){
        string(r[key],`${path}.${key}`);
        if(nodes.get(r[key])?.kind!==kind)error('RELATION_NODE_KIND',`${key} must identify an existing ${kind}.`,`${path}.${key}`);
      }
      if(!nodes.get(r.source)?.geometry)error('PATH_GEOMETRY_REQUIRED','Path sampling requires structured geometry.',path+'.source');
      inverseTargets.add(r.target);
      if(r.type==='pointOnPath'){
        if(r.mode!==undefined)choice(r.mode,['parameter','length'],path+'.mode');
        if(r.tolerance!==undefined)number(r.tolerance,path+'.tolerance',{strictMin:0});
      }else{
        number(r.length,path+'.length',{strictMin:0});
        if(r.normal!==undefined&&typeof r.normal!=='boolean')error('PATH_NORMAL','normal must be boolean.',path+'.normal');
        if(r.mode!==undefined||r.tolerance!==undefined)error('PATH_DIRECTION_SAMPLING','Direction inherits sampling from its pointOnPath relation.',path);
      }
      for(const property of relationOutputs(r as Relation))write(r.target,property,path);
      dependencyGraph.set(r.target,[...(dependencyGraph.get(r.target)??[]),...relationSources(r as Relation)]);
      return;
    }
    if (r.type === 'connect' || r.type === 'pathLabel') {
      string(r.target, `${path}.target`);
      const target = nodes.get(r.target), targetKind = r.type === 'connect' ? 'path' : 'tex';
      if (!target) error('RELATION_REFERENCE', `Missing node ${r.target}.`, `${path}.target`);
      else if (target.kind !== targetKind) error('RELATION_NODE_KIND', `target must refer to a ${targetKind} node.`, `${path}.target`);
      inverseTargets.add(r.target);
      const sources: string[] = [];
      if (r.type === 'connect') {
        if(target?.geometry)error('CONFLICTING_WRITERS','A path cannot have both authored geometry and a connect writer.',path);
        connectTargets.add(r.target);
        for (const key of ['from', 'to']) {
          const endpoint = r[key];
          if (!object(endpoint)) { error('ANCHOR_REFERENCE', 'Expected {node, anchor}.', `${path}.${key}`); continue; }
          string(endpoint.node, `${path}.${key}.node`); string(endpoint.anchor, `${path}.${key}.anchor`);
          const owner = nodes.get(endpoint.node);
          if (!owner) error('RELATION_REFERENCE', `Missing node ${endpoint.node}.`, `${path}.${key}.node`);
          else if (owner.kind !== 'group') error('RELATION_NODE_KIND', 'Anchors belong to group nodes.', `${path}.${key}.node`);
          else if (!object(owner.anchors) || !own(owner.anchors, endpoint.anchor)) error('ANCHOR_REFERENCE', `Missing anchor ${endpoint.node}.${endpoint.anchor}.`, `${path}.${key}.anchor`);
          if (nonempty(endpoint.node)) sources.push(endpoint.node);
        }
        if (r.bend !== undefined) number(r.bend, `${path}.bend`);
      } else {
        string(r.path, `${path}.path`);
        if (!nodes.has(r.path)) error('RELATION_REFERENCE', `Missing node ${r.path}.`, `${path}.path`);
        else if (nodes.get(r.path)?.kind !== 'path') error('RELATION_NODE_KIND', 'path must refer to a path node.', `${path}.path`);
        if (nonempty(r.path)) sources.push(r.path);
        number(r.position, `${path}.position`, { min: 0, max: 1 }); number(r.offset, `${path}.offset`);
        if (r.rotate !== undefined && typeof r.rotate !== 'boolean') error('LABEL_ROTATE', 'rotate must be boolean.', `${path}.rotate`);
      }
      for (const property of relationOutputs(r as Relation)) write(r.target, property, path);
      dependencyGraph.set(r.target, [...(dependencyGraph.get(r.target) ?? []), ...sources]);
      return;
    }
    const expected: Record<string, string>[] = r.type === 'pointOnEllipse' ? [{ target: 'point', source: 'ellipse' }]
      : r.type === 'tangent' ? [{ target: 'line', source: 'ellipse', point: 'point' }]
      : r.type === 'attach' ? [{ target: 'tex', source: 'point' }]
      : r.type === 'lineBetween' ? [{ target: 'line', a: 'point', b: 'point' }] : [];
    if (!expected.length) { error('RELATION_KIND', `Unsupported relation ${r.type}.`, `${path}.type`); return; }
    const participants: Obj[] = [];
    for (const [key, kind] of Object.entries(expected[0])) {
      string(r[key], `${path}.${key}`);
      const n = nodes.get(r[key]);
      if (!n) error('RELATION_REFERENCE', `Missing node ${r[key]}.`, `${path}.${key}`);
      else {
        participants.push(n);
        if (n.kind !== kind) error('RELATION_NODE_KIND', `${key} must refer to a ${kind} node.`, `${path}.${key}`);
        const tr = n.transform;
        const identity = !tr || (object(tr) && (tr.translate === undefined || (Array.isArray(tr.translate) && tr.translate.every((v: number) => v === 0))) && (tr.rotate === undefined || tr.rotate === 0) && (tr.scale === undefined || (Array.isArray(tr.scale) && tr.scale.every((v: number) => v === 1))));
        if (!identity || transformTargets.has(n.id)) error('RELATION_LOCAL_TRANSFORM', 'v0.1 relation participants require identity local transforms; transform their shared parent group instead.', `${path}.${key}`);
      }
    }
    if (participants.some(n => n.parent !== participants[0]?.parent)) error('RELATION_COORDINATE_SPACE', 'All participants must have the same parent coordinate space.', path);
    if (r.type === 'tangent') number(r.length, `${path}.length`, { strictMin: 0 });
    if (r.type === 'attach') tuple(r.offset, 2, `${path}.offset`);
    const relation = r as Relation;
    for (const property of relationOutputs(relation)) write(r.target, property, path);
    dependencyGraph.set(r.target, [...(dependencyGraph.get(r.target) ?? []), ...relationSources(relation)]);
  });
  checkCycles(dependencyGraph, 'RELATION_CYCLE');
  if (Array.isArray(b.relations)) b.relations.forEach((r: any, i: number) => {
    if (object(r) && r.type === 'pathLabel' && !connectTargets.has(r.path)) error('PATH_LABEL_GEOMETRY', 'pathLabel requires a path generated by a connect relation.', `$.relations[${i}].path`);
    if(object(r)&&r.type==='pathDirection'){
      const producer=b.relations.find((other:any)=>object(other)&&other.type==='pointOnPath'&&other.target===r.point);
      if(!producer||producer.source!==r.source)error('PATH_POINT_SOURCE','Direction point must sample the same path via pointOnPath.',`$.relations[${i}].point`);
    }
  });
  for (const [id, n] of nodes) if (n.kind === 'path' && (n.arrowStart || n.arrowEnd) && !connectTargets.has(id) && !n.geometry) error('ARROW_GEOMETRY', 'Arrowheads require editable geometry or a connect relation.', `$.nodes.${id}`);
  // Every matrix inverted for a connector or label must remain nonsingular.
  // Continuous scale interpolation crossing zero is rejected up front; runtime
  // inversion also checks composed matrices for numerical overflow.
  const inverseChain = new Set<string>();
  for (const id of inverseTargets) {
    let current: string | undefined = id;
    const seen = new Set<string>();
    while (current !== undefined && !seen.has(current)) { seen.add(current); inverseChain.add(current); current = nodes.get(current)?.parent; }
  }
  for (const id of inverseChain) {
    const scale = nodes.get(id)?.transform?.scale;
    if (Array.isArray(scale) && scale.some((v: number) => v === 0)) error('SINGULAR_TRANSFORM', `Inverse coordinate space ${id} has zero scale.`, `$.nodes.${id}.transform.scale`);
  }
  if (Array.isArray(b.tracks)) b.tracks.forEach((t: any, i: number) => {
    if (!object(t) || !inverseChain.has(t.target) || t.property !== 'transform.scale' || !Array.isArray(t.keys)) return;
    if(!errors.some(d=>d.severity==='error')&&trackHasSingularScale(t as Track))error('SINGULAR_TRANSFORM', 'Scale animation makes an inverse coordinate space singular.', `$.tracks[${i}].keys`);
  });
  if (b.document !== undefined && (!object(b.document) || !Array.isArray(b.document.blocks))) error('DOCUMENT', 'document.blocks must be an array.', '$.document');
  if (b.diagnostics !== undefined) {
    if (!Array.isArray(b.diagnostics)) error('DIAGNOSTICS', 'diagnostics must be an array.', '$.diagnostics');
    else b.diagnostics.forEach((d: unknown, i: number) => {
      if (!object(d) || !['error', 'warning'].includes(d.severity) || !nonempty(d.code) || !nonempty(d.message)) error('DIAGNOSTIC_SHAPE', 'Expected severity, code and message.', `$.diagnostics[${i}]`);
      else errors.push(d as Diagnostic);
    });
  }
  if (b.operationGraph !== undefined) {
    if (b.version !== '0.3') error('OPERATION_BUNDLE_VERSION', 'Operation graphs require bundle version 0.3.', '$.operationGraph');
    if (!errors.some(d => d.severity === 'error')) errors.push(...validateOperationGraphInContext(b.operationGraph, b as Bundle));
  }
  if (b.expressions !== undefined && !errors.some(d => d.severity === 'error')) errors.push(...validateExpressionProgramInContext(b.expressions,b as Bundle));
  if (b.fields !== undefined && !errors.some(d => d.severity === 'error')) errors.push(...validateFieldProgramInContext(b.fields,b as Bundle));
  if (b.deformations !== undefined && !errors.some(d => d.severity === 'error')) errors.push(...validateDeformationProgramInContext(b.deformations,b as Bundle));
  if (b.plots !== undefined && !errors.some(d => d.severity === 'error')) errors.push(...validatePlotProgramInContext(b.plots,b as Bundle));
  if (b.morphs !== undefined && !errors.some(d => d.severity === 'error')) errors.push(...validateMorphProgramInContext(b.morphs,b as Bundle));
  if (b.mathTransforms !== undefined && !errors.some(d => d.severity === 'error')) errors.push(...validateMathTransformProgramInContext(b.mathTransforms,b as Bundle));
  if (b.traces !== undefined && !errors.some(d => d.severity === 'error')) errors.push(...validateTraceProgramInContext(b.traces,b as Bundle));
  if (b.presentation !== undefined && !errors.some(d => d.severity === 'error')) errors.push(...validatePresentationProgramInContext(b.presentation,b as Bundle));
  if (b.surfaces !== undefined && !errors.some(d => d.severity === 'error')) errors.push(...validateSurfaceProgramInContext(b.surfaces,b as Bundle));
  if (b.curves3d !== undefined && !errors.some(d => d.severity === 'error')) errors.push(...validateCurveProgram3DInContext(b.curves3d,b as Bundle));
  if (b.meshAttributes !== undefined && !errors.some(d => d.severity === 'error')) errors.push(...validateMeshAttributeProgramInContext(b.meshAttributes,b as Bundle));
  if (b.bakes !== undefined && !errors.some(d => d.severity === 'error')) {if(b.version!=='0.3')error('BAKE_BUNDLE_VERSION','Temporal bakes require Bundle 0.3.','$.bakes');else errors.push(...validateBakeRegistry(b.bakes));}
  if (b.sampledFields !== undefined && !errors.some(d => d.severity === 'error')) errors.push(...validateSampledFieldProgramInContext(b.sampledFields,b as Bundle));
  if (b.fieldVisualization !== undefined && !errors.some(d => d.severity === 'error')) errors.push(...validateFieldVisualizationProgramInContext(b.fieldVisualization,b as Bundle));
  if (b.instances !== undefined && !errors.some(d => d.severity === 'error')) errors.push(...validateInstanceProgramInContext(b.instances,b as Bundle));
  if (b.space3d !== undefined && !errors.some(d => d.severity === 'error')) {
    if(b.version!=='0.3')error('SPACE3D_VERSION','3D spaces require Bundle 0.3.','$.space3d');
    else errors.push(...validateSpace3DInContext(b.space3d,instanceValidationResources(b.instances,fieldVisualizationValidationResources(b.fieldVisualization,sampledFieldValidationResources(b.sampledFields,meshAttributeValidationResources(b.meshAttributes,curveValidationResources(b.curves3d,surfaceValidationResources(b.surfaces,b.resources))),b.bakes))),'$.space3d',{viewport:b.viewport,duration:b.duration},{...fieldVisualizationValidationSets(b.fieldVisualization),...instanceValidationSets(b.instances)}));
  }
  if(b.timeline!==undefined&&!errors.some(d=>d.severity==='error')){
    if(b.version!=='0.3')error('TIMELINE_VERSION','Timeline metadata requires Bundle 0.3.','$.timeline');
    else errors.push(...validateTimelineMetadata(b.timeline,b.duration));
  }
  return errors;
}

export class BundleValidationError extends Error {
  constructor(public readonly diagnostics: Diagnostic[]) {
    super(diagnostics.filter(d => d.severity === 'error').map(d => `${d.code}${d.path ? ` at ${d.path}` : ''}: ${d.message}`).join('\n'));
    this.name = 'BundleValidationError';
  }
}
export function assertBundle(bundle: unknown): asserts bundle is Bundle {
  const diagnostics = validateBundle(bundle);
  if (diagnostics.some(d => d.severity === 'error')) throw new BundleValidationError(diagnostics);
}
