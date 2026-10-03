import type { EvaluatedFrame, Node, PaintItem, PathNode, Style } from './index.js';
import {pathGeometryData} from './path-geometry.js';
import {legacyArrowPoints} from './geometry/arrowheads.js';

export interface SvgOptions {
  background?: string;
  width?: number;
  height?: number;
  /** Unique per inline SVG instance in a shared HTML document. */
  idPrefix?: string;
}

const escapeXml = (value: string): string => value.replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
}[c]!));

const number = (value: number): string => {
  if (!Number.isFinite(value)) throw new Error(`Non-finite SVG coordinate: ${value}`);
  return Object.is(value, -0) ? '0' : String(value);
};

function styleAttributes(style: Style | undefined): string {
  if (!style) return '';
  const names: Record<string, string> = {
    fill: 'fill', stroke: 'stroke', strokeWidth: 'stroke-width', opacity: 'opacity',
    lineCap: 'stroke-linecap', lineJoin: 'stroke-linejoin', fillRule: 'fill-rule',
    fillOpacity: 'fill-opacity', strokeOpacity: 'stroke-opacity', miterLimit: 'stroke-miterlimit',
  };
  const attributes: string[] = [];
  for (const [key, value] of Object.entries(style)) {
    if (value === undefined) continue;
    if (key === 'dash') {
      attributes.push(`stroke-dasharray="${(value as number[]).map(number).join(' ')}"`);
    } else if (names[key]) {
      attributes.push(`${names[key]}="${escapeXml(String(value))}"`);
    } else {
      throw new Error(`Unsupported SVG paint property: ${key}`);
    }
  }
  return attributes.length ? ` ${attributes.join(' ')}` : '';
}

function matrixAttribute(matrix?: readonly number[]): string {
  return matrix ? ` transform="matrix(${matrix.map(number).join(' ')})"` : '';
}

function nodeTransform(node: Node): string {
  if (!node.transform) return '';
  const { translate, rotate, scale } = node.transform;
  const operations: string[] = [];
  if (translate) operations.push(`translate(${translate.map(number).join(' ')})`);
  if (rotate !== undefined) operations.push(`rotate(${number(rotate * 180 / Math.PI)})`);
  if (scale) operations.push(`scale(${scale.map(number).join(' ')})`);
  return operations.length ? ` transform="${operations.join(' ')}"` : '';
}

/** A perceptually ordered blue / cream / coral map, evaluated values only. */
export function fieldColor(value: number, range: readonly number[]): string {
  if (!Number.isFinite(value)) throw new Error('Non-finite scalar field value');
  const span = range[1] - range[0];
  const t = span === 0 ? 0.5 : Math.max(0, Math.min(1, (value - range[0]) / span));
  const stops = [[69, 115, 183], [243, 233, 201], [207, 95, 79]];
  const half = t < 0.5 ? 0 : 1;
  const alpha = t < 0.5 ? t * 2 : (t - 0.5) * 2;
  const rgb = stops[half].map((channel, i) => Math.round(channel + (stops[half + 1][i] - channel) * alpha));
  return `rgb(${rgb.join(',')})`;
}

/** Render a fully evaluated frame. No clock, TeX compiler, or animation logic is used here. */
export function renderSvg(frame: EvaluatedFrame, options: SvgOptions = {}): string {
  if(frame.space3d||Object.values(frame.resources).some(r=>r.kind==='mesh'))throw new Error('RENDER_CAPABILITY: SVG 2D cannot render mesh/space3d. Use the explicit GPU scene compositor for projected 3D scenes.');
  const { width: logicalWidth, height: logicalHeight } = frame.viewport;
  const width = options.width ?? logicalWidth;
  const height = options.height ?? logicalHeight;
  if (width <= 0 || height <= 0 || logicalWidth <= 0 || logicalHeight <= 0) {
    throw new Error('SVG dimensions must be positive');
  }
  const defs: string[] = [];
  const prefix = options.idPrefix ?? 'tl';
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(prefix)) throw new Error('SVG idPrefix must be an XML-safe identifier.');
  let serial = 0;
  const clipAttribute = (clip?: { d: string; transform?: number[]; fillRule?: string }): string => {
    if (!clip) return '';
    const id = `${prefix}-clip-${serial++}`;
    defs.push(`<clipPath id="${id}" clipPathUnits="userSpaceOnUse"><path d="${escapeXml(clip.d)}"${matrixAttribute(clip.transform)}${clip.fillRule ? ` clip-rule="${escapeXml(clip.fillRule)}"` : ''}/></clipPath>`);
    return ` clip-path="url(#${id})"`;
  };
  const paintItem = (item: PaintItem): string => {
    const attrs = matrixAttribute(item.transform) + styleAttributes(item.style) + clipAttribute(item.clip);
    switch (item.kind) {
      case 'group': return `<g${attrs}>${(item.children ?? []).map(paintItem).join('')}</g>`;
      case 'path':
        if (item.d === undefined) throw new Error('Vector path is missing its geometry');
        return `<path d="${escapeXml(item.d)}"${attrs}/>`;
      default: throw new Error(`Unsupported vector paint item: ${(item as { kind: string }).kind}`);
    }
  };
  const resourceIds = new Map<string, string>();
  const vectorResource = (key: string): string => {
    const existing = resourceIds.get(key);
    if (existing) return existing;
    const resource = frame.resources[key];
    if (!resource || resource.kind !== 'vector') throw new Error(`Missing vector resource: ${key}`);
    const id = `${prefix}-vector-${resourceIds.size}`;
    resourceIds.set(key, id);
    const contents = resource.items.map(paintItem).join('');
    defs.push(`<g id="${id}">${contents}</g>`);
    return id;
  };

  const nodes = new Map<string, Node>();
  const children = new Map<string | undefined, Node[]>();
  for (const node of frame.nodes) {
    if (nodes.has(node.id)) throw new Error(`Duplicate scene object: ${node.id}`);
    nodes.set(node.id, node);
    const siblings = children.get(node.parent) ?? [];
    siblings.push(node);
    children.set(node.parent, siblings);
  }
  for (const node of frame.nodes) {
    if (node.parent && (!nodes.has(node.parent) || nodes.get(node.parent)!.kind !== 'group')) {
      throw new Error(`Invalid scene parent for ${node.id}: ${node.parent}`);
    }
  }
  const visited = new Set<string>();
  // SVG paint properties inherit, while compositing opacity does not. Keep
  // arrowhead fill coupled to the shaft's inherited stroke without applying
  // an object's opacity separately to its overlapping pieces.
  const inheritedStroke = (node: Node): {color: string; opacity: number} => {
    let color: string | undefined;
    let opacity: number | undefined;
    let current: Node | undefined = node;
    const seen = new Set<string>();
    while (current) {
      if (seen.has(current.id)) throw new Error(`Scene cycle at ${current.id}`);
      seen.add(current.id);
      color ??= current.style?.stroke;
      opacity ??= current.style?.strokeOpacity;
      current = current.parent ? nodes.get(current.parent) : undefined;
    }
    return {color: color ?? 'none', opacity: opacity ?? 1};
  };
  const arrowHead = (node: PathNode, end: boolean): string => {
    const p = node.resolvedPath;
    if (!p) throw new Error(`Arrow path ${node.id} has not been evaluated`);
    const points = legacyArrowPoints(p, end, node.arrowSize ?? 9);
    const paint = inheritedStroke(node);
    return `<polygon data-arrow="${end ? 'end' : 'start'}" points="${points.map(p => p.map(number).join(',')).join(' ')}" fill="${escapeXml(paint.color)}" fill-opacity="${number(paint.opacity)}" stroke="none"/>`;
  };
  const renderNode = (node: Node): string => {
    if (visited.has(node.id)) throw new Error(`Scene cycle at ${node.id}`);
    visited.add(node.id);
    // Mark descendants even when hidden: malformed graphs must not silently vanish.
    const descendants = (children.get(node.id) ?? []).map(renderNode).join('');
    if (node.visible === false) return '';
    // TeX foreground paths use currentColor. Bind that color at every authored
    // node, including groups, so foreground inheritance matches ordinary paint.
    const bindColor = node.style?.fill && (node.style.fill !== 'none' || node.kind === 'group' || node.kind === 'tex');
    const color = bindColor ? ` color="${escapeXml(node.style!.fill === 'none' ? 'transparent' : node.style!.fill!)}"` : '';
    const attrs = ` data-node-id="${escapeXml(node.id)}"` + nodeTransform(node) + styleAttributes(node.style) + clipAttribute(node.clip) + color;
    switch (node.kind) {
      case 'group': return `<g${attrs}>${descendants}</g>`;
      case 'path': {
        if (node.resolvedArrows) {
          const paint = inheritedStroke(node);
          const tip = (end: boolean): string => {
            const geometry = end ? node.resolvedArrows!.endTip : node.resolvedArrows!.startTip;
            if (!geometry.contours.length) return '';
            return `<path data-arrow="${end ? 'end' : 'start'}" d="${escapeXml(pathGeometryData(geometry))}" fill="${escapeXml(paint.color)}" fill-opacity="${number(paint.opacity)}" stroke="none"/>`;
          };
          return `<g${attrs}><path d="${escapeXml(pathGeometryData(node.resolvedArrows.shaft))}" fill="none" stroke-linecap="butt"/>${tip(false)}${tip(true)}</g>`;
        }
        if (!node.arrowStart && !node.arrowEnd) return `<path d="${escapeXml(node.d)}"${attrs}/>`;
        return `<g${attrs}><path d="${escapeXml(node.d)}"/>${node.arrowStart ? arrowHead(node, false) : ''}${node.arrowEnd ? arrowHead(node, true) : ''}</g>`;
      }
      case 'ellipse': return `<ellipse cx="${number(node.cx)}" cy="${number(node.cy)}" rx="${number(node.rx)}" ry="${number(node.ry)}"${attrs}/>`;
      case 'point': return `<circle cx="${number(node.x)}" cy="${number(node.y)}" r="${number(node.r)}"${attrs}/>`;
      case 'line': return `<line x1="${number(node.x1)}" y1="${number(node.y1)}" x2="${number(node.x2)}" y2="${number(node.y2)}"${attrs}/>`;
      case 'tex': {
        const id = vectorResource(node.resourceId);
        const scale = node.scale ?? 1;
        return `<g${attrs}><use href="#${id}" transform="translate(${number(node.x)} ${number(node.y)}) scale(${number(scale)})"/></g>`;
      }
      case 'field': {
        const resource = frame.resources[node.resourceId];
        if (!resource || resource.kind !== 'scalar-field') throw new Error(`Missing field resource: ${node.resourceId}`);
        const values = (node as Node & { values?: number[] }).values;
        if (!values || values.length !== resource.columns * resource.rows) throw new Error(`Field ${node.id} has not been evaluated`);
        const cw = node.width / resource.columns;
        const ch = node.height / resource.rows;
        const cells = values.map((value, i) => `<rect x="${number(node.x + (i % resource.columns) * cw)}" y="${number(node.y + Math.floor(i / resource.columns) * ch)}" width="${number(cw)}" height="${number(ch)}" fill="${fieldColor(value, resource.range)}"/>`).join('');
        return `<g${attrs} shape-rendering="crispEdges">${cells}</g>`;
      }
      default: throw new Error(`Unsupported scene object: ${(node as { kind: string }).kind}`);
    }
  };
  const scene = (children.get(undefined) ?? []).map(renderNode).join('');
  if (visited.size !== frame.nodes.length) throw new Error('Scene contains an unreachable parent cycle');
  const camera = frame.camera;
  if (camera.zoom <= 0) throw new Error('Camera zoom must be positive');
  const cameraTransform = `translate(${number(logicalWidth / 2)} ${number(logicalHeight / 2)}) scale(${number(camera.zoom)}) rotate(${number(-(camera.rotation ?? 0) * 180 / Math.PI)}) translate(${number(-logicalWidth / 2 - camera.x)} ${number(-logicalHeight / 2 - camera.y)})`;
  const background = options.background === undefined ? '#091c27' : options.background;
  const backdrop = background === 'transparent' ? '' : `<rect width="${number(logicalWidth)}" height="${number(logicalHeight)}" fill="${escapeXml(background)}"/>`;
  const descriptions=Object.values(frame.mathTransforms??{}).filter(report=>report.active).map(report=>report.description);
  const descriptionId=`${prefix}-math-description`;
  const describedBy=descriptions.length?` aria-describedby="${descriptionId}"`:'';
  const description=descriptions.length?`<desc id="${descriptionId}">${escapeXml(descriptions.join(' '))}</desc>`:'';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${number(width)}" height="${number(height)}" viewBox="0 0 ${number(logicalWidth)} ${number(logicalHeight)}" role="img" aria-label="Texloom scene at ${number(frame.time)} seconds"${describedBy} color="#e7eee4">${description}<defs>${defs.join('')}</defs>${backdrop}<g transform="${cameraTransform}" fill="#e7eee4" stroke="none">${scene}</g></svg>`;
}
