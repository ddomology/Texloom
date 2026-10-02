"""Literal shape capture and representative comparisons with real PGF geometry."""
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
from shape_capture import lower_shapes, ShapeCaptureDiagnostic


def document(body):
    paths = ''.join('\\TLNode{' + name + '}{path}{"d":"M0 0L1 0","geometry":{"contours":[{"id":"c","start":[0,0],"segments":[{"id":"s","kind":"line","to":[1,0]}]}]},"style":{"stroke":"#71DFC2"}}\n'
                    for name in ('circle', 'ellipse', 'arc', 'rectangle', 'rounded', 'polyline'))
    return (r'''\documentclass{article}
\usepackage{texloom-tikz}
\usepackage{texloom-shapes}
\begin{document}
\begin{loomscene}[width=400,height=220,duration=2,title={Parametric shapes}]
\TLNode{O}{point}{"x":80,"y":80,"r":30}
\TLNode{P}{point}{"x":0,"y":0,"r":3}
''' + paths + body + '\n\\end{loomscene}\n\\end{document}\n')


STATIC = r'''
\loomshape[tolerance=0.01]{circle}{circle}{{"center":"O","radius":30}}
\loomshape[tolerance=0.01]{ellipse}{ellipse}{{"center":[180,80],"rx":20,"ry":35}}
\loomshape[tolerance=0.01]{arc}{arc}{{"center":[300,80],"rx":60,"ry":35,"startAngle":0,"sweepAngle":"pi*1rad/2"}}
\loomshape{rectangle}{rectangle}{{"origin":[30,140],"width":90,"height":40}}
\loomshape{rounded}{roundedRectangle}{{"origin":[160,145],"width":80,"height":35,"cornerRadius":6}}
\loomshape{polyline}{polyline}{{"points":[[270,170],[290,145],[330,175],[360,150]],"closed":false}}
\loomshapesample{P}{shape:circle}{0.25}
'''

PGF = r'''
\loomgeometry[draw=black] (pgf-circle) {(80,80) circle[radius=30bp]};
\loomgeometry[draw=black] (pgf-ellipse) {(180,80) ellipse[x radius=20bp,y radius=35bp]};
\loomgeometry[draw=black] (pgf-arc) {(360,80) arc[start angle=0,end angle=-90,x radius=60bp,y radius=35bp]};
\loomgeometry[draw=black] (pgf-rectangle) {(30,140) rectangle (120,180)};
'''


def sample(path):
    script = '''import {readFile} from 'node:fs/promises'; import {build} from 'esbuild';
const code=await build({entryPoints:['src/index.ts'],bundle:true,platform:'node',format:'esm',write:false});
const {evaluate}=await import('data:text/javascript;base64,'+Buffer.from(code.outputFiles[0].text).toString('base64'));
console.log(JSON.stringify(evaluate(JSON.parse(await readFile(process.argv[1],'utf8')),0)));'''
    result = subprocess.run(['node', '--input-type=module', '-e', script, str(path)], cwd=ROOT,
                            capture_output=True, text=True, encoding='utf8', errors='replace')
    if result.returncode:
        raise AssertionError(result.stderr[-10000:] + result.stdout)
    return json.loads(result.stdout)


def flatten(geometry):
    contours = []
    for contour in geometry['contours']:
        start = contour['start']
        points = [start]
        for segment in contour['segments']:
            if segment['kind'] == 'line':
                points.append(segment['to'])
            else:
                for i in range(1, 97):
                    t = i / 96
                    points.append([(1-t)**3*start[a]+3*(1-t)**2*t*segment['c1'][a]+
                                   3*(1-t)*t*t*segment['c2'][a]+t**3*segment['to'][a] for a in (0, 1)])
            start = segment['to']
        if contour.get('closed'):
            points.append(points[0])
        contours.append(points)
    return contours


def distance(point, a, b):
    dx, dy = b[0]-a[0], b[1]-a[1]
    length = dx*dx+dy*dy
    t = max(0, min(1, ((point[0]-a[0])*dx+(point[1]-a[1])*dy)/length)) if length else 0
    return math.hypot(point[0]-a[0]-t*dx, point[1]-a[1]-t*dy)


class ShapeCompilerTests(unittest.TestCase):
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
        return folder, records, {'version': '0.2'}

    def test_literal_json_and_nested_decoded_expression_spans_are_exact(self):
        expression = '\n vec2(1bp,2bp) + \\undefinedmacro + "quote" % # ## ^^M ^^J &&\n'
        inputs = json.dumps({'points': ['O', {'expression': expression}, [30, 40]], 'closed': True}, indent=2)
        folder, records, bundle = self.capture('literal', '\\loomshape{polyline}{polyline}{' + inputs + '}')
        lower_shapes(records, bundle, folder, folder)
        operation = bundle['operationGraph']['operations'][0]
        point = operation['inputs']['points']['items'][1]
        self.assertEqual(point['expression'], expression)
        self.assertEqual(point['kind'], 'pointExpression')
        self.assertEqual(point['sourceSpan']['end'], {'line': 3, 'column': 1})
        self.assertEqual((folder / point['sourceSpan']['file']).read_text(encoding='utf8'), expression + '\n')
        self.assertEqual((folder / operation['sourceSpan']['file']).read_text(encoding='utf8'), inputs + '\n')
        self.assertEqual(operation['inputs']['closed']['value']['value'], 1)
        self.assertEqual(set(next(r for r in records if r['type'] == 'shape-file')), {'type', 'kind', 'file'})

    def test_lowering_profiles_spaces_property_inputs_and_analytic_sampler(self):
        body = r'''\loomshape[id=ring,space=plot:chart,profile=polyline,tolerance=0.2,maxSegments=1000]{circle}{circle}{{"center":"O","radius":{"node":"O","property":"r"}}}
\loomshapesample[space=plot:chart]{P}{ring}{"time/2s"}
'''
        folder, records, bundle = self.capture('lowering', body)
        previous = {'id': 'previous', 'operator': 'scalarValue', 'version': 1, 'spaces': {},
                    'inputs': {'value': {'kind': 'literal', 'value': {'type': 'scalar', 'value': 1}}}}
        bundle['operationGraph'] = {'version': 1, 'operations': [previous], 'bindings': []}
        lower_shapes(records, bundle, folder, folder)
        graph = bundle['operationGraph']
        self.assertEqual(graph['operations'][0], previous)
        constructor, lowering, transform, sampler, scene = graph['operations'][1:]
        self.assertEqual(constructor['inputs']['radius'], {'kind': 'property', 'node': 'O', 'property': 'r', 'unit': 'bp'})
        self.assertEqual(lowering['operator'], 'shapeToPolyline')
        self.assertEqual(lowering['inputs']['tolerance']['value']['value'], .2)
        self.assertEqual(transform['operator'], 'transformPath')
        self.assertEqual(transform['spaces']['to'], {'kind': 'local', 'node': 'circle'})
        self.assertEqual(sampler['operator'], 'sampleShape')
        self.assertEqual(sampler['inputs']['shape']['ref'], {'operation': 'ring', 'socket': 'shape'})
        self.assertEqual(scene['operator'], 'transformPoint')
        self.assertEqual([b['property'] for b in graph['bindings']], ['geometry', 'position'])

    def test_invalid_capture_options_and_json_are_rejected(self):
        cases = [('duplicate', '', 'circle', '{"center":"O","radius":1,"radius":2}', 'Duplicate JSON key'),
                 ('nonfinite', '', 'circle', '{"center":"O","radius":NaN}', 'nonfinite'),
                 ('profile', 'profile=mesh', 'circle', '{}', 'profile must be'),
                 ('budget', 'maxSegments=1.5', 'circle', '{}', 'positive integer'),
                 ('tolerance', 'tolerance=0', 'circle', '{}', 'positive finite'),
                 ('constructor', '', 'sphere', '{}', 'Unknown shape constructor'),
                 ('socket', '', 'circle', '{"diameter":30}', 'Unknown circle input')]
        for name, options, constructor, inputs, message in cases:
            with self.subTest(name=name):
                folder, records, bundle = self.capture(name, '\\loomshape[' + options + ']{circle}{' + constructor + '}{' + inputs + '}')
                with self.assertRaisesRegex(ShapeCaptureDiagnostic, message):
                    lower_shapes(records, bundle, folder, folder)

    def test_representative_boundaries_match_real_pgf_and_sampling_is_analytic(self):
        source = self.folder / 'pgf.tex'
        source.write_text(document(STATIC + PGF), encoding='utf8')
        output = self.folder / 'pgf-out'
        compile_scene(source, output)
        nodes = {node['id']: node for node in sample(output / 'bundle.json')['nodes']}
        for shape in ('circle', 'ellipse', 'arc', 'rectangle'):
            with self.subTest(shape=shape):
                a = flatten(nodes[shape]['geometry'])[0]
                b = flatten(nodes['pgf-' + shape]['geometry'])[0]
                # Compare both boundary directions, independent of path start,
                # traversal direction or different cubic subdivision counts.
                for points, reference in ((a, b), (b, a)):
                    error = max(min(distance(point, p, q) for p, q in zip(reference, reference[1:])) for point in points)
                    self.assertLess(error, .06, f'{shape} PGF boundary error {error}bp')
        self.assertAlmostEqual(nodes['P']['x'], 80, places=9)
        self.assertAlmostEqual(nodes['P']['y'], 110, places=9)
        self.assertTrue(nodes['rounded']['geometry']['contours'][0]['closed'])
        self.assertFalse(nodes['polyline']['geometry']['contours'][0].get('closed', False))

    def test_full_compiles_repeat_with_exact_archived_json_and_expression_sources(self):
        source = self.folder / 'repeat.tex'
        source.write_text(document(r'\loomshape{circle}{circle}{{"center":{"expression":"vec2(80bp,80bp)"},"radius":"30bp+2bp*sin(1rad*time/1s)"}}'), encoding='utf8')
        outputs = [self.folder / 'repeat-one', self.folder / 'repeat-two']
        bundles = [compile_scene(source, output) for output in outputs]
        self.assertEqual({key: value for key, value in bundles[0].items() if key != 'provenance'},
                         {key: value for key, value in bundles[1].items() if key != 'provenance'})
        for output, bundle in zip(outputs, bundles):
            operation = bundle['operationGraph']['operations'][0]
            archived = output / operation['sourceSpan']['file']
            original = next(output.glob('runs/compile-*/source/' + archived.name))
            self.assertEqual(archived.read_bytes(), original.read_bytes())
            for value in operation['inputs'].values():
                self.assertEqual((output / value['sourceSpan']['file']).read_text(encoding='utf8'), value['expression'] + '\n')

    def test_unknown_expression_reaches_shared_validator(self):
        source = self.folder / 'unknown.tex'
        source.write_text(document(r'\loomshape{circle}{circle}{{"center":"O","radius":"unknown_radius"}}'), encoding='utf8')
        with self.assertRaisesRegex(CompileDiagnostic, 'unknown_radius'):
            compile_scene(source, self.folder / 'unknown-out')

    def test_empty_package_preserves_scene_shape(self):
        source = self.folder / 'empty.tex'
        text = '\n'.join(line for line in document('').splitlines() if not line.startswith('\\TLNode')) + '\n'
        source.write_text(text, encoding='utf8')
        bundle = compile_scene(source, self.folder / 'empty-out')
        self.assertEqual(bundle['version'], '0.2')
        self.assertNotIn('operationGraph', bundle)
        self.assertNotIn('expressions', bundle)


if __name__ == '__main__':
    unittest.main()
