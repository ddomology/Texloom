import type {Clip, EvaluatedFrame, Matrix, Node, PaintItem, PathNode, Style, Transform} from './schema.js';
import {fieldColor} from './render-svg.js';

export interface CanvasOptions {
  background?: string;
  /** Target extent in backing pixels; does not resize the host canvas. */
  width?: number;
  height?: number;
  /** Clear the target extent before painting, subject to the host's clip. */
  clear?: boolean;
  /** Return an independent context. Its canvas is reset before every use. */
  createSurface?: (width: number, height: number) => CanvasRenderingContext2D;
}

interface PaintState {
  fill: string; stroke: string; color: string;
  strokeWidth: number; fillOpacity: number; strokeOpacity: number;
  dash: number[]; lineCap: CanvasLineCap; lineJoin: CanvasLineJoin;
  miterLimit: number; fillRule: CanvasFillRule;
}
const INITIAL: PaintState = {
  fill: '#e7eee4', stroke: 'none', color: '#e7eee4', strokeWidth: 1,
  fillOpacity: 1, strokeOpacity: 1, dash: [], lineCap: 'butt', lineJoin: 'miter',
  miterLimit: 4, fillRule: 'nonzero',
};
const STYLE_KEYS = new Set(['fill', 'stroke', 'strokeWidth', 'opacity', 'dash', 'fillOpacity',
  'strokeOpacity', 'miterLimit', 'lineCap', 'lineJoin', 'fillRule']);

function positive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be finite and positive`);
}
function paintSyntax(value: string): void {
  if (typeof value !== 'string' || !value.trim() || /(?:url|var|env)\s*\(/i.test(value)
    || /^(?:inherit|initial|unset|revert(?:-layer)?|context-fill|context-stroke)$/i.test(value.trim())) {
    throw new Error(`Unsupported Canvas paint: ${String(value)}`);
  }
}
function inspectStyle(style: Style | undefined, paints: Set<string>): void {
  if (!style) return;
  for (const key of Object.keys(style)) {
    if (!STYLE_KEYS.has(key)) throw new Error(`Unsupported Canvas paint property: ${key}`);
  }
  for (const color of [style.fill, style.stroke]) {
    if (color !== undefined) {paintSyntax(color); paints.add(color);}
  }
  for (const [key, value] of [['opacity', style.opacity], ['fillOpacity', style.fillOpacity],
    ['strokeOpacity', style.strokeOpacity]] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > 1)) {
      throw new Error(`Canvas ${key} must be between zero and one`);
    }
  }
}
function combine(parent: PaintState, style?: Style, kind?: Node['kind']): PaintState {
  if (!style) return parent;
  const {opacity: _opacity, ...properties} = style;
  let color = parent.color;
  if (kind && style.fill && (style.fill !== 'none' || kind === 'group' || kind === 'tex')) {
    color = style.fill === 'none' ? 'transparent'
      : style.fill === 'currentColor' ? parent.color : style.fill;
  }
  return {...parent, ...properties, color};
}
function nodeTransform(ctx: CanvasRenderingContext2D, transform?: Transform): void {
  if (!transform) return;
  if (transform.translate) ctx.translate(...transform.translate);
  if (transform.rotate !== undefined) ctx.rotate(transform.rotate);
  if (transform.scale) ctx.scale(...transform.scale);
}
function clipPath(ctx: CanvasRenderingContext2D, clip?: Clip & {transform?: Matrix}): void {
  if (!clip) return;
  let path = new Path2D(clip.d);
  if (clip.transform) {
    const [a, b, c, d, e, f] = clip.transform;
    const transformed = new Path2D();
    transformed.addPath(path, {a, b, c, d, e, f});
    path = transformed;
  }
  ctx.clip(path, clip.fillRule ?? 'nonzero');
}
function fillColor(value: string, paint: PaintState): string {
  return value === 'currentColor' ? paint.color : value;
}
function drawPath(ctx: CanvasRenderingContext2D, path: Path2D, paint: PaintState): void {
  ctx.globalCompositeOperation = 'source-over';
  if (paint.fill !== 'none' && paint.fillOpacity > 0) {
    ctx.globalAlpha = paint.fillOpacity;
    ctx.fillStyle = fillColor(paint.fill, paint);
    ctx.fill(path, paint.fillRule);
  }
  if (paint.stroke !== 'none' && paint.strokeWidth > 0 && paint.strokeOpacity > 0) {
    ctx.globalAlpha = paint.strokeOpacity;
    ctx.strokeStyle = fillColor(paint.stroke, paint);
    ctx.lineWidth = paint.strokeWidth;
    ctx.lineCap = paint.lineCap;
    ctx.lineJoin = paint.lineJoin;
    ctx.miterLimit = paint.miterLimit;
    ctx.setLineDash(paint.dash);
    ctx.lineDashOffset = 0;
    ctx.stroke(path);
  }
  ctx.globalAlpha = 1;
}

function arrowPath(node: PathNode, end: boolean): Path2D {
  const path = node.resolvedPath;
  if (!path) throw new Error(`Arrow path ${node.id} has not been evaluated`);
  const tip = end ? path.end : path.start;
  const inner = end ? path.c2 : path.c1;
  let dx = tip[0] - inner[0], dy = tip[1] - inner[1];
  if (Math.hypot(dx, dy) < 1e-10) {
    const opposite = end ? path.start : path.end;
    dx = tip[0] - opposite[0]; dy = tip[1] - opposite[1];
  }
  const length = Math.hypot(dx, dy);
  if (length < 1e-10) throw new Error(`Arrow path ${node.id} has no direction`);
  const ux = dx / length, uy = dy / length, size = node.arrowSize ?? 9;
  const bx = tip[0] - ux * size, by = tip[1] - uy * size;
  const head = new Path2D();
  head.moveTo(...tip);
  head.lineTo(bx - uy * size * .42, by + ux * size * .42);
  head.lineTo(bx + uy * size * .42, by - ux * size * .42);
  head.closePath();
  return head;
}

function defaultSurface(width: number, height: number): CanvasRenderingContext2D {
  if (typeof document === 'undefined') {
    throw new Error('Canvas opacity requires createSurface outside a browser document');
  }
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Unable to create a Canvas 2D compositing surface');
  return ctx;
}

/**
 * Draw an evaluated frame using native Canvas geometry. No timeline, TeX,
 * DOM/SVG rasterization or animation evaluation occurs here. Host state is
 * restored; its existing clip remains active. Pixel antialiasing can differ
 * from SVG despite identical geometry. Styles use isolated compositing opacity.
 */
export function renderCanvas(frame: EvaluatedFrame, ctx: CanvasRenderingContext2D,
  options: CanvasOptions = {}): void {
  const {width: logicalWidth, height: logicalHeight} = frame.viewport;
  const width = options.width ?? ctx.canvas.width;
  const height = options.height ?? ctx.canvas.height;
  positive(width, 'Canvas width'); positive(height, 'Canvas height');
  positive(logicalWidth, 'Scene width'); positive(logicalHeight, 'Scene height');
  positive(ctx.canvas.width, 'Backing canvas width'); positive(ctx.canvas.height, 'Backing canvas height');
  positive(frame.camera.zoom, 'Camera zoom');
  if (![frame.camera.x, frame.camera.y, frame.camera.rotation ?? 0].every(Number.isFinite)) {
    throw new Error('Camera coordinates must be finite');
  }
  const background = options.background ?? '#091c27';
  paintSyntax(background);
  const paints = new Set<string>([background]);
  const byId = new Map<string, Node>();
  const children = new Map<string | undefined, Node[]>();
  for (const node of frame.nodes) {
    if (byId.has(node.id)) throw new Error(`Duplicate scene object: ${node.id}`);
    byId.set(node.id, node);
    const siblings = children.get(node.parent) ?? [];
    siblings.push(node); children.set(node.parent, siblings);
    inspectStyle(node.style, paints);
  }
  for (const node of frame.nodes) {
    if (node.parent !== undefined && byId.get(node.parent)?.kind !== 'group') {
      throw new Error(`Invalid scene parent for ${node.id}: ${node.parent}`);
    }
  }
  const seen = new Set<string>();
  const checkTree = (node: Node): void => {
    if (seen.has(node.id)) throw new Error(`Scene cycle at ${node.id}`);
    seen.add(node.id);
    for (const child of children.get(node.id) ?? []) checkTree(child);
  };
  for (const root of children.get(undefined) ?? []) checkTree(root);
  if (seen.size !== frame.nodes.length) throw new Error('Scene contains an unreachable parent cycle');
  const inspectPaint = (item: PaintItem): void => {
    inspectStyle(item.style, paints);
    for (const child of item.children ?? []) inspectPaint(child);
  };
  for (const resource of Object.values(frame.resources)) {
    if (resource.kind === 'vector') resource.items.forEach(inspectPaint);
  }
  if (typeof Path2D === 'undefined') throw new Error('Canvas renderer requires the native Path2D API');

  // Canvas silently ignores invalid CSS paint assignments. Detect that case
  // using two sentinels, before clearing or drawing the host canvas.
  ctx.save();
  try {
    for (const paint of paints) {
      if (paint === 'none' || paint === 'currentColor') continue;
      ctx.fillStyle = '#010203'; ctx.fillStyle = paint;
      const first = ctx.fillStyle;
      ctx.fillStyle = '#040506'; ctx.fillStyle = paint;
      if (ctx.fillStyle !== first) throw new Error(`Unsupported Canvas paint: ${paint}`);
    }
  } finally {ctx.restore();}

  const createSurface = options.createSurface ?? defaultSurface;
  const activeSurfaces = new Set([ctx.canvas]);
  const withOpacity = (target: CanvasRenderingContext2D, opacity: number,
    draw: (surface: CanvasRenderingContext2D) => void): void => {
    if (opacity === 0) return;
    if (opacity === 1) {draw(target); return;}
    const w = ctx.canvas.width, h = ctx.canvas.height;
    const surface = createSurface(w, h);
    if (!surface || activeSurfaces.has(surface.canvas)) {
      throw new Error('createSurface must return an independent Canvas 2D context');
    }
    activeSurfaces.add(surface.canvas);
    try {
      // Reset stale clips, transforms and paint from a reusable surface factory.
      surface.canvas.width = w; surface.canvas.height = h;
      surface.setTransform(target.getTransform());
      draw(surface);
      target.save();
      try {
        target.resetTransform();
        target.globalCompositeOperation = 'source-over';
        target.globalAlpha = opacity;
        target.drawImage(surface.canvas, 0, 0);
      } finally {target.restore();}
    } finally {activeSurfaces.delete(surface.canvas);}
  };

  const paintItem = (item: PaintItem, target: CanvasRenderingContext2D, inherited: PaintState): void => {
    const paint = combine(inherited, item.style);
    withOpacity(target, item.style?.opacity ?? 1, surface => {
      surface.save();
      try {
        if (item.transform) surface.transform(...item.transform);
        clipPath(surface, item.clip);
        if (item.kind === 'group') {
          for (const child of item.children ?? []) paintItem(child, surface, paint);
        } else if (item.kind === 'path') {
          if (item.d === undefined) throw new Error('Vector path is missing its geometry');
          drawPath(surface, new Path2D(item.d), paint);
        } else throw new Error(`Unsupported vector paint item: ${(item as {kind: string}).kind}`);
      } finally {surface.restore();}
    });
  };
  const renderNode = (node: Node, target: CanvasRenderingContext2D, inherited: PaintState): void => {
    if (node.visible === false) return;
    const paint = combine(inherited, node.style, node.kind);
    withOpacity(target, node.style?.opacity ?? 1, surface => {
      surface.save();
      try {
        nodeTransform(surface, node.transform);
        clipPath(surface, node.clip);
        switch (node.kind) {
          case 'group':
            for (const child of children.get(node.id) ?? []) renderNode(child, surface, paint);
            break;
          case 'path': {
            drawPath(surface, new Path2D(node.d), paint);
            const headPaint = {...paint, fill: paint.stroke, fillOpacity: paint.strokeOpacity, stroke: 'none'};
            if (node.arrowStart) drawPath(surface, arrowPath(node, false), headPaint);
            if (node.arrowEnd) drawPath(surface, arrowPath(node, true), headPaint);
            break;
          }
          case 'ellipse': {
            const path = new Path2D();
            path.ellipse(node.cx, node.cy, node.rx, node.ry, 0, 0, Math.PI * 2);
            drawPath(surface, path, paint); break;
          }
          case 'point': {
            const path = new Path2D(); path.arc(node.x, node.y, node.r, 0, Math.PI * 2);
            drawPath(surface, path, paint); break;
          }
          case 'line': {
            const path = new Path2D(); path.moveTo(node.x1, node.y1); path.lineTo(node.x2, node.y2);
            drawPath(surface, path, {...paint, fill: 'none'}); break;
          }
          case 'tex': {
            const resource = frame.resources[node.resourceId];
            if (!resource || resource.kind !== 'vector') throw new Error(`Missing vector resource: ${node.resourceId}`);
            surface.translate(node.x, node.y); surface.scale(node.scale ?? 1, node.scale ?? 1);
            for (const item of resource.items) paintItem(item, surface, paint);
            break;
          }
          case 'field': {
            const resource = frame.resources[node.resourceId];
            if (!resource || resource.kind !== 'scalar-field') throw new Error(`Missing field resource: ${node.resourceId}`);
            if (!node.values || node.values.length !== resource.columns * resource.rows) {
              throw new Error(`Field ${node.id} has not been evaluated`);
            }
            const cw = node.width / resource.columns, ch = node.height / resource.rows;
            const matrix = surface.getTransform();
            const aligned = Math.abs(matrix.b) < 1e-12 && Math.abs(matrix.c) < 1e-12
              && Math.abs(matrix.a) > 1e-12 && Math.abs(matrix.d) > 1e-12;
            for (let i = 0; i < node.values.length; i++) {
              let x = node.x + (i % resource.columns) * cw;
              let y = node.y + Math.floor(i / resource.columns) * ch;
              let w = cw, h = ch;
              // Match SVG crispEdges for axis-aligned cells. Rotated cells use
              // Canvas's native edge antialiasing, retaining exact geometry.
              if (aligned) {
                const right = (Math.round(matrix.a * (x + cw) + matrix.e) - matrix.e) / matrix.a;
                const bottom = (Math.round(matrix.d * (y + ch) + matrix.f) - matrix.f) / matrix.d;
                x = (Math.round(matrix.a * x + matrix.e) - matrix.e) / matrix.a;
                y = (Math.round(matrix.d * y + matrix.f) - matrix.f) / matrix.d;
                w = right - x; h = bottom - y;
              }
              const path = new Path2D(); path.rect(x, y, w, h);
              drawPath(surface, path, {...paint, fill: fieldColor(node.values[i], resource.range)});
            }
            break;
          }
          default: throw new Error(`Unsupported scene object: ${(node as {kind: string}).kind}`);
        }
      } finally {surface.restore();}
    });
  };

  ctx.save();
  try {
    ctx.resetTransform();
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
    ctx.filter = 'none';
    if (options.clear !== false) ctx.clearRect(0, 0, width, height);
    const viewportClip = new Path2D(); viewportClip.rect(0, 0, width, height);
    ctx.clip(viewportClip);
    const scale = Math.min(width / logicalWidth, height / logicalHeight);
    ctx.translate((width - logicalWidth * scale) / 2, (height - logicalHeight * scale) / 2);
    ctx.scale(scale, scale);
    if (background !== 'transparent' && background !== 'none') {
      ctx.fillStyle = background === 'currentColor' ? INITIAL.color : background;
      ctx.fillRect(0, 0, logicalWidth, logicalHeight);
    }
    const camera = frame.camera;
    ctx.translate(logicalWidth / 2, logicalHeight / 2);
    ctx.scale(camera.zoom, camera.zoom);
    ctx.rotate(-(camera.rotation ?? 0));
    ctx.translate(-logicalWidth / 2 - camera.x, -logicalHeight / 2 - camera.y);
    for (const root of children.get(undefined) ?? []) renderNode(root, ctx, INITIAL);
  } finally {ctx.restore();}
}
