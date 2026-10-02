import {readFile} from 'node:fs/promises';
import {validateBundle} from '../src/index.ts';
const [input] = process.argv.slice(2);
if (!input) {console.error('Usage: npm run inspect -- bundle.json'); process.exit(2);}
const bundle = JSON.parse(await readFile(input, 'utf8'));
const diagnostics = validateBundle(bundle);
console.log(JSON.stringify({
  version: bundle.version, title: bundle.title, duration: bundle.duration,
  nodes: bundle.nodes?.length, resources: Object.keys(bundle.resources ?? {}).length,
  tracks: bundle.tracks?.length, relations: bundle.relations?.length,
  diagnostics, provenance: bundle.provenance,
}, null, 2));
if (diagnostics.some(d => d.severity === 'error')) process.exitCode = 1;
