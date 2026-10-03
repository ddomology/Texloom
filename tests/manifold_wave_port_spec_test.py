"""Register the manifold wave scene and preserve its independent input evidence."""
import hashlib
import json
from pathlib import Path
import sys
import unittest

ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'tools'))
from port_baseline import validate_spec


class ManifoldWavePortSpecTests(unittest.TestCase):
    def test_contract_and_original_input_manifest(self):
        spec=json.loads((ROOT/'docs/ports/features/pr37-manifold-wave.json').read_text(encoding='utf8'))
        suite=json.loads((ROOT/'tests/fixtures/manifold-wave/suite.json').read_text(encoding='utf8'));ids={f['id'] for f in suite['fixtures']}
        self.assertEqual(validate_spec(spec,ids),[]);self.assertEqual(len(ids),len(suite['fixtures']))
        for fixture in suite['fixtures']:
            self.assertIn(fixture['source'],fixture['inputs'])
            for relative in fixture['inputs']+fixture['tests']:
                file=(ROOT/relative).resolve();self.assertTrue(file.is_relative_to(ROOT));self.assertTrue(file.is_file(),relative)
        folder=ROOT/'examples/data/manifold-wave';manifest=json.loads((folder/'bake/manifest.json').read_text(encoding='utf8'));samples=json.loads((folder/'samples.json').read_text(encoding='utf8'))
        self.assertEqual(manifest['sampleTimes'],[i/8 for i in range(65)])
        self.assertEqual(manifest['topology'],samples['topology']);self.assertEqual(manifest['topology']['vertexCount'],482)
        self.assertEqual([(c['id'],c['kind'],c['unit']) for c in manifest['channels']],[('scalar','scalar','1'),('gradient','vector','1/m'),('position','position','m')])
        report=json.loads((folder/'bake/import-report.json').read_text(encoding='utf8'))
        self.assertEqual(report['sourceSha256'],hashlib.sha256((folder/'samples.json').read_bytes()).hexdigest())
        self.assertEqual(report['manifestSha256'],hashlib.sha256((folder/'bake/manifest.json').read_bytes()).hexdigest())
        for chunk in manifest['chunks']:
            file=(folder/'bake'/chunk['source']['uri']).resolve();self.assertTrue(file.is_relative_to((folder/'bake').resolve()))
            raw=file.read_bytes();self.assertEqual(len(raw),chunk['byteLength']);self.assertEqual(hashlib.sha256(raw).hexdigest(),chunk['sha256'])


if __name__=='__main__':unittest.main()
