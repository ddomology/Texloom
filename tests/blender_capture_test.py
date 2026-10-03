"""Native TeX import, source provenance, local-path boundaries and atomic failure."""
import copy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
from blender_capture import lower_blender, BlenderCaptureDiagnostic
from compile import compile_scene


class BlenderCaptureTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.folder = Path(self.temp.name)
        self.execution = self.folder / 'execution'
        self.execution.mkdir()
        self.source = self.folder / 'scene.tex'
        self.source.write_text('')
        self.base = 'scene.tl-blender-1'
        self.records = [{'type': 'blender-file', 'file': self.base}]

    def tearDown(self):
        self.temp.cleanup()

    def declaration(self, scope='asset', path='manifest.json'):
        (self.execution / (self.base + '.id.txt')).write_text(scope + '\n')
        (self.execution / (self.base + '.body.txt')).write_text(path + '\n')

    def test_paths_duplicate_json_scopes_and_sidecars_leave_bundle_unchanged(self):
        for case in ['traversal', 'absolute', 'remote', 'missing', 'duplicate-json', 'bad-scope', 'duplicate-sidecar']:
            with self.subTest(case=case):
                path = {'traversal': '../outside.json', 'absolute': str(self.folder / 'manifest.json'),
                        'remote': 'https://example.com/manifest.json', 'missing': 'missing.json'}.get(case, 'manifest.json')
                (self.folder / 'manifest.json').write_text('{"version":1,"version":2}')
                self.declaration('invalid:scope' if case == 'bad-scope' else 'asset', path)
                bundle = {'version': '0.3', 'resources': {}}
                before = copy.deepcopy(bundle)
                records = self.records * 2 if case == 'duplicate-sidecar' else self.records
                with self.assertRaises(BlenderCaptureDiagnostic):
                    lower_blender(records, bundle, self.execution, self.folder / 'out', self.source)
                self.assertEqual(bundle, before)

    def test_native_import_failure_removes_stale_published_bundle(self):
        self.source.write_text(r'''\documentclass{article}
\usepackage{texloom-blender}
\begin{document}
\TLScene{Bad import}{320}{180}{8}
\loomblender{model}{missing.json}
\end{document}
''')
        output = self.folder / 'failed'
        output.mkdir()
        (output / 'bundle.json').write_text('stale')
        with self.assertRaises(BlenderCaptureDiagnostic):
            compile_scene(self.source, output)
        self.assertFalse((output / 'bundle.json').exists())
        self.assertFalse(json.loads((output / 'compile-report.json').read_text())['success'])

    def test_native_example_archives_exact_import_and_author_placement(self):
        source = ROOT / 'examples/blender-evaluated.tex'
        output = self.folder / 'native'
        bundle = compile_scene(source, output)
        capture = bundle['provenance']['blenderCapture']
        self.assertEqual(len(capture['declarations']), 1)
        item = capture['declarations'][0]
        original = (source.parent / item['sourcePath']).read_bytes()
        self.assertEqual((output / item['manifest']).read_bytes(), original)
        self.assertEqual(item['manifestSha256'], hashlib.sha256(original).hexdigest())
        self.assertEqual(item['byteLength'], len(original))
        self.assertEqual(json.loads((output / 'blender-sources/declarations.json').read_text()), capture)
        self.assertEqual(item['id'], 'model')
        self.assertEqual(item['presentation'], {'wireframe': True})
        self.assertTrue(all(node['material']['wireframe'] for node in bundle['space3d']['nodes'] if node['kind'] == 'mesh'))
        group = next(node for node in bundle['space3d']['nodes'] if node['id'] == 'model')
        self.assertEqual(group['kind'], 'group')
        self.assertEqual(bundle['duration'], 8)
        self.assertTrue(bundle.get('bakes'))
        self.assertTrue(bundle.get('sampledFields'))
        self.assertGreaterEqual(sum(r['kind'] == 'vector' for r in bundle['resources'].values()), 6)

    def test_import_only_scene_promotes_version_and_rejects_unknown_presentation(self):
        original = (ROOT / 'examples/data/blender-evaluated/manifest.json').read_bytes()
        (self.folder / 'manifest.json').write_bytes(original)
        template = r'''\documentclass{article}
\usepackage{texloom-blender}
\begin{document}
\TLScene{Imported model}{640}{360}{8}
\loomblender%s{model}{manifest.json}
\end{document}
'''
        self.source.write_text(template % '')
        output = self.folder / 'import-only'
        bundle = compile_scene(self.source, output)
        self.assertEqual(bundle['version'], '0.3')
        self.assertTrue(any(node['id'] == 'model' and node['kind'] == 'group' for node in bundle['space3d']['nodes']))
        self.assertFalse(any(node.get('material', {}).get('wireframe', False) for node in bundle['space3d']['nodes']))
        self.source.write_text(template % '[glossy]')
        with self.assertRaises(BlenderCaptureDiagnostic):
            compile_scene(self.source, output)
        self.assertFalse((output / 'bundle.json').exists())


if __name__ == '__main__':
    unittest.main()
