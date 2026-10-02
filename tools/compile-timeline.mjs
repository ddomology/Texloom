import {readFile,writeFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
const args=process.argv.slice(2);
if(args.length!==3){console.error('Usage: node tools/compile-timeline.mjs <bundle.json> <program.json> <output.json>');process.exitCode=2;}
else try{
  const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
  const compiled=await build({entryPoints:[resolve(root,'src/timeline/compile.ts')],bundle:true,platform:'node',format:'esm',write:false});
  const {lowerTimeline}=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));
  const [bundle,program]=await Promise.all(args.slice(0,2).map(async path=>JSON.parse(await readFile(path,'utf8'))));
  const result=lowerTimeline(program,bundle);
  await writeFile(args[2],JSON.stringify(result,null,2)+'\n','utf8');
  console.log(JSON.stringify({success:true,tracks:result.tracks.length,clips:result.timeline.clips.length,cues:result.timeline.cues.length}));
}catch(error){console.error(JSON.stringify({success:false,diagnostics:error.diagnostics??[{severity:'error',code:'TIMELINE_COMPILE',message:error.message}]}));process.exitCode=1;}
