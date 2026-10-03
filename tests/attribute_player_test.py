"""Native sphere attribute data and independent linear-RGB raster interpolation."""
import base64
import hashlib
import io
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


def triples(values):
    return list(zip(*[iter(values)]*3))


def field(point, time):
    x, y, z = point
    phase = math.pi*time/4
    return [.5+.45*math.cos(3*x+phase), .5+.45*math.sin(3*y-phase), .5+.45*math.sin(3*z+phase/2)]


def srgb(value):
    encoded = 12.92*value if value <= .0031308 else 1.055*value**(1/2.4)-.055
    return round(255*encoded)


class AttributePlayerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.folder = Path(cls.temp.name)
        cls.bundle = compile_scene(ROOT / 'examples/mesh-attributes.tex', cls.folder / 'native')
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
        cls.browser.close(); cls.playwright.stop(); cls.temp.cleanup()

    def open(self, capture=False, mobile=False):
        page = self.browser.new_page(viewport={'width': 390, 'height': 844} if mobile else {'width': 960, 'height': 540},
                                     reduced_motion='reduce')
        errors, requests = [], []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('console', lambda message: errors.append(message.text) if message.type == 'error' else None)
        page.on('request', lambda request: requests.append(request.url) if request.url.startswith(('http:', 'https:')) else None)
        page.goto(self.player.as_uri() + ('?capture=1' if capture else ''))
        page.evaluate('async()=>{await window.TexloomGpuPlayer.ready;}')
        return page, errors, requests

    def assert_attributes(self, frame, time, radius=1):
        source, vertex, face = [frame['resources'][name] for name in ['sphere', 'vertex-sphere', 'face-sphere']]
        self.assertNotIn('attributes', source)
        self.assertEqual(source['positions']['count'], 114)
        self.assertEqual(source['indices']['count'], 672)
        for derived in [vertex, face]:
            for key in ['positions', 'indices', 'bounds', 'topologyRevision']:
                self.assertEqual(derived[key], source[key])
            topology = derived['attributes']['topology']
            self.assertEqual(topology['indices'], source['indices']['data'])
            self.assertEqual(topology['vertexCount'], 114)
        points = triples(source['positions']['data'])
        vertex_colors = triples(vertex['attributes']['values']['chroma']['buffer']['data'])
        heights = vertex['attributes']['values']['height']['buffer']['data']
        for point, color, height in zip(points, vertex_colors, heights):
            self.assertAlmostEqual(math.sqrt(sum(x*x for x in point)), radius, delta=2e-12)
            self.assertEqual(height, point[2])
            for actual, expected in zip(color, field(point, time)):
                self.assertAlmostEqual(actual, expected, delta=2e-12)
        self.assertEqual(face['attributes']['values']['height'], vertex['attributes']['values']['height'])
        self.assertEqual(face['attributes']['values']['chroma'], vertex['attributes']['values']['chroma'])
        face_attribute = face['attributes']['values']['face-chroma']
        self.assertEqual(face_attribute['domain'], 'face')
        self.assertEqual(face_attribute['valueType'], 'color')
        self.assertEqual(face_attribute['buffer']['count'], 224)
        face_colors = triples(face_attribute['buffer']['data'])
        for indices, color in zip(triples(source['indices']['data']), face_colors):
            reference = [sum(vertex_colors[i][component] for i in indices)/3 for component in range(3)]
            for actual, expected in zip(color, reference):
                self.assertAlmostEqual(actual, expected, delta=2e-12)
        instances = frame['space3d']['instances']
        self.assertEqual([n['material']['colorAttribute'] for n in instances], ['chroma', 'face-chroma'])
        self.assertTrue(all(overlay['visible'] for overlay in frame['space3d']['overlays']))
        return points, triples(source['indices']['data']), vertex_colors, face_colors

    def test_native_analytic_captures_and_mean_transfer_reverse_seek_exactly(self):
        page, errors, requests = self.open(capture=True)
        try:
            images = {}
            for time in [0, .5, 2, 4, 6, 8]:
                capture = page.evaluate('t=>window.TexloomGpuPlayer.capture(t)', time)
                self.assert_attributes(page.evaluate('window.TexloomGpuPlayer.getFrame()'), time)
                images[time] = hashlib.sha256(base64.b64decode(capture['data'])).hexdigest()
            self.assertGreater(len(set(images.values())), 4)
            for time in reversed(list(images)):
                capture = page.evaluate('t=>window.TexloomGpuPlayer.capture(t)', time)
                self.assertEqual(hashlib.sha256(base64.b64decode(capture['data'])).hexdigest(), images[time])
            self.assertEqual(errors, []); self.assertEqual(requests, [])
        finally:
            page.close()

    def test_visible_face_interiors_are_flat_and_vertex_pixels_interpolate_linear_rgb(self):
        page, errors, requests = self.open(capture=True)
        try:
            capture = page.evaluate('window.TexloomGpuPlayer.capture(0)')
            points, indices, colors, face_colors = self.assert_attributes(page.evaluate('window.TexloomGpuPlayer.getFrame()'), 0)
            image = Image.open(io.BytesIO(base64.b64decode(capture['data']))).convert('RGB')
            # Independent orthographic projection from authored camera [0,-7,3],
            # height4.5 and left-instance translation[-1.6,0,0]. No renderer helpers.
            d = math.sqrt(58)
            projected = [(480+(x-1.6)*120, 270-(3*y+7*z)/d*120, (-7*y+3*z-58)/d) for x, y, z in points]
            def at(px, py):
                hits = []
                for face_index, triangle in enumerate(indices):
                    a, b, c = [projected[i] for i in triangle]
                    denominator = (b[1]-c[1])*(a[0]-c[0])+(c[0]-b[0])*(a[1]-c[1])
                    # Front-facing source winding has negative screen area (downward Y).
                    if denominator >= -40:
                        continue
                    wa = ((b[1]-c[1])*(px-c[0])+(c[0]-b[0])*(py-c[1]))/denominator
                    wb = ((c[1]-a[1])*(px-c[0])+(a[0]-c[0])*(py-c[1]))/denominator
                    weights = [wa, wb, 1-wa-wb]
                    if min(weights) >= 0:
                        depth = sum(w*p[2] for w, p in zip(weights, [a, b, c]))
                        hits.append((depth, face_index, triangle, weights))
                if not hits:
                    return None
                hit = max(hits)
                return hit if min(hit[3]) > .18 else None
            flat_samples, comparisons, differences = {}, 0, 0
            for y in range(188, 353, 5):
                for x in range(200, 381, 5):
                    hit = at(x+.5, y+.5)
                    if hit is None:
                        continue
                    _, face_index, triangle, weights = hit
                    expected_vertex = [srgb(sum(w*colors[i][channel] for w, i in zip(weights, triangle))) for channel in range(3)]
                    expected_face = [srgb(value) for value in face_colors[face_index]]
                    left, right = image.getpixel((x, y)), image.getpixel((x+384, y))
                    for actual, expected in zip(left, expected_vertex):
                        self.assertLessEqual(abs(actual-expected), 2, (x, y, 'vertex', left, expected_vertex))
                    for actual, expected in zip(right, expected_face):
                        self.assertLessEqual(abs(actual-expected), 2, (x, y, 'face', right, expected_face))
                    flat_samples.setdefault(face_index, []).append(right)
                    comparisons += 1
                    differences += max(abs(a-b) for a, b in zip(left, right)) > 8
            self.assertGreater(comparisons, 100)
            self.assertGreater(differences, 40)
            repeated_faces = [values for values in flat_samples.values() if len(values) >= 3]
            self.assertGreater(len(repeated_faces), 10)
            for samples in repeated_faces:
                for channel in range(3):
                    self.assertLessEqual(max(p[channel] for p in samples)-min(p[channel] for p in samples), 1)
            self.assertEqual(errors, []); self.assertEqual(requests, [])
        finally:
            page.close()

    def test_radius_regenerates_both_domains_without_mutating_source_on_mobile(self):
        page, errors, requests = self.open(mobile=True)
        try:
            self.assertFalse(page.evaluate('document.documentElement.scrollWidth>innerWidth'))
            page.evaluate('window.TexloomGpuPlayer.seek(2)')
            before = page.evaluate('window.TexloomGpuPlayer.getFrame()')
            page.get_by_label('radius', exact=True).evaluate("e=>{e.value='.85';e.dispatchEvent(new Event('input',{bubbles:true}));}")
            changed = page.evaluate('window.TexloomGpuPlayer.getFrame()')
            self.assert_attributes(changed, 2, .85)
            self.assertNotEqual(changed['resources']['vertex-sphere']['attributes']['values']['chroma'], before['resources']['vertex-sphere']['attributes']['values']['chroma'])
            self.assertEqual(changed['resources']['sphere']['indices'], before['resources']['sphere']['indices'])
            page.get_by_label('Camera projection', exact=True).select_option('perspective')
            self.assert_attributes(page.evaluate('window.TexloomGpuPlayer.getFrame()'), 2, .85)
            page.evaluate('window.TexloomGpuPlayer.setParameter("radius",1)')
            self.assertEqual(page.evaluate('window.TexloomGpuPlayer.getFrame().resources'), before['resources'])
            self.assertTrue(page.evaluate('window.TexloomGpuPlayer.getState().sourceUnchanged'))
            self.assertEqual(errors, []); self.assertEqual(requests, [])
        finally:
            page.close()


if __name__ == '__main__':
    unittest.main()
