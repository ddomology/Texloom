"""Real TeX declaration, strict JSON capture and shared validation."""
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
from compile import compile_scene
from presentation_capture import lower_presentation


class PresentationCaptureTests(unittest.TestCase):
    def test_real_tex_glyph_and_tikz_intents_are_archived(self):
        with tempfile.TemporaryDirectory() as temp:
            out = Path(temp)
            bundle = compile_scene(ROOT / 'examples/presentation-intent.tex', out)
            self.assertEqual(bundle['presentation']['seed'], 2803)
            events = bundle['presentation']['events']
            self.assertEqual(len(events), 7)
            self.assertEqual(events[0]['mode'], 'glyph-outline')
            self.assertEqual(events[-1]['targets'], ['underline', 'direction', 'arrowhead'])
            native = next(n for n in bundle['nodes'] if n['id'] == 'underline')
            self.assertIn('geometry', native)
            self.assertEqual(len(bundle['timeline']['cues']), 2)
            for event in events:
                self.assertTrue((out / event['sourceSpan']['file']).is_file())

    def test_capture_rejects_duplicate_keys_nonfinite_and_multiple_declarations(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp)
            record = {'type': 'presentation-file', 'file': 'scene.tl-presentation-1'}
            source = folder / (record['file'] + '.program.txt')
            for text in ['{"seed":1,"seed":2}', '{"seed":NaN}']:
                source.write_text(text)
                with self.assertRaises(ValueError):
                    lower_presentation([record], {}, folder, folder)
            with self.assertRaisesRegex(ValueError, 'one presentation'):
                lower_presentation([record, record], {}, folder, folder)

    def test_shared_validator_rejects_missing_target_before_publication(self):
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / 'invalid.tex'
            source.write_text(r'''\documentclass{article}
\usepackage{texloom-presentation}
\begin{document}
\TLScene{Bad target}{100}{50}{2}
\loompresentation|{"version":1,"seed":1,"events":[{"kind":"draw","id":"write","target":"absent","start":0,"end":1,"mode":"fill"}]}|
\end{document}''')
            out = Path(temp) / 'out'
            with self.assertRaises(ValueError):
                compile_scene(source, out)
            self.assertFalse((out / 'bundle.json').exists())

    def test_no_declaration_preserves_legacy_bundle(self):
        bundle = {'version': '0.2'}
        lower_presentation([], bundle, Path('.'), Path('.'))
        self.assertEqual(bundle, {'version': '0.2'})
