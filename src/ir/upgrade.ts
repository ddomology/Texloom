import type {Bundle, Node, Relation} from '../schema.js';
import {relationOutputs} from '../schema.js';
import type {SourceSpan} from './operations.js';
import {getLegacyOperator} from '../operations/builtins/legacy.js';
import {transformReads, type PropertyAccess} from '../operations/properties.js';

export interface LoweredRelation {
  id: string; operator: string; version: 1; relation: Relation;
  path: string; sourceSpan?: SourceSpan; reads: PropertyAccess[]; writes: PropertyAccess[];
  /** An explicit sample output dependency, distinct from a node property read. */
  dependencies: string[];
}

/** Preserve authored v0.1–v0.3 relations; lower intent without rewriting sources. */
export function lowerRelations(bundle: Bundle): LoweredRelation[] {
  const nodes = new Map(bundle.nodes.map(node => [node.id,node]));
  const sampled = new Map(bundle.relations.flatMap((r,i) => r.type === 'pointOnPath' ? [[r.target,`relation:${i}`] as const] : []));
  const properties = (node: string, ...names: string[]): PropertyAccess[] => names.map(property => ({node,property}));
  const world = (node: string | undefined) => transformReads(node,nodes);
  return bundle.relations.map((relation,index) => {
    const r = relation, target = nodes.get(r.target) as Node;
    let reads: PropertyAccess[] = [], dependencies: string[] = [];
    switch (r.type) {
      case 'pointOnPath':
        reads = [...properties(r.source,'geometry','pathTolerance'),...properties(r.target,'progress'),...world(r.source),...world(r.target)]; break;
      case 'pathDirection':
        reads = [...properties(r.point,'x','y'),...world(r.source),...world(r.point),...world(r.target)];
        dependencies = [sampled.get(r.point)!]; break;
      case 'connect': reads = [...properties(r.from.node,'anchors'),...properties(r.to.node,'anchors'),...world(r.from.node),...world(r.to.node),...world(r.target)]; break;
      case 'pathLabel':
        reads = [...properties(r.path,'resolvedPath'),...world(r.path),...world(target.parent),
          ...properties(r.target,'scale','transform.translate','transform.scale',...(!r.rotate ? ['transform.rotate'] : []))]; break;
      case 'pointOnEllipse': reads = [...properties(r.source,'cx','cy','rx','ry'),...properties(r.target,'phase')]; break;
      case 'tangent': reads = [...properties(r.source,'cx','cy','rx','ry'),...properties(r.point,'phase')]; break;
      case 'attach': reads = properties(r.source,'x','y'); break;
      case 'lineBetween': reads = [...properties(r.a,'x','y'),...properties(r.b,'x','y')]; break;
    }
    const definition = getLegacyOperator(r.type);
    const outputs = relationOutputs(r);
    if (r.type === 'connect') outputs.push('resolvedPath');
    return {id:`relation:${index}`,operator:definition.name,version:definition.version,relation:r,
      path:`$.relations[${index}]`,...(r.sourceSpan ? {sourceSpan:r.sourceSpan} : {}),
      reads,writes:properties(r.target,...outputs),dependencies};
  });
}
