import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const [input,output,chalkRoot]=process.argv.slice(2);
if(!input||!output||!chalkRoot)throw new Error('Usage: node tools/build-dual-demo.mjs bundle.json output.html ChalkspaceCheckout');
const bundle=JSON.parse(await readFile(input,'utf8'));
const material=await readFile(resolve(chalkRoot,'src/chalkspace/web/board-surface.js'),'utf8');
const js=await build({entryPoints:[resolve(root,'web/dual.ts')],bundle:true,platform:'browser',format:'iife',target:'es2022',write:false});
const safeScript=s=>s.replace(/<\/script/gi,'<\\/script');
const data=JSON.stringify(bundle).replaceAll('<','\\u003c').replaceAll('\u2028','\\u2028').replaceAll('\u2029','\\u2029');
const html=`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Texloom · Shared runtime</title><style>
*{box-sizing:border-box}body{margin:0;background:#f3f0e8;color:#15333a;font:15px/1.8 system-ui,sans-serif}main{max-width:1500px;margin:auto;padding:32px}.brand{font-size:24px;font-weight:750;letter-spacing:-1px}.eyebrow{font-size:11px;letter-spacing:2px;color:#458473;margin-top:36px}h1{font-size:38px;letter-spacing:-1.5px;margin:8px 0}p{color:#60747b;max-width:920px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:30px}h2{font-size:16px}.stage{aspect-ratio:16/9;background:#091c27;overflow:hidden}svg,canvas{display:block;width:100%;height:100%}.tag{font:11px monospace;color:#668478;margin-left:12px}.controls{display:flex;align-items:center;gap:20px;margin:26px 0;padding:20px 0;border-top:1px solid #cbd6cc;border-bottom:1px solid #cbd6cc}input{flex:1;min-width:70px;accent-color:#386d5c}button{background:#173e40;color:white;border:0;padding:12px 22px;cursor:pointer}output{font:13px monospace;min-width:120px}details{margin-top:26px;font-size:13px}pre{white-space:pre-wrap;padding:20px;background:#e5e9df}.note{font-size:13px}a{color:#27695c}footer{margin-top:34px;padding-top:15px;border-top:1px solid #cbd6cc;font-size:11px;letter-spacing:1px}@media(max-width:850px){main{padding:20px}.grid{grid-template-columns:1fr}h1{font-size:29px}.controls{gap:10px}.tag{display:block;margin:0}}
</style></head><body><main><div class="brand">texloom.</div><div class="eyebrow">RESEARCH → SHARED RUNTIME FOUNDATION</div><h1>한 장면, 두 개의 렌더러.</h1><p>같은 TeX 장면을 한 번 평가해 웹의 SVG와 칠판의 Canvas에 전달합니다. 시간을 앞뒤로 움직여도 두 화면은 같은 객체 위치와 관계를 사용합니다.</p><div class="grid"><section><h2>웹 <span class="tag">NATIVE SVG</span></h2><div class="stage" id="svg"></div></section><section><h2>Chalkspace 보드 <span class="tag">NATIVE CANVAS + ACTUAL BOARD MATERIAL</span></h2><div class="stage"><canvas id="board" width="960" height="540"></canvas></div></section></div><div class="controls"><button id="play">재생</button><input id="time" type="range" min="0" step=".001" value="0" aria-label="공통 시간"><output id="clock"></output></div><p id="title"></p><p class="note">오른쪽은 실제 Chalkspace의 칠판 표면 모듈과 새 Canvas 렌더러를 사용합니다. SVG를 이미지로 변환하지 않고 경로를 직접 그립니다. 현재 콘텐츠는 벡터 잉크이며, 분필 획순·지우개·강의 음성 및 기존 강의 타임라인 연결은 다음 통합 단계입니다.</p><details><summary>공통 실행 계약</summary><pre>runtime = prepareScene(bundle)
frame = runtime.sample(absoluteSeconds)
renderSvg(frame)
chalkspaceLayer.draw(frame, canvasContext, boardCamera)

TeX → 의미·기하·타임라인 IR → 공통 평가기 → 렌더러별 표현
시뮬레이션 → 버전이 있는 샘플 데이터 → 같은 평가기</pre></details><footer>FOUNDATION M0 · SOURCE AND ROADMAP IN ddomology/Texloom</footer></main><script id="scene-data" type="application/json">${data}</script><script>${safeScript(material)}</script><script>${safeScript(js.outputFiles[0].text)}</script></body></html>`;
await mkdir(dirname(resolve(output)),{recursive:true});
let page=html.replace('<details>','<p><a href="https://github.com/ddomology/Texloom/blob/main/docs/ROADMAP.md">전체 로드맵과 단계별 완료 기준 ↗</a></p><details>');
if(bundle.version==='0.3')page=page
  .replace('RESEARCH → SHARED RUNTIME FOUNDATION','TEXLOOM 0.3 → EDITABLE PGF GEOMETRY')
  .replace('한 장면, 두 개의 렌더러.','TeX의 곡선이 살아 움직이게.')
  .replace('같은 TeX 장면을 한 번 평가해 웹의 SVG와 칠판의 Canvas에 전달합니다. 시간을 앞뒤로 움직여도 두 화면은 같은 객체 위치와 관계를 사용합니다.',
    '0–2초에는 경로를 그리고, 2–10초에는 제어점이 변하며 점·접선·법선이 따라갑니다. 시간을 앞뒤로 움직여도 웹과 칠판은 같은 계산 결과를 사용합니다.')
  .replace('FOUNDATION M0 · SOURCE AND ROADMAP IN','LIVE PATHS M1.1 + CORE M1.2 · SOURCE AND ROADMAP IN');
await writeFile(output,page);
await writeFile(resolve(dirname(output),'dual-provenance.json'),JSON.stringify({scene:bundle.title,boardModule:'Chalkspace/src/chalkspace/web/board-surface.js',boardSha256:createHash('sha256').update(material).digest('hex'),sceneVersion:bundle.version,notes:'Real board material + native Canvas geometry; not full lesson scheduler/eraser integration.'},null,2));
console.log(JSON.stringify({output:resolve(output),bytes:Buffer.byteLength(html)}));
