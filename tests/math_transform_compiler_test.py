"""Executed native TeX parts, authored correspondence, and shared time."""
import copy
import json
import math
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
from compile import compile_scene
from animation_capture import capture_animation, AnimationCaptureDiagnostic
from tests.intersection_compiler_test import samples
from tests.text_parts_oracle import compose, IDENTITY, paint_leaves, maximum_difference, outline


FORMULAS = {
    'A': r'\frac{\loompartbox{left}{x}+\loompartbox{right}{x}}{\loompartbox{two}{2}}=\loompartbox{three}{3}',
    'B': r'\loompartbox{left}{x}+\loompartbox{right}{x}=\loompart{two}{2}\cdot\loompartbox{three}{3}',
    'C': r'\loompart{two}{2}\loompartbox{result}{x}=\loompartbox{six}{6}',
    'copy-source': r'\loompartbox{seed}{x}',
    'copy-target': r'\loompartbox{first}{x}+\loompartbox{second}{x}',
    'rows-source': r'\begin{aligned}\loompart{a}{a}&=\loompart{b}{b}\\\loompart{c}{c}&=\loompart{d}{d}\end{aligned}',
    'rows-target': r'\begin{aligned}\loompart{c}{c}&=\loompart{d}{d}\\\loompart{a}{a}&=\loompart{b}{b}\end{aligned}',
}
POSITIONS = {'A': (30, 80), 'B': (80, 95), 'C': (160, 80),
             'copy-source': (30, 170), 'copy-target': (200, 180),
             'rows-source': (40, 270), 'rows-target': (270, 250)}


def pair(source, target=None, mode='replace'):
    return {'source': source, 'target': target or source, 'mode': mode,
            'sourceAnchor': 'logical-center', 'targetAnchor': 'logical-center'}


def policy(pairs, retention='replace'):
    return {'approved': True, 'retention': retention, 'pairs': pairs, 'unmatched': 'fade',
            'labels': {'source': 'The authored source formula.', 'target': 'The authored target formula.'}}


# Explicit anchors are authored routing coordinates, not inferred logical boxes.
# The native guard rejects boxing 2 here, so it remains transparent.
FIRST = policy([pair('left'), pair('right'), {**pair('two'), 'targetAnchor': [46.395412567, -3.764259029]}, pair('three')])
SECOND = policy([pair('left', 'result'), {**pair('two'), 'sourceAnchor': [46.395412567, -3.764259029], 'targetAnchor': [2.926515567, -3.764259029]}])
COPY = policy([pair('seed', 'first', 'copy'), pair('seed', 'second', 'copy')], 'keep-source')
ROWS = policy([{**pair(name), 'sourceAnchor': [0, -8 if name in 'ab' else 12],
                'targetAnchor': [0, 12 if name in 'ab' else -8]} for name in ('a', 'b', 'c', 'd')])


def transform(instance, source, target, correspondence, duration=2):
    return ('\\loommathtransform[id=' + instance + ',duration=' + str(duration) + ',easing=linear]{'
            + source + '}{' + target + '}|' + json.dumps(correspondence) + '|\n')


def document(body):
    return ('\\documentclass{article}\n\\usepackage{texloom-animation,texloom-math}\n\\begin{document}\n'
            '\\TLScene{Math transforms}{500}{350}{5}\n' + body + '\n\\end{document}\n')


def native_declarations():
    result = ''
    for name, formula in FORMULAS.items():
        x, y = POSITIONS[name]
        result += '\\TLMath{' + name + '-art}{' + formula + '}\n'
        result += ('\\TLNode{' + name + '}{tex}{"resourceId":"' + name + '-art","x":' + str(x)
                   + ',"y":' + str(y) + ',"scale":1.5,"visible":false,"style":{"fill":"#ffffff","opacity":1}}\n')
    return result


def node_matrix(node):
    transform_value = node.get('transform', {})
    x, y = transform_value.get('translate', [0, 0])
    sx, sy = transform_value.get('scale', [1, 1])
    angle = transform_value.get('rotate', 0)
    c, s = math.cos(angle), math.sin(angle)
    return (c*sx, s*sx, -s*sy, c*sy, x, y)


def visible_outlines(frame, root_ids, force_visible=False):
    """Independent native-outline positions, without timeline/math core helpers."""
    nodes = {node['id']: node for node in frame['nodes']}
    children = {}
    for node in frame['nodes']:
        children.setdefault(node.get('parent'), []).append(node)
    outlines = []

    def visit(node, matrix, opacity):
        if not force_visible and node.get('visible') is False:
            return
        opacity *= node.get('style', {}).get('opacity', 1)
        if opacity < 1e-12:
            return
        matrix = compose(matrix, node_matrix(node))
        if node['kind'] == 'tex':
            scale = node.get('scale', 1)
            matrix = compose(matrix, (scale, 0, 0, scale, node['x'], node['y']))
            resource = frame['resources'][node['resourceId']]
            transported = {'items': [{'kind': 'group', 'transform': matrix, 'children': resource['items']}]}
            for leaf in paint_leaves(transported):
                if opacity*math.prod(leaf['opacity']) > 1e-12:
                    outlines.append(leaf['outline'])
        elif node['kind'] != 'group':
            raise AssertionError('Unexpected math instance node ' + node['kind'])
        for child in children.get(node['id'], []):
            visit(child, matrix, opacity)

    for root_id in root_ids:
        visit(nodes[root_id], IDENTITY, 1)
    # Explicitly paired native parts may have a different paint traversal order.
    # These fixtures have disjoint glyphs; compare every world outline as a multiset.
    return sorted(outlines, key=lambda path: json.dumps([[v if isinstance(v, str) else round(v, 5)
                                                       for v in command] for command in path]))


class MathTransformCompilerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.temp.cleanup)
        cls.folder = Path(cls.temp.name)
        body = native_declarations() + '\\TLMath{native-x}{x}\n\\TLMath{native-three}{3}\n'
        body += '\\begin{loomanimation}[origin=0.25]\n\\begin{loomparallel}\n\\begin{loomsequence}\n'
        body += transform('move-denominator', 'A', 'B', FIRST)
        body += '\\loomwait{0.25}\n\\loomsetvalue{move-denominator}{style.opacity}|0|\n'
        body += transform('combine', 'B', 'C', SECOND, 1.5)
        body += '\\end{loomsequence}\n'
        body += transform('duplicate', 'copy-source', 'copy-target', COPY)
        body += transform('swap-rows', 'rows-source', 'rows-target', ROWS)
        body += '\\end{loomparallel}\n\\loomcue{done}\n\\end{loomanimation}\n'
        cls.source = cls.folder / 'composition.tex'
        cls.source.write_text(document(body), encoding='utf8')
        cls.output = cls.folder / 'composition'
        cls.bundle = compile_scene(cls.source, cls.output)

    def test_real_tex_sequence_copy_multiline_endpoints_and_random_seek(self):
        self.assertEqual(self.bundle['timeline']['end'], 4)
        self.assertEqual({cue['name']: cue['time'] for cue in self.bundle['timeline']['cues']}, {'done': 4})
        times = [0, .25, 1.25, 2.25, 2.5, 4, 1.25]
        result = samples(self.output / 'bundle.json', times)
        self.assertTrue(all('frame' in item for item in result), result)
        self.assertEqual(result[2]['frame'], result[-1]['frame'])
        frames = {time: item['frame'] for time, item in zip(times, result)}
        before = {node['id']: node for node in frames[0]['nodes']}
        self.assertEqual(before['move-denominator']['style']['opacity'], 0)
        for time, instance, endpoint in ((.25, 'move-denominator', 'A'), (2.25, 'move-denominator', 'B'),
                                         (2.5, 'combine', 'B'), (4, 'combine', 'C'),
                                         (.25, 'swap-rows', 'rows-source'), (2.25, 'swap-rows', 'rows-target')):
            with self.subTest(time=time, instance=instance):
                actual = visible_outlines(frames[time], [instance])
                expected = visible_outlines(frames[time], [endpoint], force_visible=True)
                self.assertGreater(len(actual), 0)
                self.assertLessEqual(maximum_difference(actual, expected), 4e-6)
        actual = visible_outlines(frames[2.25], ['duplicate'])
        expected = visible_outlines(frames[2.25], ['copy-source', 'copy-target'], force_visible=True)
        self.assertLessEqual(maximum_difference(actual, expected), 4e-6)
        actual = visible_outlines(frames[.25], ['duplicate'])
        expected = visible_outlines(frames[.25], ['copy-source'], force_visible=True)
        self.assertLessEqual(maximum_difference(actual, expected), 4e-6)
        middle = {node['id']: node for node in frames[1.25]['nodes']}
        for instance, count in (('move-denominator', 4), ('duplicate', 2)):
            for index in range(count):
                # These explicitly paired native glyphs have identical local
                # paint. Their correct anchors need one moving paint tree,
                # with no offset second glyph dissolved on top of it.
                self.assertEqual(middle[f'{instance}:pair:{index}:target']['style']['opacity'], 0)
        final_nodes = {node['id']: node for node in frames[4]['nodes']}
        self.assertEqual(final_nodes['move-denominator']['style']['opacity'], 0)
        for frame in frames.values():
            authored = {node['id']: node for node in frame['nodes']}
            for name in FORMULAS:
                self.assertFalse(authored[name]['visible'])
                self.assertEqual(authored[name]['resourceId'], name+'-art')
                self.assertEqual(frame['resources'][name+'-art']['items'], self.bundle['resources'][name+'-art']['items'])

    def test_native_proofs_measured_anchors_and_literal_source_archive(self):
        for name in FORMULAS:
            resource = self.bundle['resources'][name+'-art']
            proof = resource['provenance']['textPartsValidation']
            self.assertTrue(proof['metricsExact'])
            self.assertEqual(proof['maxCoordinateDifferenceBp'], 0)
            for part in resource['textParts']['parts']:
                if name.startswith('rows') or name in ('B', 'C') and part['id'] == 'two':
                    self.assertNotIn('logicalBox', part)
                else:
                    self.assertIn('logicalBox', part)
        program = json.loads((self.output / 'animation-sources' / 'program.json').read_text())
        parallel = program['root']['children'][0]
        first = parallel['children'][0]['children'][0]
        self.assertEqual(first['kind'], 'math-transform')
        self.assertEqual(first['correspondence'], FIRST)
        self.assertEqual((self.output / first['sourceSpan']['file']).read_text(), json.dumps(FIRST)+'\n')

    def test_measured_box_origins_follow_native_binary_and_relation_glue(self):
        # Width/height alone miss a DVI origin special shipped before math glue.
        # Independently normalize each selected native glyph using the measured
        # box baseline, then compare with an unmarked isolated TeX glyph.
        for resource_id, part_id, bare_id in (
            ('A-art', 'left', 'native-x'), ('A-art', 'right', 'native-x'),
            ('B-art', 'left', 'native-x'), ('B-art', 'right', 'native-x'),
            ('C-art', 'result', 'native-x'), ('A-art', 'three', 'native-three'),
            ('B-art', 'three', 'native-three'),
            ('copy-target-art', 'first', 'native-x'), ('copy-target-art', 'second', 'native-x'),
        ):
            with self.subTest(resource=resource_id, part=part_id):
                resource = self.bundle['resources'][resource_id]
                part = next(p for p in resource['textParts']['parts'] if p['id'] == part_id)
                bare = self.bundle['resources'][bare_id]
                logical = part['logicalBox']
                matrix = (1, 0, 0, 1, -logical[0], -logical[1]-bare['metrics']['height'])
                actual = []
                for address in part['paintPaths']:
                    accumulated, items = matrix, resource['items']
                    for index in address:
                        item = items[index]
                        accumulated = compose(accumulated, item.get('transform', IDENTITY))
                        items = item.get('children', [])
                    self.assertEqual(item['kind'], 'path')
                    actual.append(outline(item['d'], accumulated))
                expected = [leaf['outline'] for leaf in paint_leaves(bare)]
                self.assertLessEqual(maximum_difference(actual, expected), 2e-6)
                self.assertAlmostEqual(logical[2], bare['metrics']['width'], delta=2e-7)

    def test_frontend_rejects_bad_options_duplicate_keys_and_nonfinite_values(self):
        begin = {'type': 'animation-file', 'kind': 'begin', 'file': 'scene.tl-animation-1'}
        leaf = {'type': 'animation-file', 'kind': 'math-transform', 'file': 'scene.tl-animation-2'}
        end = {'type': 'animation-file', 'kind': 'end', 'file': 'scene.tl-animation-3'}
        cases = [('', '{}', 'explicit instance'), ('id=step,duration=-1', '{}', 'nonnegative'),
                 ('id=step,easing=unknown', '{}', 'easing'), ('id=step,callback=run', '{}', 'Unknown'),
                 ('id=step', '[]', 'JSON object'), ('id=step', '{"pairs":[],"pairs":[]}', 'Duplicate JSON'),
                 ('id=step', '{"sourceAnchor":[1e309,0]}', 'nonfinite')]
        for index, (options, literal, expected) in enumerate(cases):
            with self.subTest(index=index):
                folder = self.folder / ('invalid-'+str(index)); folder.mkdir()
                for serial, fields in ((1, {'group': 'animation', 'options': ''}),
                                       (2, {'options': options, 'source': 'A', 'destination': 'B', 'correspondence': literal}),
                                       (3, {'group': 'animation'})):
                    for field, text in fields.items():
                        (folder / f'scene.tl-animation-{serial}.{field}.txt').write_text(text+'\n', encoding='utf8')
                with self.assertRaisesRegex(AnimationCaptureDiagnostic, expected):
                    capture_animation([begin, leaf, end], folder, folder)

    def test_shared_compiler_rejects_missing_parts_and_ambiguous_copy_contracts(self):
        # Use the same genuinely compiled native TeX resources, with no generated
        # instances or prior schedule, to exercise the shared diagnostic boundary.
        base = {key: copy.deepcopy(self.bundle[key]) for key in ('version', 'title', 'duration', 'viewport', 'units', 'camera')}
        base.update({'nodes': [copy.deepcopy(node) for node in self.bundle['nodes'] if node['id'] in FORMULAS],
                     'resources': {name+'-art': self.bundle['resources'][name+'-art'] for name in FORMULAS},
                     'tracks': [], 'relations': [], 'diagnostics': []})
        cases = [('missing-part', policy([pair('absent', 'left')]), 'part'),
                 ('unapproved', {**FIRST, 'approved': False}, 'approv'),
                 ('unknown-field', {**FIRST, 'callback': 'run()'}, 'callback'),
                 ('copy-without-replace', policy([pair('left', 'left', 'copy')]), 'replace'),
                 ('keep-source-replace', policy([pair('left')], 'keep-source'), 'copy'),
                 ('duplicate-target', policy([pair('left'), pair('right', 'left')]), 'target')]
        for name, correspondence, expected in cases:
            with self.subTest(name=name):
                folder = self.folder / name; folder.mkdir()
                (folder/'bundle.json').write_text(json.dumps(base), encoding='utf8')
                program = {'version': 1, 'root': {'kind': 'sequence', 'children': [
                    {'kind': 'math-transform', 'id': 'invalid', 'source': 'A', 'destination': 'B',
                     'duration': 1, 'correspondence': correspondence}]}}
                (folder/'program.json').write_text(json.dumps(program), encoding='utf8')
                process = subprocess.run(['node', str(ROOT/'tools/compile-timeline.mjs'), str(folder/'bundle.json'),
                                          str(folder/'program.json'), str(folder/'lowered.json')],
                                         cwd=ROOT, capture_output=True, text=True, encoding='utf8', errors='replace')
                self.assertNotEqual(process.returncode, 0)
                self.assertIn(expected, process.stderr.lower())
                self.assertFalse((folder/'lowered.json').exists())


if __name__ == '__main__':
    unittest.main()
