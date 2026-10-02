"""Build the offline release page beside the packaged demo."""
import html
import json
from pathlib import Path
import sys

out = Path(sys.argv[1]).resolve()
manifest = json.loads((out / 'manifest.json').read_text(encoding='utf8'))
source = (out / 'commutative.tex').read_text(encoding='utf8')
page = r'''<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Texloom 0.2 · TikZ comes to life</title>
<style>
:root{color-scheme:light;--paper:#f3f0e8;--ink:#152e38;--muted:#64767a;--line:#d4d9d3;--mint:#b3e8d8}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.8 system-ui,-apple-system,"Segoe UI",sans-serif}a{color:inherit;text-underline-offset:5px}header,main,footer{max-width:1220px;margin:auto;padding:0 42px}header{height:108px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line)}.brand{font-size:30px;font-weight:760;letter-spacing:-1.5px;text-decoration:none}.brand b{color:#388771}.edition,.eyebrow{font-size:11px;letter-spacing:2.3px;font-weight:700}.edition{color:var(--muted)}.intro{padding:58px 0 36px;display:grid;grid-template-columns:1.15fr 1fr;gap:70px;align-items:end}.eyebrow{color:#448472;margin:0 0 16px}h1{font-size:clamp(35px,4.6vw,62px);letter-spacing:-2.5px;line-height:1.2;font-weight:680;margin:0}.intro p{color:var(--muted);font-size:16px;margin:0}.version{display:inline-block;margin-bottom:15px;border:1px solid #b2c9bd;padding:2px 10px;font-size:11px;letter-spacing:1.5px}video{display:block;width:100%;background:#091c27;aspect-ratio:16/9}.caption{display:flex;justify-content:space-between;gap:20px;border-bottom:1px solid var(--line);padding:13px 0;font-size:12px;color:var(--muted)}.actions{display:flex;flex-wrap:wrap;gap:12px;margin:25px 0 45px}.button{display:inline-flex;align-items:center;justify-content:center;padding:11px 20px;border:1px solid #bdc8c1;text-decoration:none;font-size:14px;font-weight:650}.button.primary{background:var(--ink);color:#fff;border-color:var(--ink)}.button:hover{background:var(--mint);color:var(--ink)}.features{display:grid;grid-template-columns:repeat(3,1fr);gap:36px;padding:10px 0 40px}.features article{border-top:2px solid #b9cbc0;padding-top:17px}.num{font:12px ui-monospace,monospace;color:#56917b}h2{font-size:22px;letter-spacing:-.6px;margin:7px 0 12px}.features p{font-size:14px;color:var(--muted);margin:0}.source{display:grid;grid-template-columns:.8fr 1.2fr;gap:45px;border-top:1px solid var(--line);padding:40px 0}.source p{font-size:14px;color:var(--muted)}pre{background:#e7e9e1;color:#28454d;padding:24px;overflow:auto;font:13px/1.85 Consolas,ui-monospace,monospace;margin:0;tab-size:2}code{font-family:Consolas,ui-monospace,monospace}details{border-top:1px solid var(--line);padding:16px 0}summary{cursor:pointer;font-size:14px;font-weight:650}details pre{margin-top:14px;max-height:480px}.evidence{border-top:1px solid var(--line);padding:30px 0 45px}.evidence p{font-size:13px;color:var(--muted);max-width:870px;margin:8px 0}footer{border-top:1px solid var(--line);padding-top:22px;padding-bottom:35px;display:flex;justify-content:space-between;font-size:11px;letter-spacing:1px;color:var(--muted)}@media(max-width:760px){header,main,footer{padding-left:22px;padding-right:22px}header{height:80px}.intro{grid-template-columns:1fr;gap:24px;padding-top:36px}.features,.source{grid-template-columns:1fr;gap:24px}.caption{flex-direction:column;gap:3px}.features{padding-bottom:30px}.source{padding-top:28px}.edition{font-size:9px;letter-spacing:1px}h1{letter-spacing:-1.5px}pre{font-size:11px;padding:16px}.actions{margin-bottom:25px}footer{gap:20px}.button{flex:1;white-space:nowrap}}
</style></head><body>
<header><a class="brand" href="#">texloom<b>.</b></a><span class="edition">RELEASE 0.2 / NAMED TIKZ SCENES</span></header>
<main><section class="intro"><div><p class="eyebrow">TIKZ COMES TO LIFE</p><h1>움직여도,<br>관계는 이어진다.</h1></div><div><span class="version">TeX → OBJECTS → MOTION</span><p>TikZ가 그린 노드와 실제 앵커를 객체로 가져옵니다. 노드가 이동하고 회전하는 동안 화살표와 수식 라벨이 함께 자리를 잡습니다.</p></div></section>
<video controls autoplay loop muted playsinline preload="metadata" poster="demo/poster.png"><source src="demo/demo.mp4" type="video/mp4"></video>
<div class="caption"><span>가환도 · 12초 · 1280 × 720 · 30 fps · 무음</span><span>실제 TeX 조판 + PGF 앵커 + 시간 평가기</span></div>
<div class="actions"><a class="button primary" href="demo/player.html">인터랙티브 플레이어 ↗</a><a class="button" href="commutative.tex" download>TeX 원본 ↓</a><a class="button" href="Texloom-v0.2-source.zip" download>전체 소스 ↓</a><a class="button" href="demo/demo.mp4" download>영상 ↓</a></div>
<section class="features"><article><span class="num">01 / AUTHOR</span><h2>TikZ로 쓰기</h2><p>도형·폰트·수식·스타일은 실제 TikZ로 조판합니다. JSON 없이 이름과 좌표, 키 옵션으로 장면을 작성합니다.</p></article><article><span class="num">02 / CONNECT</span><h2>관계로 연결하기</h2><p><code>X.east → Y.west</code>. PGF가 계산한 앵커를 사용하며, 부모 그룹의 이동·회전·확대까지 따라갑니다.</p></article><article><span class="num">03 / PLAY</span><h2>같은 객체로 재생하기</h2><p>시간을 앞뒤로 이동해도 같은 장면이 나옵니다. 웹 플레이어, SVG 프레임, MP4가 같은 평가 결과를 사용합니다.</p></article></section>
<section class="source"><div><p class="eyebrow">THE AUTHORING LAYER</p><h2>이제 이런 TeX를 씁니다.</h2><p>노드 모양은 TikZ에 맡기고, 객체의 이름과 관계, 시간 변화는 Texloom이 보존합니다. 아래는 데모에서 사용하는 문법입니다.</p><p><a href="authoring-guide.md">지원 문법과 단위 안내 ↗</a></p></div><pre>\loomnode[object] (X) at (-238,-79) {$X$};
\loomnode[object] (Y) at (238,-79) {$Y$};

\loomconnect[draw=mint,-&gt;]
  (f) (X.east) to (Y.west);

\loomlabel[at=.5,offset=-22,text=mint]
  (f-label) on (f) {$f$};

\loomanimate[duration=6] (Y)
  {move to={(223,-48)},scale to=1.08};</pre></section>
<details><summary>실행한 TeX 전체 보기</summary><pre>__SOURCE__</pre></details>
<section class="evidence"><p class="eyebrow">VERIFIED SCOPE</p><h2>작동 범위와 검증</h2><p>__TESTS__ · 타입 검사 통과 · 브라우저/SVG 동일 프레임의 픽셀 일치 · 역방향 탐색 일치 · 모바일 가로 넘침 없음. 실제 브라우저에서 __ANCHORS__번 화살표 끝과 앵커의 일치도 확인했습니다.</p><p>임의의 TikZ 코드를 모두 애니메이션 객체로 복원하는 단계는 아닙니다. 이름 있는 객체용 래퍼와 명시적인 연결 관계를 사용합니다. 라이브 연결선은 직선·입방 곡선과 삼각 화살촉을 지원하며, 교차점·장식·범용 경로 모핑·3D는 후속 확장 범위입니다.</p><p><a href="demo/bundle.json">객체 IR</a> · <a href="demo/snapshot.svg">SVG 프레임</a> · <a href="manifest.json">검증 요약</a> · <a href="demo/anchor-report.json">앵커 검증</a></p></section>
</main><footer><span>TEXLOOM / MATHEMATICS IN MOTION</span><span>LOCAL PREVIEW · v0.2</span></footer></body></html>'''
checks = manifest['verification']
page = page.replace('__SOURCE__', html.escape(source))
page = page.replace('__TESTS__', f"TypeScript {checks['typescriptTests']}개 + Python {checks['pythonTests']}개 테스트 통과")
page = page.replace('__ANCHORS__', str(manifest['anchors']['checks']))
(out / 'index.html').write_text(page, encoding='utf8')
print(out / 'index.html')
