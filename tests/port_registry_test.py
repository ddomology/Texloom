"""Registry and approved-artifact integrity checks; no TeX, browser or network."""
from copy import deepcopy
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

PROJECT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT / 'tools'))
module_spec = importlib.util.spec_from_file_location('port_registry_verifier', PROJECT / 'tools/verify-port.py')
verifier = importlib.util.module_from_spec(module_spec)
module_spec.loader.exec_module(verifier)


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding='utf8')


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


class PortRegistryTests(unittest.TestCase):
    def test_report_serialization_uses_lf_on_every_platform(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'report.json'
            verifier.save(path, {'nested': {'value': 1}})
            self.assertNotIn(b'\r', path.read_bytes())
            self.assertEqual(json.loads(path.read_bytes()), {'nested': {'value': 1}})

    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.fixtures = self.root / 'tests/fixtures/ports'
        self.reference = self.fixtures / 'reference'
        self.suite_path = self.fixtures / 'suite.json'
        self.spec_path = self.root / 'docs/ports/test-port.json'
        self.input = self.root / 'examples/scene.tex'
        self.input.parent.mkdir(parents=True)
        self.input.write_text('fixed authored input\n', encoding='utf8')
        self.suite = {
            'schemaVersion': 1,
            'numericTolerance': {'absolute': 1e-7, 'relative': 1e-10},
            'rasterTolerance': {'meanChannelDifference': .1, 'changedFraction': .01, 'maximumChannelDifference': 16},
            'consumerTolerance': {'meanChannelDifference': .1, 'changedFraction': .01, 'maximumChannelDifference': 16},
            'fixtures': [{'id': 'scene', 'source': 'examples/scene.tex',
                          'inputs': ['examples/scene.tex'], 'times': [0]}],
        }
        self.spec = {
            'schemaVersion': 1, 'id': 'test-port', 'title': 'Registry test',
            'implementation': {'mode': 'independent-regression-baseline',
                               'supportedProfile': ['Registered scene'], 'excluded': ['Other scenes']},
            'upstream': [{'project': 'owner/project', 'revision': 'a' * 40, 'path': 'source.py',
                          'symbols': ['curve'], 'documentation': ['https://example.invalid/source'],
                          'role': 'reference-only', 'license': {'status': 'review-required', 'note': 'No source reuse.'}}],
            'contract': {'inputs': ['Authored input'], 'outputs': ['Frame'],
                         'coordinates': ['bp'], 'errorPolicy': ['Fail on mismatch']},
            'fixtures': ['scene'],
            'verification': {'command': 'python tools/verify-port.py',
                             'claims': ['Registered regression'], 'notEstablished': ['General equivalence']},
        }
        write_json(self.suite_path, self.suite)
        write_json(self.spec_path, self.spec)
        self.specs = {'docs/ports/test-port.json': digest(self.spec_path)}
        artifact_names = ['toolchain.json', 'scene/bundle.json', 'scene/observations.json',
                          'scene/frame-0.svg', 'scene/frame-0.png']
        for name in artifact_names:
            path = self.reference / name
            path.parent.mkdir(parents=True, exist_ok=True)
            # This layer validates bytes and inventory, not image/scene decoding.
            path.write_bytes(('fixed reference: ' + name).encode())
        self.manifest = {
            'schemaVersion': 1, 'suiteSha256': digest(self.suite_path),
            'specHashes': self.specs,
            'inputHashes': {'scene': {'examples/scene.tex': digest(self.input)}},
            'artifacts': {name: digest(self.reference / name) for name in artifact_names},
        }
        write_json(self.reference / 'manifest.json', self.manifest)
        patcher = patch.multiple(verifier, ROOT=self.root, FIXTURES=self.fixtures,
                                 SUITE=self.suite_path, REFERENCE=self.reference)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_complete_registry_and_matching_reference_are_accepted(self):
        suite, specs = verifier.suite_and_specs()
        self.assertEqual(suite, self.suite)
        self.assertEqual(specs, self.specs)
        self.assertEqual(verifier.validate_reference(suite, specs), self.manifest)

    def test_changed_spec_is_not_covered_by_old_reference(self):
        self.spec['upstream'][0]['revision'] = 'b' * 40
        write_json(self.spec_path, self.spec)
        suite, specs = verifier.suite_and_specs()
        with self.assertRaisesRegex(RuntimeError, 'PortSpec contract changed'):
            verifier.validate_reference(suite, specs)

    def test_missing_artifact_fails_even_when_inventory_lists_it(self):
        (self.reference / 'scene/frame-0.png').unlink()
        with self.assertRaisesRegex(RuntimeError, 'Missing or modified reference artifact'):
            verifier.validate_reference(self.suite, self.specs)

    def test_modified_artifact_cannot_reuse_approved_hash(self):
        (self.reference / 'scene/observations.json').write_bytes(b'changed observations')
        with self.assertRaisesRegex(RuntimeError, 'Missing or modified reference artifact'):
            verifier.validate_reference(self.suite, self.specs)

    def test_changed_authored_input_requires_reference_review(self):
        self.input.write_text('different authored input\n', encoding='utf8')
        with self.assertRaisesRegex(RuntimeError, 'reference input hashes differ'):
            verifier.validate_reference(self.suite, self.specs)

    def test_inventory_must_include_every_required_frame(self):
        del self.manifest['artifacts']['scene/frame-0.svg']
        write_json(self.reference / 'manifest.json', self.manifest)
        with self.assertRaisesRegex(RuntimeError, 'artifact inventory is incomplete or unexpected'):
            verifier.validate_reference(self.suite, self.specs)

    def test_changed_suite_cannot_reuse_old_reference(self):
        self.suite['fixtures'][0]['times'].append(1)
        write_json(self.suite_path, self.suite)
        with self.assertRaisesRegex(RuntimeError, 'Reference suite has changed'):
            verifier.validate_reference(self.suite, self.specs)

    def test_boolean_tolerances_are_rejected_by_registry(self):
        for policy, key in [('rasterTolerance', 'maximumChannelDifference'),
                            ('consumerTolerance', 'changedFraction'),
                            ('numericTolerance', 'absolute')]:
            with self.subTest(policy=policy, key=key):
                suite = deepcopy(self.suite)
                suite[policy][key] = True
                write_json(self.suite_path, suite)
                with self.assertRaisesRegex(ValueError, 'Invalid'):
                    verifier.suite_and_specs()

    def test_a_template_does_not_substitute_for_an_active_spec(self):
        self.spec_path.unlink()
        write_json(self.spec_path.with_name('port-spec.template.json'), {})
        with self.assertRaisesRegex(ValueError, 'No active PortSpec found'):
            verifier.suite_and_specs()

    def test_active_spec_without_revision_fails_registry_validation(self):
        del self.spec['upstream'][0]['revision']
        write_json(self.spec_path, self.spec)
        with self.assertRaisesRegex(ValueError, 'revision requires a full immutable commit SHA'):
            verifier.suite_and_specs()


if __name__ == '__main__':
    unittest.main()
