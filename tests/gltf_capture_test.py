"""Native glTF capture: real TeX, strict containers and independent byte provenance."""
import base64
import copy
import hashlib
import json
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
from gltf_capture import (lower_gltf, read_asset, unpack_glb, parse_options,
                          contained_path, GltfCaptureDiagnostic)
from compile import compile_scene


def fixture():
    positions = struct.pack('<9f', 0, 0, 0, 1, 0, 0, 0, 1, 0)
    normals = struct.pack('<9f', 0, 0, 1, 0, 0, 1, 0, 0, 1)
    indices = struct.pack('<3H', 0, 1, 2)
    binary = positions + normals + indices
    document = {
        'asset': {'version': '2.0'}, 'scene': 0, 'scenes': [{'nodes': [0]}],
        'nodes': [{'mesh': 0}],
        'meshes': [{'primitives': [{'attributes': {'POSITION': 0, 'NORMAL': 1}, 'indices': 2, 'material': 0}]}],
        'materials': [{'extensions': {'KHR_materials_unlit': {}}, 'pbrMetallicRoughness': {'baseColorFactor': [0.2, 0.6, 0.8, 1]}}],
        'extensionsUsed': ['KHR_materials_unlit'],
        'buffers': [{'uri': 'scene.bin', 'byteLength': len(binary)}],
        'bufferViews': [{'buffer': 0, 'byteOffset': 0, 'byteLength': 36},
                        {'buffer': 0, 'byteOffset': 36, 'byteLength': 36},
                        {'buffer': 0, 'byteOffset': 72, 'byteLength': 6}],
        'accessors': [{'bufferView': 0, 'componentType': 5126, 'count': 3, 'type': 'VEC3', 'min': [0, 0, 0], 'max': [1, 1, 0]},
                      {'bufferView': 1, 'componentType': 5126, 'count': 3, 'type': 'VEC3'},
                      {'bufferView': 2, 'componentType': 5123, 'count': 3, 'type': 'SCALAR'}]}
    return document, binary


def glb(document, binary):
    document = copy.deepcopy(document)
    document['buffers'][0].pop('uri', None)
    text = json.dumps(document, separators=(',', ':')).encode()
    text += b' ' * (-len(text) % 4)
    payload = binary + b'\0' * (-len(binary) % 4)
    chunks = struct.pack('<II', len(text), 0x4E4F534A) + text + struct.pack('<II', len(payload), 0x004E4942) + payload
    return struct.pack('<4sII', b'glTF', 2, 12 + len(chunks)) + chunks


class GltfCaptureTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.folder = Path(self.temp.name)
        self.execution = self.folder / 'execution'
        self.execution.mkdir()
        self.output = self.folder / 'output'
        self.source = self.folder / 'scene.tex'
        self.source.write_text('')
        self.base = 'scene.tl-gltf-1'
        self.records = [{'type': 'gltf-file', 'file': self.base}]
        self.document, self.binary = fixture()
        self.write_asset()

    def tearDown(self):
        self.temp.cleanup()

    def write_asset(self):
        (self.folder / 'scene.gltf').write_text(json.dumps(self.document))
        (self.folder / 'scene.bin').write_bytes(self.binary)
        (self.folder / 'scene.glb').write_bytes(glb(self.document, self.binary))

    def declaration(self, identifier='model', path='scene.gltf', options=''):
        for field, text in [('id', identifier), ('body', path), ('options', options)]:
            (self.execution / f'{self.base}.{field}.txt').write_text(text + '\n')

    def native(self, path='scene.gltf', options='', second=''):
        self.source.write_text(r'''\documentclass{article}
\usepackage{texloom-gltf}
\begin{document}
\TLScene{Native glTF}{640}{360}{8}
\loomgltf[%s]{model}{%s}
%s
\end{document}
''' % (options, path, second))
        return compile_scene(self.source, self.output)

    def test_external_data_uri_and_glb_payload_equivalence(self):
        external, external_info = read_asset(self.folder / 'scene.gltf', self.folder, self.output, 'external', [0])
        embedded, embedded_info = read_asset(self.folder / 'scene.glb', self.folder, self.output, 'embedded', [0])
        self.document['buffers'][0]['uri'] = 'data:application/octet-stream;base64,' + base64.b64encode(self.binary).decode()
        (self.folder / 'inline.gltf').write_text(json.dumps(self.document))
        inline, inline_info = read_asset(self.folder / 'inline.gltf', self.folder, self.output, 'inline', [0])
        self.assertEqual(external['buffers'], embedded['buffers'])
        self.assertEqual(external['buffers'], inline['buffers'])
        self.assertEqual([item['buffers'][0]['kind'] for item in [external_info, embedded_info, inline_info]], ['external', 'glb-bin', 'data-uri'])
        for info in [external_info, embedded_info, inline_info]:
            buffer = info['buffers'][0]
            self.assertEqual((self.output / buffer['file']).read_bytes(), self.binary)
            self.assertEqual(buffer['sha256'], hashlib.sha256(self.binary).hexdigest())

    def test_glb_header_chunk_order_alignment_and_padding_rejected(self):
        original = (self.folder / 'scene.glb').read_bytes()
        cases = {'truncated-header': original[:10], 'trailing': original + b'junk'}
        for name, offset, value in [('version', 4, 1), ('length', 8, len(original) - 4), ('json-kind', 16, 0x004E4942), ('json-alignment', 12, 7)]:
            damaged = bytearray(original)
            struct.pack_into('<I', damaged, offset, value)
            cases[name] = bytes(damaged)
        damaged = bytearray(original)
        damaged[-1] = 1
        cases['nonzero-bin-padding'] = bytes(damaged)
        document = copy.deepcopy(self.document)
        document['buffers'][0]['byteLength'] -= 4
        cases['excess-bin-padding'] = glb(document, self.binary)
        chunk_length = struct.unpack_from('<I', original, 12)[0]
        damaged = bytearray(original)
        struct.pack_into('<I', damaged, 12 + 8 + chunk_length + 4, 0x4E4F534A)
        cases['duplicate-json-chunk'] = bytes(damaged)
        for name, raw in cases.items():
            with self.subTest(name=name):
                path = self.folder / 'bad.glb'
                path.write_bytes(raw)
                with self.assertRaises(GltfCaptureDiagnostic):
                    read_asset(path, self.folder, self.output, 'bad', [0])

    def test_invalid_json_missing_buffer_and_lengths_have_clear_diagnostics(self):
        for name, change in [('missing', {'uri': 'missing.bin'}), ('length', {'byteLength': len(self.binary) + 1}),
                             ('no-uri', {'uri': None}), ('data-encoding', {'uri': 'data:application/octet-stream;base64,!!!!'})]:
            with self.subTest(name=name):
                document = copy.deepcopy(self.document)
                document['buffers'][0].update(change)
                (self.folder / 'bad.gltf').write_text(json.dumps(document))
                with self.assertRaises(GltfCaptureDiagnostic):
                    read_asset(self.folder / 'bad.gltf', self.folder, self.output, 'bad', [0])
        (self.folder / 'bad.gltf').write_text('{"asset":{},"asset":{}}')
        with self.assertRaisesRegex(GltfCaptureDiagnostic, 'GLTF_CAPTURE_JSON'):
            read_asset(self.folder / 'bad.gltf', self.folder, self.output, 'bad', [0])
        (self.folder / 'bad.gltf').write_bytes(b'{"asset":{"version":"2.0"},"name":"\\ud800"}')
        with self.assertRaisesRegex(GltfCaptureDiagnostic, 'GLTF_CAPTURE_UTF8'):
            read_asset(self.folder / 'bad.gltf', self.folder, self.output, 'bad', [0])

    def test_paths_are_contained_and_encoded_relative_paths_work(self):
        nested = self.folder / 'models'
        nested.mkdir()
        (self.folder / 'space name.bin').write_bytes(self.binary)
        self.assertEqual(contained_path(self.folder, nested, '../space%20name.bin'), self.folder / 'space name.bin')
        for uri in ['../outside.bin', '/scene.bin', 'C:/scene.bin', 'https://example.com/a.bin', '//host/a.bin',
                    'scene.bin?x=1', 'scene.bin#x', 'scene%2f..%2f..%2foutside.bin', 'scene%00.bin', 'scene%zz.bin', '%ff.bin', 'scene\\foo.bin']:
            with self.subTest(uri=uri), self.assertRaises(GltfCaptureDiagnostic):
                contained_path(self.folder, self.folder, uri)

    def test_budgets_checked_before_file_or_data_buffer_read(self):
        with patch('gltf_capture.MAX_BYTES', 12):
            with self.assertRaisesRegex(GltfCaptureDiagnostic, 'BUDGET'):
                read_asset(self.folder / 'scene.gltf', self.folder, self.output, 'bounded', [0])
        with patch('gltf_capture.MAX_JSON_BYTES', 12):
            with self.assertRaisesRegex(GltfCaptureDiagnostic, 'BUDGET'):
                read_asset(self.folder / 'scene.glb', self.folder, self.output, 'bounded', [0])
        with self.assertRaisesRegex(GltfCaptureDiagnostic, 'BUDGET'):
            read_asset(self.folder / 'scene.gltf', self.folder, self.output, 'bounded', [64 * 1024 * 1024])

    def test_options_are_explicit_unique_and_bounded(self):
        self.assertEqual(parse_options('wireframe, material=fallback,animation=0,camera=12'),
                         {'wireframe': True, 'materialPolicy': 'fallback', 'animation': 0, 'camera': 12})
        for options in ['wireframe,solid', 'animation=-1', 'camera=1.5', 'animation=01', 'camera=999999', 'animation=0,animation=1', 'material=pbr', 'unknown', 'wireframe,']:
            with self.subTest(options=options), self.assertRaisesRegex(GltfCaptureDiagnostic, 'OPTIONS'):
                parse_options(options)

    def test_invalid_sidecars_and_scope_leave_bundle_unchanged(self):
        for case in ['invalid-scope', 'duplicate', 'missing-sidecar', 'missing-source']:
            with self.subTest(case=case):
                self.declaration(identifier='invalid:scope' if case == 'invalid-scope' else 'model',
                                 path='missing.gltf' if case == 'missing-source' else 'scene.gltf')
                if case == 'missing-sidecar':
                    (self.execution / f'{self.base}.options.txt').unlink()
                records = self.records * 2 if case == 'duplicate' else self.records
                bundle = {'version': '0.3', 'resources': {}}
                before = copy.deepcopy(bundle)
                with self.assertRaises(GltfCaptureDiagnostic):
                    lower_gltf(records, bundle, self.execution, self.output, self.source)
                self.assertEqual(bundle, before)

    def test_native_tex_promotes_version_and_archives_exact_source_bytes(self):
        bundle = self.native(options='wireframe')
        self.assertEqual(bundle['version'], '0.3')
        capture = bundle['provenance']['gltfCapture']
        self.assertEqual(capture['imports'], bundle['provenance']['gltfImports'])
        self.assertEqual(json.loads((self.output / 'gltf-sources/declarations.json').read_text()), capture)
        declaration = capture['declarations'][0]
        self.assertEqual(declaration['options'], {'wireframe': True})
        self.assertEqual((self.output / declaration['asset']).read_bytes(), (self.folder / 'scene.gltf').read_bytes())
        self.assertEqual((self.output / capture['source']['file']).read_bytes(), self.source.read_bytes())
        self.assertEqual(capture['source']['sha256'], hashlib.sha256(self.source.read_bytes()).hexdigest())
        for sidecar in declaration['sidecars']:
            self.assertEqual(hashlib.sha256((self.output / sidecar['file']).read_bytes()).hexdigest(), sidecar['sha256'])
        self.assertTrue(all(node['material']['wireframe'] for node in bundle['space3d']['nodes'] if node['kind'] == 'mesh'))

    def test_native_gltf_glb_produce_same_meshes_and_transforms(self):
        first = self.native()
        second = self.native(path='scene.glb')
        self.assertEqual(first['space3d'], second['space3d'])
        for rid in first['resources']:
            self.assertEqual(first['resources'][rid]['positions'], second['resources'][rid]['positions'])
            self.assertEqual(first['resources'][rid]['indices'], second['resources'][rid]['indices'])

    def test_native_failed_import_replaces_no_stale_bundle(self):
        self.native()
        with self.assertRaises(GltfCaptureDiagnostic):
            self.native(path='missing.gltf')
        self.assertFalse((self.output / 'bundle.json').exists())
        self.assertFalse(json.loads((self.output / 'compile-report.json').read_text())['success'])
        self.document['extensionsRequired'] = ['KHR_draco_mesh_compression']
        self.write_asset()
        with self.assertRaisesRegex(GltfCaptureDiagnostic, 'LOWERING'):
            self.native()
        self.assertFalse((self.output / 'bundle.json').exists())

    def test_native_multiple_declarations_have_independent_scopes_and_archives(self):
        bundle = self.native(second=r'\loomgltf[solid]{second}{scene.glb}')
        capture = bundle['provenance']['gltfCapture']
        self.assertEqual([item['id'] for item in capture['declarations']], ['model', 'second'])
        self.assertNotEqual(capture['declarations'][0]['asset'], capture['declarations'][1]['asset'])
        self.assertEqual(len(capture['imports']), 2)
        self.assertTrue({'model', 'second'} <= {node['id'] for node in bundle['space3d']['nodes']})
        for declaration in capture['declarations']:
            self.assertEqual((self.output / declaration['buffers'][0]['file']).read_bytes(), self.binary)

    def test_export_cli_publishes_reimportable_files_and_refuses_overwrite(self):
        original = self.native()
        destination = self.folder / 'exported'
        command = ['node', str(ROOT / 'tools/export-gltf.mjs'), str(self.output / 'bundle.json'), '--out', str(destination)]
        result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, encoding='utf8', timeout=120)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        paths = sorted(path for path in destination.iterdir())
        before = {path.name: path.read_bytes() for path in paths}
        self.assertTrue({'scene.gltf', 'texloom-sidecar.json', 'conversion-report.json'} <= set(before))
        for filename in ('scene.gltf', 'texloom-sidecar.json', 'conversion-report.json'):
            self.assertIsInstance(json.loads(before[filename]), dict)
        result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, encoding='utf8', timeout=120)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('GLTF_EXPORT_EXISTS', result.stderr)
        self.assertEqual({path.name: path.read_bytes() for path in destination.iterdir()}, before)
        restored = self.native(path='exported/scene.gltf')
        original_meshes = [value for value in original['resources'].values() if value['kind'] == 'mesh']
        restored_meshes = [value for value in restored['resources'].values() if value['kind'] == 'mesh']
        self.assertEqual(len(original_meshes), len(restored_meshes))
        self.assertEqual(original_meshes[0]['positions'], restored_meshes[0]['positions'])
        self.assertEqual(original_meshes[0]['indices'], restored_meshes[0]['indices'])
        self.assertFalse(list(self.folder.glob('.texloom-gltf-*')))


if __name__ == '__main__':
    unittest.main()
