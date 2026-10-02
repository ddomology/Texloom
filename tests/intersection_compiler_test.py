"""Real TeX intersection declarations, PGF references and analytic geometry."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
from compile import compile_scene, CompileDiagnostic, PT_TO_BP
from intersection_capture import lower_intersections, IntersectionCaptureDiagnostic

PAIR_NODES = r'''
\TLNode{pair-a}{path}{"d":"M0 -8C33.333333333333336 16 66.66666666666667 -16 100 8","geometry":{"contours":[{"id":"a","start":[0,-8],"segments":[{"id":"a","kind":"cubic","c1":[33.333333333333336,16],"c2":[66.66666666666667,-16],"to":[100,8]}]}]}}
\TLNode{pair-b}{path}{"d":"M0 0C33.333333333333336 2 66.66666666666667 -2 100 0","geometry":{"contours":[{"id":"b","start":[0,0],"segments":[{"id":"b","kind":"cubic","c1":[33.333333333333336,2],"c2":[66.66666666666667,-2],"to":[100,0]}]}]}}
'''

NONMATCHING_NODES = r'''
\TLNode{param-a}{path}{"d":"M0 0C33.333333333333336 0 66.66666666666667 0 100 100","geometry":{"contours":[{"id":"a","start":[0,0],"segments":[{"id":"a","kind":"cubic","c1":[33.333333333333336,0],"c2":[66.66666666666667,0],"to":[100,100]}]}]}}
\TLNode{param-b}{path}{"d":"M0 100C0 66.66666666666667 0 33.333333333333336 100 0","geometry":{"contours":[{"id":"b","start":[0,100],"segments":[{"id":"b","kind":"cubic","c1":[0,66.66666666666667],"c2":[0,33.333333333333336],"to":[100,0]}]}]}}
'''


def document(body, extra=''):
    return r'''\documentclass{article}
\usepackage{texloom-intersections}
\usepackage{tikz}
\usetikzlibrary{intersections}
\newwrite\ReferenceFile
\newdimen\ReferenceX
\newdimen\ReferenceY
\begin{document}
\TLScene{Path intersections}{400}{220}{2}
\TLNode{line}{path}{"d":"M100 0L0 0","geometry":{"contours":[{"id":"line","start":[100,0],"segments":[{"id":"line","kind":"line","to":[0,0]}]}]}}
\TLNode{cubic}{path}{"d":"M0 -8C33.333333333333336 14 66.66666666666667 -14 100 8","geometry":{"contours":[{"id":"cubic","start":[0,-8],"segments":[{"id":"cubic","kind":"cubic","c1":[33.333333333333336,14],"c2":[66.66666666666667,-14],"to":[100,8]}]}]}}
\TLNode{short}{path}{"d":"M0 0L10 0","geometry":{"contours":[{"id":"short","start":[0,0],"segments":[{"id":"short","kind":"line","to":[10,0]}]}]}}
\TLNode{vertical}{path}{"d":"M20 -5L20 5","geometry":{"contours":[{"id":"vertical","start":[20,-5],"segments":[{"id":"vertical","kind":"line","to":[20,5]}]}]}}
\TLNode{overlap}{path}{"d":"M5 0L15 0","geometry":{"contours":[{"id":"overlap","start":[5,0],"segments":[{"id":"overlap","kind":"line","to":[15,0]}]}]}}
\TLNode{P}{point}{"x":7,"y":9,"r":2,"style":{"opacity":0.6}}
\TLNode{Q}{point}{"x":0,"y":0,"r":2}
\TLNode{R}{point}{"x":0,"y":0,"r":2}
''' + extra + body + '\n\\end{document}\n'


def samples(path, times=(0,)):
    script = '''import {readFile} from 'node:fs/promises';import {build} from 'esbuild';
const code=await build({entryPoints:['src/index.ts'],bundle:true,platform:'node',format:'esm',write:false});
const {createEvaluator}=await import('data:text/javascript;base64,'+Buffer.from(code.outputFiles[0].text).toString('base64'));
const evaluate=createEvaluator(JSON.parse(await readFile(process.argv[1],'utf8')));
console.log(JSON.stringify(JSON.parse(process.argv[2]).map(t=>{try{return {frame:evaluate(t)}}catch(error){return {error:error.message}}})));'''
    result = subprocess.run(['node', '--input-type=module', '-e', script, str(path), json.dumps(times)], cwd=ROOT,
                            capture_output=True, text=True, encoding='utf8', errors='replace')
    if result.returncode:
        raise AssertionError(result.stderr[-10000:] + result.stdout)
    return json.loads(result.stdout)


def without_provenance(value):
    """Ignore run artifacts at both bundle and individual TeX resource levels."""
    if isinstance(value, dict):
        return {key: without_provenance(item) for key, item in value.items() if key != 'provenance'}
    if isinstance(value, list):
        return [without_provenance(item) for item in value]
    return value


class IntersectionCompilerTests(unittest.TestCase):
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
        bundle = {'version': '0.1', 'nodes': [r['value'] for r in records if r['type'] == 'node']}
        return folder, records, bundle

    def compile(self, name, body, extra=''):
        source = self.folder / (name + '.tex')
        source.write_text(document(body, extra), encoding='utf8')
        output = self.folder / (name + '-out')
        return output, compile_scene(source, output)

    def test_literal_capture_lowering_and_authored_fallback_have_exact_spans(self):
        expression = '\n 1bp + \\unknown + "quote" % # ## ^^M ^^J &&\n'
        values = json.dumps({'a': 'line', 'b': {'operation': 'curve:trimmed', 'socket': 'path'},
                             'positionTolerance': expression}, indent=2)
        body = '\\loomintersections[space=plot:chart,domain-a=line]{hits}{' + values + '}\n' + r'''
\loomintersectionpoint[space=plot:chart,along=b,index=2,missing=hide]{P}{{"intersections":"hits"}}
'''
        folder, records, bundle = self.capture('literal', body)
        lower_intersections(records, bundle, folder, folder)
        intersection, fallback, select, scene = bundle['operationGraph']['operations']
        self.assertEqual(intersection['id'], 'hits')
        self.assertEqual(intersection['inputs']['domainA']['value']['value'], 1)
        source = intersection['inputs']['positionTolerance']
        self.assertEqual(source['expression'], expression)
        self.assertEqual((folder / source['sourceSpan']['file']).read_text(encoding='utf8'), expression+'\n')
        self.assertEqual((folder / intersection['sourceSpan']['file']).read_text(encoding='utf8'), values+'\n')
        self.assertEqual(fallback['inputs']['point']['value']['value'], [7, 9])
        self.assertEqual(fallback['spaces']['from'], {'kind': 'local', 'node': 'P'})
        self.assertEqual(select['inputs']['visibleOpacity']['value']['value'], .6)
        self.assertEqual(select['inputs']['along']['value']['value'], 1)
        self.assertEqual(select['inputs']['missing']['value']['value'], 1)
        self.assertEqual(scene['spaces']['to'], {'kind': 'scene'})
        self.assertEqual([b['property'] for b in bundle['operationGraph']['bindings']], ['position', 'style.opacity'])

    def test_invalid_or_implicit_selection_policies_are_rejected(self):
        cases = [('implicit', '', '{"intersections":"hits"}', 'explicit along and missing'),
                 ('along', 'along=nearest,missing=hide', '{}', 'along must be'),
                 ('missing', 'along=a,missing=keep', '{}', 'missing must be'),
                 ('negative', 'along=a,missing=hide,index=-1', '{}', 'nonnegative integer'),
                 ('duplicate', 'along=a,missing=hide', '{"intersections":"hits","index":0,"index":1}', 'Duplicate JSON key'),
                 ('twice', 'along=a,missing=hide,index=1', '{"intersections":"hits","index":0}', 'both options')]
        for name, options, values, message in cases:
            with self.subTest(name=name):
                folder, records, bundle = self.capture(name, '\\loomintersectionpoint[' + options + ']{P}{' + values + '}')
                with self.assertRaisesRegex(IntersectionCaptureDiagnostic, message):
                    lower_intersections(records, bundle, folder, folder)

    def test_cubic_roots_ordering_match_analytic_values_and_real_pgf(self):
        body = r'''
\loomintersections{hits}{{"a":"line","b":"cubic"}}
\loomintersectionpoint[along=a,index=0,missing=error]{P}{{"intersections":"hits"}}
\loomintersectionpoint[along=a,index=1,missing=error]{Q}{{"intersections":"hits"}}
\loomintersectionpoint[along=b,index=0,missing=error]{R}{{"intersections":"hits"}}
\immediate\openout\ReferenceFile=pgf-reference.txt
\begin{tikzpicture}[x=1bp,y=1bp]
  \path[name path=A] (100,0)--(0,0);
  \path[name path=B] (0,-8) .. controls (33.333333333333336,14) and (66.66666666666667,-14) .. (100,8);
  \path[name intersections={of=A and B,sort by=A,name=hit,total=\Total}]
    \pgfextra{\immediate\write\ReferenceFile{count:\Total}};
  \foreach \i in {1,2,3}{
    \pgfextractx{\ReferenceX}{\pgfpointanchor{hit-\i}{center}}
    \pgfextracty{\ReferenceY}{\pgfpointanchor{hit-\i}{center}}
    \immediate\write\ReferenceFile{\the\ReferenceX,\the\ReferenceY}}
\end{tikzpicture}
\immediate\closeout\ReferenceFile
'''
        output, _ = self.compile('cubic', body)
        result = samples(output / 'bundle.json')[0]
        self.assertNotIn('error', result, result.get('error'))
        frame = result['frame']
        nodes = {n['id']: n for n in frame['nodes']}
        result = frame['intersections']['sets']['hits']['result']
        self.assertEqual(len(result['points']), 3)
        self.assertEqual(result['overlaps'], [])
        for name, x in [('P', 80), ('Q', 50), ('R', 20)]:
            self.assertAlmostEqual(nodes[name]['x'], x, delta=1e-5)
            self.assertAlmostEqual(nodes[name]['y'], 0, delta=1e-7)
        pgf = next(output.glob('runs/compile-*/source/pgf-reference.txt')).read_text().splitlines()
        self.assertEqual(pgf[0], 'count:3')
        for line, expected in zip(pgf[1:], [80, 50, 20]):
            x, y = [float(v.removesuffix('pt')) * PT_TO_BP for v in line.split(',')]
            self.assertAlmostEqual(x, expected, delta=.05)
            self.assertAlmostEqual(y, 0, delta=.05)
        self.assertTrue(all(p['incidents'][0]['contact'] == 'crossing' for p in result['points']))

    def test_line_domains_missing_hide_and_transformed_authored_fallback(self):
        body = r'''
\loomintersections{finite}{{"a":"short","b":"vertical"}}
\loomintersections[domain-a=line]{extended}{{"a":"short","b":"vertical"}}
\loomintersectionpoint[along=a,missing=hide]{P}{{"intersections":"finite"}}
\loomintersectionpoint[along=b,missing=error]{Q}{{"intersections":"extended"}}
'''
        source = self.folder / 'domains.tex'
        text = document(body, r'\TLNode{chart}{group}{"transform":{"translate":[30,50],"scale":[2,-1]}}')
        source.write_text(text.replace('\\TLNode{P}{point}{', '\\TLNode{P}{point}{"parent":"chart",'), encoding='utf8')
        output = self.folder / 'domains-out'
        compile_scene(source, output)
        result = samples(output / 'bundle.json')[0]
        self.assertNotIn('error', result, result.get('error'))
        frame = result['frame']
        nodes = {n['id']: n for n in frame['nodes']}
        self.assertEqual([nodes['P']['x'], nodes['P']['y']], [7, 9])
        self.assertEqual(nodes['P']['style']['opacity'], 0)
        self.assertEqual([nodes['Q']['x'], nodes['Q']['y']], [20, 0])
        self.assertIsNone(frame['intersections']['selections']['intersection:P']['selected'])
        incident = frame['intersections']['selections']['intersection:Q']['incident']
        self.assertEqual(incident['parameterA'], 2)

    def test_missing_is_stateless_and_overlap_is_not_an_arbitrary_point(self):
        body = r'''
\TLTrack{vertical}{transform.translate}{linear}{[[0,[-15,0]],[1,[0,0]],[2,[-15,0]]]}
\loomintersections{hits}{{"a":"short","b":"vertical"}}
\loomintersectionpoint[along=a,missing=hide]{P}{{"intersections":"hits"}}
'''
        output, _ = self.compile('missing', body)
        frames = [result['frame'] for result in samples(output / 'bundle.json', (0, 1, 2, 0))]
        points = [next(n for n in frame['nodes'] if n['id'] == 'P') for frame in frames]
        self.assertEqual([p['style']['opacity'] for p in points], [.6, 0, .6, .6])
        self.assertEqual([points[1]['x'], points[1]['y']], [7, 9])
        self.assertEqual(frames[0], frames[-1])
        output, _ = self.compile('overlap', r'''
\loomintersections{hits}{{"a":"short","b":"overlap"}}
\loomintersectionpoint[along=a,missing=hide]{P}{{"intersections":"hits"}}
''')
        self.assertIn('INTERSECTION_OVERLAP', samples(output / 'bundle.json')[0]['error'])
        output, _ = self.compile('error', r'''
\loomintersections{hits}{{"a":"short","b":"vertical"}}
\loomintersectionpoint[along=a,missing=error]{P}{{"intersections":"hits"}}
''')
        self.assertIn('INTERSECTION_MISSING', samples(output / 'bundle.json')[0]['error'])

    def test_raw_tex_labels_and_repeatable_archived_scalar_sources(self):
        source = self.folder / 'repeat.tex'
        source.write_text(document(r'''
\TLMath{label-art}{p_0}
\TLNode{label}{tex}{"resourceId":"label-art","x":17,"y":23,"style":{"opacity":0.7}}
\loomintersections{hits}{{"a":"line","b":"cubic","positionTolerance":"1e-7bp"}}
\loomintersectionpoint[along=b,missing=hide]{label}{{"intersections":"hits","index":"0+time/2s"}}
'''), encoding='utf8')
        outputs = [self.folder / 'repeat-one', self.folder / 'repeat-two']
        bundles = [compile_scene(source, output) for output in outputs]
        self.assertEqual(without_provenance(bundles[0]), without_provenance(bundles[1]))
        for output, bundle in zip(outputs, bundles):
            for operation in bundle['operationGraph']['operations']:
                archived = output / operation['sourceSpan']['file']
                original = next(output.glob('runs/compile-*/source/' + archived.name))
                self.assertEqual(archived.read_bytes(), original.read_bytes())
                for value in operation['inputs'].values():
                    if value['kind'] == 'expression':
                        self.assertEqual((output / value['sourceSpan']['file']).read_text(encoding='utf8'), value['expression']+'\n')
        results = samples(outputs[0] / 'bundle.json', (0, 1))
        label = next(n for n in results[0]['frame']['nodes'] if n['id'] == 'label')
        self.assertAlmostEqual(label['x'], 20, delta=1e-5)
        self.assertEqual(label['style']['opacity'], .7)
        self.assertIn('INTERSECTION_INDEX', results[1]['error'])

    def test_empty_package_preserves_original_version_and_unknown_expression_fails(self):
        source = self.folder / 'empty.tex'
        source.write_text('\n'.join(line for line in document('').splitlines() if '}{path}' not in line), encoding='utf8')
        bundle = compile_scene(source, self.folder / 'empty-out')
        self.assertEqual(bundle['version'], '0.1')
        self.assertNotIn('operationGraph', bundle)
        with self.assertRaisesRegex(CompileDiagnostic, 'unknown_tolerance'):
            self.compile('unknown', r'\loomintersections{hits}{{"a":"line","b":"cubic","positionTolerance":"unknown_tolerance"}}')

    def test_curve_solver_is_explicit_and_archives_exact_budget_expression(self):
        graphs = []
        for name, option in [('default-solver', ''), ('basic-solver', '[solver=basic]')]:
            folder, records, bundle = self.capture(name, '\\loomintersections'+option+'{hits}{{"a":"line","b":"cubic"}}')
            lower_intersections(records, bundle, folder, folder)
            graphs.append(bundle['operationGraph'])
        self.assertEqual(graphs[0], graphs[1])
        self.assertEqual(graphs[0]['operations'][0]['version'], 1)
        expression = '\n 65536 + time / 1s\n'
        payload = json.dumps({'a': 'pair-a', 'b': 'pair-b', 'maxWork': expression}, indent=2)
        folder, records, bundle = self.capture('curves-capture', '\\loomintersections[solver=curves,max-depth=40]{hits}{'+payload+'}')
        lower_intersections(records, bundle, folder, folder)
        operation = bundle['operationGraph']['operations'][0]
        self.assertEqual(operation['version'], 2)
        self.assertEqual(operation['inputs']['maxDepth']['value'], {'type': 'scalar', 'unit': '1', 'value': 40})
        value = operation['inputs']['maxWork']
        self.assertEqual(value['unit'], '1')
        self.assertEqual(value['expression'], expression)
        self.assertEqual((folder/value['sourceSpan']['file']).read_text(encoding='utf8'), expression+'\n')
        self.assertEqual((folder/operation['sourceSpan']['file']).read_text(encoding='utf8'), payload+'\n')

    def test_curve_solver_budget_authoring_rejects_implicit_or_invalid_limits(self):
        cases = [
            ('budget-basic-option', 'max-work=12', '{}', 'require solver=curves'),
            ('budget-basic-json', 'solver=basic', '{"maxDepth":40}', 'require solver=curves'),
            ('budget-solver', 'solver=auto', '{}', 'solver must be'),
            ('budget-zero', 'solver=curves,max-work=0', '{}', 'integer in'),
            ('budget-fractional', 'solver=curves,max-depth=1.5', '{}', 'integer in'),
            ('budget-too-deep', 'solver=curves,max-depth=53', '{}', 'integer in'),
            ('budget-too-much', 'solver=curves,max-work=1048577', '{}', 'integer in'),
            ('budget-twice', 'solver=curves,max-work=65536', '{"maxWork":100}', 'both options'),
        ]
        for name, option, values, message in cases:
            with self.subTest(name=name):
                folder, records, bundle = self.capture(name, '\\loomintersections['+option+']{hits}{'+values+'}')
                with self.assertRaisesRegex(IntersectionCaptureDiagnostic, message):
                    lower_intersections(records, bundle, folder, folder)

    def test_two_cubic_roots_match_real_pgf_and_hide_reappear_without_history(self):
        body = r'''
\TLTrack{pair-b}{transform.translate}{linear}{[[0,[0,0]],[1,[0,1.8]],[2,[0,0]]]}
\loomintersections[solver=curves,max-work=65536,max-depth=40]{hits}{{"a":"pair-a","b":"pair-b"}}
\loomintersectionpoint[along=b,index=0,missing=hide]{P}{{"intersections":"hits"}}
\loomintersectionpoint[along=b,index=1,missing=hide]{Q}{{"intersections":"hits"}}
\loomintersectionpoint[along=b,index=2,missing=hide]{R}{{"intersections":"hits"}}
\immediate\openout\ReferenceFile=pgf-reference.txt
\begin{tikzpicture}[x=1bp,y=1bp]
  \path[name path=A] (0,-8) .. controls (33.333333333333336,16) and (66.66666666666667,-16) .. (100,8);
  \path[name path=B] (0,0) .. controls (33.333333333333336,2) and (66.66666666666667,-2) .. (100,0);
  \path[name intersections={of=A and B,sort by=B,name=hit,total=\Total}]
    \pgfextra{\immediate\write\ReferenceFile{count:\Total}};
  \foreach \i in {1,2,3}{
    \pgfextractx{\ReferenceX}{\pgfpointanchor{hit-\i}{center}}
    \pgfextracty{\ReferenceY}{\pgfpointanchor{hit-\i}{center}}
    \immediate\write\ReferenceFile{\the\ReferenceX,\the\ReferenceY}}
\end{tikzpicture}
\immediate\closeout\ReferenceFile
'''
        output, _ = self.compile('two-cubics', body, PAIR_NODES)
        results = samples(output/'bundle.json', (0, 1, 2, 0))
        self.assertTrue(all('frame' in value for value in results), results)
        frames = [value['frame'] for value in results]
        self.assertEqual(frames[0], frames[-1])
        self.assertEqual([len(frame['intersections']['sets']['hits']['result']['points']) for frame in frames], [3, 1, 3, 3])
        initial = {node['id']: node for node in frames[0]['nodes']}
        hidden = {node['id']: node for node in frames[1]['nodes']}
        for name, parameter in [('P', .2), ('Q', .5), ('R', .8)]:
            self.assertAlmostEqual(initial[name]['x'], 100*parameter, delta=1e-5)
            self.assertAlmostEqual(initial[name]['y'], 6*parameter*(1-parameter)*(1-2*parameter), delta=1e-7)
        self.assertEqual(hidden['P']['style']['opacity'], .6)
        self.assertEqual([hidden['Q']['style']['opacity'], hidden['R']['style']['opacity']], [0, 0])
        self.assertEqual([hidden['Q']['x'], hidden['Q']['y']], [0, 0])
        report = frames[0]['intersections']['sets']['hits']['report']
        self.assertEqual(report['solver'], 'adaptive-cubic-v2')
        self.assertEqual(report['cubicPairs'], 1)
        self.assertGreater(report['work'], 0)
        pgf = next(output.glob('runs/compile-*/source/pgf-reference.txt')).read_text().splitlines()
        self.assertEqual(pgf[0], 'count:3')
        for line, parameter in zip(pgf[1:], [.2, .5, .8]):
            x, y = [float(v.removesuffix('pt'))*PT_TO_BP for v in line.split(',')]
            # PGF's two-curve subdivision reference is coarse (about 0.1 bp
            # here). The runtime is checked above against exact analytic roots
            # at 1e-5 bp; PGF independently checks contact count and order.
            self.assertAlmostEqual(x, 100*parameter, delta=.15)
            self.assertAlmostEqual(y, 6*parameter*(1-parameter)*(1-2*parameter), delta=.15)

    def test_curve_solver_handles_nonmatching_parameterizations(self):
        output, _ = self.compile('nonmatching-cubics', r'''
\loomintersections[solver=curves]{hits}{{"a":"param-a","b":"param-b"}}
\loomintersectionpoint[along=a,missing=error]{P}{{"intersections":"hits"}}
''', NONMATCHING_NODES)
        result = samples(output/'bundle.json')[0]
        self.assertNotIn('error', result, result.get('error'))
        frame = result['frame']
        # A(t)=(100t,100t^3), B(u)=(100u^3,100(1-u)).
        # The unique intersection solves u^9+u-1=0, independently by bisection.
        low, high = 0., 1.
        for _ in range(80):
            middle = (low+high)/2
            if middle**9+middle-1 < 0:
                low = middle
            else:
                high = middle
        u = (low+high)/2
        selected = frame['intersections']['selections']['intersection:P']
        point = next(node for node in frame['nodes'] if node['id']=='P')
        self.assertAlmostEqual(point['x'], 100*u**3, delta=1e-5)
        self.assertAlmostEqual(point['y'], 100*(1-u), delta=1e-5)
        self.assertAlmostEqual(selected['incident']['parameterA'], u**3, delta=1e-8)
        self.assertAlmostEqual(selected['incident']['parameterB'], u, delta=1e-8)

    def test_curve_solver_budgets_and_legacy_version_are_not_silent_fallbacks(self):
        output, _ = self.compile('basic-cubic-pair', r'\loomintersections{hits}{{"a":"pair-a","b":"pair-b"}}', PAIR_NODES)
        self.assertIn('INTERSECTION_UNSUPPORTED', samples(output/'bundle.json')[0]['error'])
        output, _ = self.compile('exhausted-cubic-pair', r'\loomintersections[solver=curves,max-work=1]{hits}{{"a":"param-a","b":"param-b"}}', NONMATCHING_NODES)
        self.assertIn('INTERSECTION_BUDGET', samples(output/'bundle.json')[0]['error'])
        output, _ = self.compile('dynamic-cubic-budget', r'\loomintersections[solver=curves]{hits}{{"a":"pair-a","b":"pair-b","maxWork":"65536+time/2s"}}', PAIR_NODES)
        results = samples(output/'bundle.json', (0, 1))
        self.assertIn('frame', results[0], results[0])
        self.assertIn('INTERSECTION_BUDGET', results[1]['error'])


if __name__ == '__main__':
    unittest.main()
