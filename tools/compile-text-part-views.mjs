import {readFile,writeFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';

const args=process.argv.slice(2),options={};
let valid=args.length===6;
for(let index=0;index<args.length;index+=2){
  const key=args[index];
  if(!['--scene','--views','--out'].includes(key)||Object.hasOwn(options,key)||!args[index+1])valid=false;
  else options[key]=args[index+1];
}
if(!valid){
  console.error(JSON.stringify({success:false,diagnostics:[{severity:'error',code:'TEXT_PART_VIEW_USAGE',message:'Usage: node tools/compile-text-part-views.mjs --scene input.json --views records.json --out output.json'}]}));
  process.exitCode=2;
}else try{
  const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
  const compiled=await build({entryPoints:[resolve(root,'src/ir/text-part-views.ts')],bundle:true,platform:'node',format:'esm',write:false});
  const {lowerTextPartViews}=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));
  const [scene,records]=await Promise.all([options['--scene'],options['--views']].map(async path=>JSON.parse(await readFile(path,'utf8'))));
  const result=lowerTextPartViews(scene,records);
  await writeFile(options['--out'],JSON.stringify(result,null,2)+'\n','utf8');
  console.log(JSON.stringify({success:true,views:records.length,nodes:result.nodes.length,resources:Object.keys(result.resources).length}));
}catch(error){
  console.error(JSON.stringify({success:false,diagnostics:error.diagnostics??[{severity:'error',code:'TEXT_PART_VIEW_COMPILE',message:error.message}]}));
  process.exitCode=1;
}
