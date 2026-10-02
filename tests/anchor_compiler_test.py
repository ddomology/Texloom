"""Real TeX tests for logical boxes, native PGF anchors and declarative layout."""
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
from compile import compile_scene, asset_document, PT_TO_BP
from anchor_capture import lower_anchors, AnchorCaptureDiagnostic
from tikz_capture import read_capture
from tests.shape_compiler_test import sample


def document(body, package=True):
    return (r'''\documentclass{article}
\usepackage{texloom-tikz}
\usepackage{texloom-shapes}
''' + ('\\usepackage{texloom-anchors}\n' if package else '') + r'''
\begin{document}
\begin{loomscene}[width=500,height=300,duration=2,title={Anchor fixtures}]
\TLNode{P}{point}{"x":0,"y":0,"r":3}
\TLNode{Q}{point}{"x":0,"y":0,"r":3}
''' + body + '\n\\end{loomscene}\n\\end{document}\n')


class AnchorCompilerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.folder = Path(cls.temp.name)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def capture(self, name, body):
        folder = self.folder / name
        folder.mkdir()
        (folder / 'scene.tex').write_text(document(body), encoding='utf8')
        env = os.environ.copy()
        env['TEXINPUTS'] = str(ROOT / 'tex') + os.pathsep + env.get('TEXINPUTS', '')
        result = subprocess.run(['latex', '-no-shell-escape', '-interaction=nonstopmode', '-halt-on-error', 'scene.tex'],
                                cwd=folder, env=env, capture_output=True, text=True, encoding='utf8', errors='replace')
        self.assertEqual(result.returncode, 0, result.stdout[-5000:] + result.stderr)
        records = [json.loads(line) for line in (folder / 'scene.tl.jsonl').read_text(encoding='utf8').splitlines()]
        return folder, records, {'version': '0.2', 'nodes': [], 'resources': {}}

    def compile(self, name, body, package=True):
        source = self.folder / (name + '.tex')
        source.write_text(document(body, package), encoding='utf8')
        output = self.folder / (name + '-out')
        return output, compile_scene(source, output)

    def test_literal_query_and_placement_spans_and_nested_padding(self):
        expression = '\n vec2(1bp,2bp) + \\macro + "quote" % # ## ^^M ^^J &&\n'
        inputs = json.dumps({'towards': {'expression': expression}}, indent=2)
        folder, records, bundle = self.capture('literal',
            '\\loomanchor[space=plot:chart,innerSep=[2,3],outerSep=4]{P}{node:formula}{' + inputs + '}\n' +
            r'\loomplace[anchor=base east]{formula}{[200,100]}')
        lower_anchors(records, bundle, folder, folder)
        first, transform, placement = bundle['operationGraph']['operations']
        value = first['inputs']['a']
        self.assertEqual(value['source']['innerSep'], [2, 3])
        self.assertEqual(value['source']['outerSep'], [4, 4])
        point = value['query']['towards']
        self.assertEqual(point['expression'], expression)
        self.assertEqual(point['sourceSpan']['end'], {'line': 3, 'column': 1})
        self.assertEqual((folder / point['sourceSpan']['file']).read_text(encoding='utf8'), expression + '\n')
        self.assertEqual((folder / first['sourceSpan']['file']).read_text(encoding='utf8'), inputs + '\n')
        self.assertEqual(transform['operator'], 'transformPoint')
        self.assertEqual(placement['inputs']['a']['kind'], 'textPlacement')
        self.assertEqual(placement['inputs']['a']['anchor'], 'base east')

    def test_invalid_options_queries_and_measured_padding_are_rejected(self):
        cases = [('negative', 'outerSep=-1', 'formula', '"east"', 'nonnegative'),
                 ('unknown', '', 'formula', '"ink east"', 'known name'),
                 ('inner', 'innerSep=0', 'shape:orbit', '"east"', 'do not accept innerSep'),
                 ('duplicate', '', 'formula', '{"towards":"P","towards":"Q"}', 'Duplicate JSON key')]
        for name, options, source, query, message in cases:
            with self.subTest(name=name):
                folder, records, bundle = self.capture(name, '\\loomanchor[' + options + ']{P}{' + source + '}{' + query + '}')
                with self.assertRaisesRegex(AnchorCaptureDiagnostic, message):
                    lower_anchors(records, bundle, folder, folder)
        folder, records, bundle = self.capture('measured-padding', r'\loomanchor[outerSep=0]{P}{native}{"east"}')
        bundle['nodes'] = [{'id': 'native', 'anchorMetrics': {'kind': 'pgf'}}]
        with self.assertRaisesRegex(AnchorCaptureDiagnostic, 'padding overrides'):
            lower_anchors(records, bundle, folder, folder)

    def test_real_pgf_logical_metrics_preserve_depth_phantom_overhang_and_alignment(self):
        body = r'''
\loomnode[inner xsep=3bp,inner ysep=5bp,outer xsep=2bp,outer ysep=4bp] (math) at (100,70) {$g_j+\frac{1}{x}$};
\loomnode[inner sep=0bp,outer sep=0bp] (phantom) at (100,130) {$x\phantom{\rule[-7bp]{20bp}{30bp}}$};
\loomnode[inner sep=0bp,outer sep=0bp] (overhang) at (250,70) {\makebox[10bp][l]{\rule[-4bp]{30bp}{20bp}}};
\loomnode[text width=80bp,align=right,inner sep=2bp,outer sep=0bp] (aligned) at (250,150) {First line\\Second};
\loomanchor{P}{math}{"base west"}
\loomanchor{Q}{math}{"base east"}
'''
        output, bundle = self.compile('logical', body)
        nodes = {n['id']: n for n in bundle['nodes']}
        metadata = nodes['math']['anchorMetrics']
        self.assertGreater(metadata['textMetrics']['depth'], 0)
        for got, expected in zip(metadata['innerSep'] + metadata['outerSep'], [3, 5, 2, 4]):
            self.assertAlmostEqual(got, expected, delta=.0001)
        # Native rectangle PGF baseline depends on logical height minus depth.
        h, d = (metadata['textMetrics'][k] for k in ('height', 'depth'))
        self.assertAlmostEqual(nodes['math']['anchors']['base'][1], (h-d)/2, delta=.0001)
        self.assertAlmostEqual(nodes['phantom']['anchorMetrics']['textMetrics']['height'], 23, delta=.0001)
        self.assertAlmostEqual(nodes['phantom']['anchorMetrics']['textMetrics']['depth'], 7, delta=.0001)
        overhang = nodes['overhang']['anchorMetrics']
        self.assertAlmostEqual(overhang['logicalTextBox'][2], 10, delta=.0001)
        self.assertGreater(bundle['resources']['overhang-art']['inkBounds'][2], 25)
        self.assertEqual(nodes['aligned']['anchorMetrics']['alignment'], 'right')
        self.assertAlmostEqual(nodes['aligned']['anchorMetrics']['textMetrics']['width'], 80, delta=.0001)
        evaluated = {n['id']: n for n in sample(output / 'bundle.json')['nodes']}
        for point, name in [('P', 'base west'), ('Q', 'base east')]:
            expected = nodes['math']['anchors'][name]
            self.assertAlmostEqual(evaluated[point]['x'], 100+expected[0], places=7)
            self.assertAlmostEqual(evaluated[point]['y'], 70+expected[1], places=7)

    def test_native_transformed_logical_corners_are_not_ink_bounds(self):
        output, bundle = self.compile('transformed', r'''
\loomnode[inner sep=0bp,outer sep=0bp,rotate=30,xscale=1.7,yscale=.8,transform shape] (box) at (200,100) {\makebox[20bp][l]{\rule[-4bp]{35bp}{16bp}}};
''')
        group = next(n for n in bundle['nodes'] if n['id'] == 'box')
        metric = group['anchorMetrics']
        # PGF applies rotate then anisotropic scale in the supplied order.
        capture = bundle['resources']['box-art']['provenance']['pgfCapture']
        corners = capture['logicalCorners']
        self.assertEqual(len(corners), 4)
        # Independent geometric invariant: each opposite edge has the same
        # vector, and transformed area is determinant(scale)*logical area.
        a, b, _, d = corners
        area = abs((b[0]-a[0])*(d[1]-a[1])-(b[1]-a[1])*(d[0]-a[0]))
        self.assertAlmostEqual(area, 20*16*1.7*.8, delta=.04)
        self.assertGreater(metric['logicalTextBox'][2], 20)
        self.assertNotEqual(metric['logicalTextBox'], bundle['resources']['box-art'].get('bounds'))

    def test_raw_formula_placement_uses_logical_baseline_and_shape_border(self):
        output, bundle = self.compile('placement', r'''
\TLMath{formula-art}{\frac{g_j}{x}+\int_0^1 f(t)\,dt}
\TLNode{formula}{tex}{"resourceId":"formula-art","x":0,"y":0,"scale":1.5}
\TLNode{outline}{path}{"d":"M0 0L1 0","geometry":{"contours":[{"id":"c","start":[0,0],"segments":[{"id":"s","kind":"line","to":[1,0]}]}]}}
\loomshape[id=orbit]{outline}{ellipse}{{"center":[300,150],"rx":80,"ry":40}}
\loomplace{formula}{[40,90]}
\loomanchor{P}{formula}{"base west"}
\loomanchor{Q}{shape:orbit}{{"towards":[500,150]}}
''')
        nodes = {n['id']: n for n in sample(output / 'bundle.json')['nodes']}
        self.assertEqual([nodes['P']['x'], nodes['P']['y']], [40, 90])
        self.assertEqual([nodes['Q']['x'], nodes['Q']['y']], [380, 150])
        self.assertAlmostEqual(nodes['formula']['y'], 90)

    def test_repeated_capture_is_deterministic_and_opt_out_keeps_original_assets(self):
        body = r'\loomnode[align=center,inner sep=2bp] (native) at (100,100) {$g_j$};'
        outputs = [self.compile('repeat-a', body), self.compile('repeat-b', body)]
        first = outputs[0][1]
        second = outputs[1][1]
        self.assertEqual([{k: v for k, v in n.items() if k != 'source'} for n in first['nodes']],
                         [{k: v for k, v in n.items() if k != 'source'} for n in second['nodes']])
        a = next(n for n in first['nodes'] if n['id'] == 'native')['anchorMetrics']
        self.assertEqual(len(a['revision']), 64)
        _, changed = self.compile('changed', body.replace('$g_j$', '$g_j+x$'))
        self.assertNotEqual(a['revision'], next(n for n in changed['nodes'] if n['id'] == 'native')['anchorMetrics']['revision'])
        output, old = self.compile('opt-out', body, False)
        group = next(n for n in old['nodes'] if n['id'] == 'native')
        self.assertNotIn('anchorMetrics', group)
        self.assertNotIn('base west', group['anchors'])
        self.assertNotIn('text-metrics', old['resources']['native-art']['provenance']['pgfCapture'])
        source_asset = next(output.glob('runs/compile-*/assets/native-art/asset.tex')).read_text(encoding='utf8')
        self.assertNotIn('TLAmeasure', source_asset)
        self.assertEqual(old['version'], '0.2')


if __name__ == '__main__':
    unittest.main()
