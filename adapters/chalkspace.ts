import type {Bundle, EvaluatedFrame} from '../src/index.ts';
import {evaluate} from '../src/index.ts';
import {renderSvg} from '../src/render-svg.ts';

export interface BoardPlacement {
  x: number; y: number; width: number;
}
/**
 * Bridge to a Chalkspace overlay, preserving a single evaluator and full vector
 * compositing. x is centered board x; y is downward from board top.
 * This does not infer chalk strokes or translate all old lecture actions.
 */
export function placeOnChalkspace(bundle: Bundle, time: number, placement: BoardPlacement): {
  frame: EvaluatedFrame;
  localToBoard: [number, number, number, number, number, number];
  bounds: {x: number; y: number; width: number; height: number};
  svg: string;
} {
  const {x, y, width} = placement;
  if (![x, y, width].every(Number.isFinite) || width <= 0) throw new Error('Invalid board placement.');
  const frame = evaluate(bundle, time);
  const scale = width / bundle.viewport.width;
  const height = bundle.viewport.height * scale;
  return {
    frame,
    localToBoard: [scale, 0, 0, scale, x - width/2, y],
    bounds: {x: x-width/2, y, width, height},
    svg: renderSvg(frame, {background: 'transparent'}),
  };
}
