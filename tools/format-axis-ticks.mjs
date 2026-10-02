/** Batch numeric TeX labels use the exact same formatter as the runtime API. */
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
try {
  let input='';for await(const chunk of process.stdin)input+=chunk;
  const request=JSON.parse(input);
  if(!Array.isArray(request))throw new Error('Tick formatter input must be a catalog list.');
  const compiled=await build({entryPoints:[resolve(root,'src/geometry/data-space.ts')],bundle:true,platform:'node',format:'esm',write:false});
  const {formatTickLabels}=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));
  console.log(JSON.stringify(request.map(({values,precision,notation})=>formatTickLabels(values,{precision,notation}))));
} catch(error) {
  console.error(JSON.stringify({code:error.code??'AXIS_LABEL_FORMAT',message:error.message}));
  process.exitCode=1;
}
