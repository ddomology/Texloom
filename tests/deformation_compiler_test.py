"""Real TeX deformation capture, deterministic sources and shared validation."""
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
from deformation_capture import lower_deformations, DeformationCaptureDiagnostic


def document(body):
    return r'''\documentclass{article}
\usepackage{texloom-geometry}
\begin{document}
\TLScene{Curve deformation}{240}{160}{2}
\TLNode{source}{path}{"d":"M20 80C80 80 160 80 220 80","geometry":{"contours":[{"id":"c","start":[20,80],"segments":[{"id":"s","kind":"cubic","c1":[80,80],"c2":[160,80],"to":[220,80]}]}]},"style":{"stroke":"#31505C"}}
\TLNode{target}{path}{"d":"M20 80L220 80","geometry":{"contours":[{"id":"c","start":[20,80],"segments":[{"id":"s","kind":"line","to":[220,80]}]}]},"style":{"stroke":"#71DFC2"}}
''' + body + '\n\\end{document}\n'


VALID = r'''
\loomparameter[unit=bp,min=0,max=20]{amplitude}{10}
\loomdeform[mode=pointwiseDeform,tolerance=0.35,max-depth=16,max-segments=32768]{wave}{source}{target}{
  position + vec2(0bp,amplitude*sin(2*pi*1rad*parameter + 1rad*time/1s))
}
'''


class DeformationCompilerTests(unittest.TestCase):
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

    def test_literal_multiline_capture_preserves_specials_and_span(self):
        expression = '\n  position + \\undefinedmacro + "quoted" % # ## ^^M ^^J &&\n  vec2(0bp,1bp)\n'
        folder, records, bundle = self.capture('literal', '\\loomdeform{wave}{source}{target}{' + expression + '}')
        lower_deformations(records, bundle, folder, folder)
        operation = bundle['deformations']['operations'][0]
        self.assertEqual(operation['expression'], expression)
        self.assertEqual(operation['sourceSpan']['file'], 'deformation-sources/scene.tl-deformation-1.body.txt')
        self.assertEqual(operation['sourceSpan']['end'], {'line': 4, 'column': 1})
        self.assertEqual((folder / operation['sourceSpan']['file']).read_text(encoding='utf8'), expression + '\n')
        declaration = next(record for record in records if record['type'] == 'deformation-file')
        self.assertEqual(set(declaration), {'type', 'file'})

    def test_options_are_typed_and_declaration_namespaces_do_not_collide(self):
        body = VALID + r'''
\loomexpr{P}{position}{vec2(20bp,30bp)}
\loomdeform[mode=controlDeform]{controls}{source}{source}{position + vec2(index*1bp,0bp)}
'''
        folder, records, bundle = self.capture('options', body)
        lower_deformations(records, bundle, folder, folder)
        first, second = bundle['deformations']['operations']
        self.assertEqual(bundle['version'], '0.3')
        self.assertEqual((first['mode'], first['tolerance'], first['maxDepth'], first['maxSegments']),
                         ('pointwiseDeform', 0.35, 16, 32768))
        self.assertEqual(second['mode'], 'controlDeform')
        self.assertEqual(second['source'], second['target'])
        self.assertNotIn('tolerance', second)
        self.assertEqual(second['expression'], 'position + vec2(index*1bp,0bp)')
        self.assertTrue((folder / 'scene.tl-expression-2.body.txt').exists())
        self.assertTrue((folder / 'scene.tl-deformation-2.body.txt').exists())

    def test_invalid_capture_options_are_not_silently_repaired(self):
        cases = [('unknown', 'quality=high', 'Unknown deformation option'),
                 ('duplicate', 'mode=controlDeform,mode=pointwiseDeform', 'Duplicate deformation option'),
                 ('mode', 'mode=warp', 'mode must be'),
                 ('finite', 'tolerance=NaN', 'finite JSON number'),
                 ('positive', 'tolerance=0', 'must be positive'),
                 ('integer', 'max-depth=2.5', 'positive integer'),
                 ('boolean', 'max-segments=true', 'finite JSON number')]
        for name, options, message in cases:
            with self.subTest(name=name):
                folder, records, bundle = self.capture(name, '\\loomdeform[' + options + ']{wave}{source}{target}{position}')
                with self.assertRaisesRegex(DeformationCaptureDiagnostic, message):
                    lower_deformations(records, bundle, folder, folder)

    def test_full_real_tex_compiles_are_repeatable_with_exact_archived_sources(self):
        source = self.folder / 'repeat.tex'
        source.write_text(document(VALID), encoding='utf8')
        outputs = [self.folder / 'repeat-one', self.folder / 'repeat-two']
        bundles = [compile_scene(source, output) for output in outputs]
        self.assertEqual({key: value for key, value in bundles[0].items() if key != 'provenance'},
                         {key: value for key, value in bundles[1].items() if key != 'provenance'})
        for output, bundle in zip(outputs, bundles):
            operation = bundle['deformations']['operations'][0]
            archived = output / operation['sourceSpan']['file']
            original = next(output.glob('runs/compile-*/source/' + archived.name))
            self.assertEqual(archived.read_bytes(), original.read_bytes())
            self.assertNotIn('compile-', operation['sourceSpan']['file'])

    def test_unknown_symbol_reaches_shared_validator(self):
        source = self.folder / 'unknown.tex'
        source.write_text(document(VALID.replace('position + vec2', 'unknown_position + vec2')), encoding='utf8')
        with self.assertRaisesRegex(CompileDiagnostic, 'unknown_position'):
            compile_scene(source, self.folder / 'unknown-out')

    def test_loading_package_without_declarations_preserves_existing_bundle_shape(self):
        source = self.folder / 'empty.tex'
        body = '\n'.join(line for line in document('').splitlines() if not line.startswith('\\TLNode')) + '\n'
        source.write_text(body, encoding='utf8')
        bundle = compile_scene(source, self.folder / 'empty-out')
        self.assertEqual(bundle['version'], '0.1')
        self.assertNotIn('deformations', bundle)
        self.assertNotIn('expressions', bundle)


if __name__ == '__main__':
    unittest.main()
