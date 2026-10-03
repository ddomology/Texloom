/** Compact iframe presentation of the standard 2D/3D player runtimes. */
import {readFile,writeFile,mkdir,rename,rm} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {buildPlayer} from './build-player.mjs';
import {buildGpuPlayer} from './build-gpu-player.mjs';

// Retain the existing DOM hooks and controls: the runtime owns rendering,
// playback, seeking, resize and capture. Only the surrounding layout changes.
const EMBED_STYLE=`
html[data-lecture-player],html[data-lecture-player] body{width:100%;height:100%;margin:0;overflow:hidden;background:#0e241c}
html[data-lecture-player] main{width:100%;height:100%;max-width:none;margin:0;padding:0}
html[data-lecture-player] header,html[data-lecture-player] .intro,html[data-lecture-player] .inspector,
html[data-lecture-player] .architecture,html[data-lecture-player] .explanation,html[data-lecture-player] footer,
html[data-lecture-player] .viewer-heading,html[data-lecture-player] .parameter-controls,
html[data-lecture-player] .timeline-labels,html[data-lecture-player] #download-svg{display:none!important}
html[data-lecture-player] .workspace{display:block;width:100%;height:100%;margin:0;padding:0}
html[data-lecture-player] .viewer{display:flex;flex-direction:column;width:100%;height:100%;min-height:0;
  border:0;border-radius:0;box-shadow:none;overflow:hidden}
html[data-lecture-player] #stage{position:relative;flex:1 1 0;width:100%;min-height:0;height:auto;
  aspect-ratio:auto!important;overflow:hidden;line-height:0}
html[data-lecture-player] #stage>svg,html[data-lecture-player] #stage>canvas{display:block;width:100%;height:100%;object-fit:contain}
html[data-lecture-player] .transport{flex:0 0 auto;padding:8px 12px 10px;margin:0;border-top:1px solid #ffffff18;background:#102720}
html[data-lecture-player] .transport-top,html[data-lecture-player] .transport-row{display:flex;align-items:center;gap:9px;height:32px;margin:0}
html[data-lecture-player] .clock{margin:0;white-space:nowrap;font-size:10px}
html[data-lecture-player] #play{height:30px;min-width:34px;flex:0 0 auto}
html[data-lecture-player] #restart{flex:0 0 auto}
html[data-lecture-player] .speed-label{display:flex;align-items:center;gap:5px;margin-left:auto;font-size:10px}
html[data-lecture-player] #speed{font-size:10px;padding:5px}
html[data-lecture-player] #timeline{display:block;width:100%;height:12px;margin:8px 0 0;cursor:pointer}
html[data-lecture-player] #error{position:absolute;z-index:5;bottom:76px;left:8px;right:8px;margin:0;max-height:70%;overflow:auto}
html[data-lecture-player] body.capture #stage{height:100vh}
@media(max-width:300px){html[data-lecture-player] .transport{padding-left:8px;padding-right:8px}
 html[data-lecture-player] .transport-top,html[data-lecture-player] .transport-row{gap:5px}
 html[data-lecture-player] .clock{font-size:9px}}
`;

export async function buildLecturePlayer(input,output){
  input=resolve(input);output=resolve(output);
  const bundle=JSON.parse(await readFile(input,'utf8'));
  await mkdir(dirname(output),{recursive:true});
  const temporary=output+'.lecture-'+randomUUID()+'.tmp';
  try{
    const result=await (bundle.space3d?buildGpuPlayer:buildPlayer)(input,temporary);
    const base=await readFile(temporary,'utf8');
    if(!/<html\b/i.test(base)||!base.includes('</head>'))throw new Error('LECTURE_PLAYER_TEMPLATE: missing document hooks.');
    const html=base.replace(/<html\b/i,'<html data-lecture-player="1"')
      .replace('</head>','<style id="lecture-player-layout">'+EMBED_STYLE+'</style></head>');
    await writeFile(temporary,html,'utf8');
    await rename(temporary,output);
    return {...result,output,bytes:Buffer.byteLength(html),presentation:'lecture-embed/1',
      renderer:bundle.space3d?'WebGL2 + native TeX Canvas2D':'SVG'};
  }finally{
    await rm(temporary,{force:true});
    await rm(temporary+'.tmp',{force:true});
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const [input,output,...extra]=process.argv.slice(2);
  try{
    if(!input||!output||extra.length)throw new Error('Usage: node tools/build-lecture-player.mjs bundle.json player.html');
    console.log(JSON.stringify(await buildLecturePlayer(input,output)));
  }catch(error){
    console.error(JSON.stringify({success:false,diagnostics:error.diagnostics??[
      {severity:'error',code:'LECTURE_PLAYER_BUILD',message:error.message}]}));
    process.exitCode=1;
  }
}
