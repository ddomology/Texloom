import {readFile,writeFile,mkdir,rename,stat} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {build} from 'esbuild';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export async function lowerBlenderImports(input,output){
  if((await stat(input)).size>96*1024*1024)throw new Error('BLENDER_REQUEST_BUDGET: request exceeds 96 MiB.');
  const request=JSON.parse(await readFile(input,'utf8'));
  if(!request||Array.isArray(request)||typeof request!=='object'||Object.keys(request).length!==2||!Object.hasOwn(request,'bundle')||!Object.hasOwn(request,'imports'))
    throw new Error('BLENDER_REQUEST: expected {bundle,imports}.');
  const compiled=await build({entryPoints:[resolve(root,'src/resources/blender-manifest.ts')],bundle:true,platform:'node',format:'esm',target:'es2022',write:false});
  const api=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));
  const result=api.mergeBlenderManifests(request.bundle,request.imports);
  const destination=resolve(output);await mkdir(dirname(destination),{recursive:true});
  await writeFile(destination+'.tmp',JSON.stringify(result)+'\n','utf8');await rename(destination+'.tmp',destination);
  return {success:true,output:destination,imports:result.reports.length};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const [input,output,...extra]=process.argv.slice(2);
  try{
    if(!input||!output||extra.length)throw new Error('Usage: node tools/lower-blender.mjs request.json response.json');
    console.log(JSON.stringify(await lowerBlenderImports(resolve(input),resolve(output))));
  }catch(error){console.error(JSON.stringify({success:false,diagnostics:error.diagnostics??[{severity:'error',code:'BLENDER_IMPORT',message:error.message}]}));process.exitCode=1;}
}
