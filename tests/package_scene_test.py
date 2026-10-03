"""Native TeX resources retain byte identity across portable package delivery modes."""
import copy
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
from compile import compile_scene


class PackageSceneTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.folder = Path(cls.temp.name)
        source = cls.folder / 'package.tex'
        source.write_text(r'''\documentclass{article}
\usepackage{texloom}
\begin{document}
\TLScene{Portable native math}{320}{180}{2}
\TLMath{formula}{x^2+\frac{1}{2}}
\TLMath{hidden}{\sin^2\theta+\cos^2\theta=1}
\TLNode{A}{tex}{"resourceId":"formula","x":20,"y":60}
\TLNode{B}{tex}{"resourceId":"formula","x":150,"y":60}
\TLNode{H}{tex}{"resourceId":"hidden","x":0,"y":0,"visible":false}
\end{document}
''', encoding='utf8')
        cls.bundle = compile_scene(source, cls.folder / 'native')
        cls.bundle['version'] = '0.3'
        cls.bundle['resources']['formula-alias'] = copy.deepcopy(cls.bundle['resources']['formula'])
        cls.bundle['resources']['unused-field'] = {
            'kind': 'scalar-field', 'columns': 2, 'rows': 2, 'times': [0],
            'samples': [[0, 1, 1, 0]], 'range': [0, 1], 'interpolation': 'linear'}
        cls.input = cls.folder / 'bundle.json'
        cls.input.write_text(json.dumps(cls.bundle, ensure_ascii=False), encoding='utf8')
        # One esbuild invocation per helper module; delivery parity is verified
        # with the real asynchronous resource store, not a test-only decoder.
        script = r'''
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const folder=process.env.PACKAGE_TEST_FOLDER;
const {packageScene}=await import(pathToFileURL(resolve('tools/package-scene.mjs')));
const built=await build({entryPoints:['src/index.ts'],bundle:true,platform:'node',format:'esm',write:false});
const api=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));
const original=JSON.parse(await readFile(resolve(folder,'bundle.json'),'utf8'));
const reference=api.prepareScene(original);const reports=[];
for(const [name,mode] of [['external','external'],['repeat','external'],['inline','inline'],['packed','packed']]){
  const out=resolve(folder,name);const report=await packageScene(resolve(folder,'bundle.json'),out,{mode});
  const manifest=JSON.parse(await readFile(resolve(out,'scene.json'),'utf8'));
  const payload=async entry=>{
    if(entry.source.kind==='inline')return Buffer.from(entry.source.data,'utf8');
    const bytes=await readFile(resolve(out,entry.source.uri)),range=entry.source.byteRange;
    return range?bytes.subarray(range.offset,range.offset+range.length):bytes;
  };
  for(const entry of manifest.assets.entries){
    const resource=JSON.parse((await payload(entry)).toString('utf8'));
    assert.deepStrictEqual(resource,original.resources[entry.id]);
    if(resource.kind==='vector')assert.equal(api.textResourceRevision(resource),api.textResourceRevision(original.resources[entry.id]));
  }
  const prepared=await api.prepareSceneAsync(manifest,{assetResolver:payload});
  for(const time of [0,.5,2,0])assert.deepStrictEqual(prepared.sample(time),reference.sample(time));
  prepared.dispose();reports.push(report);
}
const invalid=structuredClone(original);invalid.duration=-1;
await writeFile(resolve(folder,'invalid.json'),JSON.stringify(invalid));
const before=await readFile(resolve(folder,'external/scene.json'));
await assert.rejects(()=>packageScene(resolve(folder,'invalid.json'),resolve(folder,'external')));
assert.deepStrictEqual(await readFile(resolve(folder,'external/scene.json')),before);
await writeFile(resolve(folder,'parity.json'),JSON.stringify({modes:reports.length,resourceRevisions:true,frames:true,failedPublicationPreserved:true,reports}));
'''
        import os
        environment = os.environ.copy()
        environment['PACKAGE_TEST_FOLDER'] = str(cls.folder)
        process = subprocess.run(['node', '--input-type=module'], input=script, cwd=ROOT,
                                 env=environment, capture_output=True, text=True, encoding='utf8')
        if process.returncode:
            raise AssertionError(process.stdout + process.stderr[-10000:])

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def manifest(self, name):
        return json.loads((self.folder / name / 'scene.json').read_text(encoding='utf8'))

    def payload(self, name, entry):
        source = entry['source']
        if source['kind'] == 'inline':
            return source['data'].encode('utf8')
        data = (self.folder / name / source['uri']).read_bytes()
        if 'byteRange' in source:
            offset, length = source['byteRange']['offset'], source['byteRange']['length']
            return data[offset:offset + length]
        return data

    def test_external_exact_bytes_determinism_and_hidden_inventory(self):
        self.assertEqual((self.folder / 'external/scene.json').read_bytes(),
                         (self.folder / 'repeat/scene.json').read_bytes())
        manifest = self.manifest('external')
        self.assertNotIn('resources', manifest['scene'])
        self.assertEqual(manifest['contract'], 'texloom-package/1')
        entries = {entry['id']: entry for entry in manifest['assets']['entries']}
        self.assertEqual(set(entries), set(self.bundle['resources']))
        self.assertEqual(entries['formula']['source'], entries['formula-alias']['source'])
        self.assertEqual(entries['unused-field']['bounds'], [0, 0, 1, 1])
        self.assertIn('hidden', entries)
        self.assertEqual(len(list((self.folder / 'external/assets').iterdir())), len(entries) - 1)
        for entry in entries.values():
            data = self.payload('external', entry)
            self.assertTrue(data.endswith(b'\n'))
            self.assertEqual(len(data), entry['byteLength'])
            self.assertEqual(hashlib.sha256(data).hexdigest(), entry['sha256'])
            resource = self.bundle['resources'][entry['id']]
            if resource['kind'] == 'vector':
                self.assertEqual(entry['bounds'], resource['inkBounds'])

    def test_inline_and_packed_ranges_preserve_the_same_resource_bytes(self):
        originals = {entry['id']: self.payload('external', entry)
                     for entry in self.manifest('external')['assets']['entries']}
        for name in ['inline', 'packed']:
            manifest = self.manifest(name)
            for entry in manifest['assets']['entries']:
                self.assertEqual(self.payload(name, entry), originals[entry['id']])
                self.assertEqual(hashlib.sha256(self.payload(name, entry)).hexdigest(), entry['sha256'])
            if name == 'packed':
                self.assertEqual(len({entry['source']['uri'] for entry in manifest['assets']['entries']}), 1)
                self.assertTrue(all(entry['source']['byteRange']['length'] == entry['byteLength']
                                    for entry in manifest['assets']['entries']))
        self.assertFalse((self.folder / 'inline/assets').exists())

    def test_async_runtime_frame_and_native_text_revision_parity(self):
        parity = json.loads((self.folder / 'parity.json').read_text())
        self.assertEqual(parity['modes'], 4)
        self.assertTrue(parity['resourceRevisions'])
        self.assertTrue(parity['frames'])
        self.assertTrue(parity['failedPublicationPreserved'])

    def test_python_cli_mode_validation_and_publication(self):
        output = self.folder / 'python-cli'
        process = subprocess.run([sys.executable, str(ROOT / 'tools/package-scene.py'),
                                  str(self.input), '--out', str(output), '--inline'],
                                 capture_output=True, text=True, encoding='utf8')
        self.assertEqual(process.returncode, 0, process.stderr)
        self.assertEqual((output / 'scene.json').read_bytes(), (self.folder / 'inline/scene.json').read_bytes())
        rejected = subprocess.run([sys.executable, str(ROOT / 'tools/package-scene.py'),
                                   str(self.input), '--out', str(self.folder / 'bad-cli'), '--inline', '--packed'],
                                  capture_output=True, text=True, encoding='utf8')
        self.assertNotEqual(rejected.returncode, 0)
        self.assertFalse((self.folder / 'bad-cli/scene.json').exists())


if __name__ == '__main__':
    unittest.main()
