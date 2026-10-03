import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {packageScene} from './package-scene.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const [input,output]=process.argv.slice(2);
if(!input||!output)throw new Error('Usage: node tools/build-asset-demo.mjs bundle.json output.html');
const folder=dirname(resolve(output));await mkdir(folder,{recursive:true});
const reports=[];
for(const [name,mode] of [['package','external'],['inline','inline'],['packed','packed']])
  reports.push(await packageScene(resolve(input),resolve(folder,name),{mode}));
const manifest=JSON.parse(await readFile(resolve(folder,'package/scene.json'),'utf8'));
const byteMap={};
for(const entry of manifest.assets.entries)if(entry.source.kind==='external'&&!Object.hasOwn(byteMap,entry.source.uri))
  byteMap[entry.source.uri]=(await readFile(resolve(folder,'package',entry.source.uri))).toString('base64');
const js=await build({entryPoints:[resolve(root,'web/asset-demo.ts')],bundle:true,platform:'browser',format:'iife',target:'es2022',write:false,minify:true});
const safe=value=>JSON.stringify(value).replaceAll('<','\\u003c').replaceAll('\u2028','\\u2028').replaceAll('\u2029','\\u2029');
const template=await readFile(resolve(root,'web/asset-demo.html'),'utf8'),css=await readFile(resolve(root,'web/asset-demo.css'),'utf8');
const html=template.replace('__STYLE__',()=>css).replace('__PACKAGE__',()=>safe(manifest)).replace('__BYTES__',()=>safe(byteMap))
  .replace('__SCRIPT__',()=>js.outputFiles[0].text.replace(/<\/script/gi,'<\\/script'));
await writeFile(output,html,'utf8');
await writeFile(resolve(folder,'package-build-info.json'),JSON.stringify({packages:reports,offline:'Embedded exact external-package byte map; host resolver, not file fetch.'},null,2)+'\n');
console.log(JSON.stringify({output:resolve(output),bytes:Buffer.byteLength(html),entries:manifest.assets.entries.length}));
