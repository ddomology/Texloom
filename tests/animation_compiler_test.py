"""Executed TeX composition lowered by the shared TypeScript timeline compiler."""
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
from tests.intersection_compiler_test import samples, without_provenance


NODES = r'''
\TLNode{A}{point}{"x":0,"y":0,"r":2}
\TLNode{B}{point}{"x":0,"y":0,"r":2}
\TLNode{G}{group}{"transform":{"translate":[0,0]}}
'''


def document(body='', packages='texloom-animation', duration=8):
    return ('\\documentclass{article}\n\\usepackage{' + packages + '}\n' +
            '\\begin{document}\n\\TLScene{Animation test}{500}{350}{' + str(duration) + '}\n' +
            NODES + body + '\n\\end{document}\n')


COMPOSITION = r'''
\begin{loomanimation}[origin=0.5]
  \loomcue{opening}
  \loomtween[id=move,duration=1]{A}{x}|{"to":10}|
  \begin{loomparallel}[id=stage]
    \loomtween[duration=2]{A}{y}|{"to":20}|
    \begin{loomsequence}
      \loomwait{0.5}
      \loomtween[duration=1,easing=smooth]{B}{x}|{"from":2,"to":12}|
      \loomwait{0.5}
    \end{loomsequence}
  \end{loomparallel}
  \begin{loomstagger}[id=grow]{0.25}
    \loomtween[duration=1]{A}{r}|{"to":4}|
    \loomtween[duration=1]{B}{r}|{"to":6}|
    \loomtween[duration=0.5]{G}{transform.translate}|{"to":[30,40]}|
  \end{loomstagger}
  \loomsetvalue[id=reset]{A}{x}|30|
  \loomtween[duration=0]{A}{y}|{"to":40}|
  \loomcue{finished}
\end{loomanimation}
'''


class AnimationCompilerTests(unittest.TestCase):
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

    def capture(self, name, body):
        folder = self.folder / name; folder.mkdir()
        (folder / 'scene.tex').write_text(document(body), encoding='utf8')
        env = os.environ.copy(); env['TEXINPUTS'] = str(ROOT / 'tex') + os.pathsep + env.get('TEXINPUTS', '')
        process = subprocess.run(['latex', '-no-shell-escape', '-interaction=nonstopmode', '-halt-on-error', 'scene.tex'],
                                 cwd=folder, env=env, capture_output=True, text=True, encoding='utf8', errors='replace')
        self.assertEqual(process.returncode, 0, process.stdout[-5000:])
        records = [json.loads(line) for line in (folder / 'scene.tl.jsonl').read_text().splitlines()]
        return folder, records

    def records(self, name, declarations):
        folder = self.folder / name; folder.mkdir(); records = []
        for index, (kind, fields) in enumerate(declarations, 1):
            base = f'scene.tl-animation-{index}'
            for field, value in fields.items():
                (folder / f'{base}.{field}.txt').write_text(value + '\n', encoding='utf8')
            records.append({'type': 'animation-file', 'kind': kind, 'file': base})
        return folder, records

    def test_real_tex_nested_composition_exact_boundaries_and_seek(self):
        output, bundle = self.compile('nested', document(COMPOSITION))
        metadata = bundle['timeline']
        self.assertEqual(bundle['version'], '0.3')
        self.assertEqual(metadata['origin'], .5); self.assertEqual(metadata['duration'], 4.25)
        self.assertEqual({cue['name']: cue['time'] for cue in metadata['cues']}, {'opening': .5, 'finished': 4.75})
        clips = {clip['id']: clip for clip in metadata['clips']}
        self.assertEqual((clips['move']['start'], clips['move']['end']), (.5, 1.5))
        self.assertEqual((clips['reset']['start'], clips['reset']['end']), (4.75, 4.75))
        self.assertEqual(len(metadata['clips']), 8)
        times = [0, .5, 1, 1.5, 2, 2.5, 3.5, 4, 4.25, 4.75, 8, 1]
        results = samples(output / 'bundle.json', times)
        self.assertTrue(all('frame' in result for result in results), results)
        self.assertEqual(results[2]['frame'], results[-1]['frame'])
        by_time = {time: {node['id']: node for node in result['frame']['nodes']} for time, result in zip(times, results)}
        for time in times:
            want_x = 0 if time <= .5 else (10*(time-.5) if time < 1.5 else (10 if time < 4.75 else 30))
            want_y = 0 if time <= 1.5 else (10*(time-1.5) if time < 3.5 else (20 if time < 4.75 else 40))
            self.assertAlmostEqual(by_time[time]['A']['x'], want_x)
            self.assertAlmostEqual(by_time[time]['A']['y'], want_y)
        self.assertEqual(by_time[2.5]['B']['x'], 7)
        self.assertEqual(by_time[4]['A']['r'], 3)
        self.assertEqual(by_time[4]['B']['r'], 3)
        self.assertEqual(by_time[4.25]['G']['transform']['translate'], [15, 20])
        for clip in metadata['clips']:
            self.assertTrue((output / clip['sourceSpan']['file']).is_file())
        program = json.loads((output / 'animation-sources' / 'program.json').read_text())
        self.assertEqual(program['root']['children'][2]['kind'], 'parallel')
        self.assertEqual(program['root']['children'][3]['lag'], .25)

    def test_verbatim_values_group_structure_and_strict_capture_errors(self):
        literal = '{"to":4,"from":2}'
        body = ('\\begin{loomanimation}[origin=0.5]\n\\begin{loomparallel}[id=stage]\n' +
                '\\loomtween[duration=1,easing=smooth,id=clip]{A}{x}|' + literal + '|\n' +
                '\\loomsetvalue{G}{transform.translate}|[12,24]|\n\\end{loomparallel}\n\\end{loomanimation}')
        folder, records = self.capture('capture', body)
        first = capture_animation(records, folder, folder); second = capture_animation(copy.deepcopy(records), folder, folder)
        self.assertEqual(first, second)
        tween, setter = first['root']['children'][0]['children']
        self.assertEqual(tween['from'], 2); self.assertEqual(tween['to'], 4)
        self.assertEqual(setter['value'], [12, 24])
        self.assertEqual((folder / tween['sourceSpan']['file']).read_text(), literal + '\n')
        hostile = '{"to":4,"extra":"\\\\macro % # ## ^^M ^^J"}'
        folder, records = self.capture('literal', '\\begin{loomanimation}\n\\loomtween{A}{x}|' + hostile + '|\n\\end{loomanimation}')
        actual = next(folder.glob('*.values.txt')).read_text()
        self.assertEqual(actual, hostile + '\n')
        with self.assertRaisesRegex(AnimationCaptureDiagnostic, 'optional from only'):
            capture_animation(records, folder, folder)
        begin = ('begin', {'group': 'animation', 'options': ''}); end = ('end', {'group': 'animation'})
        tween = {'target': 'A', 'property': 'x', 'options': '', 'values': '{"to":2}'}
        cases = [
            ('outside', [('wait', {'duration': '1'})], 'inside loomanimation'),
            ('unclosed', [begin], 'Unclosed'),
            ('mismatch', [begin, ('end', {'group': 'parallel'})], 'Mismatched'),
            ('two-roots', [begin, end, begin, end], 'Exactly one'),
            ('nested-root', [begin, begin, end, end], 'Exactly one'),
            ('option', [begin, ('tween', {**tween, 'options': 'unexpected=1'}), end], 'Unknown'),
            ('duplicate-option', [begin, ('tween', {**tween, 'options': 'duration=1,duration=2'}), end], 'Duplicate'),
            ('negative', [begin, ('wait', {'duration': '-1'}), end], 'nonnegative'),
            ('duration-bool', [begin, ('wait', {'duration': 'true'}), end], 'nonnegative'),
            ('easing', [begin, ('tween', {**tween, 'options': 'easing=elastic'}), end], 'easing'),
            ('duplicate-json', [begin, ('tween', {**tween, 'values': '{"to":2,"to":3}'}), end], 'Duplicate JSON'),
            ('nan', [begin, ('tween', {**tween, 'values': '{"to":NaN}'}), end], 'nonfinite'),
            ('infinite', [begin, ('tween', {**tween, 'values': '{"to":1e309}'}), end], 'finite numeric'),
            ('huge-integer', [begin, ('tween', {**tween, 'values': '{"to":' + '1' + '0'*400 + '}'}), end], 'finite numeric'),
            ('null-vector', [begin, ('tween', {**tween, 'values': '{"to":[1,null]}'}), end], 'finite numeric'),
        ]
        for name, declarations, message in cases:
            with self.subTest(name=name):
                folder, records = self.records(name, declarations)
                with self.assertRaisesRegex(AnimationCaptureDiagnostic, message):
                    capture_animation(records, folder, folder)

    def test_shared_compiler_owns_conflicts_invalid_destinations_and_duration(self):
        cases = [
            ('overlap', r'''\begin{loomanimation}\begin{loomparallel}
\loomtween[id=first,duration=2]{A}{x}|{"to":10}|
\loomtween[id=second,duration=1]{A}{x}|{"to":20}|
\end{loomparallel}\end{loomanimation}''', 'conflict'),
            ('missing', r'''\begin{loomanimation}\loomtween{missing}{x}|{"to":2}|\end{loomanimation}''', 'missing'),
            ('extent', r'''\begin{loomanimation}[origin=7]\loomtween[duration=2]{A}{x}|{"to":2}|\end{loomanimation}''', 'duration'),
            ('vector', r'''\begin{loomanimation}\loomtween{A}{x}|{"to":[1,2]}|\end{loomanimation}''', 'shape'),
        ]
        for name, body, expected in cases:
            with self.subTest(name=name):
                with self.assertRaises((AnimationCaptureDiagnostic, CompileDiagnostic)) as caught:
                    self.compile(name, document(body))
                self.assertIn('timeline', str(caught.exception).lower())
                self.assertIn(expected, str(caught.exception).lower())
                self.assertFalse((self.folder / (name + '-out') / 'bundle.json').exists())
        # Schedule errors are generated by the shared TS compiler, with the
        # captured source of both conflicting commands retained in diagnostics.
        source = self.folder / 'overlap-out' / 'animation-sources'
        self.assertEqual(len(list(source.glob('*.values.txt'))), 2)

    def test_unused_package_is_noop_and_tikz_style_command_survives(self):
        canonical = []
        for packages in ('texloom-expressions', 'texloom-animation'):
            _, bundle = self.compile('unused', document(packages=packages))
            self.assertEqual(bundle['version'], '0.1'); self.assertNotIn('timeline', bundle)
            self.assertEqual(bundle['tracks'], [])
            canonical.append(without_provenance(bundle))
        self.assertEqual(canonical[0], canonical[1])
        # Both package load orders keep loomset as TikZ style configuration.
        for order, packages in enumerate(('texloom-tikz,texloom-animation', 'texloom-animation,texloom-tikz')):
            body = r'''\loomset{teststyle/.style={draw=blue}}
\begin{loomanimation}\loomsetvalue{A}{x}|12|\end{loomanimation}'''
            output, bundle = self.compile('styles-' + str(order), document(body, packages))
            result = samples(output / 'bundle.json')[0]
            self.assertIn('frame', result)
            self.assertEqual(next(node for node in result['frame']['nodes'] if node['id'] == 'A')['x'], 12)


if __name__ == '__main__':
    unittest.main()
