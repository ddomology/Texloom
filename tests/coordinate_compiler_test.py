"""Literal coordinate capture and numerical parity with the real PGF calc engine."""
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
from compile import compile_scene, CompileDiagnostic, PT_TO_BP
from coordinate_capture import lower_coordinates, CoordinateCaptureDiagnostic


def document(body):
    points = ''.join('\\TLNode{' + name + '}{point}{"x":0,"y":0,"r":3}\n'
                     for name in ('M', 'L', 'E', 'D', 'R', 'F', 'S'))
    return r'''\documentclass{article}
\usepackage{texloom-coordinates}
\usepackage{tikz}
\usetikzlibrary{calc}
\newwrite\ReferenceFile
\newdimen\ReferenceX
\newdimen\ReferenceY
\newcommand\ReferencePoint[1]{%
  \pgfextractx{\ReferenceX}{\pgfpointanchor{#1}{center}}%
  \pgfextracty{\ReferenceY}{\pgfpointanchor{#1}{center}}%
  \immediate\write\ReferenceFile{#1,\the\ReferenceX,\the\ReferenceY}}
\begin{document}
\TLScene{Coordinate operations}{320}{180}{2}
\TLNode{A}{point}{"x":20,"y":30,"r":3}
\TLNode{B}{point}{"x":180,"y":70,"r":3}
\TLNode{P}{point}{"x":240,"y":130,"r":3}
''' + points + body + '\n\\end{document}\n'


STATIC = r'''
\loomcoordinate{M}{midpoint}{{"a":"A","b":"B"}}
\loomcoordinate{L}{lerpPoint}{{"a":"A","b":"B","factor":0.3}}
\loomcoordinate{E}{lerpPoint}{{"a":"A","b":"B","factor":1.35}}
\loomcoordinate{D}{pointTowards}{{"a":"A","b":"B","distance":40}}
\loomcoordinate{R}{rotatePoint}{{"point":"B","center":"A","angle":"pi*1rad/6"}}
\loomcoordinate{F}{projectLine}{{"point":"P","a":"A","b":"B"}}
\loomcoordinate{S}{projectSegment}{{"point":"P","a":"A","b":"B"}}
'''

# Use positive numerical axes in both engines. PGF displays +y upwards, whereas
# the scene displays the same numeric tuples with +y down. No visual rotation
# sign is inferred from a screenshot; positive angles share the numeric formula.
PGF_REFERENCE = r'''
\immediate\openout\ReferenceFile=pgf-reference.txt
\begin{tikzpicture}[x=1bp,y=1bp]
  \coordinate (A) at (20,30);
  \coordinate (B) at (180,70);
  \coordinate (P) at (240,130);
  \coordinate (M) at ($(A)!.5!(B)$);
  \coordinate (L) at ($(A)!.3!(B)$);
  \coordinate (E) at ($(A)!1.35!(B)$);
  \coordinate (D) at ($(A)!40bp!(B)$);
  \coordinate (R) at ($(A)!1!30:(B)$);
  \coordinate (F) at ($(A)!(P)!(B)$);
  \coordinate (S) at ($(A)!1!(B)$);
  \ReferencePoint{M}\ReferencePoint{L}\ReferencePoint{E}\ReferencePoint{D}
  \ReferencePoint{R}\ReferencePoint{F}\ReferencePoint{S}
\end{tikzpicture}
\immediate\closeout\ReferenceFile
'''


def sample(path):
    script = '''import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';
const code=await build({entryPoints:['src/index.ts'],bundle:true,platform:'node',format:'esm',write:false});
const {evaluate}=await import('data:text/javascript;base64,'+Buffer.from(code.outputFiles[0].text).toString('base64'));
console.log(JSON.stringify(evaluate(JSON.parse(await readFile(process.argv[1],'utf8')),0)));'''
    result = subprocess.run(['node', '--input-type=module', '-e', script, str(path)], cwd=ROOT,
                            capture_output=True, text=True, encoding='utf8', errors='replace')
    if result.returncode:
        raise AssertionError(result.stderr[-12000:] + result.stdout)
    return json.loads(result.stdout)


class CoordinateCompilerTests(unittest.TestCase):
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

    def test_literal_json_and_decoded_expressions_have_exact_separate_spans(self):
        expression = '\n pi*1rad/6 + \\undefinedmacro + "quote" % # ## ^^M ^^J &&\n'
        inputs = json.dumps({'point': 'B', 'center': 'A', 'angle': expression}, indent=2)
        folder, records, bundle = self.capture('literal', '\\loomcoordinate{R}{rotatePoint}{' + inputs + '}')
        lower_coordinates(records, bundle, folder, folder)
        operation = bundle['operationGraph']['operations'][0]
        scalar = operation['inputs']['angle']
        self.assertEqual(scalar['expression'], expression)
        self.assertEqual(scalar['unit'], 'rad')
        self.assertEqual(scalar['sourceSpan']['end'], {'line': 3, 'column': 1})
        self.assertEqual((folder / scalar['sourceSpan']['file']).read_text(encoding='utf8'), expression + '\n')
        self.assertEqual((folder / operation['sourceSpan']['file']).read_text(encoding='utf8'), inputs + '\n')
        self.assertNotEqual(scalar['sourceSpan']['file'], operation['sourceSpan']['file'])
        self.assertEqual(set(next(r for r in records if r['type'] == 'coordinate-file')), {'type', 'file'})

    def test_non_scene_lowering_uses_explicit_live_transform_and_output_refs(self):
        body = r'''\loomcoordinate[space=plot:chart,id=middle]{M}{midpoint}{{"a":"A","b":[30,40]}}
\loomcoordinate[space=plot:chart]{L}{lerpPoint}{{"a":{"operation":"middle","socket":"position"},"b":"B","factor":1.25}}
'''
        folder, records, bundle = self.capture('space', body)
        previous = {'id': 'previous', 'operator': 'scalarValue', 'version': 1, 'spaces': {},
                    'inputs': {'value': {'kind': 'literal', 'value': {'type': 'scalar', 'value': 1}}}}
        bundle['operationGraph'] = {'version': 1, 'operations': [previous], 'bindings': []}
        lower_coordinates(records, bundle, folder, folder)
        graph = bundle['operationGraph']
        self.assertEqual(graph['operations'][0], previous)
        first, transform, second, _ = graph['operations'][1:]
        self.assertEqual(first['spaces'], {'space': {'kind': 'plot', 'node': 'chart'}})
        self.assertEqual(first['inputs']['a'], {'kind': 'node', 'node': 'A', 'property': 'position', 'space': {'kind': 'plot', 'node': 'chart'}})
        self.assertEqual(first['inputs']['b']['value']['value'], [30, 40])
        self.assertEqual(transform['id'], 'middle:scene')
        self.assertEqual(transform['inputs']['transform'], {'kind': 'spaceTransform', 'from': {'kind': 'plot', 'node': 'chart'}, 'to': {'kind': 'scene'}})
        self.assertEqual(second['inputs']['a'], {'kind': 'output', 'ref': {'operation': 'middle', 'socket': 'position'}})
        self.assertEqual(second['inputs']['factor']['value'], {'type': 'scalar', 'unit': '1', 'value': 1.25})
        self.assertEqual(graph['bindings'][0]['value']['operation'], 'middle:scene')

    def test_invalid_json_options_and_inputs_are_rejected(self):
        cases = [('duplicate-json', '', 'midpoint', '{"a":"A","a":"B","b":"B"}', 'Duplicate JSON key'),
                 ('nonfinite', '', 'lerpPoint', '{"a":"A","b":"B","factor":NaN}', 'nonfinite'),
                 ('boolean', '', 'pointTowards', '{"a":"A","b":"B","distance":true}', 'finite number'),
                 ('option', 'space=world', 'midpoint', '{"a":"A","b":"B"}', 'space must be'),
                 ('duplicate-option', 'space=scene,space=scene', 'midpoint', '{}', 'Duplicate coordinate option'),
                 ('operator', '', 'tikzCalc', '{}', 'Unknown coordinate operator'),
                 ('socket', '', 'midpoint', '{"from":"A","b":"B"}', 'Unknown midpoint input')]
        for name, options, operator, inputs, error in cases:
            with self.subTest(name=name):
                folder, records, bundle = self.capture(name, '\\loomcoordinate[' + options + ']{M}{' + operator + '}{' + inputs + '}')
                with self.assertRaisesRegex(CoordinateCaptureDiagnostic, error):
                    lower_coordinates(records, bundle, folder, folder)

    def test_static_results_match_actual_pgf_calc_with_dimension_rounding(self):
        source = self.folder / 'pgf.tex'
        source.write_text(document(STATIC + PGF_REFERENCE), encoding='utf8')
        output = self.folder / 'pgf-out'
        compile_scene(source, output)
        reference = next(output.glob('runs/compile-*/source/pgf-reference.txt'))
        frame = sample(output / 'bundle.json')
        nodes = {node['id']: node for node in frame['nodes']}
        for line in reference.read_text().splitlines():
            name, x, y = line.split(',')
            expected = [float(value.removesuffix('pt')) * PT_TO_BP for value in (x, y)]
            for axis, value in zip(('x', 'y'), expected):
                self.assertAlmostEqual(nodes[name][axis], value, delta=.025, msg=f'PGF calc {name}.{axis}')
        self.assertGreater(nodes['F']['x'], nodes['B']['x'])
        self.assertAlmostEqual(nodes['S']['x'], nodes['B']['x'])

    def test_full_compiles_are_repeatable_with_exact_json_and_expression_sources(self):
        source = self.folder / 'repeat.tex'
        source.write_text(document(r'\loomcoordinate{R}{rotatePoint}{{"point":"B","center":"A","angle":"pi*1rad/6"}}'), encoding='utf8')
        outputs = [self.folder / 'repeat-one', self.folder / 'repeat-two']
        bundles = [compile_scene(source, output) for output in outputs]
        self.assertEqual({key: value for key, value in bundles[0].items() if key != 'provenance'},
                         {key: value for key, value in bundles[1].items() if key != 'provenance'})
        for output, bundle in zip(outputs, bundles):
            operation = bundle['operationGraph']['operations'][0]
            archived = output / operation['sourceSpan']['file']
            original = next(output.glob('runs/compile-*/source/' + archived.name))
            self.assertEqual(archived.read_bytes(), original.read_bytes())
            scalar = operation['inputs']['angle']
            self.assertEqual((output / scalar['sourceSpan']['file']).read_text(encoding='utf8'), scalar['expression'] + '\n')

    def test_unknown_expression_symbol_reaches_shared_validator(self):
        source = self.folder / 'unknown.tex'
        source.write_text(document(r'\loomcoordinate{R}{rotatePoint}{{"point":"B","center":"A","angle":"missing_angle"}}'), encoding='utf8')
        with self.assertRaisesRegex(CompileDiagnostic, 'missing_angle'):
            compile_scene(source, self.folder / 'unknown-out')

    def test_loading_package_without_declarations_preserves_bundle_shape(self):
        source = self.folder / 'empty.tex'
        source.write_text(document(''), encoding='utf8')
        bundle = compile_scene(source, self.folder / 'empty-out')
        self.assertEqual(bundle['version'], '0.1')
        self.assertNotIn('operationGraph', bundle)
        self.assertNotIn('expressions', bundle)


if __name__ == '__main__':
    unittest.main()
