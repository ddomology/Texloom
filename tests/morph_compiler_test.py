"""Real TeX geometry transitions with immutable templates and shared timing."""
import copy
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
from animation_capture import capture_animation, AnimationCaptureDiagnostic
from tests.intersection_compiler_test import samples


LINE = {'contours': [{'id': 'line', 'start': [0, 0], 'segments': [{'id': 'edge', 'kind': 'line', 'to': [60, 0]}]}]}
CURVE = {'contours': [{'id': 'curve', 'start': [0, 0], 'segments': [
    {'id': 'bend', 'kind': 'cubic', 'c1': [20, -30], 'c2': [40, 30], 'to': [60, 0]}]}]}
MAPPING = {'approved': True, 'contours': [{'source': 'line', 'target': 'curve',
                                        'segments': [{'source': 'edge', 'target': 'bend'}]}], 'unmatched': 'error'}


def node(name, geometry, **properties):
    value = {'d': 'M0 0', 'geometry': geometry, 'visible': False, 'style': {'stroke': '#ffffff', 'fill': 'none'}, **properties}
    return '\\TLNode{' + name + '}{path}{' + json.dumps(value)[1:-1] + '}\n'


def document(body='', duration=6):
    return ('\\documentclass{article}\n\\usepackage{texloom-animation}\n\\begin{document}\n' +
            '\\TLScene{Morph test}{500}{350}{' + str(duration) + '}\n' + body + '\n\\end{document}\n')


def morph(source='S', destination='D', instance='transition', options=None, duration=2):
    return ('\\loommorph[id=' + instance + ',duration=' + str(duration) + ']{' + source + '}{' + destination + '}|' +
            json.dumps(MAPPING if options is None else options) + '|\n')


class MorphCompilerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(); cls.folder = Path(cls.temp.name)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def compile(self, name, body):
        source = self.folder / (name + '.tex'); source.write_text(document(body), encoding='utf8')
        output = self.folder / (name + '-out')
        return output, compile_scene(source, output)

    def capture(self, name, body):
        folder = self.folder / name; folder.mkdir()
        (folder / 'scene.tex').write_text(document(body), encoding='utf8')
        env = os.environ.copy(); env['TEXINPUTS'] = str(ROOT / 'tex') + os.pathsep + env.get('TEXINPUTS', '')
        process = subprocess.run(['latex', '-no-shell-escape', '-interaction=nonstopmode', '-halt-on-error', 'scene.tex'],
                                 cwd=folder, env=env, capture_output=True, text=True, encoding='utf8', errors='replace')
        self.assertEqual(process.returncode, 0, process.stdout[-5000:])
        records = [json.loads(line) for line in (folder / 'scene.tl.jsonl').read_text().splitlines()]
        return folder, records

    def test_real_tex_morph_clone_enter_exit_and_random_seek(self):
        body = r'\TLNode{parent}{group}{"transform":{"translate":[10,20]}}' + '\n'
        body += node('S', LINE, parent='parent', transform={'translate': [5, 6]})
        body += node('D', CURVE, transform={'translate': [999, 999]})
        body += '\\begin{loomanimation}[origin=0.5]\n\\loomclone[id=copy]{S}\n\\begin{loomparallel}\n'
        body += morph()
        body += r'''
\begin{loomsequence}
  \loomenter[duration=0.5]{copy}
  \loomtween[duration=1]{copy}{transform.translate}|{"to":[80,30]}|
  \loomexit[duration=0.5,mode=create]{copy}
\end{loomsequence}
\end{loomparallel}
\loomexit[duration=0.5]{transition}
\loomcue{done}
\end{loomanimation}
'''
        output, bundle = self.compile('composition', body)
        self.assertEqual(bundle['timeline']['end'], 3)
        self.assertEqual({cue['name']: cue['time'] for cue in bundle['timeline']['cues']}, {'done': 3})
        authored = {item['id']: item for item in bundle['nodes']}
        self.assertEqual(authored['S']['geometry'], LINE); self.assertEqual(authored['D']['geometry'], CURVE)
        self.assertEqual(authored['transition']['parent'], 'parent')
        self.assertEqual(authored['transition']['transform']['translate'], [5, 6])
        times = [0, .5, 1, 1.5, 2, 2.5, 3, 1.5]
        results = samples(output / 'bundle.json', times)
        self.assertTrue(all('frame' in result for result in results), results)
        self.assertEqual(results[3]['frame'], results[-1]['frame'])
        frames = {time: {item['id']: item for item in result['frame']['nodes']} for time, result in zip(times, results)}
        self.assertEqual(frames[.5]['transition:shape']['geometry'], LINE)
        self.assertEqual(frames[2.5]['transition:shape']['geometry'], CURVE)
        control = frames[1.5]['transition:shape']['geometry']['contours'][0]['segments'][0]
        self.assertEqual(control['kind'], 'cubic'); self.assertEqual(control['c1'], [20, -15]); self.assertEqual(control['c2'], [40, 15])
        self.assertEqual(frames[1.5]['copy']['transform']['translate'], [42.5, 18])
        self.assertEqual(frames[2.5]['copy']['reveal'], 0)
        self.assertEqual(frames[3]['transition']['style']['opacity'], 0)
        for frame in frames.values():
            self.assertEqual(frame['S']['geometry'], LINE); self.assertEqual(frame['D']['geometry'], CURVE)
            self.assertFalse(frame['S']['visible']); self.assertFalse(frame['D']['visible'])
        program = json.loads((output / 'animation-sources' / 'program.json').read_text())
        transition = program['root']['children'][1]['children'][0]
        self.assertEqual(transition['source'], 'S'); self.assertEqual(transition['destination'], 'D')
        self.assertEqual((output / transition['sourceSpan']['file']).read_text(), json.dumps(MAPPING) + '\n')

    def test_real_tex_resampling_and_unmatched_fade_create(self):
        source = copy.deepcopy(LINE); source['contours'].append({'id': 'old', 'start': [0, 20], 'segments': [{'id': 'old-edge', 'kind': 'line', 'to': [60, 20]}]})
        target = copy.deepcopy(CURVE); target['contours'].append({'id': 'new', 'start': [0, -20], 'segments': [{'id': 'new-edge', 'kind': 'line', 'to': [60, -20]}]})
        polyline = {'contours': [{'id': 'poly', 'start': [0, 0], 'segments': [
            {'id': 'first', 'kind': 'line', 'to': [30, -20]}, {'id': 'second', 'kind': 'line', 'to': [60, 0]}]}]}
        body = node('S', LINE) + node('D', polyline) + node('multi-source', source) + node('multi-target', target)
        body += '\\begin{loomanimation}\n\\begin{loomparallel}\n'
        body += morph(instance='resampled', options={'approved': True, 'contours': [{'source': 'line', 'target': 'poly'}],
                                                   'resample': {'count': 9, 'tolerance': .02}}, duration=1)
        for policy in ('fade', 'create'):
            body += morph('multi-source', 'multi-target', policy, {**MAPPING, 'unmatched': policy}, 1)
        body += '\\end{loomparallel}\n\\end{loomanimation}'
        output, bundle = self.compile('policies', body)
        results = samples(output / 'bundle.json', (0, .5, 1))
        self.assertTrue(all('frame' in result for result in results), results)
        frames = [{item['id']: item for item in result['frame']['nodes']} for result in results]
        self.assertEqual(frames[0]['resampled:shape']['geometry'], LINE)
        self.assertEqual(frames[2]['resampled:shape']['geometry'], polyline)
        self.assertEqual(len(frames[1]['resampled:shape']['geometry']['contours'][0]['segments']), 8)
        for part in ('leaving', 'entering'):
            self.assertEqual(frames[1]['fade:' + part]['style']['opacity'], .5)
            self.assertEqual(frames[1]['create:' + part]['reveal'], .5)

    def test_new_commands_literal_capture_and_frontend_errors(self):
        literal = json.dumps(MAPPING)
        body = '\\begin{loomanimation}\n' + morph() + r'''
\loomclone[id=copy]{S}
\loomenter[duration=0.5,easing=smooth,mode=create,id=entry]{copy}
\loomexit[duration=0.25,mode=fade]{copy}
\end{loomanimation}
'''
        folder, records = self.capture('capture', body)
        program = capture_animation(records, folder, folder)
        self.assertEqual(program, capture_animation(copy.deepcopy(records), folder, folder))
        nodes = program['root']['children']
        self.assertEqual([n['kind'] for n in nodes], ['morph', 'clone', 'enter', 'exit'])
        self.assertEqual(nodes[0]['correspondence'], MAPPING)
        self.assertEqual((folder / nodes[0]['sourceSpan']['file']).read_text(), literal + '\n')
        self.assertNotIn('duration', nodes[1]); self.assertEqual(nodes[2]['mode'], 'create')
        begin = {'type': 'animation-file', 'kind': 'begin', 'file': 'scene.tl-animation-1'}
        end = {'type': 'animation-file', 'kind': 'end', 'file': 'scene.tl-animation-3'}
        cases = [
            ('missing-morph-id', 'morph', {'options': '', 'source': 'S', 'destination': 'D', 'correspondence': literal}, 'explicit instance'),
            ('missing-clone-id', 'clone', {'options': '', 'source': 'S'}, 'explicit instance'),
            ('clone-duration', 'clone', {'options': 'id=copy,duration=1', 'source': 'S'}, 'Unknown'),
            ('bad-mode', 'enter', {'options': 'mode=unknown', 'target': 'S'}, 'fade or create'),
            ('bad-policy-array', 'morph', {'options': 'id=M', 'source': 'S', 'destination': 'D', 'correspondence': '[]'}, 'JSON object'),
            ('duplicate-policy', 'morph', {'options': 'id=M', 'source': 'S', 'destination': 'D', 'correspondence': '{"approved":true,"approved":false}'}, 'Duplicate JSON'),
            ('overflow-policy', 'morph', {'options': 'id=M', 'source': 'S', 'destination': 'D', 'correspondence': '{"resample":{"count":1e309}}'}, 'nonfinite'),
        ]
        for name, kind, fields, expected in cases:
            with self.subTest(name=name):
                folder = self.folder / name; folder.mkdir()
                for index, values in [(1, {'group': 'animation', 'options': ''}), (2, fields), (3, {'group': 'animation'})]:
                    for field, text in values.items():
                        (folder / f'scene.tl-animation-{index}.{field}.txt').write_text(text + '\n', encoding='utf8')
                declarations = [begin, {'type': 'animation-file', 'kind': kind, 'file': 'scene.tl-animation-2'}, end]
                with self.assertRaisesRegex(AnimationCaptureDiagnostic, expected):
                    capture_animation(declarations, folder, folder)

    def test_shared_compiler_rejects_unapproved_unknown_and_colliding_instances(self):
        cases = [
            ('unapproved', {**MAPPING, 'approved': False}, 'transition', 'approval'),
            ('unknown-field', {**MAPPING, 'callback': 'animate()'}, 'transition', 'unknown'),
            ('duplicate-contour', {**MAPPING, 'contours': MAPPING['contours']*2}, 'transition', 'duplicate'),
            ('id-collision', MAPPING, 'S', 'distinct'),
        ]
        for name, policy, instance, expected in cases:
            with self.subTest(name=name):
                body = node('S', LINE) + node('D', CURVE) + '\\begin{loomanimation}\n'
                body += morph(instance=instance, options=policy) + '\\end{loomanimation}'
                with self.assertRaises((AnimationCaptureDiagnostic, CompileDiagnostic)) as caught:
                    self.compile(name, body)
                message = str(caught.exception).lower()
                self.assertIn(expected, message)
                self.assertIn('animation-sources/', message)
                self.assertFalse((self.folder / (name + '-out') / 'bundle.json').exists())


if __name__ == '__main__':
    unittest.main()
