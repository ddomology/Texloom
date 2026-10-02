"""Literal curve capture and real-TeX execution against analytical geometry."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
from compile import compile_scene, CompileDiagnostic
from curve_capture import lower_curves, CurveCaptureDiagnostic
from tests.shape_compiler_test import sample


def document(body, extra=''):
    placeholders = ''.join('\\TLNode{' + name + '}{path}{"d":"M0 0L1 0","geometry":{"contours":[{"id":"c","start":[0,0],"segments":[{"id":"s","kind":"line","to":[1,0]}]}]}}\n'
                           for name in ('trimmed', 'resampled', 'spacing', 'reversed', 'joined', 'wrapped'))
    return r'''\documentclass{article}
\usepackage{texloom-curves}
\begin{document}
\TLScene{Curve operations}{400}{220}{2}
\TLNode{source}{path}{"d":"M0 0C0 0 0 0 100 0","geometry":{"contours":[{"id":"main","start":[0,0],"segments":[{"id":"slow","kind":"cubic","c1":[0,0],"c2":[0,0],"to":[100,0]}]}]}}
\TLNode{disconnected}{path}{"d":"M0 0L10 0M100 10L120 10","geometry":{"contours":[{"id":"a","start":[0,0],"segments":[{"id":"a1","kind":"line","to":[10,0]}]},{"id":"b","start":[100,10],"segments":[{"id":"b1","kind":"line","to":[120,10]}]}]}}
\TLNode{square}{path}{"d":"M0 0L10 0L10 10L0 10Z","geometry":{"contours":[{"id":"square","start":[0,0],"segments":[{"id":"east","kind":"line","to":[10,0]},{"id":"south","kind":"line","to":[10,10]},{"id":"west","kind":"line","to":[0,10]}],"closed":true}]}}
\TLNode{P}{point}{"x":0,"y":0,"r":2}
\TLNode{Q}{point}{"x":0,"y":0,"r":2}
\TLNode{tip}{point}{"x":0,"y":0,"r":2}
''' + placeholders + extra + body + '\n\\end{document}\n'


class CurveCompilerTests(unittest.TestCase):
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
        return folder, records, {'version': '0.1'}

    def compile(self, name, body, extra=''):
        source = self.folder / (name + '.tex')
        source.write_text(document(body, extra), encoding='utf8')
        output = self.folder / (name + '-out')
        return output, compile_scene(source, output)

    def test_literal_multiline_json_expressions_and_policy_lowering(self):
        expression = '\n .5 + \\unknown + "quote" % # ## ^^M ^^J &&\n'
        inputs = json.dumps({'path': 'source', 'start': 0, 'end': expression}, indent=2)
        body = '\\loomcurve[mode=parameter,contour=0,wrap=true,tolerance=0.02]{trimmed}{trim}{' + inputs + '}\n' + r'''
\loomcurvesample[space=plot:chart,tangent=tip,distance=18]{P}{{"path":{"operation":"curve:trimmed","socket":"path"},"parameter":0.4}}
'''
        folder, records, bundle = self.capture('literal', body)
        lower_curves(records, bundle, folder, folder)
        operations = bundle['operationGraph']['operations']
        trim = operations[0]
        self.assertEqual(trim['inputs']['mode']['value']['value'], 0)
        self.assertEqual(trim['inputs']['contour']['value']['value'], 0)
        self.assertEqual(trim['inputs']['wrap']['value']['value'], 1)
        self.assertEqual(trim['inputs']['tolerance']['value']['unit'], 'bp')
        self.assertEqual(trim['inputs']['path'], {'kind': 'path', 'node': 'source', 'space': {'kind': 'scene'}})
        end = trim['inputs']['end']
        self.assertEqual(end['expression'], expression)
        self.assertEqual((folder / end['sourceSpan']['file']).read_text(encoding='utf8'), expression+'\n')
        self.assertEqual((folder / trim['sourceSpan']['file']).read_text(encoding='utf8'), inputs+'\n')
        sampler = next(op for op in operations if op['operator'] == 'sampleCurve')
        self.assertEqual(sampler['version'], 2)
        direction = next(op for op in operations if op['operator'] == 'offsetPoint')
        self.assertEqual(direction['inputs']['direction']['ref']['socket'], 'tangent')
        self.assertEqual(direction['inputs']['distance']['value']['value'], 18)
        self.assertEqual(len([op for op in operations if op['operator'] == 'transformPoint']), 2)

    def test_invalid_frontend_policy_and_input_combinations(self):
        cases = [('both', '', 'resample', '{"path":"source","count":5,"spacing":10}', 'exactly one'),
                 ('neither', '', 'resample', '{"path":"source"}', 'exactly one'),
                 ('mode', 'mode=distance', 'trim', '{}', 'mode must be'),
                 ('contour', 'contour=1.5', 'reverse', '{}', 'integer index'),
                 ('wrap', 'wrap=yes', 'trim', '{}', 'wrap must be'),
                 ('join', 'join=snap', 'join', '{}', 'join must be'),
                 ('duplicate', '', 'trim', '{"path":"source","start":0,"start":1}', 'Duplicate JSON key'),
                 ('operator', '', 'sample', '{"path":"source"}', 'Unknown curve operation'),
                 ('tolerance', 'tolerance=0.2', 'reverse', '{"path":"source","tolerance":0.1}', 'both options')]
        for name, options, operator, values, message in cases:
            with self.subTest(name=name):
                folder, records, bundle = self.capture(name, '\\loomcurve[' + options + ']{trimmed}{' + operator + '}{' + values + '}')
                with self.assertRaisesRegex(CurveCaptureDiagnostic, message):
                    lower_curves(records, bundle, folder, folder)

    def test_compiled_trim_resampling_reverse_and_closed_wrap_are_analytical(self):
        output, bundle = self.compile('analytical', r'''
\loomcurve[mode=parameter,tolerance=0.000001]{trimmed}{trim}{{"path":"source","start":0.2,"end":0.8}}
\loomcurve[tolerance=0.000001]{resampled}{resample}{{"path":"source","count":6}}
\loomcurve[tolerance=0.000001]{spacing}{resample}{{"path":"disconnected","spacing":6}}
\loomcurve[tolerance=0.000001]{reversed}{reverse}{{"path":{"operation":"curve:trimmed","socket":"path"}}}
\loomcurve[join=separate]{joined}{join}{{"a":"source","b":"disconnected"}}
\loomcurve[wrap=true,tolerance=0.000001]{wrapped}{trim}{{"path":"square","start":0.875,"end":0.125}}
\loomcurvesample[id=mid,tangent=tip,distance=12,tolerance=0.000001]{P}{{"path":"source","parameter":0.5}}
\loomcurvesample[id=reverse-mid,tolerance=0.000001]{Q}{{"path":{"operation":"curve:reversed","socket":"path"},"parameter":0.5}}
''')
        frame = sample(output / 'bundle.json')
        nodes = {n['id']: n for n in frame['nodes']}
        trimmed = nodes['trimmed']['geometry']['contours'][0]
        self.assertAlmostEqual(trimmed['start'][0], .8, places=9)
        self.assertAlmostEqual(trimmed['segments'][-1]['to'][0], 51.2, places=9)
        self.assertEqual(trimmed['segments'][0]['kind'], 'cubic')
        resampled = nodes['resampled']['geometry']['contours'][0]
        values = [resampled['start'][0]] + [s['to'][0] for s in resampled['segments']]
        for got, expected in zip(values, [0, 20, 40, 60, 80, 100]):
            self.assertAlmostEqual(got, expected, delta=.0001)
        self.assertEqual(len(values), 6)
        self.assertTrue(all(s['kind'] == 'line' for s in resampled['segments']))
        contours = nodes['spacing']['geometry']['contours']
        self.assertEqual([len(c['segments']) for c in contours], [2, 4])
        self.assertEqual(len(nodes['joined']['geometry']['contours']), 3)
        wrapped = nodes['wrapped']['geometry']['contours'][0]
        self.assertEqual(wrapped['start'], [0, 5])
        self.assertEqual(wrapped['segments'][-1]['to'], [5, 0])
        self.assertAlmostEqual(nodes['P']['x'], 50, delta=.0001)
        self.assertAlmostEqual(nodes['tip']['x'], 62, delta=.0001)
        self.assertAlmostEqual(nodes['Q']['x'], 26, delta=.0001)
        reversed_sample = frame['curves']['samples']['reverse-mid']['sample']
        self.assertEqual(reversed_sample['tangent'], [-1, 0])

    def test_native_pgf_path_input_is_transformed_to_scene_then_target_local(self):
        body = r'''
\loomgeometry[draw=black] (native) {(0,0) .. controls (0,0) and (0,0) .. (100,0)};
\TLNode{chart}{group}{"transform":{"translate":[30,50],"scale":[2,-1]}}
\TLTrack{native}{transform.translate}{linear}{[[0,[5,10]],[2,[5,10]]]}
\loomcurve[space=scene,tolerance=0.000001]{trimmed}{trim}{{"path":"native","start":0.25,"end":0.75}}
\loomcurvesample[tolerance=0.000001]{P}{{"path":{"operation":"curve:trimmed","socket":"path"},"parameter":0.5}}
'''
        # Native PGF uses bp units and a small TeX dimension-rounding tolerance.
        source = self.folder / 'native.tex'
        source.write_text(document(body).replace('\\TLNode{trimmed}{path}{', '\\TLNode{trimmed}{path}{"parent":"chart",').replace('\\usepackage{texloom-curves}', '\\usepackage{texloom-curves}\n\\usepackage{texloom-tikz}').replace('\\TLScene{Curve operations}{400}{220}{2}', '\\begin{loomscene}[width=400,height=220,duration=2,title={Native curve}]').replace('\\end{document}', '\\end{loomscene}\n\\end{document}'), encoding='utf8')
        output = self.folder / 'native-out'
        compile_scene(source, output)
        nodes = {n['id']: n for n in sample(output / 'bundle.json')['nodes']}
        self.assertAlmostEqual(nodes['P']['x'], 55, delta=.003)
        self.assertAlmostEqual(nodes['P']['y'], 10, delta=.003)
        self.assertAlmostEqual(nodes['trimmed']['geometry']['contours'][0]['start'][0], 0, delta=.003)
        self.assertAlmostEqual(nodes['trimmed']['geometry']['contours'][0]['start'][1], 40, delta=.003)

    def test_repeated_compiles_archive_exact_json_and_decoded_expression(self):
        source = self.folder / 'repeat.tex'
        source.write_text(document(r'\loomcurve{trimmed}{trim}{{"path":"source","start":0.1,"end":"0.75+0.1*sin(time/1s*1rad)"}}'), encoding='utf8')
        outputs = [self.folder / 'repeat-one', self.folder / 'repeat-two']
        bundles = [compile_scene(source, output) for output in outputs]
        self.assertEqual({k: v for k, v in bundles[0].items() if k != 'provenance'},
                         {k: v for k, v in bundles[1].items() if k != 'provenance'})
        for output, bundle in zip(outputs, bundles):
            op = bundle['operationGraph']['operations'][0]
            archived = output / op['sourceSpan']['file']
            original = next(output.glob('runs/compile-*/source/' + archived.name))
            self.assertEqual(archived.read_bytes(), original.read_bytes())
            expr = op['inputs']['end']
            self.assertEqual((output / expr['sourceSpan']['file']).read_text(encoding='utf8'), expr['expression']+'\n')

    def test_runtime_expression_and_writer_errors_are_reported(self):
        with self.assertRaisesRegex(CompileDiagnostic, 'unknown_end'):
            self.compile('unknown', r'\loomcurve{trimmed}{trim}{{"path":"source","start":0,"end":"unknown_end"}}')
        with self.assertRaisesRegex(CompileDiagnostic, 'cycle|CYCLE'):
            self.compile('cycle', r'\loomcurve{source}{reverse}{{"path":"source"}}')

    def test_empty_package_preserves_original_bundle_version(self):
        source = self.folder / 'empty.tex'
        source.write_text('\n'.join(line for line in document('').splitlines() if '}{path}' not in line), encoding='utf8')
        bundle = compile_scene(source, self.folder / 'empty-out')
        self.assertEqual(bundle['version'], '0.1')
        self.assertNotIn('operationGraph', bundle)


if __name__ == '__main__':
    unittest.main()
