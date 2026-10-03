"""Executed literal 3D declarations preserve native resources and fail before publication."""
import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
from compile import compile_scene
from space3d_capture import lower_space3d, Space3DCaptureDiagnostic, MAX_CAPTURE_BYTES


def mesh():
    return {'kind': 'mesh', 'version': 1, 'primitive': 'triangles', 'units': 'm',
            'coordinateSpace': 'object', 'winding': 'ccw', 'topologyRevision': 'triangle-v1',
            'positions': {'version': 1, 'componentType': 'float32', 'components': 3, 'count': 3,
                          'byteOffset': 0, 'byteStride': 12, 'data': [0, 0, 0, 1, 0, 0, 0, 1, 0]},
            'indices': {'version': 1, 'componentType': 'uint16', 'components': 1, 'count': 3,
                        'byteOffset': 0, 'byteStride': 2, 'data': [0, 1, 2]},
            'bounds': {'min': [0, 0, 0], 'max': [1, 1, 0]}}


def space():
    return {'version': 1, 'units': 'm', 'handedness': 'right', 'upAxis': 'z',
            'nodes': [{'id': 'surface', 'kind': 'mesh', 'resourceId': 'triangle'}]}


def document(body='', package='texloom-space3d'):
    return ('\\documentclass{article}\n\\usepackage{' + package + '}\n' +
            '\\begin{document}\n\\TLScene{Mesh fixture}{320}{180}{2}\n' +
            body + '\n\\end{document}\n')


def declaration(resource=None, program=None):
    resource = mesh() if resource is None else resource
    program = space() if program is None else program
    return '\\loommesh{triangle}|' + json.dumps(resource) + '|\n\\loomspace|' + json.dumps(program) + '|'


class Space3DCaptureTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.folder = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def compile(self, name, body):
        source = self.folder / (name + '.tex')
        source.write_text(body, encoding='utf8')
        output = self.folder / (name + '-out')
        return output, compile_scene(source, output)

    def records(self, name, items):
        execution = self.folder / name
        execution.mkdir()
        records = []
        for index, (kind, text, resource_id) in enumerate(items, 1):
            base = f'scene.tl-space3d-{index}'
            (execution / f'{base}.body.txt').write_text(text + '\n', encoding='utf8')
            if resource_id is not None:
                (execution / f'{base}.id.txt').write_text(resource_id + '\n', encoding='utf8')
            records.append({'type': 'space3d-file', 'kind': kind, 'file': base})
        return execution, records

    def test_real_cube_example_has_two_shared_instances_native_math_and_source_archives(self):
        output = self.folder / 'example'
        bundle = compile_scene(ROOT / 'examples/mesh-space.tex', output)
        self.assertEqual(bundle['version'], '0.3')
        self.assertEqual(set(bundle['resources']), {'unit-cube', 'cube-label'})
        cube = bundle['resources']['unit-cube']
        self.assertEqual(cube['positions']['count'], 8)
        self.assertEqual(cube['indices']['count'], 36)
        self.assertEqual(cube['bounds'], {'min': [-1, -1, -1], 'max': [1, 1, 1]})
        self.assertEqual(bundle['resources']['cube-label']['kind'], 'vector')
        self.assertTrue(bundle['resources']['cube-label']['items'])
        self.assertEqual([n['resourceId'] for n in bundle['space3d']['nodes'] if n['kind'] == 'mesh'],
                         ['unit-cube', 'unit-cube'])
        captures = bundle['provenance']['space3dCapture']
        self.assertEqual(captures['version'], 1)
        self.assertEqual(len(captures['declarations']), 2)
        for item in captures['declarations']:
            source = output / item['sourceSpan']['file']
            self.assertTrue(source.is_file())
            value = json.loads(source.read_text(encoding='utf8'))
            self.assertEqual(value, cube if item['kind'] == 'mesh' else bundle['space3d'])
        self.assertEqual(json.loads((output / 'space3d-sources/declarations.json').read_text()), captures)
        self.assertTrue(json.loads((output / 'compile-report.json').read_text())['success'])

    def test_real_verbatim_json_is_unexpanded_and_repeated_compiles_reset_capture(self):
        resource = mesh()
        resource['provenance'] = {'literal': '\\notexpanded ## # % ^ λ', 'multiline': 'one\ntwo'}
        source = self.folder / 'literal.tex'
        source.write_text(document('\\def\\notexpanded{WRONG}\n' + declaration(resource)), encoding='utf8')
        output = self.folder / 'literal-out'
        first = compile_scene(source, output)
        second = compile_scene(source, output)
        self.assertEqual(first['resources']['triangle'], resource)
        self.assertEqual(second['resources']['triangle'], resource)
        self.assertEqual(first['provenance']['space3dCapture'], second['provenance']['space3dCapture'])
        source.write_text(document(), encoding='utf8')
        plain = compile_scene(source, output)
        self.assertEqual(plain['version'], '0.1')
        self.assertEqual(plain['resources'], {})
        self.assertNotIn('space3d', plain)
        self.assertNotIn('space3dCapture', plain['provenance'])

    def test_shared_validator_and_duplicates_fail_without_publishing_a_bundle(self):
        bad_index = mesh(); bad_index['indices']['data'][2] = 99
        wrong_units = space(); wrong_units['units'] = 'cm'
        cases = [
            ('index', declaration(bad_index), 'MESH_INDEX_RANGE'),
            ('units', declaration(program=wrong_units), 'SPACE3D_UNIT_MISMATCH'),
            ('duplicate', declaration() + '\n\\loommesh{triangle}|' + json.dumps(mesh()) + '|', 'SPACE3D_CAPTURE_DUPLICATE'),
        ]
        for name, body, code in cases:
            source = self.folder / (name + '.tex'); source.write_text(document(body), encoding='utf8')
            output = self.folder / (name + '-out'); output.mkdir()
            (output / 'bundle.json').write_text('{"stale":true}')
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, code):
                compile_scene(source, output)
            self.assertFalse((output / 'bundle.json').exists())
            self.assertFalse(json.loads((output / 'compile-report.json').read_text())['success'])

    def test_capture_rejects_json_path_depth_size_and_identifiers_with_located_diagnostics(self):
        cases = [
            ('duplicate-key', '{"kind":"mesh","kind":"mesh"}', 'ok', 'SPACE3D_CAPTURE_DUPLICATE'),
            ('nan', '{"kind":"mesh","x":NaN}', 'ok', 'SPACE3D_CAPTURE_NONFINITE'),
            ('infinity', '{"kind":"mesh","x":1e999}', 'ok', 'SPACE3D_CAPTURE_NONFINITE'),
            ('large-integer', '{"kind":"mesh","x":' + '9' * 400 + '}', 'ok', 'SPACE3D_CAPTURE_NONFINITE'),
            ('nonobject', '[]', 'ok', 'SPACE3D_CAPTURE_JSON'),
            ('identifier', json.dumps(mesh()), '../outside', 'SPACE3D_CAPTURE_ID'),
            ('macro-id', json.dumps(mesh()), r'\notexpanded', 'SPACE3D_CAPTURE_ID'),
            ('depth', '[' * 130 + '0' + ']' * 130, 'ok', 'SPACE3D_CAPTURE_BUDGET'),
            ('size', ' ' * (MAX_CAPTURE_BYTES + 1), 'ok', 'SPACE3D_CAPTURE_BUDGET'),
        ]
        for name, text, resource_id, code in cases:
            execution, records = self.records(name, [('mesh', text, resource_id)])
            authored = {'version': '0.1', 'resources': {}}
            with self.subTest(name=name), self.assertRaises(Space3DCaptureDiagnostic) as context:
                lower_space3d(records, authored, execution, self.folder / 'archive')
            self.assertEqual(context.exception.code, code)
            self.assertEqual(authored, {'version': '0.1', 'resources': {}})
            if name not in ('size',):
                self.assertIsNotNone(context.exception.sourceSpan)
        for base in ['../scene.tl-space3d-1', 'scene.tl-space3d-0', 'scene.tl-space3d-1/../../outside']:
            with self.assertRaisesRegex(Space3DCaptureDiagnostic, 'SPACE3D_CAPTURE_PATH'):
                lower_space3d([{'type': 'space3d-file', 'kind': 'mesh', 'file': base}], {}, self.folder, self.folder)
        with self.assertRaisesRegex(Space3DCaptureDiagnostic, 'SPACE3D_CAPTURE_PATH'):
            lower_space3d([{'type': 'space3d-file', 'kind': 'mesh', 'file': 'scene.tl-space3d-99'}], {}, self.folder, self.folder)

    def test_duplicate_space_or_existing_resource_never_partially_mutates_bundle(self):
        cases = [
            [('space', json.dumps(space()), None), ('space', json.dumps(space()), None)],
            [('mesh', json.dumps(mesh()), 'new'), ('mesh', json.dumps(mesh()), 'occupied')],
        ]
        for index, declarations in enumerate(cases):
            execution, records = self.records(f'duplicates-{index}', declarations)
            for kind in ['vector', 'scalar-field']:
                authored = {'version': '0.1', 'resources': {'occupied': {'kind': kind}}}
                before = copy.deepcopy(authored)
                with self.assertRaisesRegex(Space3DCaptureDiagnostic, 'SPACE3D_CAPTURE_DUPLICATE'):
                    lower_space3d(records, authored, execution, self.folder / 'archive')
                self.assertEqual(authored, before)
        unchanged = {'version': '0.2'}
        self.assertIsNone(lower_space3d([], unchanged, self.folder, self.folder))
        self.assertEqual(unchanged, {'version': '0.2'})


if __name__ == '__main__':
    unittest.main()
