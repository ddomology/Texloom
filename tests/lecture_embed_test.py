"""Real compact iframe layout and standard-runtime controls in 2D and 3D."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
from compile import compile_scene


class LectureEmbedTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.temp.cleanup)
        cls.folder = Path(cls.temp.name)
        cls.evidence = ROOT / 'build/pr40-embed-qa'
        cls.evidence.mkdir(parents=True, exist_ok=True)
        cls.hosts = {}
        for kind, scene in [('2d', 'lectures/diagrams/commuting-square.tex'), ('3d', 'gpu-cube.tex')]:
            out = cls.folder / kind
            compile_scene(ROOT / 'examples' / scene, out)
            result = subprocess.run(['node', str(ROOT / 'tools/build-lecture-player.mjs'),
                                     str(out / 'bundle.json'), str(out / 'player.html')],
                                    cwd=ROOT, capture_output=True, text=True, encoding='utf8')
            if result.returncode:
                raise AssertionError(result.stdout + result.stderr)
            metadata = json.loads(result.stdout)
            if metadata['presentation'] != 'lecture-embed/1':
                raise AssertionError(metadata)
            host = out / 'host.html'
            host.write_text('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">'
                            '<style>body{margin:0;padding:16px;background:#172925}iframe{display:block;width:100%;height:300px;border:0}</style>'
                            '<iframe title="Mathematical scene" src="player.html"></iframe>', encoding='utf8')
            cls.hosts[kind] = host
        cls.playwright = sync_playwright().start()
        cls.addClassCleanup(cls.playwright.stop)
        cls.browser = cls.playwright.chromium.launch(headless=True,
            args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
        cls.addClassCleanup(cls.browser.close)

    def open(self, kind, width, height):
        page = self.browser.new_page(viewport={'width': width, 'height': 844}, reduced_motion='reduce')
        self.addCleanup(page.close)
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(self.hosts[kind].as_uri())
        page.locator('iframe').evaluate('(el,height)=>el.style.height=height+"px"', height)
        frame = page.frames[1]
        frame.wait_for_function('window.texloom?.ready')
        frame.evaluate('async()=>await window.texloom.ready')
        return page, frame, errors

    def assert_fitted(self, frame):
        result = frame.evaluate('''()=>{
          const box=id=>{const r=document.querySelector(id).getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,right:r.right,bottom:r.bottom};};
          const svg=document.querySelector('#stage>svg'),vb=svg?.viewBox.baseVal,m=svg?.getScreenCTM();
          const corners=svg?[[vb.x,vb.y],[vb.x+vb.width,vb.y+vb.height]].map(([x,y])=>{const p=new DOMPoint(x,y).matrixTransform(m);return {x:p.x,y:p.y};}):null;
          return {width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,
            scrollHeight:document.documentElement.scrollHeight,stage:box('#stage'),transport:box('.transport'),
            controls:['#play','#restart','#timeline','#speed'].map(box),corners,
            hidden:['header','.intro','.inspector'].every(s=>getComputedStyle(document.querySelector(s)).display==='none'),
            canvas:document.querySelector('canvas')?box('canvas'):null};
        }''')
        self.assertTrue(result['hidden'])
        self.assertLessEqual(result['scrollWidth'], result['width'])
        self.assertLessEqual(result['scrollHeight'], result['height'])
        self.assertGreaterEqual(result['stage']['h'], 180)
        for box in [result['stage'], result['transport'], *result['controls']]:
            self.assertGreaterEqual(box['x'], -0.1)
            self.assertGreaterEqual(box['y'], -0.1)
            self.assertLessEqual(box['right'], result['width'] + .1)
            self.assertLessEqual(box['bottom'], result['height'] + .1)
        self.assertAlmostEqual(result['transport']['bottom'], result['height'], delta=1)
        if result['corners']:
            for point in result['corners']:
                self.assertGreaterEqual(point['x'], result['stage']['x'] - .1)
                self.assertLessEqual(point['x'], result['stage']['right'] + .1)
                self.assertGreaterEqual(point['y'], result['stage']['y'] - .1)
                self.assertLessEqual(point['y'], result['stage']['bottom'] + .1)
        if result['canvas']:
            self.assertAlmostEqual(result['canvas']['w'], result['stage']['w'], delta=.1)
            self.assertAlmostEqual(result['canvas']['h'], result['stage']['h'], delta=.1)

    def test_mobile_and_desktop_iframes_fit_complete_scene_and_transport_for_both_renderers(self):
        for kind in ['2d', '3d']:
            for name, width, height in [('mobile', 390, 300), ('desktop', 960, 420)]:
                with self.subTest(kind=kind, layout=name):
                    page, frame, errors = self.open(kind, width, height)
                    self.assert_fitted(frame)
                    page.locator('iframe').screenshot(path=str(self.evidence / f'{kind}-{name}.png'))
                    self.assertEqual(errors, [])

    def test_mobile_seek_play_restart_and_resize_use_unchanged_shared_runtimes(self):
        for kind in ['2d', '3d']:
            with self.subTest(kind=kind):
                page, frame, errors = self.open(kind, 390, 300)
                frame.locator('#timeline').evaluate('(el)=>{el.value="2";el.dispatchEvent(new Event("input",{bubbles:true}));}')
                self.assertEqual(frame.evaluate('window.texloom.getFrame().time'), 2)
                frame.locator('#play').click()
                frame.wait_for_function('window.texloom.getFrame().time>2.05')
                frame.locator('#play').click()
                self.assertEqual(frame.locator('#play').get_attribute('aria-pressed'), 'false')
                frame.locator('#restart').click()
                self.assertEqual(frame.evaluate('window.texloom.getFrame().time'), 0)
                page.set_viewport_size({'width': 960, 'height': 844})
                page.locator('iframe').evaluate('(el)=>el.style.height="420px"')
                self.assert_fitted(frame)
                self.assertEqual(errors, [])


if __name__ == '__main__':
    unittest.main()
