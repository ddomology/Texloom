"""Native TeX authoring of stateless updates and fixed-domain traces."""
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
from relation_capture import lower_relations, validate_relation_targets, RelationCaptureDiagnostic
from tests.intersection_compiler_test import without_provenance


def document(body, package='texloom-relations,texloom-animation,texloom-intersections'):
    return ('\\documentclass{article}\n\\usepackage{'+package+'}\n\\begin{document}\n'
            '\\TLScene{Declarative updates}{400}{300}{4}\n'+body+'\n\\end{document}\n')


BODY = r'''
\loomparameter[unit=bp,min=10,max=60]{amplitude}|20|
\TLNode{P}{point}{"x":80,"y":100,"r":3}
\loomexpr{P}{position}|vec2(80bp+30bp*time/1s,100bp+amplitude*sin(pi*1rad*time/2s))|
\TLNode{chart}{group}{"transform":{"translate":[100,50],"scale":[2,0.5]}}
\loomexpr{chart}{transform.rotate}|0.2rad*time/1s|
\TLText{tag-art}{Point $P$}
\TLNode{tag}{tex}{"resourceId":"tag-art","parent":"chart","x":0,"y":0}
\loomfollow[id=follow-tag]{tag}|{"point":"P","offset":[10,-5]}|
\TLNode{local-copy}{point}{"x":0,"y":0,"r":2}
\loomfollow[space=local:chart]{local-copy}|{"point":[4,6],"offset":[2,-1]}|
\TLNode{expressed}{point}{"x":0,"y":0,"r":2}
\loomfollow{expressed}|{"point":{"expression":"vec2(10bp+time*5bp/1s,30bp)"}}|
\TLNode{arrow}{line}{"parent":"chart","x1":0,"y1":0,"x2":20,"y2":0,"transform":{"scale":[1.4,1]}}
\loomalign[id=align-arrow]{arrow}|{"direction":[1,2]}|
\TLNode{gaze}{line}{"parent":"chart","x1":0,"y1":0,"x2":20,"y2":0}
\loomlookat[id=look-at]{gaze}|{"from":[100,100],"to":"P","fallbackAngle":0.4}|
\TLNode{zero}{line}{"x1":0,"y1":0,"x2":20,"y2":0}
\loomalign{zero}|{"direction":[0,0],"fallbackAngle":0.7}|
\TLNode{trace}{path}{"d":"M0 0","style":{"fill":"none","stroke":"#71dfc2"}}
\loomtrace{trace}|{"source":{"kind":"node","node":"P","property":"position","space":{"kind":"scene"}},"domain":[0,4],"step":0.25,"tolerance":0.1,"maxSamples":4096}|
\TLNode{horizontal}{path}{"d":"M0 200L100 200","geometry":{"contours":[{"id":"line","start":[0,200],"segments":[{"id":"line","kind":"line","to":[100,200]}]}]}}
\TLNode{vertical}{path}{"d":"M40 180L40 220","geometry":{"contours":[{"id":"line","start":[40,180],"segments":[{"id":"line","kind":"line","to":[40,220]}]}]}}
\loomexpr{vertical}{transform.translate}|vec2(100bp*sin(pi*1rad*time/2s),0bp)|
\loomintersections{hits}|{"a":"horizontal","b":"vertical"}|
\TLNode{I}{point}{"x":0,"y":200,"r":3}
\loomintersectionpoint[along=a,missing=hide]{I}|{"intersections":"hits"}|
\TLNode{I-label}{tex}{"resourceId":"tag-art","x":0,"y":0}
\loomfollow{I-label}|{"point":"I","offset":[0,-8]}|
\loomvisibility{I-label}|{"value":{"operation":"intersection:I","socket":"found"}}|
\TLNode{gapped-trace}{path}{"d":"M0 0","style":{"fill":"none","stroke":"#ee8d82"}}
\loomtrace{gapped-trace}|{"source":{"kind":"node","node":"I","property":"position","space":{"kind":"scene"}},"domain":[0,4],"step":0.25,"tolerance":0.1,"maxDepth":10,"maxSamples":4096}|
'''


def evaluate_requests(path, requests):
    script = '''import {readFile} from 'node:fs/promises';import {build} from 'esbuild';
const code=await build({entryPoints:['src/index.ts'],bundle:true,platform:'node',format:'esm',write:false});
const {createEvaluator}=await import('data:text/javascript;base64,'+Buffer.from(code.outputFiles[0].text).toString('base64'));
const evaluate=createEvaluator(JSON.parse(await readFile(process.argv[1],'utf8')));
console.log(JSON.stringify(JSON.parse(process.argv[2]).map(r=>evaluate(r.time,r.parameters))));'''
    result = subprocess.run(['node', '--input-type=module', '-e', script, str(path), json.dumps(requests)],
                            cwd=ROOT, capture_output=True, text=True, encoding='utf8', errors='replace')
    if result.returncode:
        raise AssertionError(result.stderr[-12000:] + result.stdout)
    return json.loads(result.stdout)


class RelationCompilerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.temp.cleanup)
        cls.folder = Path(cls.temp.name)
        source = cls.folder/'updates.tex'; source.write_text(document(BODY), encoding='utf8')
        cls.output = cls.folder/'updates'
        cls.bundle = compile_scene(source, cls.output)

    def test_actual_follow_parent_space_rotation_visibility_and_random_seek(self):
        times = [0, 1, 2, 3, 4, 1]
        frames = evaluate_requests(self.output/'bundle.json', [{'time': t} for t in times])
        self.assertEqual(frames[1], frames[-1])
        for t, frame in zip(times, frames):
            nodes = {node['id']: node for node in frame['nodes']}
            px, py = 80+30*t, 100+20*math.sin(math.pi*t/2)
            phi = .2*t; c, s = math.cos(phi), math.sin(phi)
            tx, ty = nodes['tag']['x'], nodes['tag']['y']
            self.assertAlmostEqual(100+2*c*tx-.5*s*ty, px+10, delta=1e-8)
            self.assertAlmostEqual(50+2*s*tx+.5*c*ty, py-5, delta=1e-8)
            self.assertAlmostEqual(nodes['local-copy']['x'], 100+12*c-2.5*s, delta=1e-8)
            self.assertAlmostEqual(nodes['local-copy']['y'], 50+12*s+2.5*c, delta=1e-8)
            self.assertAlmostEqual(nodes['expressed']['x'], 10+5*t, delta=1e-8)
            expected = math.atan2((-s+2*c)/.5, (c+2*s)/2)
            self.assertAlmostEqual(nodes['arrow']['transform']['rotate'], expected, delta=1e-10)
            dx, dy = px-100, py-100
            expected = math.atan2((-s*dx+c*dy)/.5, (c*dx+s*dy)/2)
            self.assertAlmostEqual(nodes['gaze']['transform']['rotate'], expected, delta=1e-10)
            self.assertEqual(nodes['zero']['transform']['rotate'], .7)
            self.assertEqual(nodes['I-label']['style']['opacity'], 0 if t in (1, 3) else 1)
            self.assertEqual(nodes['I']['style']['opacity'], nodes['I-label']['style']['opacity'])
        report = frames[4]['traces']['trace:gapped-trace']
        self.assertGreater(report['maskedIntervals'], 0)
        self.assertGreater(report['contourCount'], 1)

    def test_trace_partial_history_parameter_regeneration_and_native_archives(self):
        requests = [{'time': 2}, {'time': 2, 'parameters': {'amplitude': 40}}, {'time': 2}, {'time': 4}]
        a, changed, again, full = evaluate_requests(self.output/'bundle.json', requests)
        self.assertEqual(a, again)
        geometry = lambda frame: next(n for n in frame['nodes'] if n['id']=='trace')['geometry']
        self.assertNotEqual(geometry(a), geometry(changed))
        self.assertLess(len(geometry(a)['contours'][0]['segments']), len(geometry(full)['contours'][0]['segments']))
        endpoint = geometry(a)['contours'][-1]['segments'][-1]['to']
        self.assertAlmostEqual(endpoint[0], 140, delta=1e-9)
        self.assertAlmostEqual(endpoint[1], 100, delta=1e-9)
        self.assertEqual(a['traces']['trace:trace']['sampleCount'], full['traces']['trace:trace']['sampleCount'])
        operation = next(op for op in self.bundle['operationGraph']['operations'] if op['id']=='follow-tag')
        self.assertEqual((self.output/operation['sourceSpan']['file']).read_text(), '{"point":"P","offset":[10,-5]}\n')
        trace = self.bundle['traces']['operations'][0]
        self.assertEqual(trace['seed'], 0)
        self.assertEqual(trace['missing'], 'break')
        self.assertTrue((self.output/trace['sourceSpan']['file']).is_file())

    def test_verbatim_tex_capture_archives_literal_expression_characters(self):
        folder = self.folder/'verbatim'; folder.mkdir()
        expression = '\n 1 + \\macro{#1} + "quote" % ## ^^M &&\n'
        literal = json.dumps({'value': expression}, indent=2)
        (folder/'scene.tex').write_text(document('\\loomvisibility{P}|'+literal+'|'), encoding='utf8')
        env = os.environ.copy(); env['TEXINPUTS'] = str(ROOT/'tex')+os.pathsep+env.get('TEXINPUTS', '')
        result = subprocess.run(['latex', '-no-shell-escape', '-interaction=nonstopmode', '-halt-on-error', 'scene.tex'],
                                cwd=folder, env=env, capture_output=True, text=True, encoding='utf8', errors='replace')
        self.assertEqual(result.returncode, 0, result.stdout[-5000:])
        records = [json.loads(line) for line in (folder/'scene.tl.jsonl').read_text().splitlines()]
        bundle = {'version':'0.1', 'nodes':[]}
        lower_relations(records, bundle, folder, folder)
        operation = bundle['operationGraph']['operations'][0]
        ref = operation['inputs']['value']
        self.assertEqual(ref['expression'], expression)
        self.assertEqual((folder/ref['sourceSpan']['file']).read_text(), expression+'\n')
        self.assertEqual((folder/operation['sourceSpan']['file']).read_text(), literal+'\n')

    def test_strict_capture_and_fixed_axis_guard(self):
        folder = self.folder/'bad'; folder.mkdir()
        record = {'type':'relation-file','kind':'followPoint','file':'scene.tl-relation-1'}
        (folder/'scene.tl-relation-1.target.txt').write_text('P\n')
        (folder/'scene.tl-relation-1.options.txt').write_text('\n')
        for body, message in [('{"point":"A","point":"B"}', 'Duplicate'), ('{"point":[1e309,0]}','nonfinite'),
                              ('{"point":"P","callback":"code"}', 'Unknown'), ('[]','JSON object'),
                              ('{}','Missing'), ('{"point":"P","offset":null}', 'finite vector')]:
            with self.subTest(body=body):
                (folder/'scene.tl-relation-1.inputs.txt').write_text(body+'\n')
                with self.assertRaisesRegex(RelationCaptureDiagnostic, message) as caught:
                    lower_relations([record], {'version':'0.1'}, folder, folder)
                self.assertTrue((folder/caught.exception.sourceSpan['file']).is_file())
        guard = [{'target':'arrow','sourceSpan':{'file':'authored.json'}}]
        for scale, writers in [([-1,1],[]), ([1,1],[{'target':'arrow','property':'transform.scale'}]),
                               ([1,1],[{'target':'arrow','property':'transform'}])]:
            with self.subTest(scale=scale, writers=writers):
                with self.assertRaises(RelationCaptureDiagnostic):
                    validate_relation_targets(guard, {'nodes':[{'id':'arrow','transform':{'scale':scale}}], 'tracks':writers})
        trace = {'source':{'kind':'node','node':'P','property':'position','space':{'kind':'scene'}},
                 'domain':[0,4], 'step':.25}
        record['kind'] = 'trace'
        for field, value in [('seed',1), ('seed',True), ('version',2), ('source',{'callback':'code'})]:
            with self.subTest(field=field, value=value):
                (folder/'scene.tl-relation-1.inputs.txt').write_text(json.dumps({**trace,field:value})+'\n')
                with self.assertRaises(RelationCaptureDiagnostic):
                    lower_relations([record], {'version':'0.1'}, folder, folder)

    def test_unused_package_is_noop_and_repeat_lowering_does_not_retain_traces(self):
        path, output = self.folder/'reuse.tex', self.folder/'reuse'
        body = '\\TLNode{P}{point}{"x":1,"y":2,"r":3}'
        path.write_text(document(body, 'texloom'), encoding='utf8')
        bare = compile_scene(path, output)
        path.write_text(document(body, 'texloom-relations'), encoding='utf8')
        unused = compile_scene(path, output)
        self.assertEqual(without_provenance(bare), without_provenance(unused))
        self.assertEqual(unused['version'], '0.1')
        self.assertNotIn('traces', unused)
        self.assertNotIn('operationGraph', unused)
        self.assertIn('traces', json.loads((self.output/'bundle.json').read_text()))
        source = self.folder/'updates.tex'
        source.write_text(document(body, 'texloom-relations'), encoding='utf8')
        removed = compile_scene(source, self.output)
        self.assertEqual(removed['version'], '0.1')
        self.assertNotIn('traces', removed)
        self.assertNotIn('operationGraph', removed)


if __name__ == '__main__':
    unittest.main()
