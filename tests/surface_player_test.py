"""Actual generated sphere/torus frames, analytic geometry and offline GPU pixels."""
import base64
import hashlib
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


class SurfacePlayerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.folder = Path(cls.temp.name)
        cls.bundle = compile_scene(ROOT / 'examples/parametric-surfaces.tex', cls.folder / 'native')
        cls.player = cls.folder / 'player.html'
        result = subprocess.run(['node', str(ROOT / 'tools/build-gpu-player.mjs'),
                                 str(cls.folder / 'native/bundle.json'), str(cls.player)],
                                cwd=ROOT, capture_output=True, text=True, encoding='utf8')
        if result.returncode:
            raise AssertionError(result.stdout + result.stderr)
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(headless=True,
            args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader'])

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()
        cls.temp.cleanup()

    def open(self, capture=False, viewport=None):
        page = self.browser.new_page(viewport=viewport or {'width': 960, 'height': 540}, reduced_motion='reduce')
        errors, requests = [], []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('console', lambda message: errors.append(message.text) if message.type == 'error' else None)
        page.on('request', lambda request: requests.append(request.url) if request.url.startswith(('http:', 'https:')) else None)
        page.goto(self.player.as_uri() + ('?capture=1' if capture else ''))
        page.evaluate('async()=>{await window.TexloomGpuPlayer.ready;}')
        return page, errors, requests

    def assert_geometry(self, frame, time, radius=.9):
        self.assertEqual(frame['time'], time)
        self.assertEqual(set(frame['surfaces']), {'sphere', 'torus'})
        sphere, torus = frame['resources']['sphere'], frame['resources']['torus']
        r = radius * (1 + .15 * math.sin(math.pi*time/4))
        tube = .28 + .08 * math.sin(math.pi*time/4)
        for mesh, count, indices in [(sphere, 266, 1584), (torus, 384, 2304)]:
            self.assertEqual(mesh['positions']['count'], count)
            self.assertEqual(mesh['indices']['count'], indices)
            self.assertEqual(mesh['positions']['componentType'], 'float64')
            self.assertEqual(mesh['units'], 'm')
        for x, y, z in zip(*[iter(sphere['positions']['data'])]*3):
            self.assertAlmostEqual(math.sqrt(x*x+y*y+z*z), r, delta=2e-12)
        for x, y, z in zip(*[iter(torus['positions']['data'])]*3):
            self.assertAlmostEqual((math.hypot(x,y)-1)**2+z*z, tube*tube, delta=2e-12)
        for actual, expected in zip(sphere['bounds']['min'], [-r]*3):
            self.assertAlmostEqual(actual, expected, delta=2e-12)
        for actual, expected in zip(sphere['bounds']['max'], [r]*3):
            self.assertAlmostEqual(actual, expected, delta=2e-12)
        self.assertTrue(all(o['visible'] for o in frame['space3d']['overlays']))
        sphere_instance = next(i for i in frame['space3d']['instances'] if i['id'] == 'sphere-instance')
        self.assertAlmostEqual(sphere_instance['worldBounds']['min'][0], -1.9-r, delta=2e-12)
        return sphere, torus

    def test_native_generated_surfaces_analytic_geometry_and_reverse_pixels(self):
        page, errors, requests = self.open(capture=True)
        try:
            self.assertNotIn('sphere', self.bundle['resources'])
            self.assertNotIn('torus', self.bundle['resources'])
            images, topology = {}, None
            for time in [0, .5, 2, 4, 6, 8]:
                capture = page.evaluate('t=>window.TexloomGpuPlayer.capture(t)', time)
                sphere, torus = self.assert_geometry(page.evaluate('window.TexloomGpuPlayer.getFrame()'), time)
                current_topology = [(mesh['topologyRevision'], mesh['indices']['data']) for mesh in [sphere, torus]]
                if topology is None:
                    topology = current_topology
                self.assertEqual(current_topology, topology)
                images[time] = hashlib.sha256(base64.b64decode(capture['data'])).hexdigest()
            self.assertGreaterEqual(len(set(images.values())), 4)
            for time in reversed(list(images)):
                capture = page.evaluate('t=>window.TexloomGpuPlayer.capture(t)', time)
                self.assertEqual(hashlib.sha256(base64.b64decode(capture['data'])).hexdigest(), images[time])
            self.assertEqual(errors, [])
            self.assertEqual(requests, [])
        finally:
            page.close()

    def test_parameter_regeneration_mobile_controls_and_source_immutability(self):
        page, errors, requests = self.open(viewport={'width': 390, 'height': 844})
        try:
            self.assertFalse(page.evaluate('document.documentElement.scrollWidth>innerWidth'))
            self.assertEqual(page.locator('#mesh-count').inner_text(), '2')
            self.assertEqual(page.locator('#triangle-count').inner_text(), '1296')
            page.evaluate('window.TexloomGpuPlayer.seek(2)')
            before = page.evaluate('window.TexloomGpuPlayer.getFrame()')
            page.get_by_label('radius', exact=True).evaluate("e=>{e.value='.7';e.dispatchEvent(new Event('input',{bubbles:true}));}")
            changed = page.evaluate('window.TexloomGpuPlayer.getFrame()')
            self.assert_geometry(changed, 2, .7)
            self.assertNotEqual(changed['resources']['sphere']['positions']['data'], before['resources']['sphere']['positions']['data'])
            self.assertEqual(changed['resources']['torus'], before['resources']['torus'])
            self.assertEqual(changed['resources']['sphere']['indices'], before['resources']['sphere']['indices'])
            page.get_by_label('Camera projection', exact=True).select_option('orthographic')
            self.assert_geometry(page.evaluate('window.TexloomGpuPlayer.getFrame()'), 2, .7)
            page.evaluate('window.TexloomGpuPlayer.setParameter("radius",.9)')
            restored = page.evaluate('window.TexloomGpuPlayer.getFrame()')
            self.assertEqual(restored['resources'], before['resources'])
            self.assertTrue(page.evaluate('window.TexloomGpuPlayer.getState().sourceUnchanged'))
            self.assertFalse(page.evaluate('window.TexloomGpuPlayer.getState().failed'))
            self.assertEqual(errors, [])
            self.assertEqual(requests, [])
        finally:
            page.close()


if __name__ == '__main__':
    unittest.main()
