"""Actual WebGL2 conformance against an independent tiny GL reference."""
import json
import hashlib
from pathlib import Path
import subprocess
import tempfile
import unittest

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]


class GpuRendererTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        (ROOT/'build').mkdir(exist_ok=True)
        cls.directory = tempfile.TemporaryDirectory(prefix='gpu-browser-', dir=ROOT/'build')
        cls.output = Path(cls.directory.name)
        result = subprocess.run(['node', '-e',
            "require('esbuild').buildSync({entryPoints:[process.argv[1]],bundle:true,format:'iife',outfile:process.argv[2]})",
            str(ROOT/'tests/gpu-browser.ts'), str(cls.output/'entry.js')],
            cwd=ROOT, capture_output=True, text=True, encoding='utf8')
        if result.returncode:
            raise AssertionError(result.stdout + result.stderr)
        (cls.output/'index.html').write_text('<!doctype html><meta charset="utf-8"><script src="entry.js"></script>', encoding='utf8')
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(headless=True, args=['--enable-unsafe-swiftshader'])
        cls.reports = {}
        cls.browser_errors = []

    @classmethod
    def tearDownClass(cls):
        report = {'success':len(cls.reports)==5 and not cls.browser_errors, 'browser':cls.browser.version,
            'browserErrors':cls.browser_errors, 'checks':cls.reports,
            'files':{name:hashlib.sha256((ROOT/name).read_bytes()).hexdigest() for name in
                ('src/renderers/gpu/index.ts','src/renderers/gpu/data.ts','tests/gpu-browser.ts',
                 'tests/gpu-reference.ts','tests/gpu_renderer_test.py','src/ir/scene3d.ts',
                 'src/geometry/projection3d.ts','package-lock.json')}}
        folder = ROOT/'build/gpu-conformance'
        folder.mkdir(parents=True, exist_ok=True)
        (folder/'report.json').write_text(json.dumps(report, indent=2)+'\n', encoding='utf8')
        cls.browser.close()
        cls.playwright.stop()
        cls.directory.cleanup()

    def setUp(self):
        self.page = self.browser.new_page()
        self.errors = []
        self.page.on('pageerror', lambda e: self.errors.append(str(e)))
        self.page.goto((self.output/'index.html').as_uri())

    def tearDown(self):
        self.browser_errors.extend(self.errors)
        self.page.close()
        self.assertEqual(self.errors, [])

    def test_projection_depth_clipping_reflection_and_camera_against_raw_webgl2(self):
        reports = []
        for mode in ('orthographic', 'perspective', 'depth', 'reflection', 'double', 'backface', 'clip',
                     'camera-affine', 'camera-reflection', 'camera-reflection-double'):
            report = self.page.evaluate('(mode) => gpuQa.parity(mode)', mode)
            reports.append(report)
            self.assertEqual(report['changedChannels'], 0, report)
            self.assertTrue(report['sourceUnchanged'])
        by_mode = {r['mode']:r for r in reports}
        self.assertEqual(by_mode['depth']['center'], [255,0,0,255])
        self.assertEqual(by_mode['backface']['paintedPixels'], 0)
        self.assertEqual(by_mode['reflection']['paintedPixels'], by_mode['orthographic']['paintedPixels'])
        self.assertEqual(by_mode['double']['paintedPixels'], by_mode['orthographic']['paintedPixels'])
        self.assertEqual(by_mode['camera-reflection']['paintedPixels'], 0)
        self.assertEqual(by_mode['camera-reflection-double']['paintedPixels'], by_mode['orthographic']['paintedPixels'])
        self.assertEqual(by_mode['clip']['left'], [0,0,0,0])
        self.assertEqual(by_mode['clip']['right'], [255,0,0,255])
        # Independent analytic positions: orthographic height 2 maps x ±.5 to pixels 32/96;
        # perspective fov π/2 at z=-2 maps the same x values to 48/80.
        self.assertEqual(by_mode['orthographic']['bounds'][0:3:2], [32,95])
        self.assertEqual(by_mode['perspective']['bounds'][0:3:2], [48,79])
        self.reports['referenceParity'] = reports

    def test_reverse_seek_and_resize_reproduce_exact_same_browser_pixels(self):
        report = self.page.evaluate('gpuQa.history()')
        self.assertTrue(all(report['checks']), report)
        self.assertEqual(len(set(report['hashes'])), 3)
        self.assertEqual(report['dimensions'], [96,64])
        self.assertTrue(report['restoredSizeSame'])
        self.reports['historyAndResize'] = report

    def test_shared_geometry_identity_replacement_pruning_and_disposal(self):
        report = self.page.evaluate('gpuQa.ownership()')
        self.assertEqual(report['shared']['geometries'], 1)
        self.assertEqual(report['shared']['instances'], 2)
        self.assertEqual(report['same']['geometries'], 1)
        self.assertEqual(report['replacement']['geometries'], 1)
        self.assertEqual(report['replacement']['instances'], 1)
        self.assertTrue(report['different'])
        self.assertTrue(report['sourceUnchanged'])
        for state in ('empty', 'disposed'):
            for key in ('geometries','materials','instances','bufferBytes'):
                self.assertEqual(report[state][key], 0, report)
        self.assertEqual(report['disposed']['state'], 'disposed')
        self.assertEqual(report['afterDispose'], 'GPU_DISPOSED')
        self.reports['ownership'] = report

    def test_capability_precision_and_ownership_failures_are_explicit(self):
        report = self.page.evaluate('gpuQa.errors()')
        self.assertEqual(report, {'projection':'GPU_PROJECTION','dimensions':'GPU_SIZE','color':'GPU_COLOR',
            'unavailable':'GPU_WEBGL2','mutable':'GPU_RESOURCE_MUTABLE','precision':'GPU_PRECISION'})
        self.reports['failures'] = report

    def test_context_loss_fails_then_rebuilds_equivalent_buffers_on_restore(self):
        report = self.page.evaluate('gpuQa.context()')
        self.assertEqual(report['stateLost'], 'lost')
        self.assertEqual(report['error'], 'GPU_CONTEXT_LOST')
        self.assertEqual(report['lostStats']['geometries'], 0)
        self.assertEqual(report['stateRestored'], 'ready')
        self.assertTrue(report['samePixels'])
        self.assertEqual(report['restored']['contextGeneration'], 2)
        self.assertEqual(report['restored']['geometries'], 1)
        self.reports['context'] = report


if __name__ == '__main__':
    unittest.main()
