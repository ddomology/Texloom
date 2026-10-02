"""Real PGF capture fixtures: geometry is produced by TeX, not source parsing."""
import hashlib
import math
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
from compile import compile_scene, CompileDiagnostic
from tikz_capture import read_soft_path


def document(body, setup=''):
    return ('\\documentclass{article}\n\\usepackage{texloom-tikz}\n' + setup +
            '\n\\begin{document}\n\\begin{loomscene}[width=480,height=300,duration=4]\n' +
            body + '\n\\end{loomscene}\n\\end{document}\n')


class RealPGFPathTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.folder = Path(cls.temp.name)
        source = cls.folder / 'paths.tex'
        source.write_text(document(r'''
\begin{loomgroup}[at={(160,100)},rotate=20,scale=1.2]{g}
\loomgeometry[at={(10,20)},draw=accent,line width=2bp,reveal=.2,mode=length] (curve)
  {(0,0) \ActualPGFControls (100,0) -- (120,30)};
\loomdirection[on=curve,point=P,length=60,normal=true,draw=accent] (N);
\loompoint[on=curve,at=.25,radius=3,fill=accent,mode=length,tolerance=.025] (P);
\end{loomgroup}
\loomgeometry[draw=accent,fill=accent!10,fill rule=evenodd] (closed)
  {(0,0)--(60,0)--(60,50)--cycle (10,10) rectangle (30,30)};
\loomgeometry[draw=accent,rotate=90,scale=2,xshift=5bp,yshift=7bp] (transformed)
  {(0,0)--(20,10)};
\loomgeometry[draw=accent] (circle) {(120,80) circle[radius=20bp]};
\loomanimate[duration=4] (curve) {reveal to=1};
\loomanimate[duration=4,easing=linear] (P) {progress to=1};
\loomcontrol[duration=4] (curve) {contour-0}{segment-0}{c1}{(30,-20)};
\loomcontrol[duration=4] (curve) {contour-0}{}{start}{(-5,0)};
''', r'''\loomsetup{\definecolor{accent}{HTML}{3468AB}
\newcommand{\ActualPGFControls}{.. controls ({5*5},{-2*20}) and (70,40) ..}}
'''), encoding='utf8')
        cls.bundle = compile_scene(source, cls.folder / 'out')
        cls.nodes = {node['id']: node for node in cls.bundle['nodes']}

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def test_actual_pgf_controls_and_y_down_units(self):
        curve = self.nodes['curve']
        self.assertEqual(curve['parent'], 'g')
        self.assertEqual(curve['transform']['translate'], [10, 20])
        contour = curve['geometry']['contours'][0]
        self.assertEqual(contour['id'], 'contour-0')
        self.assertEqual(contour['segments'][0]['id'], 'segment-0')
        self.assertEqual([s['kind'] for s in contour['segments']], ['cubic', 'line'])
        for actual, expected in zip(contour['segments'][0]['c1'], [25, -40]):
            self.assertAlmostEqual(actual, expected, delta=.002)
        for actual, expected in zip(contour['segments'][0]['c2'], [70, 40]):
            self.assertAlmostEqual(actual, expected, delta=.002)
        self.assertAlmostEqual(curve['style']['strokeWidth'], 2, places=3)
        self.assertEqual(curve['style']['stroke'], '#3468AB')

    def test_multiple_contours_rectangle_and_close_survive(self):
        node = self.nodes['closed']
        contours = node['geometry']['contours']
        self.assertEqual(len(contours), 2)
        self.assertTrue(all(c['closed'] for c in contours))
        self.assertEqual(contours[1]['id'], 'contour-1')
        self.assertEqual(node['style']['fillRule'], 'evenodd')
        self.assertEqual(len(contours[1]['segments']), 3)
        self.assertAlmostEqual(contours[1]['start'][0], 10, places=3)

    def test_pgf_coordinate_transform_is_baked_before_scene_transform(self):
        contour = self.nodes['transformed']['geometry']['contours'][0]
        # TikZ postmultiplies each coordinate transform. Physical +y is up;
        # the captured IR flips it once to scene +y down.
        for actual, expected in zip(contour['start'], [-14, -10]):
            self.assertAlmostEqual(actual, expected, places=3)
        for actual, expected in zip(contour['segments'][0]['to'], [6, -50]):
            self.assertAlmostEqual(actual, expected, places=3)
        self.assertAlmostEqual(self.nodes['g']['transform']['rotate'], math.radians(20))

    def test_circle_runs_through_pgf_cubic_generation(self):
        contours = self.nodes['circle']['geometry']['contours']
        self.assertEqual(len(contours), 1)
        self.assertTrue(contours[0]['closed'])
        self.assertEqual(len(contours[0]['segments']), 4)
        self.assertTrue(all(s['kind'] == 'cubic' for s in contours[0]['segments']))

    def test_runtime_relations_tweens_and_reference_provenance(self):
        self.assertEqual(self.bundle['version'], '0.3')
        relations = {r['type']: r for r in self.bundle['relations']}
        self.assertEqual(relations['pointOnPath']['mode'], 'length')
        self.assertEqual(relations['pointOnPath']['tolerance'], .025)
        self.assertNotIn('mode', relations['pathDirection'])
        self.assertTrue(relations['pathDirection']['normal'])
        tracks = {t['property']: t for t in self.bundle['tracks']}
        self.assertEqual(tracks['progress']['keys'], [[0, .25], [4, 1]])
        self.assertEqual(tracks['reveal']['keys'], [[0, .2], [4, 1]])
        self.assertEqual(tracks['geometry.contour-0.segment-0.c1']['keys'][-1], [4, [30, -20]])
        self.assertEqual(tracks['geometry.contour-0.start']['keys'][-1], [4, [-5, 0]])
        resource = self.bundle['resources']['curve-art']
        provenance = resource['provenance']
        folder = (self.folder / 'out' / provenance['dvi']).parent
        self.assertTrue((folder / 'asset.svg').exists())
        self.assertEqual(provenance['pgfSoftPathSha256'], hashlib.sha256((folder / 'asset.path').read_bytes()).hexdigest())
        self.assertEqual(provenance['pgfSoftPath']['geometry'], self.nodes['curve']['geometry'])
        self.assertEqual(self.nodes['curve']['source']['referenceResourceId'], 'curve-art')
        self.assertIn('pgf-editable-soft-path', resource['capabilities'])


class PGFPathFailureTests(unittest.TestCase):
    def compile(self, body, setup=''):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp)
            source = folder / 'bad.tex'
            source.write_text(document(body, setup), encoding='utf8')
            return compile_scene(source, folder / 'out')

    def test_unknown_live_style_is_explicit_error(self):
        with self.assertRaisesRegex(CompileDiagnostic, 'decorate'):
            self.compile(r'\loomgeometry[decorate] (a) {(0,0)--(10,10)};')

    def test_inline_paint_change_is_explicit_error(self):
        with self.assertRaisesRegex(CompileDiagnostic, 'Unsupported live geometry body'):
            self.compile(r'\loomgeometry (a) {(0,0)--(10,10)[red]--(20,0)};')

    def test_embedded_nodes_are_not_silently_discarded(self):
        with self.assertRaisesRegex(CompileDiagnostic, 'Unsupported live geometry body'):
            self.compile(r'\loomgeometry (a) {(0,0)--(10,10) node {hidden}};')

    def test_multiple_path_statements_are_rejected(self):
        with self.assertRaisesRegex(CompileDiagnostic, 'Ambiguous live geometry'):
            self.compile(r'\loomgeometry (a) {(0,0)--(10,10);\draw (30,0)--(40,10)};')

    def test_setup_injected_clip_is_not_lost_in_native_geometry(self):
        with self.assertRaisesRegex(ValueError, 'Unsupported live geometry reference clip'):
            self.compile(r'\loomgeometry (a) {(0,0)--(10,10)};',
                         r'\loomsetup{\tikzset{every picture/.style={execute at begin picture={\clip (0,0) rectangle (5,5);}}}}')

    def test_unknown_soft_path_protocol_operation_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            file = Path(temp) / 'asset.path'
            file.write_text('protocol:pgf-soft-path-v1\npgfversion:test\nQ:0pt,0pt\n', encoding='utf8')
            with self.assertRaisesRegex(ValueError, 'Unsupported PGF soft path operation'):
                read_soft_path(file)


if __name__ == '__main__':
    unittest.main()
