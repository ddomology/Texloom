import type {Bundle} from '../src/index.ts';
import {evaluate} from '../src/index.ts';
import {renderSvg} from '../src/render-svg.ts';

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
let figureSerial = 0;

/** A responsive static figure; the document flow remains owned by Lemniro. */
export function renderLemniroFigure(bundle: Bundle, time = 0, caption = bundle.title, instanceId = `lemniro-${++figureSerial}`): string {
  const svg = renderSvg(evaluate(bundle, time), {idPrefix:instanceId}).replace('<svg ', '<svg style="display:block;width:100%;height:auto" ');
  return `<figure class="texloom-figure" style="margin:0;max-width:100%"><div style="width:100%;aspect-ratio:${bundle.viewport.width}/${bundle.viewport.height}">${svg}</div><figcaption>${escapeHtml(caption)}</figcaption></figure>`;
}

/** Embed the independently packaged player without leaking TeX tools into the site. */
export function renderLemniroPlayer(playerUrl: string, title = 'Texloom scene'): string {
  if (/^\s*(javascript|data):/i.test(playerUrl)) throw new Error('Use a hosted or relative player URL.');
  return `<iframe title="${escapeHtml(title)}" src="${escapeHtml(playerUrl)}" loading="lazy" style="width:100%;height:720px;border:0;border-radius:12px" allow="fullscreen"></iframe>`;
}
