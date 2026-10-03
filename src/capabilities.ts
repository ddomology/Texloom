import type {Bundle, PaintItem} from './schema.js';

/** Versioned renderer vocabulary. Semantic operations are evaluated upstream. */
export const VECTOR_2D_FEATURES = [
  'path.2d', 'primitive.2d', 'tex.outlines', 'field.scalar-grid.2d',
  'transform.affine.2d', 'paint.clip', 'paint.opacity', 'paint.dash',
  'paint.current-color', 'path.arrowheads',
] as const;
export const SPATIAL_3D_FEATURES=['mesh.triangles.3d','transform.affine.3d','camera.affine.3d'] as const;
export type RenderFeature = typeof VECTOR_2D_FEATURES[number]|typeof SPATIAL_3D_FEATURES[number];
export interface CapabilityProfile {
  readonly id: string;
  readonly contract: 'texloom-render/1';
  readonly features: readonly string[];
}
export const SVG_2D_PROFILE: CapabilityProfile = Object.freeze({
  id: 'texloom.svg2d/1', contract: 'texloom-render/1', features: Object.freeze([...VECTOR_2D_FEATURES]),
});
export const CANVAS_2D_PROFILE: CapabilityProfile = Object.freeze({
  id: 'texloom.canvas2d/1', contract: 'texloom-render/1', features: Object.freeze([...VECTOR_2D_FEATURES]),
});
/** Core numeric evaluator only; this profile does not promise rasterization or projection. */
export const NUMERIC_3D_PROFILE: CapabilityProfile = Object.freeze({
  id:'texloom.numeric3d/1',contract:'texloom-render/1',features:Object.freeze([...VECTOR_2D_FEATURES,...SPATIAL_3D_FEATURES]),
});
export interface CapabilityReport {
  profile: string; compatible: boolean; required: string[]; unsupported: string[];
}
/** No implicit flattening, dropping, or selection of a lossy fallback. */
export function checkCapabilities(required: readonly string[], profile: CapabilityProfile): CapabilityReport {
  if (profile.contract !== 'texloom-render/1') throw new Error(`Unsupported renderer contract: ${profile.contract}`);
  const normalized = [...new Set(required)].sort();
  const unsupported = normalized.filter(feature => !profile.features.includes(feature));
  return {profile: profile.id, compatible: unsupported.length === 0, required: normalized, unsupported};
}
export function requireCapabilities(required: readonly string[], profile: CapabilityProfile): CapabilityReport {
  const report = checkCapabilities(required, profile);
  if (!report.compatible) throw new Error(`RENDER_CAPABILITY: ${profile.id} cannot render ${report.unsupported.join(', ')}`);
  return report;
}

/** Call after bundle validation; inventories every resource, even a hidden one. */
export function sceneFeatures(bundle: Bundle): RenderFeature[] {
  const features = new Set<RenderFeature>();
  const paint = (item: {style?: PaintItem['style']; clip?: unknown; transform?: unknown}) => {
    if (item.clip) features.add('paint.clip');
    if (item.transform) features.add('transform.affine.2d');
    const s = item.style;
    if (s?.opacity !== undefined || s?.fillOpacity !== undefined || s?.strokeOpacity !== undefined) features.add('paint.opacity');
    if (s?.dash?.length) features.add('paint.dash');
    if (s?.fill === 'currentColor' || s?.stroke === 'currentColor') features.add('paint.current-color');
  };
  const vector = (items: PaintItem[]) => {
    for (const item of items) {
      paint(item);
      if (item.kind === 'path') features.add('path.2d');
      if (item.children) vector(item.children);
    }
  };
  for (const node of bundle.nodes) {
    paint(node);
    if (node.kind === 'path') {
      features.add('path.2d');
      if (node.arrowStart || node.arrowEnd || node.arrows) features.add('path.arrowheads');
    } else if (node.kind === 'tex') features.add('tex.outlines');
    else if (node.kind === 'field') features.add('field.scalar-grid.2d');
    else if (node.kind !== 'group') features.add('primitive.2d');
  }
  for (const resource of Object.values(bundle.resources)) {
    if (resource.kind === 'vector') vector(resource.items);
    if (resource.kind === 'mesh') features.add('mesh.triangles.3d');
  }
  if(bundle.space3d){
    features.add('transform.affine.3d');
    if(bundle.space3d.camera)features.add('camera.affine.3d');
    if(bundle.space3d.nodes.some(n=>n.kind==='mesh'))features.add('mesh.triangles.3d');
  }
  for (const track of bundle.tracks) {
    if (track.property.startsWith('arrows.')) features.add('path.arrowheads');
    if (track.property.startsWith('transform.')) features.add('transform.affine.2d');
    if (['style.opacity', 'style.fillOpacity', 'style.strokeOpacity'].includes(track.property)) features.add('paint.opacity');
  }
  for (const binding of [...(bundle.operationGraph?.bindings ?? []),...(bundle.expressions?.bindings ?? []),...(bundle.fields?.bindings ?? [])]) {
    if (binding.property.startsWith('arrows.')) features.add('path.arrowheads');
    if (binding.property === 'transform' || binding.property.startsWith('transform.')) features.add('transform.affine.2d');
    if (['style.opacity','style.fillOpacity','style.strokeOpacity'].includes(binding.property)) features.add('paint.opacity');
  }
  return [...features].sort();
}
