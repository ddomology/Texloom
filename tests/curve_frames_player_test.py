"""Native helix/follower pixels and independent discrete-position/projection oracles."""
import base64
import hashlib
import json
import math
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
from compile import compile_scene


def dot(a, b):
    return sum(x*y for x, y in zip(a, b))


class CurvePlayerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.folder = Path(cls.temp.name)
        cls.bundle = compile_scene(ROOT / 'examples/curve-frames.tex', cls.folder / 'native')
        cls.player = cls.folder / 'player.html'
        cls.build(cls.folder / 'native/bundle.json', cls.player)
        lines = json.loads(json.dumps(cls.bundle))
        lines['space3d']['nodes'] = [n for n in lines['space3d']['nodes'] if n['kind'] != 'mesh']
        del lines['resources']['axis-arrow']
        cls.line_player = cls.folder / 'lines.html'
        source = cls.folder / 'lines.json'; source.write_text(json.dumps(lines), encoding='utf8')
        cls.build(source, cls.line_player)
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(headless=True,
            args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader'])

    @classmethod
    def build(cls, source, target):
        result = subprocess.run(['node', str(ROOT / 'tools/build-gpu-player.mjs'), str(source), str(target)],
                                cwd=ROOT, capture_output=True, text=True, encoding='utf8')
        if result.returncode:
            raise AssertionError(result.stdout + result.stderr)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.playwright.stop(); cls.temp.cleanup()

    def open(self, capture=False, mobile=False, lines=False):
        page = self.browser.new_page(viewport={'width': 390, 'height': 844} if mobile else {'width': 960, 'height': 540},
                                     reduced_motion='reduce')
        errors, requests = [], []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('console', lambda message: errors.append(message.text) if message.type == 'error' else None)
        page.on('request', lambda request: requests.append(request.url) if request.url.startswith(('http:', 'https:')) else None)
        page.goto((self.line_player if lines else self.player).as_uri() + ('?capture=1' if capture else ''))
        page.evaluate('async()=>{await window.TexloomGpuPlayer.ready;}')
        return page, errors, requests

    def assert_geometry(self, frame, time, radius=1, projection=True):
        resource = frame['resources']['helix']
        self.assertEqual(resource['kind'], 'curve3d')
        self.assertEqual(resource['positions']['count'], 161)
        points = list(zip(*[iter(resource['positions']['data'])]*3))
        expected = [(radius*math.cos(i*math.pi/40), radius*math.sin(i*math.pi/40), .18*(i*math.pi/40-2*math.pi))
                    for i in range(161)]
        for actual, reference in zip(points, expected):
            for x, y in zip(actual, reference):
                self.assertAlmostEqual(x, y, delta=3e-12)
        # All sampled helix chords have equal length, so source-time progress
        # independently selects the corresponding segment and linear fraction.
        segment = min(int(time*20), 159); fraction = time*20-segment
        position = [expected[segment][i]*(1-fraction)+expected[segment+1][i]*fraction for i in range(3)]
        follower = frame['curves3d']['followers']['traveller']
        self.assertAlmostEqual(follower['progress'], time/8, delta=1e-15)
        sample = follower['sample']
        for x, y in zip(sample['position'], position):
            self.assertAlmostEqual(x, y, delta=3e-12)
        axes = [sample[k] for k in ['tangent', 'normal', 'binormal']]
        for i, a in enumerate(axes):
            for j, b in enumerate(axes):
                self.assertAlmostEqual(dot(a, b), 1 if i == j else 0, delta=2e-12)
        t, n, b = axes
        cross = [t[1]*n[2]-t[2]*n[1], t[2]*n[0]-t[0]*n[2], t[0]*n[1]-t[1]*n[0]]
        for x, y in zip(cross, b):
            self.assertAlmostEqual(x, y, delta=2e-12)
        self.assertAlmostEqual(sum(x*x for x in sample['quaternion']), 1, delta=2e-12)
        by_id = {overlay['id']: overlay for overlay in frame['space3d']['overlays']}
        right = [6/math.sqrt(52), 4/math.sqrt(52), 0]
        back = [4/math.sqrt(61), -6/math.sqrt(61), 3/math.sqrt(61)]
        up = [-back[2]*right[1], back[2]*right[0], back[0]*right[1]-back[1]*right[0]]
        for name, axis in zip(['tangent-label', 'normal-label', 'binormal-label'], axes):
            overlay = by_id[name]
            world = [position[i]+.85*axis[i] for i in range(3)]
            for x, y in zip(overlay['worldPosition'], world):
                self.assertAlmostEqual(x, y, delta=4e-12)
            self.assertTrue(overlay['visible'])
            if projection:
                relative = [world[i]-[4, -6, 3][i] for i in range(3)]
                offset = [-16, 14] if name == 'tangent-label' else [6, -7]
                screen = [480+dot(relative, right)*540/4.8+offset[0], 270-dot(relative, up)*540/4.8+offset[1]]
                for x, y in zip(overlay['position'], screen):
                    self.assertAlmostEqual(x, y, delta=2e-10)
        curve, = frame['space3d']['curves']
        self.assertEqual((curve['id'], curve['resourceId']), ('helix-path', 'helix'))

    def test_native_curve_and_transported_labels_seek_to_exact_repeated_pixels(self):
        page, errors, requests = self.open(capture=True)
        try:
            images = {}
            for time in [0, .123, 1, 2.25, 4, 6.1, 8]:
                capture = page.evaluate('t=>window.TexloomGpuPlayer.capture(t)', time)
                self.assert_geometry(page.evaluate('window.TexloomGpuPlayer.getFrame()'), time)
                images[time] = hashlib.sha256(base64.b64decode(capture['data'])).hexdigest()
            self.assertGreater(len(set(images.values())), 5)
            for time in reversed(list(images)):
                capture = page.evaluate('t=>window.TexloomGpuPlayer.capture(t)', time)
                self.assertEqual(hashlib.sha256(base64.b64decode(capture['data'])).hexdigest(), images[time])
            self.assertEqual(errors, []); self.assertEqual(requests, [])
        finally:
            page.close()

    def test_radius_regeneration_mobile_controls_and_source_integrity(self):
        page, errors, requests = self.open(mobile=True)
        try:
            self.assertFalse(page.evaluate('document.documentElement.scrollWidth>innerWidth'))
            self.assertEqual(page.locator('#curve-count').inner_text(), '1')
            self.assertEqual(page.locator('#segment-count').inner_text(), '160')
            page.evaluate('window.TexloomGpuPlayer.seek(2.25)')
            before = page.evaluate('window.TexloomGpuPlayer.getFrame()')
            page.get_by_label('radius', exact=True).evaluate("e=>{e.value='.8125';e.dispatchEvent(new Event('input',{bubbles:true}));}")
            changed = page.evaluate('window.TexloomGpuPlayer.getFrame()')
            self.assert_geometry(changed, 2.25, .8125)
            self.assertNotEqual(changed['resources']['helix']['positions'], before['resources']['helix']['positions'])
            self.assertEqual(changed['resources']['axis-arrow'], before['resources']['axis-arrow'])
            self.assertEqual(changed['resources']['helix']['topologyRevision'], before['resources']['helix']['topologyRevision'])
            page.get_by_label('Camera projection', exact=True).select_option('perspective')
            self.assert_geometry(page.evaluate('window.TexloomGpuPlayer.getFrame()'), 2.25, .8125, projection=False)
            page.evaluate('window.TexloomGpuPlayer.setParameter("radius",1)')
            self.assertEqual(page.evaluate('window.TexloomGpuPlayer.getFrame().resources'), before['resources'])
            self.assertTrue(page.evaluate('window.TexloomGpuPlayer.getState().sourceUnchanged'))
            self.assertEqual(errors, []); self.assertEqual(requests, [])
        finally:
            page.close()

    def test_curve_only_gpu_scene_does_not_require_dummy_triangles(self):
        page, errors, requests = self.open(lines=True)
        try:
            self.assertEqual(page.locator('#mesh-count').inner_text(), '0')
            self.assertEqual(page.locator('#triangle-count').inner_text(), '0')
            self.assertEqual(page.locator('#curve-count').inner_text(), '1')
            self.assert_geometry(page.evaluate('window.TexloomGpuPlayer.seek(4)'), 4)
            self.assertEqual(errors, []); self.assertEqual(requests, [])
        finally:
            page.close()


if __name__ == '__main__':
    unittest.main()
