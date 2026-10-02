"""Real TeX field capture, stable sidecars and shared runtime validation."""
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
from field_capture import lower_fields, FieldCaptureDiagnostic


def document(body):
    return r'''\documentclass{article}
\usepackage{texloom-fields}
\begin{document}
\TLScene{Curve fields}{240}{160}{2}
\TLNode{curve}{path}{"d":"M20 80L220 80","geometry":{"contours":[{"id":"c","start":[20,80],"segments":[{"id":"s","kind":"line","to":[220,80]}]}]},"style":{"stroke":"#31505C"}}
\TLNode{P0}{point}{"x":0,"y":0,"r":3}
\TLNode{P1}{point}{"x":0,"y":0,"r":3}
''' + body + '\n\\end{document}\n'


VALID = r'''
\loomparameter[unit=bp,min=0,max=20]{amplitude}{10}
\loomdomain{samples}{curve}{curve-sample}{[{"id":"start","parameter":0},{"id":"end","parameter":1}]}
\loomfield[position=original]{rest}{samples}{capture}{position}
\loomfield{shift}{samples}{setPosition}{position + vec2(0bp,amplitude*sin(1rad*time/1s))}
\loomfield{moved}{samples}{evaluate}{position}
\loomfield{size}{samples}{evaluate}{3bp + 2bp*index}
\loomfield{color}{samples}{evaluate}{parameter}
\loomfieldbind{samples}{moved}{position}{[{"element":"start","target":"P0"},{"element":"end","target":"P1"}]}
\loomfieldbind{samples}{size}{r}{[{"element":"start","target":"P0"},{"element":"end","target":"P1"}]}
\loomfieldbind[from=31505C,to=71DFC2]{samples}{color}{style.fill}{[{"element":"start","target":"P0"},{"element":"end","target":"P1"}]}
'''


class FieldCompilerTests(unittest.TestCase):
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
        run = subprocess.run(['latex', '-no-shell-escape', '-interaction=nonstopmode', '-halt-on-error', 'scene.tex'],
                             cwd=folder, env=env, capture_output=True, text=True, encoding='utf8', errors='replace')
        self.assertEqual(run.returncode, 0, run.stdout[-5000:] + run.stderr)
        records = [json.loads(line) for line in (folder / 'scene.tl.jsonl').read_text(encoding='utf8').splitlines()]
        return folder, records, {'version': '0.1'}

    def test_literal_multiline_expression_capture_preserves_specials_and_span(self):
        expression = '\n  position + \\undefinedmacro + "quoted" % # ## ^^M &&\n  vec2(0bp,1bp)\n'
        folder, records, bundle = self.capture('literal', '\\loomfield{test}{samples}{evaluate}{' + expression + '}')
        lower_fields(records, bundle, folder, folder)
        operation = bundle['fields']['operations'][0]
        self.assertEqual(operation['expression'], expression)
        self.assertEqual(operation['sourceSpan']['file'], 'field-sources/scene.tl-field-1.body.txt')
        self.assertEqual(operation['sourceSpan']['end'], {'line': 4, 'column': 1})
        self.assertEqual((folder / operation['sourceSpan']['file']).read_text(encoding='utf8'), expression + '\n')
        declaration = next(r for r in records if r['type'] == 'field-program-file')
        self.assertEqual(set(declaration), {'type', 'kind', 'file'})

    def test_domain_and_binding_metadata_keep_explicit_stable_ids(self):
        folder, records, bundle = self.capture('domains', VALID + '\n\\loomdomain{controls}{curve}{path-control}{[]}')
        lower_fields(records, bundle, folder, folder)
        program = bundle['fields']
        self.assertEqual(bundle['version'], '0.3')
        self.assertEqual(program['domains'][0]['samples'], [{'id': 'start', 'parameter': 0}, {'id': 'end', 'parameter': 1}])
        self.assertEqual(program['domains'][1], {'id': 'controls', 'geometry': 'curve', 'domain': 'path-control'})
        self.assertEqual(program['operations'][0]['position'], 'original')
        self.assertEqual(program['bindings'][-1]['ramp'], {'from': '#31505C', 'to': '#71DFC2'})
        self.assertEqual(program['bindings'][0]['targets'][0], {'element': 'start', 'target': 'P0'})

    def test_invalid_capture_options_and_json_are_not_silently_repaired(self):
        cases = [
            ('bad-json', r'\loomdomain{samples}{curve}{curve-sample}{[{"id":"a","parameter":NaN}]}', 'nonfinite'),
            ('duplicates', r'\loomdomain{samples}{curve}{curve-sample}{[{"id":"a","id":"b","parameter":0}]}', 'Duplicate JSON key'),
            ('controls', r'\loomdomain{controls}{curve}{path-control}{[{"id":"a","parameter":0}]}', 'samples must be'),
            ('option', r'\loomfield[position=rest]{test}{samples}{capture}{position}', 'current or original'),
            ('ramp', r'\loomfieldbind[from=red,to=00FF00]{samples}{color}{style.fill}{[]}', 'six hexadecimal'),
        ]
        for name, body, message in cases:
            with self.subTest(name=name):
                folder, records, bundle = self.capture(name, body)
                with self.assertRaisesRegex(FieldCaptureDiagnostic, message):
                    lower_fields(records, bundle, folder, folder)

    def test_full_real_tex_compiles_are_repeatable_with_exact_archived_sources(self):
        source = self.folder / 'repeat.tex'
        source.write_text(document(VALID), encoding='utf8')
        outputs = [self.folder / 'repeat-one', self.folder / 'repeat-two']
        bundles = [compile_scene(source, output) for output in outputs]
        self.assertEqual(bundles[0]['fields'], bundles[1]['fields'])
        self.assertEqual({k: v for k, v in bundles[0].items() if k != 'provenance'},
                         {k: v for k, v in bundles[1].items() if k != 'provenance'})
        for output, bundle in zip(outputs, bundles):
            self.assertEqual(bundle['expressions']['parameters']['amplitude']['unit'], 'bp')
            for declaration in bundle['fields']['operations'] + bundle['fields']['bindings']:
                archived = output / declaration['sourceSpan']['file']
                original = next(output.glob('runs/compile-*/source/' + archived.name))
                self.assertEqual(archived.read_bytes(), original.read_bytes())
                self.assertNotIn('compile-', declaration['sourceSpan']['file'])

    def test_unknown_field_expression_reaches_shared_validator(self):
        source = self.folder / 'unknown.tex'
        source.write_text(document(VALID.replace('3bp + 2bp*index', 'unknown_field + 1bp')), encoding='utf8')
        with self.assertRaisesRegex(CompileDiagnostic, 'unknown_field'):
            compile_scene(source, self.folder / 'unknown-out')

    def test_loading_package_without_declarations_preserves_existing_bundle_shape(self):
        source = self.folder / 'empty.tex'
        # A genuinely v0.1 scene has no v0.3 editable geometry requirement.
        body = '\n'.join(line for line in document('').splitlines() if not line.startswith('\\TLNode{curve}')) + '\n'
        source.write_text(body, encoding='utf8')
        bundle = compile_scene(source, self.folder / 'empty-out')
        self.assertEqual(bundle['version'], '0.1')
        self.assertNotIn('fields', bundle)
        self.assertNotIn('expressions', bundle)


if __name__ == '__main__':
    unittest.main()
