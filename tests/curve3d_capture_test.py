"""Real literal TeX capture, exact expression provenance and atomic publication."""
import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
from compile import compile_scene
from curve3d_capture import lower_curves3d, Curve3DCaptureDiagnostic, MAX_CAPTURE_BYTES


def curve():
    return {'units': 'm', 'domain': [0, 1], 'segments': 8,
            'position': ['u', 'u*u', '0'], 'frame': {'seed': {'kind': 'up', 'up': [0, 0, 1]}}}


def document(body=''):
    return ('\\documentclass{article}\n\\usepackage{texloom-curve3d}\n\\begin{document}\n'
            '\\TLScene{Curve fixture}{320}{180}{2}\n' + body + '\n\\end{document}\n')


def declaration(value=None, progress='time/2s'):
    scene = {'version': 1, 'units': 'm', 'handedness': 'right', 'upAxis': 'z',
             'nodes': [{'id': 'path', 'kind': 'curve', 'resourceId': 'curve'}, {'id': 'frame', 'kind': 'group'}]}
    return ('\\loomspatialcurve{curve}|' + json.dumps(curve() if value is None else value) + '|\n'
            '\\loomspace|' + json.dumps(scene) + '|\n'
            '\\loomfollowcurve{frame}|' + json.dumps({'curveNode': 'path', 'progress': progress}) + '|')


class CurveCaptureTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.folder = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def records(self, name, items):
        execution = self.folder / name
        execution.mkdir()
        records = []
        for index, (kind, identifier, text) in enumerate(items, 1):
            base = f'scene.tl-curve3d-{index}'
            (execution / f'{base}.body.txt').write_text(text + '\n', encoding='utf8')
            (execution / f'{base}.id.txt').write_text(identifier + '\n', encoding='utf8')
            records.append({'type': 'curve3d-file', 'kind': kind, 'file': base})
        return execution, records

    def test_real_helix_demo_preserves_literals_and_native_labels(self):
        output = self.folder / 'example'
        bundle = compile_scene(ROOT / 'examples/curve-frames.tex', output)
        self.assertEqual(bundle['version'], '0.3')
        self.assertNotIn('helix', bundle['resources'])
        self.assertEqual(bundle['resources']['axis-arrow']['kind'], 'mesh')
        self.assertEqual(bundle['resources']['tangent-label']['kind'], 'vector')
        operation, = bundle['curves3d']['operations']
        follower, = bundle['curves3d']['followers']
        self.assertEqual((operation['id'], operation['resourceId'], operation['segments']), ('helix', 'helix', 160))
        self.assertEqual((follower['target'], follower['curveNode'], follower['progress']), ('traveller', 'helix-path', 'time/8s'))
        for expression, span in zip(operation['position'], operation['expressionSpans']['position']):
            self.assertEqual((output / span['file']).read_text(encoding='utf8'), expression + '\n')
            self.assertEqual(span['start'], {'line': 1, 'column': 1})
        self.assertEqual((output / follower['expressionSpan']['file']).read_text(), 'time/8s\n')
        sources = bundle['provenance']['curve3dCapture']
        self.assertEqual(json.loads((output / 'curve3d-sources/declarations.json').read_text()), sources)
        for descriptor in [operation, follower]:
            raw = json.loads((output / descriptor['sourceSpan']['file']).read_text())
            self.assertNotIn('sourceSpan', raw)
            self.assertNotIn('resourceId', raw)
            self.assertNotIn('target', raw)

    def test_repeated_compile_unused_package_and_unexpanded_body(self):
        source, output = self.folder / 'repeat.tex', self.folder / 'repeat-out'
        source.write_text(document(declaration()), encoding='utf8')
        first = compile_scene(source, output)
        self.assertEqual(first['curves3d'], compile_scene(source, output)['curves3d'])
        source.write_text(document(), encoding='utf8')
        unused = compile_scene(source, output)
        self.assertEqual(unused['version'], '0.1')
        self.assertNotIn('curves3d', unused)
        value = curve(); value['position'][0] = r'u+\notexpanded # % λ'
        source.write_text(document('\\def\\notexpanded{999}\n' + declaration(value)), encoding='utf8')
        with self.assertRaises(ValueError):
            compile_scene(source, output)
        body = json.loads((output / 'curve3d-sources/scene.tl-curve3d-1.body.txt').read_text(encoding='utf8'))
        self.assertEqual(body['position'][0], value['position'][0])
        self.assertFalse((output / 'bundle.json').exists())

    def test_shared_validator_rejects_before_publication(self):
        units = curve(); units['units'] = 'cm'
        dimensioned = curve(); dimensioned['position'][0] = '1bp'
        unknown = curve(); unknown['callback'] = 'never executed'
        seed = curve(); seed['frame']['seed']['up'] = [0, 0, 0]
        for index, (value, progress) in enumerate([(units, 'time/2s'), (dimensioned, 'time/2s'),
                                                  (unknown, 'time/2s'), (seed, 'time/2s'), (curve(), 'time')]):
            source, output = self.folder / f'invalid-{index}.tex', self.folder / f'invalid-{index}'
            source.write_text(document(declaration(value, progress)), encoding='utf8')
            output.mkdir(); (output / 'bundle.json').write_text('{"stale":true}')
            with self.subTest(index=index), self.assertRaises(ValueError):
                compile_scene(source, output)
            self.assertFalse((output / 'bundle.json').exists())
            self.assertFalse(json.loads((output / 'compile-report.json').read_text())['success'])

    def test_strict_json_paths_and_caps_are_located_and_atomic(self):
        cases = [('keys', '{"x":1,"x":2}', 'CURVE3D_CAPTURE_DUPLICATE'),
                 ('nan', '{"x":NaN}', 'CURVE3D_CAPTURE_NONFINITE'),
                 ('overflow', '{"x":1e999}', 'CURVE3D_CAPTURE_NONFINITE'),
                 ('array', '[]', 'CURVE3D_CAPTURE_JSON'),
                 ('depth', '[' * 130 + '0' + ']' * 130, 'CURVE3D_CAPTURE_BUDGET'),
                 ('reserved', '{"resourceId":"other"}', 'CURVE3D_CAPTURE_FIELD'),
                 ('size', ' ' * (MAX_CAPTURE_BYTES + 1), 'CURVE3D_CAPTURE_BUDGET')]
        for name, body, code in cases:
            execution, records = self.records(name, [('curve', 'curve', body)])
            bundle = {'version': '0.1', 'resources': {}}
            with self.subTest(name=name), self.assertRaises(Curve3DCaptureDiagnostic) as caught:
                lower_curves3d(records, bundle, execution, self.folder / 'archive')
            self.assertEqual(caught.exception.code, code)
            if name != 'size':
                self.assertIsNotNone(caught.exception.sourceSpan)
            self.assertEqual(bundle, {'version': '0.1', 'resources': {}})
        for base in ['../scene.tl-curve3d-1', 'scene.tl-curve3d-0', 'scene.tl-curve3d-99']:
            with self.assertRaisesRegex(Curve3DCaptureDiagnostic, 'CURVE3D_CAPTURE_PATH'):
                lower_curves3d([{'type': 'curve3d-file', 'kind': 'curve', 'file': base}], {}, self.folder, self.folder)

    def test_resource_follower_collisions_and_surface_collision(self):
        variants = [({'resources': {'taken': {'kind': 'vector'}}}, [('curve', 'taken', curve())]),
                    ({'resources': {}, 'surfaces': {'operations': [{'resourceId': 'taken'}]}}, [('curve', 'taken', curve())]),
                    ({'resources': {}}, [('curve', 'same', curve()), ('curve', 'same', curve())]),
                    ({'resources': {}}, [('follower', 'same', {}), ('follower', 'same', {})])]
        for index, (base, items) in enumerate(variants):
            execution, records = self.records(str(index), [(kind, key, json.dumps(value)) for kind, key, value in items])
            bundle = {'version': '0.1', **base}; before = copy.deepcopy(bundle)
            with self.assertRaisesRegex(Curve3DCaptureDiagnostic, 'CURVE3D_CAPTURE_DUPLICATE'):
                lower_curves3d(records, bundle, execution, self.folder / 'archive')
            self.assertEqual(bundle, before)


if __name__ == '__main__':
    unittest.main()
