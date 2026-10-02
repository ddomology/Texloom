"""Executed TeX plots: typed formulae, chart mapping, holes and provenance."""
import copy
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
from compile import compile_scene, CompileDiagnostic
from plot_capture import lower_plots, PlotCaptureDiagnostic
from tests.intersection_compiler_test import samples, without_provenance


def path_node(name, parent=''):
    node = {'d': 'M0 0L1 0', 'geometry': {'contours': [
        {'id': 'initial', 'start': [0, 0], 'segments': [{'id': 'line', 'kind': 'line', 'to': [1, 0]}]}]}}
    if parent:
        node['parent'] = parent
    return r'\TLNode{' + name + r'}{path}{' + json.dumps(node)[1:-1] + '}\n'


def document(body='', packages='texloom-axes,texloom-plots'):
    return ('\\documentclass{article}\n\\usepackage{' + packages + '}\n' +
            '\\begin{document}\n\\TLScene{Plot test}{500}{350}{2}\n' + body +
            '\n\\end{document}\n')


def full_scene():
    body = r'\TLNode{G}{group}{"transform":{"translate":[25,10],"rotate":0.2,"scale":[1.5,1.5]}}' + '\n'
    for name in ('wave', 'circle', 'fast', 'points', 'band', 'pole', 'masked'):
        body += path_node(name, 'G')
    body += r'''
\loomparameter[min=0.5,max=2]{rate}{1}
\loomaxes{coords}|{"space":"local:G","origin":[20,30],"width":200,"height":100,"xMin":0,"xMax":"4+time/1s","yMin":-2,"yMax":2}|
\loomplot{wave}|{"axes":"coords","mode":"function","expression":"sin(x*rate+time/1s)","domains":[[0,4]],"breaks":[2],"tolerance":0.1}|
\loomplot{circle}|{"axes":"coords","mode":"parametric","xExpression":"cos(u)","yExpression":"sin(u)","domains":[[0,6.283185307179586]]}|
\loomplot{fast}|{"axes":"coords","mode":"function","expression":"sin(64*pi*x)","domains":[[0,1]],"initialSegments":256,"tolerance":0.1}|
\loomplot{points}|{"axes":"coords","mode":"samples","samples":[[0,0],[1,1],null,[2,1],[3,0]]}|
\loomplot{band}|{"axes":"coords","mode":"area","lower":"0","upper":"1+0.1*sin(x)","domains":[[0,2]]}|
\loomplot{pole}|{"axes":"coords","mode":"function","expression":"1/(x-2)","domains":[[0,1.9],[2.1,4]]}|
\loomplot{masked}|{"axes":"coords","mode":"function","expression":"1/(x-1)","mask":"x >= 1.1","domains":[[0,2]]}|
'''
    return document(body)


def fixture_bundle():
    scalar = lambda value, unit='1': {'kind': 'literal', 'value': {'type': 'scalar', 'unit': unit, 'value': value}}
    return {'version': '0.3', 'nodes': [{'id': 'target', 'kind': 'path', 'd': 'M0 0L1 0',
                                      'geometry': {'contours': [{'id': 'c', 'start': [0, 0],
                                                               'segments': [{'id': 's', 'kind': 'line', 'to': [1, 0]}]}]}}],
            'resources': {}, 'operationGraph': {'version': 1, 'bindings': [], 'operations': [
                {'id': 'coords', 'operator': 'cartesianAxes', 'version': 1, 'spaces': {'space': {'kind': 'scene'}},
                 'inputs': {'origin': {'kind': 'literal', 'value': {'type': 'vec2', 'role': 'point',
                                                                 'space': {'kind': 'scene'}, 'value': [0, 0]}},
                            'width': scalar(200, 'bp'), 'height': scalar(100, 'bp'),
                            'xMin': scalar(-2), 'xMax': scalar(2), 'yMin': scalar(-2), 'yMax': scalar(2),
                            'tickSize': scalar(6, 'bp'), 'xStep': scalar(1)}}]}}


class PlotCompilerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(); cls.folder = Path(cls.temp.name)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def compile(self, name, text):
        source = self.folder / (name + '.tex'); source.write_text(text, encoding='utf8')
        output = self.folder / (name + '-out')
        return output, compile_scene(source, output)

    def records(self, name, values, target='target'):
        folder = self.folder / name; folder.mkdir()
        base = 'scene.tl-plot-1'
        (folder / (base + '.target.txt')).write_text(target + '\n', encoding='utf8')
        (folder / (base + '.inputs.txt')).write_text(
            (values if isinstance(values, str) else json.dumps(values)) + '\n', encoding='utf8')
        return folder, [{'type': 'plot-file', 'file': base}]

    def test_real_tex_modes_mapping_holes_quality_and_random_access(self):
        output, bundle = self.compile('all-modes', full_scene())
        results = samples(output / 'bundle.json', (0, 2, 1, 0))
        self.assertTrue(all('frame' in result for result in results), results)
        self.assertEqual(results[0]['frame'], results[-1]['frame'])
        self.assertEqual(bundle['plots']['version'], 1)
        self.assertEqual(len(bundle['plots']['operations']), 7)
        for time, result in zip((0, 2, 1, 0), results):
            nodes = {node['id']: node for node in result['frame']['nodes']}
            wave = nodes['wave']['geometry']['contours']
            self.assertLess(math.dist(wave[0]['start'], [20, 80-25*math.sin(time)]), 1e-8)
            circle = nodes['circle']['geometry']['contours']
            self.assertLess(math.dist(circle[0]['start'], [20+200/(4+time), 80]), 1e-8)
            points = nodes['points']['geometry']['contours']
            self.assertEqual(len(points), 2)
            self.assertLess(math.dist(points[1]['start'], [20+400/(4+time), 55]), 1e-8)
            self.assertTrue(nodes['band']['geometry']['contours'][0]['closed'])
            self.assertEqual(len(nodes['pole']['geometry']['contours']), 2)
            self.assertGreaterEqual(sum(len(c['segments']) for c in nodes['fast']['geometry']['contours']), 128)
            masked = nodes['masked']['geometry']['contours']
            self.assertTrue(masked)
            self.assertTrue(all(point[0] >= 20+220/(4+time)-1e-8
                                for contour in masked for point in [contour['start']] + [s['to'] for s in contour['segments']]))
        for operation in bundle['plots']['operations']:
            self.assertNotIn('tickSize', operation['inputs'])
            self.assertTrue((output / operation['sourceSpan']['file']).is_file())
            for field, span in operation.get('expressionSpans', {}).items():
                self.assertEqual((output / span['file']).read_text(), operation[field] + '\n')

    def test_verbatim_capture_and_strict_frontend_diagnostics(self):
        expression = 'sin(x) + \\macro + "quote" % # ## ^^M ^^J &&'
        quality = '0.5 + \\macro % ^^M'
        values = {'axes': 'coords', 'mode': 'function', 'expression': expression,
                  'domains': [[-1, 1]], 'tolerance': quality}
        folder = self.folder / 'verbatim'; folder.mkdir()
        (folder / 'scene.tex').write_text(document('\\loomplot{target}{' + json.dumps(values) + '}'), encoding='utf8')
        env = os.environ.copy(); env['TEXINPUTS'] = str(ROOT / 'tex') + os.pathsep + env.get('TEXINPUTS', '')
        process = subprocess.run(['latex', '-no-shell-escape', '-interaction=nonstopmode', '-halt-on-error', 'scene.tex'],
                                 cwd=folder, env=env, capture_output=True, text=True, encoding='utf8', errors='replace')
        self.assertEqual(process.returncode, 0, process.stdout[-5000:])
        records = [json.loads(line) for line in (folder / 'scene.tl.jsonl').read_text().splitlines()]
        bundle = fixture_bundle(); lower_plots(records, bundle, folder, folder)
        operation = bundle['plots']['operations'][0]
        self.assertEqual((folder / operation['sourceSpan']['file']).read_text(), json.dumps(values) + '\n')
        self.assertEqual((folder / operation['expressionSpans']['expression']['file']).read_text(), expression + '\n')
        self.assertEqual((folder / operation['inputs']['tolerance']['sourceSpan']['file']).read_text(), quality + '\n')
        valid = {'axes': 'coords', 'mode': 'function', 'expression': 'x', 'domains': [[-1, 1]]}
        cases = [
            ('duplicate', '{"axes":"coords","axes":"coords"}', 'Duplicate JSON'),
            ('unknown', {**valid, 'surprise': 1}, 'unsupported'),
            ('version', {**valid, 'version': 2}, 'version 1'),
            ('boolean-version', {**valid, 'version': True}, 'version 1'),
            ('missing-axes', {**valid, 'axes': 'missing'}, 'existing Cartesian'),
            ('reverse-domain', {**valid, 'domains': [[1, -1]]}, 'min < max'),
            ('overlap-domain', {**valid, 'domains': [[0, 2], [1, 3]]}, 'sorted and disjoint'),
            ('bad-breaks', {**valid, 'breaks': [1, 0]}, 'strictly increasing'),
            ('outside-breaks', {**valid, 'breaks': [2]}, 'authored domain'),
            ('null-expression', {**valid, 'expression': None}, 'expression string'),
            ('numeric-mask', {**valid, 'mask': 1}, 'expression string'),
            ('nonfinite-mask', '{"axes":"coords","mode":"function","expression":"x","domains":[[0,1]],"mask":NaN}', 'nonfinite'),
            ('sample-value', {'axes': 'coords', 'mode': 'samples', 'samples': [[0, 0], [1, None]]}, 'explicit null'),
            ('sample-mask', {'axes': 'coords', 'mode': 'samples', 'samples': [[0, 0], None], 'mask': 'true'}, 'unsupported'),
            ('sample-quality', {'axes': 'coords', 'mode': 'samples', 'samples': [[0, 0], [1, 1]], 'tolerance': 1}, 'unsupported'),
            ('missing-upper', {'axes': 'coords', 'mode': 'area', 'lower': '0', 'domains': [[0, 1]]}, 'upper'),
        ]
        for name, inputs, message in cases:
            with self.subTest(name=name):
                folder, records = self.records(name, inputs)
                with self.assertRaisesRegex(PlotCaptureDiagnostic, message):
                    lower_plots(records, fixture_bundle(), folder, folder)

    def test_invalid_expression_units_and_mask_type_are_located(self):
        base = path_node('target') + '\\loomaxes{coords}|{"origin":[0,0],"width":200,"height":100,"xMin":-2,"xMax":2,"yMin":-2,"yMax":2}|\n'
        for name, expression, extra, located in [
                ('wrong-unit', 'x*1bp', {}, 'expression.expression.txt'),
                ('wrong-mask', 'x', {'mask': 'x+1'}, 'mask.expression.txt')]:
            with self.subTest(name=name):
                values = {'axes': 'coords', 'mode': 'function', 'expression': expression,
                          'domains': [[-1, 1]], **extra}
                with self.assertRaises(CompileDiagnostic) as caught:
                    self.compile(name, document(base + '\\loomplot{target}|' + json.dumps(values) + '|'))
                self.assertIn(located, str(caught.exception))
                self.assertFalse((self.folder / (name + '-out') / 'bundle.json').exists())

    def test_unused_package_and_repeated_lowering_preserve_input_contract(self):
        canonical = []
        for packages in ('texloom-expressions', 'texloom-plots'):
            _, bundle = self.compile('unused', document(r'\TLNode{target}{point}{"x":20,"y":30,"r":2}', packages))
            self.assertEqual(bundle['version'], '0.1'); self.assertNotIn('plots', bundle)
            self.assertNotIn('operationGraph', bundle)
            canonical.append(without_provenance(bundle))
        self.assertEqual(canonical[0], canonical[1])
        folder, records = self.records('repeat', {'axes': 'coords', 'mode': 'function',
                                                 'expression': 'x', 'domains': [[-1, 1]]})
        original = fixture_bundle(); bundles = []
        for _ in range(2):
            bundle = copy.deepcopy(original); lower_plots(records, bundle, folder, folder); bundles.append(bundle)
        self.assertEqual(bundles[0], bundles[1])
        bundles[0]['plots']['operations'][0]['inputs']['width']['value']['value'] = 999
        self.assertEqual(bundles[0]['operationGraph']['operations'][0]['inputs']['width']['value']['value'], 200)
        folder, records = self.records('duplicate-target', {'axes': 'coords', 'mode': 'function',
                                                           'expression': 'x', 'domains': [[-1, 1]]})
        (folder / 'scene.tl-plot-2.target.txt').write_text('target\n')
        (folder / 'scene.tl-plot-2.inputs.txt').write_text((folder / 'scene.tl-plot-1.inputs.txt').read_text())
        records.append({'type': 'plot-file', 'file': 'scene.tl-plot-2'})
        with self.assertRaisesRegex(PlotCaptureDiagnostic, 'Duplicate plot target'):
            lower_plots(records, fixture_bundle(), folder, folder)


if __name__ == '__main__':
    unittest.main()
