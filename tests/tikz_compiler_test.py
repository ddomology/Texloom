"""Integration tests against installed LaTeX/PGF, not a mock TikZ parser."""
import json
import math
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
from compile import compile_scene, CompileDiagnostic


def document(body, setup=''):
    return ('\\documentclass{article}\n\\usepackage{texloom-tikz}\n' + setup +
            '\n\\begin{document}\n\\begin{loomscene}[width=480,height=300,duration=4,title={PGF integration}]\n' +
            body + '\n\\end{loomscene}\n\\end{document}\n')


class RealTikZCaptureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.folder = Path(cls.temp.name)
        source = cls.folder / 'fixture.tex'
        source.write_text(document(r'''
\begin{loomgroup}[at={(100,100)},rotate=30]{outer}
\begin{loomgroup}{inner}
\loomconnect[draw=accent,line width=2bp,->,bend=5] (edge) (A.east) to (B.west);
\loomconnect[thin] (thin-edge) (A.east) to (B.west);
\loomnode[box] (A) at (0,0) {$\InnerMath$};
\loomnode[circle,draw=red,minimum size=50bp,inner sep=0pt,outer sep=0pt,line width=2bp] (B) at (150,0) {$Y$};
\loomlabel[at=.5,offset=-12,scale=1.5,text=accent] (edge-label) on (edge) {$f$};
\loompath[at={(0,80)}] (native) {
  \begin{scope}\clip (0,0) rectangle (100,40);
  \draw[accent,line width=2bp,opacity=.4] (-20,20) .. controls (20,-10) and (80,60) .. (120,20);
  \end{scope}
};
\end{loomgroup}
\end{loomgroup}
\loomanimate[duration=2] (A) {move to={(10,20)},rotate to=90};
\loomanimate[delay=2,duration=2] (A) {move to={(0,0)},rotate to=0};
''', r'''
\loomsetup{\definecolor{accent}{HTML}{3468AB}\newcommand{\InnerMath}{\frac{x_i^2}{1+x_i^2}}}
\loomset{box/.style={rectangle,draw=accent,fill=accent!10,minimum width=80bp,minimum height=40bp,inner sep=0pt,outer sep=2bp,font=\Large}}
'''), encoding='utf8')
        cls.bundle = compile_scene(source, cls.folder / 'out')
        cls.nodes = {n['id']: n for n in cls.bundle['nodes']}

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def test_real_shape_anchors_are_not_svg_ink_bounds(self):
        a = self.nodes['A']
        self.assertAlmostEqual(a['anchors']['east'][0], 42, places=3)
        self.assertAlmostEqual(a['anchors']['north'][1], -22, places=3)
        self.assertEqual(a['anchors']['center'], [0, 0])
        resource = self.bundle['resources']['A-art']
        capture = resource['provenance']['pgfCapture']
        self.assertEqual(capture['shape'], 'rectangle')
        self.assertGreater(a['anchors']['east'][0], capture['bounds'][2])
        self.assertAlmostEqual(self.nodes['A-art']['x'], capture['bounds'][0])
        self.assertIn('base', a['anchors'])
        self.assertGreater(len(resource['glyphs']), 4)
        self.assertTrue((self.folder / 'out' / resource['provenance']['dvi']).exists())

    def test_circle_diagonal_uses_actual_pgf_shape(self):
        anchors = self.nodes['B']['anchors']
        # A circle's diagonal anchor is not a rectangular bounding-box corner.
        self.assertAlmostEqual(anchors['east'][0], 25, places=3)
        self.assertAlmostEqual(anchors['north east'][0] / anchors['east'][0], math.sqrt(.5), places=4)
        self.assertLess(anchors['north east'][1], 0)

    def test_nested_parenting_degree_conversion_and_tween_merge(self):
        self.assertEqual(self.bundle['version'], '0.2')
        self.assertNotIn('parent', self.nodes['outer'])
        self.assertEqual(self.nodes['inner']['parent'], 'outer')
        self.assertEqual(self.nodes['A']['parent'], 'inner')
        self.assertAlmostEqual(self.nodes['outer']['transform']['rotate'], math.pi / 6)
        tracks = {t['property']: t for t in self.bundle['tracks']}
        self.assertEqual(tracks['transform.translate']['keys'], [[0, [0, 0]], [2, [10, 20]], [4, [0, 0]]])
        self.assertAlmostEqual(tracks['transform.rotate']['keys'][1][1], math.pi / 2)
        self.assertEqual(tracks['transform.rotate']['keys'][2], [4, 0])

    def test_connections_keep_identity_style_and_measured_labels(self):
        edge = self.nodes['edge']
        self.assertTrue(edge['arrowEnd'])
        self.assertEqual(edge['style']['stroke'], '#3468AB')
        self.assertAlmostEqual(edge['style']['strokeWidth'], 2, places=3)
        self.assertAlmostEqual(self.nodes['thin-edge']['style']['strokeWidth'], .6 * 72 / 72.27, places=6)
        relation = next(r for r in self.bundle['relations'] if r['type'] == 'connect')
        self.assertEqual(relation['from'], {'node': 'A', 'anchor': 'east'})
        self.assertEqual(relation['to'], {'node': 'B', 'anchor': 'west'})
        label = next(r for r in self.bundle['relations'] if r['type'] == 'pathLabel')
        self.assertEqual(label['position'], .5)
        self.assertEqual(label['offset'], -12)
        self.assertGreater(self.bundle['resources']['edge-label-art']['metrics']['height'], 0)

    def test_native_bezier_clipping_survives_as_vector_ir(self):
        resource = self.bundle['resources']['native-art']
        def walk(items):
            for item in items:
                yield item
                yield from walk(item.get('children', []))
        items = list(walk(resource['items']))
        self.assertTrue(any('clip' in item for item in items))
        self.assertTrue(any('C' in item.get('d', '') or 'c' in item.get('d', '') for item in items))
        # PGF's path opacity is emitted as stroke/fill opacity in DVI transport.
        self.assertTrue(any(item.get('style', {}).get('strokeOpacity') == .4 for item in items))
        self.assertNotIn('<svg', json.dumps(self.bundle))


class TikZFailureTests(unittest.TestCase):
    def compile(self, body):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp)
            source = folder / 'bad.tex'
            source.write_text(document(body), encoding='utf8')
            return compile_scene(source, folder / 'out')

    def test_unknown_live_option_is_an_error(self):
        with self.assertRaisesRegex(CompileDiagnostic, 'impossible option'):
            self.compile(r'\loomconnect[impossible option=1] (edge) (A.east) to (B.west);')

    def test_unknown_native_tikz_option_is_an_error(self):
        with self.assertRaisesRegex(CompileDiagnostic, 'unknown shape option'):
            self.compile(r'\loomnode[unknown shape option=1] (A) at (0,0) {$X$};')

    def test_overlapping_tweens_are_rejected(self):
        with self.assertRaisesRegex(ValueError, 'Overlapping'):
            self.compile(r'''\begin{loomgroup}{g}\end{loomgroup}
\loomanimate[duration=3] (g) {rotate to=90};
\loomanimate[delay=2,duration=2] (g) {rotate to=180};''')


if __name__ == '__main__':
    unittest.main()
