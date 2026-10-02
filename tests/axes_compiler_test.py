"""Real TeX axes, semantic coordinate conversion, and bounded typeset labels."""
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
from axes_capture import prepare_axes_records, lower_axes, AxesCaptureDiagnostic
from tests.intersection_compiler_test import samples, without_provenance


def basic(body='', package=True):
    return (r'\documentclass{article}' + '\n' +
            (r'\usepackage{texloom-axes}' if package else r'\usepackage{texloom-expressions}') +
            '\n' + r'\begin{document}\TLScene{Axes test}{500}{350}{2}' + '\n' + body +
            '\n' + r'\end{document}' + '\n')


def full_scene():
    return r'''\documentclass{article}
\usepackage{texloom-tikz,texloom-axes}
\begin{document}
\begin{loomscene}[title={Axes integration},width=500,height=350,duration=2]
\TLNode{G}{group}{"transform":{"translate":[25,10],"rotate":0.2,"scale":[1.5,1.5]}}
\TLNode{axis}{path}{"parent":"G","d":"M0 0L1 0","geometry":{"contours":[{"id":"initial","start":[0,0],"segments":[{"id":"line","kind":"line","to":[1,0]}]}]}}
\TLNode{P}{point}{"parent":"G","x":0,"y":0,"r":2}
\TLMath{raw-art}{g_j}
\TLNode{raw}{tex}{"parent":"G","resourceId":"raw-art","x":90,"y":90,"scale":1}
\loomnode[inner sep=3bp,outer sep=2bp] (measured) at (0,0) {$g_j$};
\loomaxes{linear}|{"space":"local:G","origin":[20,30],"width":200,"height":100,"xMin":0,"xMax":"4+time/1s","yMin":-2,"yMax":2,"xStep":"1+time/2s","yStep":1,"xAxis":"axis"}|
\loomdatapoint{P}|{"axes":"linear","x":2,"y":1}|
\loomaxislabel{raw}|{"axes":"linear","axis":"point","x":2,"y":1,"anchor":"base","offset":[4,-6]}|
\loomaxislabel{measured}|{"axes":"linear","axis":"point","x":2,"y":1,"anchor":"base","offset":[-8,8],"respectTicks":false}|
\loomaxisticks{linear}|{"axis":"x","values":[0,1,2],"precision":0,"anchor":"base","parent":"G","idPrefix":"numbers","offset":[0,16],"scale":0.8}|
\loomaxes{log}|{"origin":[20,180],"width":200,"height":100,"xMin":1,"xMax":100,"yMin":1,"yMax":100,"xScale":"log","yScale":"log"}|
\loomaxisticks{log}|{"axis":"x","values":[1,10],"precision":1,"notation":"scientific","idPrefix":"lognumbers"}|
\end{loomscene}
\end{document}
'''


def transformed(point, transform):
    sx, sy = transform.get('scale', [1, 1]); a = transform.get('rotate', 0)
    x, y = point; tx, ty = transform.get('translate', [0, 0])
    return [tx + math.cos(a)*sx*x - math.sin(a)*sy*y,
            ty + math.sin(a)*sx*x + math.cos(a)*sy*y]


class AxesCompilerTests(unittest.TestCase):
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

    def records(self, name, entries):
        folder = self.folder / name; folder.mkdir(); records = []
        for index, (kind, target, values) in enumerate(entries, 1):
            base = f'scene.tl-axes-{index}'
            (folder / (base + '.target.txt')).write_text(target + '\n', encoding='utf8')
            (folder / (base + '.inputs.txt')).write_text(
                (values if isinstance(values, str) else json.dumps(values)) + '\n', encoding='utf8')
            records.append({'type': 'axes-file', 'kind': kind, 'file': base})
        return folder, records

    def test_real_tex_mapping_labels_catalog_baselines_and_seek(self):
        output, bundle = self.compile('full', full_scene())
        results = samples(output / 'bundle.json', (0, 2, 1, 0))
        self.assertTrue(all('frame' in result for result in results), results)
        self.assertEqual(results[0]['frame'], results[-1]['frame'])
        self.assertEqual(bundle['version'], '0.3')
        source_nodes = {node['id']: node for node in bundle['nodes']}
        self.assertEqual(source_nodes['measured']['anchorMetrics']['kind'], 'pgf')
        self.assertEqual(bundle['resources']['lognumbers-1-r']['sourceTex'], r'1\times 10^{1}')
        self.assertGreater(bundle['resources']['raw-art']['metrics']['depth'], 0)
        for time, result in zip((0, 2, 1, 0), results):
            nodes = {node['id']: node for node in result['frame']['nodes']}
            x = 20 + 200*2/(4+time); y = 55
            self.assertLess(math.dist([nodes['P']['x'], nodes['P']['y']], [x, y]), 1e-9)
            # The actual TeX baseline remains at the data point + bp offset.
            width = bundle['resources']['raw-art']['metrics']['width']
            baseline = transformed([width/2, 0], nodes['raw']['transform'])
            self.assertLess(math.dist(baseline, [x+4, y-6]), 1e-9)
            self.assertEqual([nodes['raw']['x'], nodes['raw']['y']], [0, 0])
            measured_anchor = source_nodes['measured']['anchors']['base']
            actual = transformed(measured_anchor, nodes['measured']['transform'])
            expected = transformed([x-8, y+8], nodes['G']['transform'])
            self.assertLess(math.dist(actual, expected), 1e-8)
            self.assertLess(math.dist(nodes['axis']['geometry']['contours'][0]['start'], [20, 80]), 1e-9)
            label = nodes['numbers-2-n']; resource = bundle['resources'][label['resourceId']]
            tick_baseline = transformed([resource['metrics']['width']*.8/2, 0], label['transform'])
            self.assertLess(math.dist(tick_baseline, [x, 96]), 1e-8)
            self.assertEqual(nodes['numbers-1-n']['style']['opacity'], 1 if time == 0 else 0)
            log_label = nodes['lognumbers-1-n']; m = bundle['resources'][log_label['resourceId']]['metrics']
            self.assertLess(math.dist(transformed([m['width']/2, 0], log_label['transform']), [120, 296]), 1e-8)
        for operation in bundle['operationGraph']['operations']:
            self.assertTrue((output / operation['sourceSpan']['file']).is_file())
        self.assertIn('data:P:scene', {op['id'] for op in bundle['operationGraph']['operations']})

    def test_verbatim_capture_archives_and_strict_frontend_errors(self):
        expression = '4 + \\macro + "quote" % # ## ^^M ^^J &&'
        origin = 'vec2(1bp,2bp) + \\macro % ^^M'
        values = {'origin': {'expression': origin}, 'width': 200, 'height': 100,
                  'xMin': 0, 'xMax': expression, 'yMin': -1, 'yMax': 1}
        folder = self.folder / 'literal'; folder.mkdir()
        (folder / 'scene.tex').write_text(basic('\\loomaxes{coords}{' + json.dumps(values) + '}'), encoding='utf8')
        env = os.environ.copy(); env['TEXINPUTS'] = str(ROOT / 'tex') + os.pathsep + env.get('TEXINPUTS', '')
        result = subprocess.run(['latex', '-no-shell-escape', '-interaction=nonstopmode', '-halt-on-error', 'scene.tex'],
                                cwd=folder, env=env, capture_output=True, text=True, encoding='utf8', errors='replace')
        self.assertEqual(result.returncode, 0, result.stdout[-5000:])
        records = [json.loads(line) for line in (folder / 'scene.tl.jsonl').read_text().splitlines()]
        bundle = {'version': '0.1', 'nodes': [], 'resources': {}}
        lower_axes(records, bundle, folder, folder)
        operation = bundle['operationGraph']['operations'][0]
        for key, wanted in [('xMax', expression), ('origin', origin)]:
            self.assertEqual((folder / operation['inputs'][key]['sourceSpan']['file']).read_text(), wanted + '\n')
        self.assertEqual((folder / operation['sourceSpan']['file']).read_text(), json.dumps(values) + '\n')
        cases = [
            ('duplicate', [('axes', 'a', '{"xMin":0,"xMin":1}')], 'Duplicate JSON'),
            ('field', [('axes', 'a', {'surprise': 2})], 'unsupported'),
            ('missing', [('point', 'p', {'axes': 'missing', 'x': 0, 'y': 0})], 'existing axes'),
            ('path', [('axes', 'a', {'xAxis': 'missing'})], 'editable path'),
            ('collision', [('axes', 'a', {}), ('axes', 'a', {})], 'Duplicate axes'),
            ('label', [('axes', 'a', {}), ('label', 'p', {'axes': 'a', 'axis': 'x', 'value': 2})], 'TeX node'),
        ]
        for name, entries, message in cases:
            with self.subTest(name=name):
                folder, records = self.records(name, entries)
                with self.assertRaisesRegex(AxesCaptureDiagnostic, message):
                    lower_axes(records, {'nodes': [], 'resources': {}}, folder, folder)

    def test_formatter_collisions_budgets_and_catalog_provenance(self):
        cases = [
            ('rounding', {'axis': 'x', 'values': [.101, .102], 'precision': 1}, 'AXIS_LABEL_DUPLICATE'),
            ('binary64', {'axis': 'x', 'values': [9007199254740992, 9007199254740993], 'precision': 0}, 'duplicate formatted'),
            ('repeated', {'axis': 'x', 'values': [1, 1]}, 'distinct'),
            ('huge', {'axis': 'x', 'values': list(range(257))}, '256'),
            ('precision', {'axis': 'x', 'values': [1], 'precision': 13}, 'precision'),
            ('unknown', {'axis': 'z', 'values': [1]}, 'axis must be'),
            ('anchor-type', {'axis': 'x', 'values': [1], 'anchor': {}}, 'anchor'),
        ]
        for name, catalog, message in cases:
            with self.subTest(name=name):
                folder, records = self.records(name, [('axes', 'a', {}), ('ticks', 'a', catalog)])
                with self.assertRaisesRegex(AxesCaptureDiagnostic, message): prepare_axes_records(records, folder)
                self.assertFalse(list(folder.glob('*.tex')))
        folder, records = self.records('reserved', [('axes', 'a', {}), ('ticks', 'a', {'axis': 'x', 'values': [1], 'idPrefix': 'reserve'})])
        records.append({'type': 'resource', 'id': 'RESERVE-0-R', 'kind': 'math', 'file': 'existing.tex'})
        with self.assertRaisesRegex(AxesCaptureDiagnostic, 'collides'): prepare_axes_records(records, folder)
        folder, records = self.records('format-ok', [('axes', 'a', {}), ('ticks', 'a', {'axis': 'x', 'values': [1.005, 2], 'precision': 2, 'respectTicks': False})])
        prepare_axes_records(records, folder)
        resources = [r for r in records if r['type'] == 'resource']
        self.assertEqual([(folder / r['file']).read_text() for r in resources], ['1\n', '2\n'])
        self.assertEqual(records[1]['generatedLabels'][0]['values']['respectTicks'], False)

    def test_unused_package_and_repeated_frontend_are_deterministic(self):
        common = r'\TLMath{artifact}{g_j}\TLNode{A}{tex}{"resourceId":"artifact","x":30,"y":40}'
        canonical = []
        for enabled in (False, True):
            _, bundle = self.compile('empty', basic(common, enabled))
            self.assertEqual(bundle['version'], '0.1'); self.assertNotIn('operationGraph', bundle)
            canonical.append(without_provenance(bundle))
        self.assertEqual(canonical[0], canonical[1])
        entries = [('axes', 'a', {'origin': [1, 2], 'width': 200, 'height': 100,
                                  'xMin': 0, 'xMax': '4+time/1s', 'yMin': -1, 'yMax': 1}),
                   ('point', 'P', {'axes': 'a', 'x': 1, 'y': .5})]
        folder, records = self.records('repeat', entries)
        bundles = []
        for _ in range(2):
            bundle = {'nodes': [{'id': 'P', 'kind': 'point', 'x': 0, 'y': 0, 'r': 2}], 'resources': {}}
            lower_axes(copy.deepcopy(records), bundle, folder, folder); bundles.append(bundle)
        self.assertEqual(bundles[0], bundles[1])


if __name__ == '__main__':
    unittest.main()
