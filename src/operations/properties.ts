import type {Node} from '../schema.js';
import type {OperationBinding} from '../ir/operations.js';
import type {Unit} from '../fields/ast.js';

/** Units shared by expression destinations and scalar property input reads. */
export function scalarPropertyUnit(property:string):Unit {
  if(property.startsWith('arrows.')&&!['arrows.start','arrows.end'].includes(property))return 'bp';
  return ['transform.rotate','rotation','phase'].includes(property)?'rad'
    : ['x','y','cx','cy','x1','x2','y1','y2','rx','ry','r','width','height','style.strokeWidth'].includes(property)?'bp':'1';
}

/** Node IDs and property paths are separate, including when an ID has dots. */
export interface PropertyAccess {node: string; property: string}
export function propertiesOverlap(a: PropertyAccess, b: PropertyAccess): boolean {
  return a.node === b.node && (a.property === b.property ||
    a.property.startsWith(b.property + '.') || b.property.startsWith(a.property + '.'));
}
export function bindingProperties(binding: Pick<OperationBinding, 'target'|'property'>, nodes: ReadonlyMap<string, Node>): PropertyAccess[] {
  const {target:node, property} = binding;
  const slots = property === 'position' ? nodes.get(node)?.kind === 'ellipse' ? ['cx','cy'] : ['x','y']
    : property === 'start' ? ['x1','y1'] : property === 'end' ? ['x2','y2']
    : property === 'geometry' ? ['geometry','d'] : [property];
  return slots.map(property => ({node,property}));
}
export function transformReads(id: string | undefined, nodes: ReadonlyMap<string, Node>): PropertyAccess[] {
  const result: PropertyAccess[] = [], seen = new Set<string>();
  while (id !== undefined && !seen.has(id)) {
    seen.add(id); result.push({node:id,property:'transform'}); id = nodes.get(id)?.parent;
  }
  return result;
}
