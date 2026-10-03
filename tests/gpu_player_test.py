"""Native TeX GPU player: absolute poses, projected labels, real pixels and controls."""
import base64
import hashlib
from io import BytesIO
import math
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
from compile import compile_scene


class GpuPlayerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.folder = Path(cls.temp.name)
        cls.bundle = compile_scene(ROOT / 'examples/gpu-cube.tex', cls.folder / 'native')
        cls.player = cls.folder / 'player.html'
        result = subprocess.run(['node', str(ROOT / 'tools/build-gpu-player.mjs'),
                                 str(cls.folder / 'native/bundle.json'), str(cls.player)],
                                cwd=ROOT, capture_output=True, text=True, encoding='utf8')
        if result.returncode:
            raise AssertionError(result.stdout + result.stderr)
        cls.playwright = sync_playwright().start()
        # Explicit, reproducible software WebGL2 for the browser acceptance gate.
        cls.browser = cls.playwright.chromium.launch(headless=True,
            args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader'])

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()
        cls.temp.cleanup()

    def open(self, capture=False, viewport=None):
        page = self.browser.new_page(viewport=viewport or {'width': 1280, 'height': 960}, reduced_motion='reduce')
        errors, requests = [], []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('console', lambda message: errors.append(message.text) if message.type == 'error' else None)
        page.on('request', lambda request: requests.append(request.url) if request.url.startswith(('http:', 'https:')) else None)
        page.goto(self.player.as_uri() + ('?capture=1' if capture else ''))
        page.evaluate('async()=>{await window.TexloomGpuPlayer.ready;}')
        return page, errors, requests

    def assert_frame(self, frame, seconds, projection='perspective'):
        self.assertEqual(frame['time'], seconds)
        spatial = frame['space3d']
        theta = math.pi * seconds / 4
        c, s = math.cos(theta), math.sin(theta)
        expected_matrix = [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
        group = next(g for g in spatial['groups'] if g['id'] == 'cube-spin')
        for actual, expected in zip(group['worldMatrix'], expected_matrix):
            self.assertAlmostEqual(actual, expected, delta=2e-12)
        self.assertEqual(len(spatial['instances']), 6)
        self.assertEqual({i['resourceId'] for i in spatial['instances']}, {'square-face'})
        label = spatial['overlays'][0]
        self.assertTrue(label['visible'])
        world = [c-s, s+c, 1]
        for actual, expected in zip(label['worldPosition'], world):
            self.assertAlmostEqual(actual, expected, delta=2e-12)
        # Independent camera basis multiplication and analytic perspective/ortho projection.
        dx, dy, dz = world[0]-3.5, world[1]+3.5, world[2]-7/math.sqrt(2)
        x = (dx+dy)/math.sqrt(2)
        y = -.5*dx+.5*dy+dz/math.sqrt(2)
        z = .5*dx-.5*dy+dz/math.sqrt(2)
        if projection == 'perspective':
            focal = 1/math.tan(math.radians(20))
            ndc_x, ndc_y = x*focal/(960/540)/-z, y*focal/-z
        else:
            ndc_x, ndc_y = x/(2.6*960/540), y/2.6
        expected_position = [(ndc_x+1)*480+13, (1-ndc_y)*270-9]
        for actual, expected in zip(label['position'], expected_position):
            self.assertAlmostEqual(actual, expected, delta=1e-9)

    def test_real_gpu_pixels_reverse_seek_and_native_anchor_projection(self):
        page, errors, requests = self.open(capture=True, viewport={'width': 960, 'height': 540})
        try:
            self.assertEqual(page.locator('#stage canvas').count(), 1)
            self.assertTrue(page.locator('.transport').is_hidden())
            forward = {}
            for time in [0, 1/30, 1.5, 3.25, 4, 6, 8]:
                data = page.evaluate('t=>window.TexloomGpuPlayer.capture(t)', time)
                self.assert_frame(page.evaluate('window.TexloomGpuPlayer.getFrame()'), time)
                image_bytes = base64.b64decode(data['data'])
                forward[time] = hashlib.sha256(image_bytes).hexdigest()
                if time == 0:
                    image = Image.open(BytesIO(image_bytes)).convert('RGB')
                    self.assertEqual(image.size, (960, 540))
                    self.assertEqual(image.getpixel((480, 270)), (145, 213, 179))
                    nonbackground = sum(pixel != (14, 36, 28) for pixel in image.getdata())
                    self.assertGreater(nonbackground, 20000)
            for time in reversed(list(forward)):
                data = page.evaluate('t=>window.TexloomGpuPlayer.capture(t)', time)
                self.assertEqual(hashlib.sha256(base64.b64decode(data['data'])).hexdigest(), forward[time])
            self.assertGreater(len(set(forward.values())), 3)
            state = page.evaluate('window.TexloomGpuPlayer.getState()')
            self.assertFalse(state['playing'])
            self.assertTrue(state['sourceUnchanged'])
            self.assertEqual(errors, [])
            self.assertEqual(requests, [])
        finally:
            page.close()

    def test_controls_projection_toggle_actual_playback_and_disposal(self):
        page, errors, requests = self.open(viewport={'width': 390, 'height': 844})
        try:
            self.assertFalse(page.evaluate('document.documentElement.scrollWidth>innerWidth'))
            page.locator('#timeline').evaluate("e=>{e.value='2.125';e.dispatchEvent(new Event('input',{bubbles:true}));}")
            perspective = page.evaluate('window.TexloomGpuPlayer.getFrame()')
            self.assert_frame(perspective, 2.125)
            page.get_by_label('Camera projection', exact=True).select_option('orthographic')
            orthographic = page.evaluate('window.TexloomGpuPlayer.getFrame()')
            self.assert_frame(orthographic, 2.125, 'orthographic')
            self.assertNotEqual(orthographic['space3d']['overlays'][0]['position'], perspective['space3d']['overlays'][0]['position'])
            page.get_by_role('button', name='Play', exact=True).click()
            page.wait_for_function('window.TexloomGpuPlayer.getState().time > 2.15')
            page.get_by_role('button', name='Pause', exact=True).click()
            state = page.evaluate('window.TexloomGpuPlayer.getState()')
            self.assertFalse(state['playing'])
            self.assert_frame(page.evaluate('window.TexloomGpuPlayer.getFrame()'), state['time'], 'orthographic')
            page.get_by_role('button', name='Restart', exact=True).click()
            self.assertEqual(page.evaluate('window.TexloomGpuPlayer.getState().time'), 0)
            page.evaluate('window.TexloomGpuPlayer.setSize(1280,720)')
            self.assertEqual(page.evaluate('[document.querySelector("canvas").width,document.querySelector("canvas").height]'), [1280, 720])
            page.evaluate('window.TexloomGpuPlayer.dispose();window.TexloomGpuPlayer.dispose()')
            self.assertTrue(page.evaluate('window.TexloomGpuPlayer.getState().disposed'))
            self.assertEqual(errors, [])
            self.assertEqual(requests, [])
        finally:
            page.close()


if __name__ == '__main__':
    unittest.main()
