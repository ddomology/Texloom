import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve,dirname} from 'node:path';
import {build} from 'esbuild';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const escapeHtml=value=>value.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
export async function buildGpuPlayer(input,output){
  const bundle=JSON.parse(await readFile(input,'utf8'));
  const core=await build({entryPoints:[resolve(root,'src/index.ts')],bundle:true,platform:'node',format:'esm',write:false});
  const api=await import('data:text/javascript;base64,'+Buffer.from(core.outputFiles[0].text).toString('base64'));
  api.assertBundle(bundle);const frame=api.prepareScene(bundle).sample(0);
  if(!frame.space3d?.instances.length||!bundle.space3d?.camera?.projection)
    throw new Error('GPU_PLAYER_SCENE: a scene with mesh instances and an explicit camera projection is required.');
  const license=await readFile(resolve(root,'node_modules/three/LICENSE'),'utf8');
  const js=await build({entryPoints:[resolve(root,'web/gpu-player.ts')],bundle:true,platform:'browser',format:'iife',target:'es2022',write:false,minify:true,
    banner:{js:'/*! Three.js — MIT license\n'+license.replace(/\*\//g,'* /')+'\n*/'}});
  const [template,css]=await Promise.all([readFile(resolve(root,'web/gpu-player.html'),'utf8'),readFile(resolve(root,'web/gpu-player.css'),'utf8')]);
  const data=JSON.stringify(bundle).replaceAll('<','\\u003c').replaceAll('\u2028','\\u2028').replaceAll('\u2029','\\u2029');
  const html=template.replaceAll('__TITLE__',()=>escapeHtml(bundle.title)).replace('__STYLE__',()=>css)
    .replace('__BUNDLE__',()=>data).replace('__SCRIPT__',()=>js.outputFiles[0].text.replace(/<\/script/gi,'<\\/script'));
  const destination=resolve(output);await mkdir(dirname(destination),{recursive:true});
  await writeFile(destination+'.tmp',html,'utf8');await rename(destination+'.tmp',destination);
  return {output:destination,bytes:Buffer.byteLength(html),instances:frame.space3d.instances.length,duration:bundle.duration,renderer:'WebGL2 + native TeX Canvas2D'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const [input,output,...extra]=process.argv.slice(2);
  try{
    if(!input||!output||extra.length)throw new Error('Usage: node tools/build-gpu-player.mjs bundle.json player.html');
    console.log(JSON.stringify(await buildGpuPlayer(resolve(input),resolve(output))));
  }catch(error){console.error(JSON.stringify({success:false,diagnostics:error.diagnostics??[{severity:'error',code:'GPU_PLAYER_BUILD',message:error.message}]}));process.exitCode=1;}
}
