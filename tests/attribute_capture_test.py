"""Real TeX attribute programs, exact nested-source ranges and publication failures."""
import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
from compile import compile_scene
from attribute_capture import lower_attributes, AttributeCaptureDiagnostic, MAX_CAPTURE_BYTES


def operation():
    return {'source': 'sheet', 'units': 'm', 'steps': [
        {'kind': 'capture', 'name': 'height', 'domain': 'vertex', 'valueType': 'scalar', 'expression': 'z'}]}


def document(body=''):
    return ('\\documentclass{article}\n\\usepackage{texloom-surface}\n\\usepackage{texloom-attributes}\n'
            '\\begin{document}\n\\TLScene{Attribute fixture}{320}{180}{2}\n' + body + '\n\\end{document}\n')


def declaration(value=None):
    surface = {'units': 'm', 'domain': {'u': [0, 1], 'v': [0, 1]}, 'segments': {'u': 2, 'v': 2},
               'position': ['u', 'v', '0'], 'normals': {'kind': 'analytic', 'dU': ['1', '0', '0'], 'dV': ['0', '1', '0']}}
    scene = {'version': 1, 'units': 'm', 'handedness': 'right', 'upAxis': 'z',
             'nodes': [{'id': 'instance', 'kind': 'mesh', 'resourceId': 'captured'}]}
    return ('\\loomsurface{sheet}|' + json.dumps(surface) + '|\n'
            '\\loomattributes{captured}|' + json.dumps(operation() if value is None else value) + '|\n'
            '\\loomspace|' + json.dumps(scene) + '|')


def source_slice(text, span):
    lines = text.splitlines(keepends=True)
    def offset(position):
        return sum(len(line) for line in lines[:position['line']-1]) + position['column']-1
    return text[offset(span['start']):offset(span['end'])]


class AttributeCaptureTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.folder = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def records(self, name, items):
        execution = self.folder / name
        execution.mkdir()
        records = []
        for index, (identifier, text) in enumerate(items, 1):
            base = f'scene.tl-attributes-{index}'
            (execution / f'{base}.body.txt').write_text(text + '\n', encoding='utf8')
            (execution / f'{base}.id.txt').write_text(identifier + '\n', encoding='utf8')
            records.append({'type': 'attributes-file', 'file': base})
        return execution, records

    def test_native_demo_keeps_programs_without_baked_buffers_and_exact_step_spans(self):
        output = self.folder / 'native'
        bundle = compile_scene(ROOT / 'examples/mesh-attributes.tex', output)
        self.assertEqual(bundle['version'], '0.3')
        self.assertTrue(all(resource['kind'] == 'vector' for resource in bundle['resources'].values()))
        self.assertNotIn('sphere', bundle['resources'])
        self.assertNotIn('vertex-sphere', bundle['resources'])
        self.assertNotIn('face-sphere', bundle['resources'])
        operations = bundle['meshAttributes']['operations']
        self.assertEqual([op['source'] for op in operations], ['sphere', 'vertex-sphere'])
        self.assertEqual([op['resourceId'] for op in operations], ['vertex-sphere', 'face-sphere'])
        self.assertEqual([node['material']['colorAttribute'] for node in bundle['space3d']['nodes']], ['chroma', 'face-chroma'])
        for operation in operations:
            body = (output / operation['sourceSpan']['file']).read_text(encoding='utf8')
            literal = json.loads(body)
            for step, authored in zip(operation['steps'], literal['steps']):
                self.assertEqual(json.loads(source_slice(body, step['sourceSpan'])), authored)
                self.assertEqual(step['sourceSpan']['file'], operation['sourceSpan']['file'])
                if 'expression' in authored:
                    values = authored['expression'] if isinstance(authored['expression'], list) else [authored['expression']]
                    for expression, span in zip(values, step['expressionSpans']):
                        self.assertEqual((output / span['file']).read_text(encoding='utf8'), expression + '\n')
        metadata = json.loads((output / 'attribute-sources/declarations.json').read_text())
        self.assertEqual(metadata, bundle['provenance']['attributeCapture'])

    def test_repeated_compile_unused_package_and_unexpanded_expression(self):
        source, output = self.folder / 'repeat.tex', self.folder / 'repeat'
        deformed = operation()
        deformed['steps'].append({'kind': 'set-position', 'expression': ['x', 'y', 'z+0.2'], 'normalPolicy': 'drop'})
        source.write_text(document(declaration(deformed)), encoding='utf8')
        first = compile_scene(source, output)
        self.assertEqual(first['meshAttributes'], compile_scene(source, output)['meshAttributes'])
        self.assertEqual(len(first['meshAttributes']['operations'][0]['steps'][1]['expressionSpans']), 3)
        source.write_text(document(), encoding='utf8')
        unused = compile_scene(source, output)
        self.assertEqual(unused['version'], '0.1')
        self.assertNotIn('meshAttributes', unused)
        value = operation(); value['steps'][0]['expression'] = r'z+\notexpanded # % λ'
        source.write_text(document('\\def\\notexpanded{999}\n' + declaration(value)), encoding='utf8')
        with self.assertRaises(ValueError):
            compile_scene(source, output)
        literal = json.loads((output / 'attribute-sources/scene.tl-attributes-1.body.txt').read_text(encoding='utf8'))
        self.assertEqual(literal, value)
        self.assertFalse((output / 'bundle.json').exists())

    def test_authoritative_validator_rejects_invalid_domain_units_and_transfer(self):
        units = operation(); units['units'] = 'cm'
        expression = operation(); expression['steps'][0]['expression'] = '1bp'
        domain = operation(); domain['steps'][0]['domain'] = 'edge'
        transfer = operation(); transfer['steps'].append({'kind': 'transfer', 'source': 'height', 'name': 'faces', 'domain': 'face', 'method': 'guess'})
        unknown = operation(); unknown['steps'][0]['callback'] = 'not executed'
        for index, value in enumerate([units, expression, domain, transfer, unknown]):
            source, output = self.folder / f'invalid-{index}.tex', self.folder / f'invalid-{index}'
            source.write_text(document(declaration(value)), encoding='utf8')
            output.mkdir(); (output / 'bundle.json').write_text('{"stale":true}')
            with self.subTest(index=index), self.assertRaises(ValueError):
                compile_scene(source, output)
            self.assertFalse((output / 'bundle.json').exists())
            self.assertFalse(json.loads((output / 'compile-report.json').read_text())['success'])

    def test_json_source_ranges_metadata_path_and_budgets_are_strict(self):
        cases = [('duplicate', '{"steps":[],"steps":[]}', 'ATTRIBUTE_CAPTURE_DUPLICATE'),
                 ('nonfinite', '{"value":NaN}', 'ATTRIBUTE_CAPTURE_NONFINITE'),
                 ('overflow', '{"value":1e999}', 'ATTRIBUTE_CAPTURE_NONFINITE'),
                 ('array', '[]', 'ATTRIBUTE_CAPTURE_JSON'),
                 ('size', ' ' * (MAX_CAPTURE_BYTES+1), 'ATTRIBUTE_CAPTURE_BUDGET'),
                 ('reserved', '{"resourceId":"elsewhere"}', 'ATTRIBUTE_CAPTURE_FIELD'),
                 ('step-span', '{"steps":[{"kind":"capture","sourceSpan":{}}]}', 'ATTRIBUTE_CAPTURE_FIELD'),
                 ('steps', json.dumps({'steps': [{}] * 33}), 'ATTRIBUTE_CAPTURE_BUDGET')]
        for name, text, code in cases:
            execution, records = self.records(name, [('result', text)])
            bundle = {'version': '0.1', 'resources': {}}
            with self.subTest(name=name), self.assertRaises(AttributeCaptureDiagnostic) as caught:
                lower_attributes(records, bundle, execution, self.folder / 'archive')
            self.assertEqual(caught.exception.code, code)
            if name != 'size':
                self.assertIsNotNone(caught.exception.sourceSpan)
            self.assertEqual(bundle, {'version': '0.1', 'resources': {}})
        for base in ['../scene.tl-attributes-1', 'scene.tl-attributes-0', 'scene.tl-attributes-99']:
            with self.assertRaisesRegex(AttributeCaptureDiagnostic, 'ATTRIBUTE_CAPTURE_PATH'):
                lower_attributes([{'type': 'attributes-file', 'file': base}], {}, self.folder, self.folder)

    def test_step_ranges_preserve_whitespace_and_collisions_are_atomic(self):
        text = '{ "note": "steps\\nλ",\n "steps" : [\n  { "kind":"capture", "expression":"x + 2" },\n {"kind":"transfer"}\n ] }'
        execution, records = self.records('ranges', [('out', text)])
        bundle = {'version': '0.1', 'resources': {}}
        lower_attributes(records, bundle, execution, self.folder / 'archive')
        first = bundle['meshAttributes']['operations'][0]['steps'][0]
        self.assertEqual(source_slice(text, first['sourceSpan']), '{ "kind":"capture", "expression":"x + 2" }')
        for index, base in enumerate([{'resources': {'taken': {'kind': 'mesh'}}},
                                      {'resources': {}, 'surfaces': {'operations': [{'resourceId': 'taken'}]}},
                                      {'resources': {}, 'curves3d': {'operations': [{'resourceId': 'taken'}]}}]):
            execution, records = self.records(f'collision-{index}', [('free', json.dumps(operation())), ('taken', json.dumps(operation()))])
            bundle = {'version': '0.1', **base}; before = copy.deepcopy(bundle)
            with self.assertRaisesRegex(AttributeCaptureDiagnostic, 'ATTRIBUTE_CAPTURE_DUPLICATE'):
                lower_attributes(records, bundle, execution, self.folder / 'archive')
            self.assertEqual(bundle, before)


if __name__ == '__main__':
    unittest.main()
