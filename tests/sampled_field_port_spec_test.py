"""The temporal sample contract registers all original external data dependencies."""
import hashlib
import json
from pathlib import Path
import sys
import unittest

ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'tools'))
from port_baseline import validate_spec


class SampledFieldPortSpecTests(unittest.TestCase):
    def test_contract_registry_and_checked_in_producer_hashes(self):
        spec=json.loads((ROOT/'docs/ports/features/pr36-temporal-bake.json').read_text())
        suite=json.loads((ROOT/'tests/fixtures/temporal-samples/suite.json').read_text());ids={f['id'] for f in suite['fixtures']}
        self.assertEqual(validate_spec(spec,ids),[]);self.assertEqual(len(ids),len(suite['fixtures']))
        for fixture in suite['fixtures']:
            self.assertIn(fixture['source'],fixture['inputs'])
            for path in fixture['inputs']+fixture['tests']:
                target=(ROOT/path).resolve();self.assertTrue(target.is_relative_to(ROOT));self.assertTrue(target.is_file(),path)
        folder=ROOT/'examples/data/temporal-samples';report=json.loads((folder/'bake/import-report.json').read_text())
        self.assertEqual(report['sourceSha256'],hashlib.sha256((folder/'samples.json').read_bytes()).hexdigest())
        self.assertEqual(report['manifestSha256'],hashlib.sha256((folder/'bake/manifest.json').read_bytes()).hexdigest())
        manifest=json.loads((folder/'bake/manifest.json').read_text())
        for chunk in manifest['chunks']:
            data=(folder/'bake'/chunk['source']['uri']).read_bytes();self.assertEqual(len(data),chunk['byteLength']);self.assertEqual(hashlib.sha256(data).hexdigest(),chunk['sha256'])


if __name__=='__main__':unittest.main()
