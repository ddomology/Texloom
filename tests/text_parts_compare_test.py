import copy
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
from text_parts_compare import assert_same_layout, TextPartLayoutDiagnostic


def resource(items):
    return {'kind': 'vector', 'items': items, 'metrics': {'width': 20, 'height': 8, 'depth': 2},
            'inkBounds': [0, -8, 20, 10], 'sourceTex': 'x+x'}


def path(d='M0 0 C0 8 10 8 10 0', **extra):
    return {'kind': 'path', 'd': d, **extra}


class TextPartsCompareTest(unittest.TestCase):
    def test_inert_transport_groups_preserve_affine_outlines_and_inherited_paint(self):
        native = resource([{'kind': 'group', 'transform': [1, 0, 0, 1, 10, 5], 'style': {'fill': '#abc'},
                            'children': [path()]}])
        marked = resource([{'kind': 'group', 'transform': [1, 0, 0, 1, 4, 5],
                            'children': [{'kind': 'group', 'transform': [1, 0, 0, 1, 6, 0],
                                          'children': [path(style={'fill': '#abc'})]}]}])
        marked.update(sourceTex=r'\loompart{x}{x}+x', glyphs=[{'outlineId': 'different-definition'}])
        before = copy.deepcopy(marked)
        report = assert_same_layout(native, marked)
        self.assertEqual(report, {'metricsExact': True, 'paintLeaves': 1, 'maxCoordinateDifferenceBp': 0,
                                 'maxInkBoundsDifferenceBp': 0, 'toleranceBp': 2e-6})
        self.assertEqual(marked, before)

    def test_relative_repeated_smooth_and_quadratic_commands_are_expanded(self):
        a = resource([path('m1 2 3 0 h2 v2 c1 0 1 2 2 2 s1 2 2 0 q3 3 6 0 t6 0z')])
        b = resource([path('M1 2 L4 2 L6 2 L6 4 C7 4 7 6 8 6 C9 6 9 8 10 6 '
                           'C12 8 14 8 16 6 C18 4 20 4 22 6 Z')])
        self.assertEqual(assert_same_layout(a, b)['maxCoordinateDifferenceBp'], 0)

    def test_same_bounds_do_not_hide_changed_outline_or_paint_order(self):
        native = resource([path(), path('M2 0 L8 0')])
        changed = copy.deepcopy(native)
        changed['items'][0]['d'] = 'M0 0 C3 8 7 8 10 0'
        with self.assertRaises(TextPartLayoutDiagnostic):
            assert_same_layout(native, changed)
        changed = copy.deepcopy(native)
        changed['items'].reverse()
        with self.assertRaises(TextPartLayoutDiagnostic):
            assert_same_layout(native, changed)

    def test_shared_opacity_scope_is_not_equivalent_to_two_independent_scopes(self):
        native = resource([{'kind': 'group', 'style': {'opacity': .5}, 'children': [path(), path()]}])
        split = resource([{'kind': 'group', 'style': {'opacity': .5}, 'children': [path()]},
                          {'kind': 'group', 'style': {'opacity': .5}, 'children': [path()]}])
        with self.assertRaises(TextPartLayoutDiagnostic):
            assert_same_layout(native, split)
        inert = copy.deepcopy(native)
        inert['items'][0]['children'] = [{'kind': 'group', 'children': inert['items'][0]['children']}]
        assert_same_layout(native, inert)

    def test_clipping_and_effective_paint_are_compared(self):
        native = resource([{'kind': 'group', 'style': {'fill': '#000'},
                            'clip': {'d': 'M0 0 H20 V10 H0 Z', 'fillRule': 'evenodd'}, 'children': [path()]}])
        for change in ('clip', 'rule', 'paint'):
            altered = copy.deepcopy(native)
            if change == 'clip':
                altered['items'][0]['clip']['d'] = 'M0 0 H20 V10 L1 10 Z'
            elif change == 'rule':
                altered['items'][0]['clip']['fillRule'] = 'nonzero'
            else:
                altered['items'][0]['children'][0]['style'] = {'fill': '#fff'}
            with self.assertRaises(TextPartLayoutDiagnostic):
                assert_same_layout(native, altered)

    def test_identical_centerline_with_different_affine_stroke_is_rejected(self):
        native = resource([path('M0 0 L10 0', transform=[2, 0, 0, 2, 0, 0], style={'stroke': '#fff', 'strokeWidth': 1})])
        altered = resource([path('M0 0 L20 0', style={'stroke': '#fff', 'strokeWidth': 1})])
        with self.assertRaises(TextPartLayoutDiagnostic):
            assert_same_layout(native, altered)

    def test_metrics_are_exact_but_transport_coordinates_and_ink_have_bounded_tolerance(self):
        native = resource([path('M0 0 L1 0')])
        close = copy.deepcopy(native)
        close['items'][0]['d'] = 'M0.000001 0 L1 0'
        close['inkBounds'][0] = 1e-6
        report = assert_same_layout(native, close)
        self.assertEqual(report['maxCoordinateDifferenceBp'], 1e-6)
        self.assertEqual(report['maxInkBoundsDifferenceBp'], 1e-6)
        close['metrics']['width'] += 1e-9
        with self.assertRaises(TextPartLayoutDiagnostic):
            assert_same_layout(native, close)
        far = copy.deepcopy(native)
        far['items'][0]['d'] = 'M0.000003 0 L1 0'
        with self.assertRaises(TextPartLayoutDiagnostic):
            assert_same_layout(native, far)

    def test_unsupported_or_malformed_path_data_never_silently_passes(self):
        for d in ('M0 0 A1 1 0 0 1 2 0', 'L1 1', 'M0 0 C1 2', 'M0,,0', 'M0 0,', 'M0 0 Z 1 2', 'M0 0 R1 1'):
            with self.subTest(d=d), self.assertRaises(TextPartLayoutDiagnostic) as caught:
                assert_same_layout(resource([path(d)]), resource([path(d)]))
            self.assertEqual(caught.exception.code, 'TEXT_PART_LAYOUT')
        empty = resource([{'kind': 'group', 'children': []}])
        self.assertEqual(assert_same_layout(empty, empty)['paintLeaves'], 0)


if __name__ == '__main__':
    unittest.main()
