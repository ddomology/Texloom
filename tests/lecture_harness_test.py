"""Real three-lecture acceptance through the public authoring Python API."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import hashlib
import json
import math
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
import lecture


EXPECTED = {
    'hausdorff-compact-closed': ['statement', 'hausdorff', 'compactness', 'empty-case', 'fix-point',
        'local-separation', 'finite-cover', 'finite-intersection', 'disjointness', 'conclusion'],
    'commuting-square': ['composition', 'square', 'maps', 'upper-route', 'lower-route',
        'commutativity', 'numerical-check', 'interpretation'],
    'uniform-limit-continuity': ['statement', 'uniform-convergence', 'strategy', 'fix-point',
        'choose-index', 'choose-radius', 'triangle-inequality', 'three-bounds', 'conclusion', 'why-uniform'],
}


def read(path):
    return json.loads(path.read_text(encoding='utf8'))


def digest(data):
    return hashlib.sha256(data).hexdigest()


class LectureHarnessTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        (ROOT / 'build').mkdir(exist_ok=True)
        cls.temp = tempfile.TemporaryDirectory(prefix='lecture-harness-', dir=ROOT / 'build')
        cls.folder = Path(cls.temp.name).resolve()
        cls.addClassCleanup(cls.temp.cleanup)
        cls.sources = cls.folder / 'sources'
        shutil.copytree(ROOT / 'examples/lectures', cls.sources)
        cls.input_bytes = {p: p.read_bytes() for p in cls.sources.rglob('*.tex')}
        cls.outputs = {name: cls.folder / name for name in EXPECTED}
        def build(name):
            return name, lecture.compile_lecture(cls.sources / (name + '.tex'), cls.outputs[name])
        with ThreadPoolExecutor(max_workers=3) as pool:
            cls.reports = dict(pool.map(build, EXPECTED))

    @contextmanager
    def changed_artifacts(self, output, *names):
        paths = {output / name for name in (*names, 'manifest.json', 'authoring-map.json')}
        before = {p: p.read_bytes() for p in paths}
        try:
            yield
        finally:
            for path, content in before.items():
                path.write_bytes(content)

    def reseal(self, output):
        """Keep integrity coherent so semantic validation, not stale-hash failure, is tested."""
        manifest = read(output / 'manifest.json')
        manifest['files'] = {name: digest((output / name).read_bytes()) for name in manifest['files']}
        revision = lecture.artifact_revision(manifest['sourceRevision'], manifest['files'])
        manifest['artifactRevision'] = revision
        mapping = read(output / 'authoring-map.json')
        mapping['artifactRevision'] = revision
        lecture.save(output / 'authoring-map.json', mapping)
        manifest['mapSha256'] = digest((output / 'authoring-map.json').read_bytes())
        lecture.save(output / 'manifest.json', manifest)

    def test_three_complete_sources_have_exact_ordered_block_script_and_scene_correspondence(self):
        for name, expected in EXPECTED.items():
            with self.subTest(lecture=name):
                output = self.outputs[name]
                notes, lesson, mapping = [read(output / file) for file in ('notes.json', 'lesson.json', 'authoring-map.json')]
                self.assertEqual([b['id'] for b in notes['blocks']], expected)
                self.assertEqual([b['id'] for b in mapping['blocks']], expected)
                self.assertEqual([b['id'] for b in lesson['beats']], expected)
                self.assertEqual(set(lesson['objects']), set(expected))
                self.assertEqual(len(mapping['scenes']), 1)
                self.assertEqual(len([b for b in mapping['blocks'] if b['sceneIds']]), 1)
                for block, row, beat in zip(notes['blocks'], mapping['blocks'], lesson['beats']):
                    self.assertEqual(row['say'], block['say'])
                    self.assertEqual(beat['say'], block['say'])
                    self.assertEqual(row['beatId'], block['id'])
                    self.assertEqual(row['objectId'], block['id'])
                    self.assertIn(block['tex'], lesson['objects'][block['id']]['tex'])
                    self.assertEqual(row['sourceSpan'], block['sourceSpan'])
                    self.assertTrue(block['tex'].strip())
                    self.assertTrue(block['say'].strip())
                report = lecture.validate_lecture(output, check_inputs=True)
                self.assertTrue(report['renderValidation']['passed'], report)
                self.assertEqual(report['semanticCoverage']['omissions'], [])
                self.assertEqual(report['semanticCoverage']['expectedBlocks'], len(expected))
                self.assertEqual(report['mathReview']['status'], 'unresolved')
                self.assertEqual(report['timing']['status'], 'estimated')

    def test_native_paragraph_vectors_are_finite_measured_unclipped_and_complete(self):
        for name, expected in EXPECTED.items():
            with self.subTest(lecture=name):
                output = self.outputs[name]
                metrics = read(output / 'vectors/metrics.json')
                self.assertEqual([row['id'] for row in metrics], expected)
                for row in metrics:
                    self.assertLessEqual(row['overflow'], 1, row)
                    self.assertTrue(all(math.isfinite(row[k]) and row[k] > 0 for k in ('width', 'height')), row)
                    svg = ET.fromstring((output / 'vectors' / row['file']).read_text(encoding='utf8'))
                    self.assertEqual(svg.tag, '{http://www.w3.org/2000/svg}svg')
                    self.assertTrue(svg.findall('.//{http://www.w3.org/2000/svg}path'))
                    self.assertEqual([float(v) for v in svg.attrib['viewBox'].split()], [0, 0, row['width'], row['height']])
                page = (output / 'index.html').read_text(encoding='utf8')
                self.assertEqual(page.count('<article '), len(expected))
                self.assertEqual(page.count('<iframe '), 1)
                for identifier in expected:
                    self.assertIn(f'id="{identifier}"', page)
                    self.assertIn(f'vectors/{identifier}.svg', page)

    def test_public_sample_hook_uses_the_real_animated_scene_and_preserves_build_bytes(self):
        output = self.outputs['hausdorff-compact-closed']
        manifest = lecture.verify_artifacts(output)
        mapping = read(output / 'authoring-map.json')
        scene = output / next(iter(mapping['scenes'].values()))['file']
        snapshots = []
        for time in (0, 4):
            target = self.folder / f'frame-{time}.svg'
            info = json.loads(lecture.node('sample', scene, target, time))
            self.assertEqual(info['time'], time)
            svg = ET.fromstring(target.read_text(encoding='utf8'))
            snapshots.append([path.attrib.get('d') for path in svg.findall('.//{http://www.w3.org/2000/svg}path')])
        self.assertNotEqual(snapshots[0], snapshots[1])
        self.assertEqual(lecture.verify_artifacts(output), manifest)
        for source, original in self.input_bytes.items():
            self.assertEqual(source.read_bytes(), original)

    def test_old_artifact_bytes_and_changed_source_fail_the_correct_validation_boundary(self):
        output = self.outputs['commuting-square']
        with self.changed_artifacts(output, 'vectors/composition.svg'):
            path = output / 'vectors/composition.svg'
            path.write_bytes(path.read_bytes() + b'\n<!-- changed -->')
            with self.assertRaisesRegex(ValueError, 'LECTURE_STALE_ARTIFACT'):
                lecture.validate_lecture(output)
        source = self.sources / 'commuting-square.tex'
        original = source.read_bytes()
        try:
            source.write_bytes(original + b'\n% a later authoring revision\n')
            # Archived output remains inspectable. Explicit source validation
            # and repair must reject a build based on the earlier input.
            lecture.verify_artifacts(output)
            with self.assertRaisesRegex(ValueError, 'LECTURE_STALE_SOURCE'):
                lecture.verify_artifacts(output, check_inputs=True)
        finally:
            source.write_bytes(original)

    def test_immutable_build_refuses_to_overwrite_a_previous_publication(self):
        name = 'commuting-square'
        output = self.outputs[name]
        before = {p: p.read_bytes() for p in output.iterdir() if p.is_file()}
        with self.assertRaisesRegex(ValueError, 'LECTURE_OUTPUT'):
            lecture.compile_lecture(self.sources / (name + '.tex'), output)
        self.assertEqual({p: p.read_bytes() for p in before}, before)

    def test_semantic_validation_rejects_reordered_correspondence_even_with_valid_integrity(self):
        output = self.outputs['hausdorff-compact-closed']
        with self.changed_artifacts(output):
            mapping = read(output / 'authoring-map.json')
            mapping['blocks'].reverse()
            lecture.save(output / 'authoring-map.json', mapping)
            self.reseal(output)
            report = lecture.validate_lecture(output)
            self.assertFalse(report['renderValidation']['passed'])
            self.assertIn('LECTURE_CORRESPONDENCE', [d['code'] for d in report['renderValidation']['diagnostics']])

    def test_script_cannot_drift_from_captured_source_even_when_map_and_beat_agree(self):
        output = self.outputs['uniform-limit-continuity']
        with self.changed_artifacts(output, 'lesson.json'):
            mapping, lesson = read(output / 'authoring-map.json'), read(output / 'lesson.json')
            changed = 'Pointwise convergence is sufficient for the theorem.'
            mapping['blocks'][0]['say'] = changed
            lesson['beats'][0]['say'] = changed
            lecture.save(output / 'authoring-map.json', mapping)
            lecture.save(output / 'lesson.json', lesson)
            self.reseal(output)
            report = lecture.validate_lecture(output)
            self.assertFalse(report['renderValidation']['passed'])
            self.assertIn('LECTURE_SCRIPT', [d['code'] for d in report['renderValidation']['diagnostics']])

    def test_revision_bound_repair_recompiles_without_changing_the_prior_build(self):
        source = self.sources / 'commuting-square.tex'
        output = self.outputs['commuting-square']
        original = source.read_bytes()
        manifest = read(output / 'manifest.json')
        mapping = read(output / 'authoring-map.json')
        span = mapping['blocks'][0]['sourceSpan']
        text = original.decode('utf8')
        expected = text[span['startOffset']:span['endOffset']]
        replacement = expected.replace('Read composition from right to left', 'Read function composition from right to left')
        self.assertNotEqual(expected, replacement)
        request = {'expectedSourceRevision': manifest['sourceRevision'],
                   'expectedArtifactRevision': manifest['artifactRevision'],
                   'sourceSpan': span, 'expectedText': expected, 'replacement': replacement}
        previous_page = (output / 'index.html').read_bytes()
        audit_path = None
        try:
            repair = lecture.repair_lecture(source, output, request)
            audit_path = Path(repair['audit']).resolve()
            self.assertEqual(audit_path.parent, self.sources.resolve())
            self.assertTrue(repair['changed'])
            self.assertNotEqual(repair['sourceRevision'], manifest['sourceRevision'])
            self.assertEqual(read(Path(repair['audit']))['status'], 'applied')
            with self.assertRaisesRegex(ValueError, 'LECTURE_STALE_SOURCE'):
                lecture.verify_artifacts(output, check_inputs=True)
            rebuilt = self.folder / 'commuting-square-repaired'
            report = lecture.compile_lecture(source, rebuilt)
            self.assertTrue(report['renderValidation']['passed'], report)
            self.assertEqual(report['manualRepairCount'], 1)
            self.assertEqual(report['sourceRevision'], repair['sourceRevision'])
            self.assertEqual(read(rebuilt / 'notes.json')['blocks'][0]['title'], 'Read function composition from right to left')
            self.assertNotEqual(report['artifactRevision'], manifest['artifactRevision'])
            self.assertEqual((output / 'index.html').read_bytes(), previous_page)
            self.assertEqual(lecture.verify_artifacts(output), manifest)
        finally:
            source.write_bytes(original)
            if audit_path is not None and audit_path.parent == self.sources.resolve():
                audit_path.unlink(missing_ok=True)


class LectureHarnessCliTests(unittest.TestCase):
    def test_public_templates_and_syntax_commands_exit_successfully_with_json(self):
        for arguments in [('templates',), ('syntax', 'commuting-square')]:
            with self.subTest(arguments=arguments):
                result = subprocess.run([sys.executable, str(ROOT / 'tools/lecture.py'), *arguments],
                                        cwd=ROOT, capture_output=True, text=True, encoding='utf8', timeout=30)
                self.assertEqual(result.returncode, 0, result.stderr)
                data = json.loads(result.stdout)
                if arguments[0] == 'templates':
                    self.assertEqual({row['id'] for row in data}, set(EXPECTED))
                else:
                    self.assertEqual(data['template'], 'commuting-square')
                    self.assertIn(r'\loomblock', data['source'])
                    self.assertIn(r'\ProvidesPackage{texloom-lecture}', data['package'])


class LectureHarnessFailureTests(unittest.TestCase):
    def test_invalid_body_has_a_revision_and_source_span_for_exact_repair_and_recompile(self):
        (ROOT / 'build').mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='lecture-repair-failure-', dir=ROOT / 'build') as folder:
            root = Path(folder).resolve()
            (root / 'source').mkdir()
            source = root / 'source/broken.tex'
            text = (r'\documentclass{article}' '\n'
                    r'\usepackage{texloom-lecture}' '\n'
                    r'\begin{document}' '\n'
                    r'\loomlecture{repaired-example}{A repaired example}' '\n'
                    r'\loomblock{identity}{remark}{An identity}{\NotATexloomOrLatexCommand}{The number one equals itself.}' '\n'
                    r'\end{document}' '\n')
            original = text.encode('utf8')
            source.write_bytes(original)
            failed = root / 'failed'
            with self.assertRaises((ValueError, RuntimeError, subprocess.SubprocessError)):
                lecture.compile_lecture(source, failed)
            status, manifest = read(failed / 'status.json'), read(failed / 'manifest.json')
            self.assertFalse(status['success'])
            self.assertEqual(status['stage'], 'failed')
            self.assertEqual(status['sourceRevision'], digest(original))
            self.assertEqual(manifest['status'], 'failed')
            self.assertEqual(manifest['sourceRevision'], digest(original))
            self.assertEqual((failed / 'sources/failed-notes.tex').read_bytes(), original)
            span = status['diagnostics'][0]['sourceSpan']
            self.assertEqual(span['file'], 'broken.tex')
            self.assertEqual(span['precision'], 'document')
            self.assertEqual(span['offsetUnit'], 'unicode-code-point')
            self.assertEqual((span['startOffset'], span['endOffset']), (0, len(text)))
            self.assertFalse(lecture.validate_lecture(failed, check_inputs=True)['renderValidation']['passed'])
            expected = text[span['startOffset']:span['endOffset']]
            replacement = expected.replace(r'\NotATexloomOrLatexCommand', r'$1=1$.')
            request = {'expectedSourceRevision': manifest['sourceRevision'],
                       'expectedArtifactRevision': manifest['artifactRevision'],
                       'sourceSpan': span, 'expectedText': expected, 'replacement': replacement}
            repair = lecture.repair_lecture(source, failed, request)
            self.assertTrue(repair['changed'])
            rebuilt = root / 'rebuilt'
            report = lecture.compile_lecture(source, rebuilt)
            self.assertTrue(report['renderValidation']['passed'], report)
            self.assertEqual(report['sourceRevision'], repair['sourceRevision'])
            self.assertEqual(report['manualRepairCount'], 1)
            self.assertEqual(read(rebuilt / 'notes.json')['blocks'][0]['tex'], r'$1=1$.')
            self.assertEqual(lecture.verify_artifacts(failed)['status'], 'failed')
            self.assertEqual((failed / 'sources/failed-notes.tex').read_bytes(), original)


if __name__ == '__main__':
    unittest.main()
