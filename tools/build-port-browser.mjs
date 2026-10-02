import {build} from 'esbuild';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (!process.argv[2]) throw new Error('Usage: build-port-browser.mjs output.js');
await build({entryPoints: [resolve(root, 'tools/port-browser.ts')], outfile: process.argv[2],
  bundle: true, platform: 'browser', format: 'iife', target: 'es2022'});
