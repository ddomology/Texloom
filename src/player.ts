import {createEvaluator, validateBundle} from './index.js';
import type {Bundle, EvaluatedFrame, Node} from './index.js';
import {renderSvg} from './render-svg.js';

declare global {
  interface Window {
    texloom: {
      bundle: Bundle;
      ready: Promise<void>;
      render(time: number): EvaluatedFrame;
      getFrame(): EvaluatedFrame;
      downloadSvg(): void;
      pause(): void;
    };
  }
}

const el = <T extends HTMLElement = HTMLElement>(id: string) => {
  const item = document.getElementById(id);
  if (!item) throw new Error(`Missing player element: ${id}`);
  return item as T;
};

function saveFile(name: string, type: string, data: string) {
  const url = URL.createObjectURL(new Blob([data], {type}));
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = name; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function main() {
  const bundle = JSON.parse(el('scene-data').textContent ?? '') as Bundle;
  const diagnostics = validateBundle(bundle);
  const sample = createEvaluator(bundle);
  const stage = el('stage');
  const capture = new URL(location.href).searchParams.get('capture') === '1';
  const slider = el<HTMLInputElement>('timeline');
  const play = el<HTMLButtonElement>('play');
  const playIcon = el('play-icon');
  const speed = el<HTMLSelectElement>('speed');
  const objectList = el('object-list');
  let frame = sample(0);
  let selected = bundle.nodes.find(n => bundle.relations.some(r => r.target === n.id))?.id ?? bundle.nodes[0]?.id;
  let playing = false;
  let raf = 0;
  let anchorWall = 0;
  let anchorTime = 0;
  let rate = 1;
  const rows = new Map<string, HTMLButtonElement>();

  el('scene-title').textContent = bundle.title;
  el('edition-version').textContent = `/ v${bundle.version}`;
  el('duration').textContent = `${bundle.duration.toFixed(2)} s`;
  el('timeline-end').textContent = `00:${String(Math.floor(bundle.duration)).padStart(2,'0')}`;
  el('viewport-label').textContent = `${bundle.viewport.width} × ${bundle.viewport.height} / SVG`;
  el('object-count').textContent = String(bundle.nodes.length);
  el('track-count').textContent = String(bundle.tracks.length);
  el('relation-count').textContent = String(bundle.relations.length);
  slider.max = String(bundle.duration);
  stage.style.aspectRatio = `${bundle.viewport.width}/${bundle.viewport.height}`;

  for (const node of bundle.nodes) {
    const row = document.createElement('button');
    row.type = 'button'; row.className = 'object-row'; row.setAttribute('aria-pressed', String(selected === node.id));
    row.setAttribute('role','listitem');
    const icon = document.createElement('span'); icon.className = 'object-kind'; icon.textContent = node.kind === 'tex' ? 'T' : node.kind === 'group' ? '□' : '○';
    const label = document.createElement('span'); label.className = 'object-name'; label.textContent = node.id;
    const kind = document.createElement('small'); kind.textContent = node.kind;
    row.append(icon,label,kind);
    row.addEventListener('click', () => {selected=node.id; updateInspector();});
    rows.set(node.id,row); objectList.append(row);
  }
  const diagnosticBox = el('diagnostics');
  const notes = [...(bundle.diagnostics ?? []), ...diagnostics];
  el('diagnostic-count').textContent = String(notes.length);
  const compilerText = document.createElement('p');
  compilerText.textContent = (bundle.provenance as Record<string,unknown> | undefined)?.compatibility as string ?? 'Compiled scene validated. Vector resources include actual TeX outlines and logical metrics.';
  diagnosticBox.append(compilerText);
  for (const note of notes) {
    const p = document.createElement('p'); p.textContent = `${note.code}: ${note.message}`; diagnosticBox.append(p);
  }

  function updateInspector() {
    for (const [id,row] of rows) row.setAttribute('aria-pressed',String(id===selected));
    const node = frame.nodes.find(n=>n.id===selected);
    if (!node) return;
    el('selected-name').textContent = node.id;
    el('selected-kind').textContent = node.kind;
    const values = (node as Node & {values?:number[]}).values;
    const info: Record<string,unknown> = {...node};
    if (values) info.values = {count:values.length, minimum:Math.min(...values), maximum:Math.max(...values)};
    el('object-data').textContent = JSON.stringify(info, (_key,value) => typeof value==='number' ? Math.round(value*100000)/100000 : value,2);
  }

  function draw(time: number) {
    frame = sample(time);
    stage.innerHTML = renderSvg(frame);
    if (!capture) {
      slider.value = String(frame.time);
      slider.style.setProperty('--progress',`${100*frame.time/bundle.duration}%`);
      el('current-time').textContent = frame.time.toFixed(2);
      updateInspector();
    }
    return frame;
  }
  function pause() {
    playing = false; cancelAnimationFrame(raf);
    play.setAttribute('aria-pressed','false'); play.setAttribute('aria-label','Play animation'); playIcon.textContent='▶';
  }
  function tick(now: number) {
    if (!playing) return;
    const time = anchorTime+(now-anchorWall)*rate/1000;
    if (time>=bundle.duration) {draw(bundle.duration);pause();return;}
    draw(time); raf=requestAnimationFrame(tick);
  }
  function start() {
    if (frame.time>=bundle.duration) draw(0);
    playing=true; anchorTime=frame.time; anchorWall=performance.now();
    play.setAttribute('aria-pressed','true'); play.setAttribute('aria-label','Pause animation'); playIcon.textContent='Ⅱ';
    raf=requestAnimationFrame(tick);
  }
  function downloadSvg() {
    saveFile(`texloom-${frame.time.toFixed(3)}.svg`,'image/svg+xml',renderSvg(frame));
  }
  play.addEventListener('click',()=>playing?pause():start());
  el('restart').addEventListener('click',()=>{pause();draw(0);});
  slider.addEventListener('input',()=>{pause();draw(Number(slider.value));});
  speed.addEventListener('change',()=>{const resume=playing;pause();rate=Number(speed.value);if(resume)start();});
  el('download-svg').addEventListener('click',downloadSvg);
  el('download-bundle').addEventListener('click',()=>saveFile('texloom-bundle.json','application/json',JSON.stringify(bundle,null,2)));
  document.addEventListener('keydown',event=>{
    const target=event.target as HTMLElement;
    if (target.matches('input,select,textarea,button') || target.isContentEditable || capture) return;
    if(event.code==='Space'){event.preventDefault();playing?pause():start();}
    if(event.code==='ArrowLeft'||event.code==='ArrowRight'){
      event.preventDefault();pause();draw(Math.max(0,Math.min(bundle.duration,frame.time+(event.code==='ArrowRight'?.1:-.1))));
    }
  });
  if(capture){
    document.body.className='capture';
    document.body.replaceChildren(stage);
    stage.style.width='100vw';stage.style.height='100vh';stage.style.aspectRatio='auto';
  }
  window.texloom = {bundle,ready:Promise.resolve(), render(time){pause();return draw(time);},getFrame:()=>frame,downloadSvg,pause};
  draw(0);
}

try { main(); } catch (error) {
  const message=error instanceof Error?error.message:String(error);
  const box=document.getElementById('error');
  if(box){box.hidden=false;box.textContent=message;}
  console.error(error);
  throw error;
}
