import {readFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const compiled=await build({entryPoints:[resolve(root,'src/index.ts')],bundle:true,platform:'node',format:'esm',write:false});
const {validateBundle,prepareOperationGraph,createEvaluator}=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));
const args=process.argv.slice(2), prepare=args.includes('--prepare-operations');
const files=args.filter(arg=>!arg.startsWith('--'));
if(files.length!==1||args.some(arg=>arg.startsWith('--')&&arg!=='--prepare-operations')) {
  console.error('Usage: node tools/validate-bundle.mjs <bundle.json> [--prepare-operations]');
  process.exitCode=2;
} else try {
  const bundle=JSON.parse(await readFile(files[0],'utf8'));
  const diagnostics=validateBundle(bundle);
  if(diagnostics.some(d=>d.severity==='error')) {
    console.log(JSON.stringify(diagnostics));process.exitCode=1;
  } else {
    // A valid graph alone can still cycle through a geometry/property binding.
    // Prepare the complete runtime plan before publishing a compiled bundle.
    // No frame is sampled and no defaults are written into the authored input.
    createEvaluator(bundle);
    if(prepare) {
      if(!bundle.operationGraph) {
        console.log(JSON.stringify([{severity:'error',code:'OPERATION_GRAPH_REQUIRED',message:'This bundle has no operationGraph.',path:'$.operationGraph'}]));
        process.exitCode=1;
      } else console.log(JSON.stringify(prepareOperationGraph(bundle.operationGraph,bundle),null,2));
    } else console.log(JSON.stringify(diagnostics));
  }
} catch(error) {
  console.log(JSON.stringify(error.diagnostics??[{severity:'error',code:'BUNDLE_READ',message:error.message,path:'$'}]));
  process.exitCode=1;
}
