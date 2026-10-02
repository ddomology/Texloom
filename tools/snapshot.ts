import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {assertBundle, evaluate} from '../src/index.ts';
import {renderSvg} from '../src/render-svg.ts';

const [input, output, seconds = '0'] = process.argv.slice(2);
if (!input || !output) {
  console.error('Usage: npm run snapshot -- bundle.json output.svg [seconds]');
  process.exit(2);
}
const time = Number(seconds);
if (!Number.isFinite(time)) throw new Error('Time must be finite seconds.');
const bundle = JSON.parse(await readFile(resolve(input), 'utf8'));
assertBundle(bundle);
const svg = renderSvg(evaluate(bundle, time));
await mkdir(dirname(resolve(output)), {recursive: true});
await writeFile(resolve(output), svg, 'utf8');
console.log(`SVG snapshot: ${resolve(output)} at ${time}s`);
