/** Observe public APIs without reimplementing evaluation in the verifier. */
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {prepareScene} from '../src/runtime.ts';
import {assertBundle} from '../src/schema.ts';
import {renderSvg} from '../src/render-svg.ts';

const [input, output, timesJSON] = process.argv.slice(2);
if (!input || !output || !timesJSON) throw new Error('Usage: port-regression.ts bundle.json output-dir times-json');
const bundle = JSON.parse(await readFile(input, 'utf8'));
assertBundle(bundle);
const times: number[] = JSON.parse(timesJSON);
if (!Array.isArray(times) || !times.length || times.some(t => !Number.isFinite(t) || t < 0 || t > bundle.duration)) {
  throw new Error('Fixture times must be finite and within scene duration');
}
const before = JSON.stringify(bundle);
const runtime = prepareScene(bundle);
const observe = (time: number) => {
  const {resources: _shared, ...frame} = runtime.sample(time);
  return frame;
};
const frames = times.map(observe);
// A reverse traversal must not mutate already-returned frames or change a result.
const frozenFrames = JSON.stringify(frames);
const svgs = times.map(t => renderSvg(runtime.sample(t), {idPrefix: 'port-reference'}));
for (let i = times.length - 1; i >= 0; i--) {
  if (JSON.stringify(observe(times[i])) !== JSON.stringify(frames[i]) || renderSvg(runtime.sample(times[i]), {idPrefix: 'port-reference'}) !== svgs[i]) {
    throw new Error(`Reverse seek changed frame ${times[i]}`);
  }
}
if (before !== JSON.stringify(bundle) || frozenFrames !== JSON.stringify(frames)) throw new Error('Sampling mutated input or previous frames');
const independent = prepareScene(bundle);
if (JSON.stringify(independent.sample(times[0])) !== JSON.stringify(runtime.sample(times[0]))) throw new Error('Independent runtimes differ');
await mkdir(output, {recursive: true});
await writeFile(resolve(output, 'observations.json'), JSON.stringify({manifest: runtime.manifest, frames}, null, 2) + '\n');
for (let i = 0; i < times.length; i++) await writeFile(resolve(output, `frame-${i}.svg`), svgs[i]);
