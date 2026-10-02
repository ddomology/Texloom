import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve,dirname} from 'node:path';
import {build} from 'esbuild';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const escapeHtml=s=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export async function buildPlayer(input,output){
  const bundle=JSON.parse(await readFile(input,'utf8'));
  const core=await build({entryPoints:[resolve(root,'src/index.ts')],bundle:true,platform:'node',format:'esm',write:false});
  const {assertBundle}=await import('data:text/javascript;base64,'+Buffer.from(core.outputFiles[0].text).toString('base64'));
  assertBundle(bundle);
  const js=await build({entryPoints:[resolve(root,'src/player.ts')],bundle:true,platform:'browser',format:'iife',target:'es2022',write:false,minify:true});
  const template=await readFile(resolve(root,'web/player.html'),'utf8');
  const css=await readFile(resolve(root,'web/style.css'),'utf8');
  const script=js.outputFiles[0].text.replace(/<\/script/gi,'<\\/script');
  const data=JSON.stringify(bundle).replaceAll('<','\\u003c').replaceAll('\u2028','\\u2028').replaceAll('\u2029','\\u2029');
  const html=template.replaceAll('__TITLE__',()=>escapeHtml(bundle.title))
    .replace('__STYLE__',()=>css).replace('__BUNDLE__',()=>data).replace('__SCRIPT__',()=>script);
  await mkdir(dirname(resolve(output)),{recursive:true});await writeFile(output,html,'utf8');
  return {output:resolve(output),bytes:Buffer.byteLength(html),nodes:bundle.nodes.length,duration:bundle.duration};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const [input,output]=process.argv.slice(2);
  if(!input||!output){console.error('Usage: node tools/build-player.mjs bundle.json player.html');process.exit(2);}
  console.log(JSON.stringify(await buildPlayer(resolve(input),resolve(output))));
}
