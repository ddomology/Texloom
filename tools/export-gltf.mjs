/** Export the supported spatial profile into a new, atomically published folder. */
import {readFile,writeFile,mkdir,rename,stat,lstat,mkdtemp,rm} from 'node:fs/promises';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {build} from 'esbuild';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
async function requireAbsent(path){
  try{await lstat(path);}catch(error){if(error.code==='ENOENT')return;throw error;}
  throw new Error('GLTF_EXPORT_EXISTS: output already exists; choose a new directory.');
}
export async function exportGltfFile(input,output){
  if((await stat(input)).size>96*1024*1024)throw new Error('GLTF_EXPORT_BUDGET: bundle exceeds 96 MiB.');
  const destination=resolve(output);
  await requireAbsent(destination);
  const bundle=JSON.parse(await readFile(input,'utf8'));
  const compiled=await build({entryPoints:[resolve(root,'src/resources/gltf-profile.ts')],bundle:true,platform:'node',format:'esm',target:'es2022',write:false});
  const api=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));
  const result=api.exportGltfAsset(bundle);
  const files=new Map([
    ['scene.gltf',Buffer.from(JSON.stringify(result.asset.document,null,2)+'\n')],
    ['texloom-sidecar.json',Buffer.from(JSON.stringify(result.sidecar,null,2)+'\n')],
    ['conversion-report.json',Buffer.from(JSON.stringify(result.report,null,2)+'\n')],
  ]);
  if(!Array.isArray(result.asset.document.buffers)||result.asset.document.buffers.length!==result.asset.buffers.length)
    throw new Error('GLTF_EXPORT_BUFFERS: exporter returned inconsistent buffers.');
  let total=0;
  for(let i=0;i<result.asset.buffers.length;i++){
    const declaration=result.asset.document.buffers[i],encoded=result.asset.buffers[i];
    if(typeof declaration.uri!=='string'||!/^buffer-[0-9]{3}\.bin$/.test(declaration.uri)||files.has(declaration.uri))
      throw new Error('GLTF_EXPORT_PATH: exporter must use unique portable buffer-NNN.bin filenames.');
    if(typeof encoded!=='string'||encoded.length>4*Math.ceil(64*1024*1024/3))throw new Error('GLTF_EXPORT_BUDGET: invalid encoded buffer.');
    const bytes=Buffer.from(encoded,'base64');total+=bytes.byteLength;
    if(bytes.toString('base64')!==encoded||bytes.byteLength!==declaration.byteLength||total>64*1024*1024)
      throw new Error('GLTF_EXPORT_BUFFERS: buffer encoding, length or total budget is invalid.');
    files.set(declaration.uri,bytes);
  }
  await mkdir(dirname(destination),{recursive:true});
  const temporary=await mkdtemp(join(dirname(destination),'.texloom-gltf-'));
  try{
    for(const [name,bytes] of files)await writeFile(join(temporary,name),bytes,{flag:'wx'});
    await requireAbsent(destination);
    await rename(temporary,destination);
  }catch(error){await rm(temporary,{recursive:true,force:true});throw error;}
  return {success:true,output:destination,files:[...files.keys()],report:result.report};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const [input,flag,output,...extra]=process.argv.slice(2);
  try{
    if(!input||flag!=='--out'||!output||extra.length)throw new Error('Usage: node tools/export-gltf.mjs bundle.json --out new-directory');
    console.log(JSON.stringify(await exportGltfFile(resolve(input),resolve(output))));
  }catch(error){console.error(JSON.stringify({success:false,diagnostics:error.diagnostics??[{severity:'error',code:'GLTF_EXPORT',message:error.message}]}));process.exitCode=1;}
}
