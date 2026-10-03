"""Real TeX → bundled numeric inspector, checked against independent affine arithmetic."""
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


class MeshInspectorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.folder = Path(cls.temp.name)
        cls.bundle = compile_scene(ROOT / 'examples/mesh-space.tex', cls.folder / 'native')
        cls.page_file = cls.folder / 'inspector.html'
        built = subprocess.run(['node', str(ROOT / 'tools/build-mesh-inspector.mjs'),
                                str(cls.folder / 'native/bundle.json'), str(cls.page_file)],
                               cwd=ROOT, capture_output=True, text=True, encoding='utf8')
        if built.returncode:
            raise AssertionError(built.stdout + built.stderr)
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()
        cls.temp.cleanup()

    def open(self, viewport=None):
        page = self.browser.new_page(viewport=viewport or {'width': 1440, 'height': 1100})
        errors, requests = [], []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('console', lambda message: errors.append(message.text) if message.type == 'error' else None)
        page.on('request', lambda request: requests.append(request.url) if request.url.startswith(('http:', 'https:')) else None)
        page.goto(self.page_file.as_uri())
        page.wait_for_function('window.texloomMeshQA?.ready === true')
        return page, errors, requests

    def snapshot(self, page):
        return page.evaluate('window.texloomMeshQA.snapshot()')

    def assert_geometry(self, state, first_scale=2, camera_x=0):
        self.assertTrue(state['sourceUnchanged'])
        resource = state['resources'][0]
        self.assertEqual(resource['id'], 'unit-cube')
        self.assertEqual(resource['positions'], self.bundle['resources']['unit-cube']['positions']['data'])
        self.assertEqual(resource['indices'], self.bundle['resources']['unit-cube']['indices']['data'])
        self.assertEqual(resource['referencedBy'], ['stretched', 'reflected'])
        self.assertEqual(resource['triangleCount'], 12)
        for instance in state['instances']:
            scale, translation = ([first_scale, 1, .5], [3, 2, 3]) if instance['id'] == 'stretched' else ([-1, 2, 1], [-2, 2, 4])
            matrix = [scale[0], 0, 0, 0, 0, scale[1], 0, 0, 0, 0, scale[2], 0, *translation, 1]
            self.assertEqual(instance['worldMatrix'], matrix)
            for index, vertex in enumerate(instance['vertices']):
                local = resource['positions'][index*3:index*3+3]
                world = [scale[axis]*local[axis] + translation[axis] for axis in range(3)]
                camera = [world[0] - (1 + camera_x), world[1] + 6, world[2] - 8]
                self.assertEqual(vertex['local'], local)
                self.assertEqual(vertex['world'], world)
                self.assertEqual(vertex['camera'], camera)
            minimum = [translation[i] - abs(scale[i]) for i in range(3)]
            maximum = [translation[i] + abs(scale[i]) for i in range(3)]
            self.assertEqual(instance['worldBounds'], {'min': minimum, 'max': maximum})

    def test_default_affine_oracle_reflection_camera_edit_collapse_and_reset(self):
        page, errors, requests = self.open()
        try:
            original = self.snapshot(page)
            self.assert_geometry(original)
            self.assertEqual(original['instances'][0]['orientation'], 1)
            self.assertEqual(original['instances'][1]['orientation'], -1)
            self.assertEqual(page.locator('#wireframe [data-instance]').count(), 2)
            self.assertEqual(page.locator('#wireframe line').count(), 39)  # 18 distinct triangle edges per cube + 3 axes.
            page.get_by_role('button', name='Reflect x axis').click()
            reflected = self.snapshot(page)
            self.assert_geometry(reflected, first_scale=-2)
            self.assertEqual(reflected['instances'][0]['worldWinding'], 'cw')
            self.assertIn('REFLECTED', page.locator('#orientation').inner_text())
            wireframe_before = page.locator('#wireframe').inner_html()
            page.get_by_label('Camera local x', exact=True).focus()
            page.keyboard.press('ArrowRight')
            moved_camera = self.snapshot(page)
            self.assert_geometry(moved_camera, first_scale=-2, camera_x=.25)
            self.assertEqual(page.locator('#wireframe').inner_html(), wireframe_before)
            page.locator('#scale-x').evaluate("e=>{e.value='0';e.dispatchEvent(new Event('input',{bubbles:true}));}")
            collapsed = self.snapshot(page)
            self.assert_geometry(collapsed, first_scale=0, camera_x=.25)
            self.assertEqual(collapsed['instances'][0]['orientation'], 0)
            self.assertIsNone(collapsed['instances'][0]['normalMatrix'])
            page.get_by_role('button', name='Reset source values').click()
            self.assertEqual(self.snapshot(page), original)
            self.assertFalse(page.locator('#error').is_visible())
            self.assertEqual(errors, [])
            self.assertEqual(requests, [])
        finally:
            page.close()

    def test_offline_mobile_layout_selection_and_detached_qa_snapshot(self):
        page, errors, requests = self.open({'width': 390, 'height': 844})
        try:
            self.assertFalse(page.evaluate('document.documentElement.scrollWidth > innerWidth'))
            self.assertIn('Axonometric numeric inspector', page.get_by_role('heading', name='Axonometric numeric inspector').inner_text())
            self.assertIn('no depth, lighting, or GPU rendering', page.locator('.diagram-note').inner_text())
            page.get_by_label('Mesh instance', exact=True).select_option('reflected')
            page.get_by_label('Vertex', exact=True).select_option('6')
            state = self.snapshot(page)
            self.assertEqual((state['selected'], state['vertex']), ('reflected', 6))
            self.assert_geometry(state)
            self.assertIn('World', page.locator('#coordinates').inner_text())
            page.evaluate('window.texloomMeshQA.snapshot().resources[0].positions[0]=999')
            self.assertEqual(self.snapshot(page)['resources'][0]['positions'][0], -1)
            self.assertFalse(page.locator('#error').is_visible())
            self.assertEqual(errors, [])
            self.assertEqual(requests, [])
        finally:
            page.close()


if __name__ == '__main__':
    unittest.main()
