import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
from text_part_views_capture import capture_part_views


class TextPartViewCaptureTests(unittest.TestCase):
    def test_real_tex_part_views_lower_before_timeline_and_preserve_source(self):
        from compile import compile_scene
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'views.tex'
            source.write_text(r'''\documentclass{article}
\usepackage{texloom,texloom-math,texloom-animation}
\begin{document}
\TLScene{Native views}{500}{300}{2}
\TLMath{equation}{\loompart{first}{x}+\loompart{second}{x}}
\TLNode{formula}{tex}{"resourceId":"equation","x":120,"y":150,"scale":3}
\loompartview{highlight}{formula}|{"query":{"ids":["second"],"scope":"exact","overlap":"error"},"style":{"fill":"#ed8c7a","opacity":0}}|
\begin{loomanimation}
\loomtween[duration=0.4]{highlight}{style.opacity}|{"from":0,"to":1}|
\loomwait{1}
\end{loomanimation}
\end{document}
''', encoding='utf8')
            output = root / 'out'
            bundle = compile_scene(source, output)
            nodes = {n['id']:n for n in bundle['nodes']}
            original = bundle['resources']['equation']
            view = bundle['resources'][nodes['highlight']['resourceId']]
            self.assertEqual(view['metrics'], original['metrics'])
            self.assertEqual(view['inkBounds'], original['inkBounds'])
            self.assertNotIn('textParts', view)
            self.assertEqual(view['provenance']['textPartView']['partIds'], ['second'])
            self.assertEqual([p['id'] for p in original['textParts']['parts']], ['first','second'])
            self.assertEqual(nodes['highlight']['x'], nodes['formula']['x'])
            self.assertEqual(nodes['highlight']['scale'], 3)
            self.assertEqual(nodes['highlight']['style'], {'fill':'#ed8c7a','opacity':0})
            self.assertEqual(bundle['tracks'][0]['target'], 'highlight')
            self.assertEqual(bundle['tracks'][0]['property'], 'style.opacity')
            self.assertEqual(bundle['tracks'][0]['keys'], [[0,0],[.4,1]])
            self.assertTrue((output / 'math-sources/views/program.json').is_file())

    def test_verbatim_selection_source_archive_and_duplicate_guard(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            base = 'scene.tl-part-view-1'
            body = '{"query":{"ids":["second-x"],"scope":"exact","overlap":"error"},\n"style":{"fill":"#fa776a","opacity":0}}'
            for field, content in {'id':'second-view','source':'formula','body':body}.items():
                (root / f'{base}.{field}.txt').write_text(content + '\n', encoding='utf8')
            record = {'type':'part-view-file','file':base}
            result = capture_part_views([record], root, root / 'output')[0]
            self.assertEqual(result['style']['fill'], '#fa776a')
            self.assertEqual(result['sourceId'], 'formula')
            archived = root / 'output' / result['sourceSpan']['file']
            self.assertEqual(archived.read_text(encoding='utf8'), body)
            self.assertEqual(result['sourceSpan']['end'], {'line':2,'column':len(body.split('\n')[1])+1})
            with self.assertRaisesRegex(ValueError, 'duplicate'):
                capture_part_views([record,record], root, root / 'output')

    def test_rejects_invalid_payloads_and_paths_before_lowering(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            record = {'type':'part-view-file','file':'scene.tl-part-view-1'}
            for field in ('id','source'):
                (root / f'{record["file"]}.{field}.txt').write_text('x', encoding='utf8')
            for body in ('[]','{"query":{},"extra":1}','{"query":{},"query":{}}','{"query":{},"style":{"opacity":1e400}}'):
                with self.subTest(body=body):
                    (root / f'{record["file"]}.body.txt').write_text(body, encoding='utf8')
                    with self.assertRaises(ValueError):
                        capture_part_views([record], root, root / 'output')
            with self.assertRaisesRegex(ValueError, 'filename'):
                capture_part_views([{'type':'part-view-file','file':'../escape'}], root, root / 'output')


if __name__ == '__main__':
    unittest.main()
