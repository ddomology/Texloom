/** Minimal native consumer for regression capture, independent of the demo UI. */
import {prepareScene} from '../src/runtime.ts';
import {assertBundle} from '../src/schema.ts';
import {renderCanvas} from '../src/render-canvas.ts';
import {renderSvg} from '../src/render-svg.ts';

Object.assign(window, {portCapture: async (bundle: unknown, time: number) => {
  assertBundle(bundle);
  const frame = prepareScene(bundle).sample(time);
  const canvas = document.createElement('canvas');
  canvas.width = bundle.viewport.width; canvas.height = bundle.viewport.height;
  renderCanvas(frame, canvas.getContext('2d')!);
  const svgCanvas = document.createElement('canvas');
  svgCanvas.width = canvas.width; svgCanvas.height = canvas.height;
  const url = URL.createObjectURL(new Blob([renderSvg(frame, {idPrefix: 'port-reference'})], {type: 'image/svg+xml'}));
  try {
    const image = new Image(); image.src = url; await image.decode();
    svgCanvas.getContext('2d')!.drawImage(image, 0, 0);
    return {svg: svgCanvas.toDataURL('image/png'), canvas: canvas.toDataURL('image/png')};
  } finally { URL.revokeObjectURL(url); }
}});
