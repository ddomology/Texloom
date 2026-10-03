"""Real executed TeX declarations and revision-bound, exact-span source repair."""
import copy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
from lecture_source import capture_lecture, apply_repair, scene_dependencies, LectureSourceError
from compile import compile_scene


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


class LectureCaptureTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.folder = Path(self.temp.name)
        self.source = self.folder / 'lecture.tex'
        self.out = self.folder / 'out'

    def tearDown(self):
        self.temp.cleanup()

    def write(self, body, preamble=''):
        text = '\\documentclass{article}\n\\usepackage{texloom-lecture}\n' + preamble + '\n\\begin{document}\n\\loomlecture{compactness}{Compact sets are closed}\n' + body + '\n\\end{document}\n'
        self.source.write_bytes(text.encode('utf8'))
        return text

    def test_real_tex_quotes_math_setup_and_original_literal_spans(self):
        self.write(r'''\loomblock{closed}{definition}{Closed subsets}{A subset $F\subseteq X$ is closed if $X\setminus F$ is open.}{We call "F" closed when its complement is open.}
\loomblock{claim}{theorem}{Compactness}{If $X$ is Hausdorff and $K\subseteq X$ is compact, then $K$ is closed.}{Every compact subset of a Hausdorff space is closed.}''',
                   r'\loomlecturesetup{\usepackage{amsmath,amssymb}}')
        notes = capture_lecture(self.source, self.out)
        self.assertEqual(notes['contract'], 'texloom-notes/1')
        self.assertEqual(notes['sourceRevision'], digest(self.source.read_bytes()))
        self.assertIn('amsmath', notes['setup'])
        self.assertEqual(len(notes['blocks']), 2)
        first = notes['blocks'][0]
        self.assertIn(r'\subseteq', first['tex'])
        self.assertIn('"F"', first['say'])
        self.assertEqual(first['sourceSpan']['precision'], 'literal-wrapper')
        source = self.source.read_text(encoding='utf8')
        span = first['sourceSpan']
        self.assertTrue(source[span['startOffset']:span['endOffset']].startswith(r'\loomblock{closed}'))
        self.assertEqual(json.loads((self.out / 'notes.json').read_text(encoding='utf8')), notes)
        self.assertEqual((self.out / 'lecture-sources/lecture.tex').read_bytes(), self.source.read_bytes())

    def test_macro_generated_block_uses_conservative_document_span(self):
        self.write(r'\generated{lemma-a}', r'\newcommand{\generated}[1]{\loomblock{#1}{lemma}{Macro title}{For every $x$, $x=x$.}{Every point equals itself.}}')
        notes = capture_lecture(self.source, self.out)
        self.assertEqual(notes['blocks'][0]['id'], 'lemma-a')
        span = notes['blocks'][0]['sourceSpan']
        self.assertEqual(span['precision'], 'document')
        self.assertEqual((span['startOffset'], span['endOffset']), (0, len(self.source.read_text(encoding='utf8'))))

    def test_duplicate_unknown_kind_or_id_fails_and_removes_stale_notes(self):
        block = r'\loomblock{one}{remark}{Title}{Text.}{Spoken text.}'
        self.write(block)
        capture_lecture(self.source, self.out)
        for body in [block + '\n' + block, block + '\n' + block.replace('{one}', '{ONE}'), block.replace('{remark}', '{unknown}'), block.replace('{one}', '{invalid:id}'), block.replace('{one}', '{invalid.id}'), block.replace('{one}', '{CON}')]:
            with self.subTest(body=body):
                self.write(body)
                with self.assertRaises(LectureSourceError):
                    capture_lecture(self.source, self.out)
                self.assertFalse((self.out / 'notes.json').exists())

    def test_scene_paths_and_single_file_dependency_policy(self):
        (self.folder / 'scene.tex').write_text('scene placeholder')
        block = r'\loomblock{one}{example}{Example}{Text.}{Spoken text.}'
        self.write(block + '\n' + r'\loomsceneuse{one}{scene.tex}{An attached scene}')
        notes = capture_lecture(self.source, self.out)
        self.assertEqual(notes['scenes'], [{'block': 'one', 'file': 'scene.tex', 'caption': 'An attached scene'}])
        (self.folder / 'extra.tex').write_text(block)
        self.write(r'\input{extra.tex}')
        with self.assertRaisesRegex(LectureSourceError, 'LECTURE_DEPENDENCY'):
            capture_lecture(self.source, self.out)
        self.write(block + '\n' + r'\loomsceneuse{one}{../outside.tex}{Outside}')
        with self.assertRaisesRegex(LectureSourceError, 'LECTURE_SCENE_PATH'):
            capture_lecture(self.source, self.out)

    def test_local_package_macros_are_rejected_as_extra_source_dependencies(self):
        (self.folder / 'localdefs.sty').write_text(r'\ProvidesPackage{localdefs}\newcommand{\localblock}{\loomblock{local}{remark}{Local}{Text.}{Spoken.}}')
        self.write(r'\localblock', r'\usepackage{localdefs}')
        with self.assertRaisesRegex(LectureSourceError, 'LECTURE_DEPENDENCY'):
            capture_lecture(self.source, self.out)
        self.assertFalse((self.out / 'notes.json').exists())

    def test_multiline_crlf_span_and_detokenized_setup_keep_exact_source_provenance(self):
        wrapper = r'''\loomblock{percent}{example}{Quotes "and" braces}
{The set $\{x\in X : x=x\}$ has 100\% of its points.}
{Every point is included.}'''
        self.write(wrapper, r'\loomlecturesetup{\newcommand{\highlight}[1]{\textbf{#1}}}')
        original = self.source.read_bytes().replace(b'\n', b'\r\n')
        self.source.write_bytes(original)
        notes = capture_lecture(self.source, self.out)
        block = notes['blocks'][0]
        self.assertIn('#1', notes['setup'])
        self.assertNotIn('##1', notes['setup'])
        self.assertIn(r'\%', block['tex'])
        self.assertIn(r'\{', block['tex'])
        self.assertEqual(block['sourceSpan']['precision'], 'literal-wrapper')
        text = original.decode('utf8')
        span = block['sourceSpan']
        self.assertEqual(text[span['startOffset']:span['endOffset']], wrapper.replace('\n', '\r\n'))
        self.assertEqual(span['end']['line'] - span['start']['line'], 2)
        self.assertEqual(notes['sourceRevision'], digest(original))
        self.assertEqual((self.out / 'lecture-sources/lecture.tex').read_bytes(), original)


class LectureDependencyTests(unittest.TestCase):
    def test_original_scene_and_generated_asset_recorders_cover_local_inputs(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary).resolve()
            package = folder / 'package'
            package.mkdir()
            dimensions, definitions = package / 'dimensions.tex', package / 'definitions.tex'
            dimensions.write_text(r'\newcommand{\scenewidth}{300}', encoding='utf8')
            definitions.write_text(r'\newcommand{\word}{Recorded}', encoding='utf8')
            source = package / 'scene.tex'
            source.write_text('\n'.join([
                r'\documentclass{article}\usepackage{texloom}',
                r'\input{dimensions.tex}', '\\TLSetup{\\input{' + definitions.as_posix() + '}}',
                r'\begin{document}\TLScene{Trace}{\scenewidth}{100}{1}',
                r'\TLText{word}{\word}', r'\TLNode{word}{tex}{"resourceId":"word","x":10,"y":40}',
                r'\end{document}']), encoding='utf8')
            out = folder / 'traced'
            compile_scene(source, out, trace_inputs=True)
            expected = {str(path): digest(path.read_bytes()) for path in (source, dimensions, definitions)}
            self.assertEqual(scene_dependencies(source, out, package), expected)
            self.assertGreaterEqual(len(list(out.glob('runs/**/*.fls'))), 2)
            # A TeX source imported by a generated asset must not be accepted
            # merely because the top-level declaration file stayed contained.
            with self.assertRaisesRegex(LectureSourceError, 'leaves the source package'):
                scene_dependencies(source, out, package / 'narrower')
            default_out = folder / 'default'
            compile_scene(source, default_out)
            self.assertFalse(list(default_out.glob('runs/**/*.fls')))
            with self.assertRaisesRegex(LectureSourceError, 'trace_inputs=True'):
                scene_dependencies(source, default_out, package)

    def test_missing_recorded_dependency_is_an_explicit_failure(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary).resolve()
            source = folder / 'scene.tex'
            source.write_text('original', encoding='utf8')
            run = folder / 'out/runs/compile-test/source'
            run.mkdir(parents=True)
            (run / 'scene.fls').write_text('PWD ' + run.as_posix() + '\nINPUT ' + (folder / 'missing.tex').as_posix() + '\n', encoding='utf8')
            with self.assertRaisesRegex(LectureSourceError, 'no longer exists'):
                scene_dependencies(source, folder / 'out', folder)


class LectureRepairTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.folder = Path(self.temp.name)
        self.source = self.folder / 'lecture.tex'
        self.raw = 'First line.\nA closed set.\nFinal line.\n'.encode('utf8')
        self.source.write_bytes(self.raw)
        self.manifest = {'sourceRevision': digest(self.raw), 'artifactRevision': 'a' * 64}
        self.request = {'expectedSourceRevision': digest(self.raw), 'expectedArtifactRevision': 'a' * 64,
                        'sourceSpan': {'file': 'lecture.tex', 'startOffset': 14, 'endOffset': 20,
                                       'offsetUnit': 'unicode-code-point'},
                        'expectedText': 'closed', 'replacement': 'compact'}

    def tearDown(self):
        self.temp.cleanup()

    def test_valid_repair_is_atomic_and_audited(self):
        result = apply_repair(self.source, self.manifest, self.request)
        raw = self.source.read_bytes()
        self.assertEqual(raw, self.raw.replace(b'closed', b'compact'))
        self.assertEqual(result['sourceRevision'], digest(raw))
        audit = json.loads(Path(result['audit']).read_text(encoding='utf8'))
        self.assertEqual(audit['status'], 'applied')
        self.assertEqual(audit['sourceRevisionBefore'], digest(self.raw))
        self.assertEqual(audit['sourceRevisionAfter'], digest(raw))
        self.assertEqual(audit['expectedText'], 'closed')

    def test_missing_mismatched_and_stale_revisions_do_not_modify_source(self):
        for field in ['expectedSourceRevision', 'expectedArtifactRevision']:
            for value in [None, 'b' * 64, 'invalid']:
                with self.subTest(field=field, value=value):
                    request = copy.deepcopy(self.request)
                    if value is None:
                        request.pop(field)
                    else:
                        request[field] = value
                    with self.assertRaisesRegex(LectureSourceError, 'REVISION'):
                        apply_repair(self.source, self.manifest, request)
                    self.assertEqual(self.source.read_bytes(), self.raw)
        self.source.write_bytes(self.raw + b'Changed')
        with self.assertRaisesRegex(LectureSourceError, 'STALE'):
            apply_repair(self.source, self.manifest, self.request)

    def test_filename_bounds_coordinate_and_expected_text_must_all_match(self):
        cases = [{'file': 'another.tex'}, {'startOffset': -1}, {'endOffset': 999999},
                 {'startOffset': True}, {'startOffset': 20, 'endOffset': 14},
                 {'start': {'line': 999, 'column': 1}}, {'offsetUnit': 'utf16'}]
        for change in cases:
            with self.subTest(change=change):
                request = copy.deepcopy(self.request)
                request['sourceSpan'].update(change)
                with self.assertRaisesRegex(LectureSourceError, 'SPAN'):
                    apply_repair(self.source, self.manifest, request)
                self.assertEqual(self.source.read_bytes(), self.raw)
        request = copy.deepcopy(self.request)
        request['expectedText'] = 'wrong'
        with self.assertRaisesRegex(LectureSourceError, 'TEXT'):
            apply_repair(self.source, self.manifest, request)
        self.assertEqual(self.source.read_bytes(), self.raw)
        self.assertFalse(list(self.folder.glob('.*.repair-*.json')))

    def test_unicode_offsets_and_crlf_bytes_are_explicit_and_preserved(self):
        text = 'α😀\r\ncompact\r\n'
        self.source.write_bytes(text.encode('utf8'))
        revision = digest(self.source.read_bytes())
        manifest = {**self.manifest, 'sourceRevision': revision}
        request = {**self.request, 'expectedSourceRevision': revision,
                   'sourceSpan': {'file': 'lecture.tex', 'startOffset': 4, 'endOffset': 11},
                   'expectedText': 'compact', 'replacement': 'closed'}
        apply_repair(self.source, manifest, request)
        self.assertEqual(self.source.read_bytes(), 'α😀\r\nclosed\r\n'.encode('utf8'))


if __name__ == '__main__':
    unittest.main()
