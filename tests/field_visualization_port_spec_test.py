"""Validate the independent PR35 contract without changing historical raster fixtures."""
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
from port_baseline import validate_spec


class FieldVisualizationPortSpecTests(unittest.TestCase):
    def test_pinned_sources_and_native_fixture_registry(self):
        spec = json.loads((ROOT / 'docs/ports/features/pr35-field-visualization.json').read_text(encoding='utf8'))
        suite = json.loads((ROOT / 'tests/fixtures/field-visualization/suite.json').read_text(encoding='utf8'))
        ids = {fixture['id'] for fixture in suite['fixtures']}
        self.assertEqual(suite['schemaVersion'], 1)
        self.assertEqual(len(ids), len(suite['fixtures']))
        self.assertEqual(validate_spec(spec, ids), [])
        for fixture in suite['fixtures']:
            self.assertIn(fixture['source'], fixture['inputs'])
            for relative in fixture['inputs'] + fixture['tests']:
                target = (ROOT / relative).resolve()
                self.assertTrue(target.is_relative_to(ROOT))
                self.assertTrue(target.is_file(), relative)
        self.assertEqual(spec['implementation']['mode'], 'independent-implementation')
        self.assertTrue(all(item['project'] == 'blender/blender' for item in spec['upstream']))


if __name__ == '__main__':
    unittest.main()
