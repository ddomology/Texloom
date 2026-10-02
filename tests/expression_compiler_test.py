"""Real TeX capture and compiler checks for the explicit expression frontend."""
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
from expression_capture import lower_expressions, ExpressionCaptureDiagnostic


def document(body):
    return ('\\documentclass{article}\n\\usepackage{texloom-expressions}\n'
            '\\begin{document}\n\\TLScene{Expressions}{240}{160}{2}\n'
            '\\TLNode{P}{point}{"x":0,"y":0,"r":3}\n' + body +
            '\n\\end{document}\n')


class ExpressionCompilerTests(unittest.TestCase):
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
        run = subprocess.run(['latex', '-no-shell-escape', '-interaction=nonstopmode',
                              '-halt-on-error', 'scene.tex'], cwd=folder, env=env,
                             capture_output=True, text=True, encoding='utf8', errors='replace')
        self.assertEqual(run.returncode, 0, run.stdout[-5000:] + run.stderr)
        records = [json.loads(line) for line in (folder / 'scene.tl.jsonl').read_text(encoding='utf8').splitlines()]
        bundle = {'version': '0.1'}
        return folder, records, bundle

    def test_verbatim_specials_and_macros_are_not_expanded_or_json_interpolated(self):
        text = r'"quoted" + \undefinedmacro + % # ## && ^ ^^M ^^J $ < > !='
        folder, records, bundle = self.capture('literal', '\\loomexpr{P}{x}{' + text + '}')
        lower_expressions(records, bundle, folder, folder)
        binding = bundle['expressions']['bindings'][0]
        self.assertEqual(binding['expression'], text)
        self.assertEqual(binding['sourceSpan']['start'], {'line': 1, 'column': 1})
        self.assertEqual(binding['sourceSpan']['end'], {'line': 1, 'column': len(text) + 1})
        self.assertTrue((folder / binding['sourceSpan']['file']).is_file())
        record = next(record for record in records if record['type'] == 'expression-file')
        self.assertEqual(set(record), {'type', 'kind', 'file'})
        self.assertNotIn(text, json.dumps(record))

    def test_multiline_capture_and_source_span_refer_to_archived_text(self):
        text = '\n  vec2(20bp,\n    30bp)\n'
        folder, records, bundle = self.capture('multiline', '\\loomexpr{P}{position}{' + text + '}')
        lower_expressions(records, bundle, folder, folder)
        binding = bundle['expressions']['bindings'][0]
        self.assertEqual(binding['expression'], text)
        self.assertEqual(binding['sourceSpan']['end'], {'line': 4, 'column': 1})
        self.assertEqual((folder / binding['sourceSpan']['file']).read_text(encoding='utf8'), text + '\n')

    def test_writer_accepts_old_raw_cr_and_new_obeyedline_tokens(self):
        # Exercise both historical xparse representations under the installed
        # real TeX engine, independent of which scanner that installation uses.
        folder, records, bundle = self.capture('newline-representations', r'''
\ExplSyntaxOn
\TLEstart{binding}
\TLEmetadata{target}{P}
\TLEmetadata{property}{position}
\exp_args:Nnx \TLEwrite {body}
  {\char_generate:nn{13}{12}vec2(20bp,\char_generate:nn{13}{12}30bp)\char_generate:nn{13}{12}}
\TLEstart{binding}
\TLEmetadata{target}{P}
\TLEmetadata{property}{position}
\TLEwrite{body}{\obeyedline vec2(20bp,\obeyedline 30bp)\obeyedline}
\ExplSyntaxOff
''')
        lower_expressions(records, bundle, folder, folder)
        self.assertEqual(len(bundle['expressions']['bindings']), 2)
        expected = '\nvec2(20bp,\n30bp)\n'
        for binding in bundle['expressions']['bindings']:
            self.assertEqual(binding['expression'], expected)
            self.assertEqual(binding['sourceSpan']['end'], {'line': 4, 'column': 1})
            self.assertEqual((folder / binding['sourceSpan']['file']).read_text(encoding='utf8'), expected + '\n')

    def test_checked_scalar_boolean_and_vector_parameter_declarations(self):
        folder, records, bundle = self.capture('parameters', r'''
\loomparameter[unit=rad,min=-2,max=2]{a}{0.5}
\loomparameter[type=boolean]{enabled}{true}
\loomparameter[type=vec2,unit=bp]{offset}{[12,24]}
''')
        lower_expressions(records, bundle, folder, folder)
        self.assertEqual(bundle['version'], '0.3')
        self.assertEqual(bundle['expressions']['parameters'], {
            'a': {'type': 'scalar', 'unit': 'rad', 'min': -2, 'max': 2, 'default': .5},
            'enabled': {'type': 'boolean', 'default': True},
            'offset': {'type': 'vec2', 'unit': 'bp', 'default': [12, 24]},
        })

    def test_invalid_parameter_and_duplicate_declarations_fail_after_real_capture(self):
        cases = [('badtype', r'\loomparameter[type=scalar]{a}{true}', 'does not match'),
                 ('badbounds', r'\loomparameter[min=2,max=1]{a}{1}', 'min cannot exceed'),
                 ('duplicate', r'\loomparameter{a}{1}\loomparameter{a}{2}', 'Duplicate expression parameter')]
        for name, body, message in cases:
            with self.subTest(name=name):
                folder, records, bundle = self.capture(name, body)
                with self.assertRaisesRegex(ExpressionCaptureDiagnostic, message):
                    lower_expressions(records, bundle, folder, folder)

    def test_full_compiler_routes_units_time_and_power_to_shared_validator(self):
        source = self.folder / 'valid.tex'
        source.write_text(document(r'''
\loomparameter[unit=rad]{a}{0}
\loomexpr{P}{position}{vec2(120bp,80bp - 20bp*sin(a + 1rad*time/1s))}
\loomexpr{P}{style.opacity}{(2^3 >= 8 && true) ? 1 : 0}
'''), encoding='utf8')
        bundle = compile_scene(source, self.folder / 'compiled')
        self.assertEqual(bundle['version'], '0.3')
        self.assertEqual(len(bundle['expressions']['bindings']), 2)
        self.assertIn('&&', bundle['expressions']['bindings'][1]['expression'])
        self.assertTrue((self.folder / 'compiled' / bundle['provenance']['sourceDvi']).exists())

    def test_unknown_symbol_reaches_expression_diagnostic_and_old_sources_stay_unchanged(self):
        source = self.folder / 'unknown.tex'
        source.write_text(document(r'\loomexpr{P}{x}{unknown_value + 1bp}'), encoding='utf8')
        with self.assertRaisesRegex(CompileDiagnostic, 'unknown_value'):
            compile_scene(source, self.folder / 'unknown-out')
        old = self.folder / 'old.tex'
        old.write_text(document(''), encoding='utf8')
        bundle = compile_scene(old, self.folder / 'old-out')
        self.assertEqual(bundle['version'], '0.1')
        self.assertNotIn('expressions', bundle)

    def test_repeat_compiles_preserve_program_and_exact_archived_expression_source(self):
        expression = '\n  vec2(120bp,\n    80bp - 20bp*sin(a + 1rad*time/1s))\n'
        source = self.folder / 'repeat.tex'
        source.write_text(document('\\loomparameter[unit=rad]{a}{0}\n' +
                                   '\\loomexpr{P}{position}{' + expression + '}'), encoding='utf8')
        outputs = [self.folder / 'repeat-one', self.folder / 'repeat-two']
        bundles = [compile_scene(source, output) for output in outputs]
        self.assertEqual(bundles[0]['expressions'], bundles[1]['expressions'])
        self.assertEqual({k: v for k, v in bundles[0].items() if k != 'provenance'},
                         {k: v for k, v in bundles[1].items() if k != 'provenance'})
        for output, bundle in zip(outputs, bundles):
            binding = bundle['expressions']['bindings'][0]
            self.assertEqual(binding['sourceSpan']['file'],
                             'expression-sources/scene.tl-expression-2.body.txt')
            archived = output / binding['sourceSpan']['file']
            self.assertEqual(archived.read_text(encoding='utf8'), expression + '\n')
            original = next(output.glob('runs/compile-*/source/scene.tl-expression-2.body.txt'))
            self.assertEqual(archived.read_bytes(), original.read_bytes())
            self.assertEqual(binding['sourceSpan']['end'], {'line': 4, 'column': 1})


if __name__ == '__main__':
    unittest.main()
