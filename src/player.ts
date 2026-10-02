import {createEvaluator, validateBundle} from './index.js';
import type {Bundle, EvaluatedFrame, ExpressionValue, Node} from './index.js';
import {renderSvg} from './render-svg.js';

declare global {
  interface Window {
    texloom: {
      bundle: Bundle;
      ready: Promise<void>;
      render(time: number, parameters?: Readonly<Record<string, ExpressionValue>>): EvaluatedFrame;
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
  const parameterDefinitions = bundle.expressions?.parameters ?? {};
  let parameters: Record<string, ExpressionValue> = Object.fromEntries(Object.entries(parameterDefinitions)
    .map(([name, definition]) => [name, structuredClone(definition.default)]));
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

  function draw(time: number, overrides: Readonly<Record<string, ExpressionValue>> = parameters) {
    // Evaluation and serialization must both succeed before replacing the last
    // good frame. An invalid parameter edit cannot partially update the scene.
    const next = sample(time, overrides);
    const svg = renderSvg(next);
    frame = next;
    stage.innerHTML = svg;
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
  if (!capture && Object.keys(parameterDefinitions).length) {
    const controls = document.createElement('section');
    controls.className = 'parameter-controls'; controls.setAttribute('aria-label', 'Scene parameters');
    const heading = document.createElement('h3'); heading.textContent = 'Parameters'; controls.append(heading);
    for (const [name, definition] of Object.entries(parameterDefinitions)) {
      const row = document.createElement('div'); row.className = 'parameter-row'; row.dataset.parameter = name;
      const label = document.createElement('label'); label.className = 'parameter-label'; label.textContent = name;
      const unit = document.createElement('span'); unit.className = 'parameter-unit';
      unit.textContent = definition.type === 'boolean' ? 'boolean' : definition.unit ?? '1';
      label.append(unit); row.append(label);
      const inputs: HTMLInputElement[] = [];
      const readout = document.createElement('output'); readout.className = 'parameter-readout';
      const values = definition.type === 'vec2' ? definition.default as [number, number] : [definition.default];
      for (const [axis, value] of values.entries()) {
        const input = document.createElement('input');
        input.id = `parameter-${controls.childElementCount}-${axis}`;
        input.dataset.parameter = name;
        input.setAttribute('aria-label', definition.type === 'vec2' ? `${name} ${axis === 0 ? 'x' : 'y'}` : name);
        input.type = definition.type === 'boolean' ? 'checkbox' : definition.type === 'scalar' &&
          definition.min !== undefined && definition.max !== undefined ? 'range' : 'number';
        if (input.type === 'checkbox') input.checked = Boolean(value);
        else {
          input.step = 'any';
          if (definition.min !== undefined) input.min = String(definition.min);
          if (definition.max !== undefined) input.max = String(definition.max);
          input.value = String(value);
        }
        if (axis === 0) label.htmlFor = input.id;
        inputs.push(input); row.append(input);
      }
      const updateReadout = (value: ExpressionValue) => {
        readout.textContent = typeof value === 'number' ? Number(value.toFixed(4)).toString() : '';
      };
      if (inputs[0].type === 'range') {updateReadout(definition.default); row.append(readout);}
      const update = () => {
        pause();
        try {
          const value: ExpressionValue = definition.type === 'boolean' ? inputs[0].checked :
            definition.type === 'vec2' ? [inputs[0].valueAsNumber, inputs[1].valueAsNumber] : inputs[0].valueAsNumber;
          const numbers = typeof value === 'number' ? [value] : Array.isArray(value) ? value : [];
          if (!numbers.every(Number.isFinite)) throw new Error(`Parameter ${name} requires finite numeric values.`);
          if (typeof value === 'number' && (definition.min !== undefined && value < definition.min ||
              definition.max !== undefined && value > definition.max)) throw new Error(`Parameter ${name} is outside its declared bounds.`);
          const nextParameters = {...parameters, [name]: value};
          draw(frame.time, nextParameters);
          parameters = nextParameters;
          updateReadout(value);
          inputs.forEach(input => input.removeAttribute('aria-invalid'));
          el('error').hidden = true;
        } catch (error) {
          inputs.forEach(input => input.setAttribute('aria-invalid', 'true'));
          const box = el('error'); box.hidden = false; box.textContent = error instanceof Error ? error.message : String(error);
        }
      };
      inputs.forEach(input => input.addEventListener(input.type === 'checkbox' ? 'change' : 'input', update));
      controls.append(row);
    }
    stage.parentElement!.append(controls);
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
  window.texloom = {bundle,ready:Promise.resolve(), render(time,overrides){pause();return draw(time,overrides);},getFrame:()=>frame,downloadSvg,pause};
  draw(0);
}

try { main(); } catch (error) {
  const message=error instanceof Error?error.message:String(error);
  const box=document.getElementById('error');
  if(box){box.hidden=false;box.textContent=message;}
  console.error(error);
  throw error;
}
