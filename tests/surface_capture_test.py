"""Real TeX literal capture and publication gates for generated surface resources."""
import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
from compile import compile_scene
from surface_capture import lower_surfaces, SurfaceCaptureDiagnostic, MAX_CAPTURE_BYTES


def plane():
    return {'units': 'm', 'domain': {'u': [0, 1], 'v': [0, 1]},
            'segments': {'u': 2, 'v': 2}, 'position': ['u', 'v', '0'],
            'normals': {'kind': 'analytic', 'dU': ['1', '0', '0'], 'dV': ['0', '1', '0']}}


def document(body=''):
    return ('\\documentclass{article}\n\\usepackage{texloom-surface}\n\\begin{document}\n'
            '\\TLScene{Surface fixture}{320}{180}{2}\n' + body + '\n\\end{document}\n')


def declaration(value=None):
    scene = {'version': 1, 'units': 'm', 'handedness': 'right', 'upAxis': 'z',
             'nodes': [{'id': 'instance', 'kind': 'mesh', 'resourceId': 'sheet'}]}
    return ('\\loomsurface{sheet}|' + json.dumps(plane() if value is None else value) + '|\n'
            '\\loomspace|' + json.dumps(scene) + '|')


class SurfaceCaptureTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.folder = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def records(self, name, items):
        execution = self.folder / name
        execution.mkdir()
        records = []
        for index, (resource_id, text) in enumerate(items, 1):
            base = f'scene.tl-surface-{index}'
            (execution / f'{base}.body.txt').write_text(text + '\n', encoding='utf8')
            (execution / f'{base}.id.txt').write_text(resource_id + '\n', encoding='utf8')
            records.append({'type': 'surface-file', 'file': base})
        return execution, records

    def test_real_sphere_torus_example_captures_program_without_authored_mesh_buffers(self):
        output = self.folder / 'example'
        bundle = compile_scene(ROOT / 'examples/parametric-surfaces.tex', output)
        self.assertEqual(bundle['version'], '0.3')
        self.assertEqual([op['resourceId'] for op in bundle['surfaces']['operations']], ['sphere', 'torus'])
        self.assertTrue(all(r['kind'] == 'vector' for r in bundle['resources'].values()))
        self.assertNotIn('sphere', bundle['resources'])
        self.assertNotIn('torus', bundle['resources'])
        self.assertEqual(bundle['expressions']['parameters']['radius']['default'], .9)
        sources = bundle['provenance']['surfaceCapture']
        self.assertEqual(len(sources['declarations']), 2)
        for operation, declaration in zip(bundle['surfaces']['operations'], sources['declarations']):
            text = (output / declaration['sourceSpan']['file']).read_text(encoding='utf8')
            authored = json.loads(text)
            self.assertEqual(authored['position'], operation['position'])
            self.assertEqual(operation['id'], operation['resourceId'])
            for key, spans in operation['expressionSpans'].items():
                expressions = operation['position'] if key == 'position' else operation['normals'][key]
                for expression, span in zip(expressions, spans):
                    self.assertEqual((output / span['file']).read_text(encoding='utf8'), expression + '\n')
                    self.assertEqual(span['start'], {'line': 1, 'column': 1})
        self.assertEqual(json.loads((output / 'surface-sources/declarations.json').read_text()), sources)

    def test_real_repeat_unused_package_and_literal_json_remain_independent(self):
        source, output = self.folder / 'repeat.tex', self.folder / 'repeat-out'
        source.write_text(document(declaration()), encoding='utf8')
        first = compile_scene(source, output)
        second = compile_scene(source, output)
        self.assertEqual(first['surfaces'], second['surfaces'])
        source.write_text(document(), encoding='utf8')
        unused = compile_scene(source, output)
        self.assertEqual(unused['version'], '0.1')
        self.assertNotIn('surfaces', unused)
        self.assertNotIn('surfaceCapture', unused['provenance'])
        value = plane(); value['position'][0] = r'u+\notexpanded # % λ'
        source.write_text(document('\\def\\notexpanded{999}\n' + declaration(value)), encoding='utf8')
        with self.assertRaises(ValueError):
            compile_scene(source, output)
        captured = json.loads((output / 'surface-sources/scene.tl-surface-1.body.txt').read_text(encoding='utf8'))
        self.assertEqual(captured['position'][0], value['position'][0])
        self.assertFalse((output / 'bundle.json').exists())

    def test_shared_validator_rejects_invalid_program_before_publication(self):
        dimensioned = plane(); dimensioned['position'][0] = '1bp'
        unknown = plane(); unknown['callbacks'] = 'not executable'
        resolution = plane(); resolution['segments']['u'] = 0
        units = plane(); units['units'] = 'cm'
        for index, value in enumerate([dimensioned, unknown, resolution, units]):
            source, output = self.folder / f'invalid-{index}.tex', self.folder / f'invalid-{index}'
            source.write_text(document(declaration(value)), encoding='utf8')
            output.mkdir(); (output / 'bundle.json').write_text('{"stale":true}')
            with self.subTest(index=index), self.assertRaises(ValueError):
                compile_scene(source, output)
            self.assertFalse((output / 'bundle.json').exists())
            self.assertFalse(json.loads((output / 'compile-report.json').read_text())['success'])

    def test_strict_json_paths_identifiers_and_budgets_have_located_diagnostics(self):
        cases = [
            ('keys', '{"x":1,"x":2}', 'sheet', 'SURFACE_CAPTURE_DUPLICATE'),
            ('nan', '{"x":NaN}', 'sheet', 'SURFACE_CAPTURE_NONFINITE'),
            ('overflow', '{"x":1e999}', 'sheet', 'SURFACE_CAPTURE_NONFINITE'),
            ('integer', '{"x":' + '9' * 400 + '}', 'sheet', 'SURFACE_CAPTURE_NONFINITE'),
            ('array', '[]', 'sheet', 'SURFACE_CAPTURE_JSON'),
            ('depth', '[' * 130 + '0' + ']' * 130, 'sheet', 'SURFACE_CAPTURE_BUDGET'),
            ('size', ' ' * (MAX_CAPTURE_BYTES + 1), 'sheet', 'SURFACE_CAPTURE_BUDGET'),
            ('id', json.dumps(plane()), '../outside', 'SURFACE_CAPTURE_ID'),
            ('macro', json.dumps(plane()), r'\name', 'SURFACE_CAPTURE_ID'),
            ('reserved', '{"resourceId":"other"}', 'sheet', 'SURFACE_CAPTURE_FIELD'),
        ]
        for name, text, resource_id, code in cases:
            execution, records = self.records(name, [(resource_id, text)])
            bundle = {'version': '0.1', 'resources': {}}
            with self.subTest(name=name), self.assertRaises(SurfaceCaptureDiagnostic) as caught:
                lower_surfaces(records, bundle, execution, self.folder / 'archive')
            self.assertEqual(caught.exception.code, code)
            if name != 'size':
                self.assertIsNotNone(caught.exception.sourceSpan)
            self.assertEqual(bundle, {'version': '0.1', 'resources': {}})
        for base in ['../scene.tl-surface-1', 'scene.tl-surface-0', 'scene.tl-surface-99']:
            with self.assertRaisesRegex(SurfaceCaptureDiagnostic, 'SURFACE_CAPTURE_PATH'):
                lower_surfaces([{'type': 'surface-file', 'file': base}], {}, self.folder, self.folder)

    def test_resource_and_operation_collisions_are_atomic(self):
        for kind in ['vector', 'mesh', 'scalar-field']:
            execution, records = self.records(kind, [('new', json.dumps(plane())), ('occupied', json.dumps(plane()))])
            bundle = {'version': '0.1', 'resources': {'occupied': {'kind': kind}}}
            before = copy.deepcopy(bundle)
            with self.assertRaisesRegex(SurfaceCaptureDiagnostic, 'SURFACE_CAPTURE_DUPLICATE'):
                lower_surfaces(records, bundle, execution, self.folder / 'archive')
            self.assertEqual(bundle, before)
        for index, items in enumerate([
            [('same', json.dumps(plane())), ('same', json.dumps(plane()))],
            [('one', json.dumps({**plane(), 'id': 'same'})), ('two', json.dumps({**plane(), 'id': 'same'}))],
        ]):
            execution, records = self.records(f'duplicate-{index}', items)
            bundle = {'version': '0.1', 'resources': {}}
            with self.assertRaisesRegex(SurfaceCaptureDiagnostic, 'SURFACE_CAPTURE_DUPLICATE'):
                lower_surfaces(records, bundle, execution, self.folder / 'archive')
            self.assertEqual(bundle, {'version': '0.1', 'resources': {}})


if __name__ == '__main__':
    unittest.main()
