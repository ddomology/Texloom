"""Guard the regression gate against false passes, without invoking TeX or a browser."""
from copy import deepcopy
from pathlib import Path
import sys
import tempfile
import unittest

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
from port_baseline import (
    canonical_bundle,
    compare_values,
    pixel_metrics,
    validate_spec,
    within_raster,
)


def valid_spec():
    """A reference-only port may document a pending license review."""
    return {
        'schemaVersion': 1,
        'id': 'curve-baseline',
        'title': 'Curve sampling regression evidence',
        'implementation': {
            'mode': 'independent-regression-baseline',
            'supportedProfile': ['The registered finite 2D path fixture'],
            'excluded': ['General source compatibility'],
        },
        'upstream': [{
            'project': 'pgf-tikz/pgf',
            'revision': '1d6234878836bc50b5e5a15ae266d74911466e7a',
            'path': 'tex/generic/pgf/systemlayer/pgfsyssoftpath.code.tex',
            'symbols': [r'\pgfsyssoftpath@getcurrentpath'],
            'documentation': ['https://tikz.dev/pgfsys-paths'],
            'role': 'reference-only; no upstream implementation copied',
            'license': {
                'status': 'review-required',
                'note': 'Copying or adapting this source requires a separate review.',
            },
        }],
        'contract': {
            'inputs': ['Finite coordinates and absolute time'],
            'outputs': ['Ordered sampled geometry'],
            'coordinates': ['bp; positive y down'],
            'errorPolicy': ['Unsupported operations fail explicitly'],
        },
        'fixtures': ['living-paths'],
        'verification': {
            'command': 'python tools/verify-port.py',
            'claims': ['Registered semantic regression evidence is checked'],
            'notEstablished': ['Universal upstream behavioral equivalence'],
        },
    }


class PortSpecTests(unittest.TestCase):
    def test_reference_only_spec_accepts_documented_pending_license_review(self):
        self.assertEqual(validate_spec(valid_spec(), {'living-paths'}), [])

    def test_missing_immutable_revision_fails(self):
        spec = valid_spec()
        del spec['upstream'][0]['revision']
        self.assertTrue(validate_spec(spec, {'living-paths'}))

    def test_branch_tag_short_hash_and_nonhex_revision_fail(self):
        for revision in ['main', 'v3.1.11', 'abc1234', 'a' * 39, 'a' * 41, 'z' * 40, '']:
            with self.subTest(revision=revision):
                spec = valid_spec()
                spec['upstream'][0]['revision'] = revision
                self.assertTrue(validate_spec(spec, {'living-paths'}))

    def test_unknown_fixture_reference_fails(self):
        spec = valid_spec()
        spec['fixtures'].append('unregistered-scene')
        self.assertTrue(validate_spec(spec, {'living-paths'}))

    def test_direct_copy_with_unreviewed_license_fails(self):
        spec = valid_spec()
        spec['implementation']['mode'] = 'direct-copy'
        self.assertTrue(validate_spec(spec, {'living-paths'}))

    def test_every_upstream_revision_is_required(self):
        spec = valid_spec()
        second = deepcopy(spec['upstream'][0])
        second['path'] = 'tex/generic/pgf/basiclayer/pgfcorepathconstruct.code.tex'
        del second['revision']
        spec['upstream'].append(second)
        self.assertTrue(validate_spec(spec, {'living-paths'}))


def bundle_with_provenance():
    return {
        'version': '0.3',
        'provenance': {'generatedAt': '2026-10-02T00:00:00Z', 'output': 'C:/run-a'},
        'source': {'path': 'examples/living-paths.tex', 'provenance': 'semantic root source'},
        'nodes': [{
            'id': 'curve',
            'source': {'referenceResourceId': 'curve-art', 'provenance': 'semantic node source'},
            'provenance': {'authorTag': 'must-survive'},
            'geometry': {
                'contours': [{'id': 'contour-0', 'start': [0, 0], 'segments': [
                    {'id': 'segment-0', 'kind': 'line', 'to': [100, 20]},
                ]}],
            },
            'createdAt': 2.0,
        }],
        'resources': {
            'curve-art': {
                'kind': 'svg',
                'provenance': {'dvi': 'C:/run-a/asset.dvi', 'generatedAt': 'run-a'},
                'source': {'provenance': 'semantic resource source', 'path': 'source.svg'},
                'metrics': {'width': 100.0, 'height': 20.0, 'depth': 0.0},
                'paths': [{'d': 'M0 0 L100 20', 'provenance': 'semantic path metadata'}],
            },
        },
    }


class CanonicalBundleTests(unittest.TestCase):
    def test_only_two_explicit_provenance_locations_are_removed(self):
        bundle = bundle_with_provenance()
        expected = deepcopy(bundle)
        del expected['provenance']
        del expected['resources']['curve-art']['provenance']
        self.assertEqual(canonical_bundle(bundle), expected)

    def test_changing_run_paths_does_not_change_semantic_comparison(self):
        first = bundle_with_provenance()
        second = deepcopy(first)
        second['provenance'] = {'generatedAt': 'later', 'output': 'D:/run-b'}
        second['resources']['curve-art']['provenance'] = {'dvi': 'D:/run-b/asset.dvi'}
        self.assertEqual(canonical_bundle(first), canonical_bundle(second))

    def test_canonicalization_does_not_modify_or_alias_input(self):
        bundle = bundle_with_provenance()
        snapshot = deepcopy(bundle)
        canonical = canonical_bundle(bundle)
        self.assertEqual(bundle, snapshot)
        canonical['nodes'][0]['geometry']['contours'][0]['start'][0] = 123
        self.assertEqual(bundle, snapshot)

    def test_resource_metrics_and_node_source_changes_remain_observable(self):
        original = bundle_with_provenance()
        for mutate in [
            lambda b: b['resources']['curve-art']['metrics'].update(width=101.0),
            lambda b: b['nodes'][0]['source'].update(referenceResourceId='another-art'),
            lambda b: b['nodes'][0]['source'].update(provenance='different semantic source'),
            lambda b: b['nodes'][0].update(createdAt=3.0),
        ]:
            changed = deepcopy(original)
            mutate(changed)
            self.assertTrue(compare_values(canonical_bundle(original), canonical_bundle(changed)))


class SemanticComparisonTests(unittest.TestCase):
    def test_identical_nested_data_passes(self):
        value = {'nodes': [{'id': 'a', 'position': [1, -2.5], 'visible': True}], 'unused': None}
        self.assertEqual(compare_values(value, deepcopy(value)), [])

    def test_floating_point_roundoff_within_declared_tolerance_passes(self):
        self.assertEqual(compare_values({'x': 1.0}, {'x': 1.0 + 1e-8}), [])
        self.assertEqual(compare_values({'x': 1e6}, {'x': 1e6 + 1e-5}), [])

    def test_geometry_drift_beyond_declared_tolerance_fails(self):
        self.assertTrue(compare_values({'to': [10.0, 20.0]}, {'to': [10.0, 20.001]}))

    def test_caller_tolerance_is_respected(self):
        self.assertEqual(compare_values([1.0], [1.0005], abs_tol=.001, rel_tol=0), [])
        self.assertTrue(compare_values([1.0], [1.0005], abs_tol=.0001, rel_tol=0))

    def test_missing_and_added_keys_fail(self):
        for expected, actual in [({'a': 1, 'b': 2}, {'a': 1}), ({'a': 1}, {'a': 1, 'b': 2})]:
            with self.subTest(expected=expected, actual=actual):
                self.assertTrue(compare_values(expected, actual))

    def test_missing_and_reordered_nodes_fail(self):
        nodes = [{'id': 'back', 'x': 0}, {'id': 'front', 'x': 0}]
        self.assertTrue(compare_values({'nodes': nodes}, {'nodes': nodes[:1]}))
        self.assertTrue(compare_values({'nodes': nodes}, {'nodes': list(reversed(nodes))}))

    def test_nonpath_string_values_are_exact(self):
        self.assertTrue(compare_values({'id': '1.0'}, {'id': '1'}))
        self.assertTrue(compare_values({'label': 'x + y'}, {'label': 'x+y'}))

    def test_nonfinite_numbers_fail_even_when_both_sides_match(self):
        for value in [float('nan'), float('inf'), float('-inf')]:
            for expected, actual in [(value, value), (0.0, value), (value, 0.0)]:
                with self.subTest(expected=expected, actual=actual):
                    self.assertTrue(compare_values({'x': expected}, {'x': actual}))

    def test_svg_path_formatting_and_numeric_roundoff_do_not_create_false_failures(self):
        expected = {'paths': [{'d': 'M 1 2 L 3 -4.5 C 5 6 7 8 9 10 Z'}]}
        actual = {'paths': [{'d': 'M1.00000001,2 L3e0,-4.500 C5,6 7,8 9,10 Z'}]}
        self.assertEqual(compare_values(expected, actual), [])

    def test_svg_path_coordinate_drift_fails(self):
        self.assertTrue(compare_values({'d': 'M0 0 L100 20'}, {'d': 'M0 0 L100.01 20'}))

    def test_svg_path_command_case_order_and_added_segment_fail(self):
        expected = {'d': 'M0 0 L10 20 Z'}
        for path in ['m0 0 L10 20 Z', 'M0 0 C10 20 Z', 'M0 0 L10 20 L30 40 Z']:
            with self.subTest(path=path):
                self.assertTrue(compare_values(expected, {'d': path}))


class RasterComparisonTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.folder = Path(self.temp.name)
        self.addCleanup(self.temp.cleanup)

    def save(self, name, image):
        path = self.folder / name
        image.save(path)
        return path

    def test_identical_rgb_and_opaque_rgba_are_equivalent(self):
        rgb = Image.new('RGB', (4, 3), (12, 34, 56))
        rgba = rgb.convert('RGBA')
        metrics = pixel_metrics(self.save('rgb.png', rgb), self.save('rgba.png', rgba))
        self.assertEqual(metrics['meanChannelDifference'], 0)
        self.assertEqual(metrics['changedFraction'], 0)
        self.assertEqual(metrics['maximumChannelDifference'], 0)
        self.assertTrue(within_raster(metrics, {
            'meanChannelDifference': 0, 'changedFraction': 0, 'maximumChannelDifference': 0,
        }))

    def test_alpha_difference_is_not_discarded_when_normalizing_modes(self):
        rgb = Image.new('RGB', (4, 3), (12, 34, 56))
        rgba = Image.new('RGBA', (4, 3), (12, 34, 56, 200))
        metrics = pixel_metrics(self.save('opaque.png', rgb), self.save('alpha.png', rgba))
        self.assertGreater(metrics['meanChannelDifference'], 0)
        self.assertEqual(metrics['changedFraction'], 1)
        self.assertEqual(metrics['maximumChannelDifference'], 55)

    def test_canvas_size_mismatch_fails_even_with_lax_pixel_tolerances(self):
        first = self.save('first.png', Image.new('RGB', (4, 3), 'white'))
        second = self.save('second.png', Image.new('RGB', (5, 3), 'white'))
        metrics = pixel_metrics(first, second)
        self.assertTrue(metrics.get('sizeMismatch'))
        self.assertFalse(within_raster(metrics, {
            'meanChannelDifference': 255, 'changedFraction': 1, 'maximumChannelDifference': 255,
        }))

    def test_maximum_channel_limit_catches_a_small_high_contrast_shift(self):
        original = Image.new('RGBA', (100, 100), (255, 255, 255, 255))
        original.putpixel((49, 50), (0, 0, 0, 255))
        shifted = Image.new('RGBA', (100, 100), (255, 255, 255, 255))
        shifted.putpixel((50, 50), (0, 0, 0, 255))
        metrics = pixel_metrics(self.save('original.png', original), self.save('shifted.png', shifted))
        self.assertAlmostEqual(metrics['changedFraction'], 2 / 10000)
        self.assertLess(metrics['meanChannelDifference'], .1)
        self.assertEqual(metrics['maximumChannelDifference'], 255)
        policy = {'meanChannelDifference': .1, 'changedFraction': .001, 'maximumChannelDifference': 20}
        self.assertFalse(within_raster(metrics, policy))

    def test_each_raster_tolerance_is_a_separate_required_gate(self):
        policy = {'meanChannelDifference': 1, 'changedFraction': .1, 'maximumChannelDifference': 20}
        at_limit = dict(policy)
        self.assertTrue(within_raster(at_limit, policy))
        for key, value in [('meanChannelDifference', 1.01), ('changedFraction', .101),
                           ('maximumChannelDifference', 21)]:
            with self.subTest(key=key):
                metrics = dict(at_limit)
                metrics[key] = value
                self.assertFalse(within_raster(metrics, policy))


if __name__ == '__main__':
    unittest.main()
