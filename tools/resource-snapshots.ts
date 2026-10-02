import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {evaluate,type Bundle} from '../src/index.ts';
import {renderSvg} from '../src/render-svg.ts';
const [source,output]=process.argv.slice(2);
const bundle:Bundle=JSON.parse(await readFile(source,'utf8'));
await mkdir(output,{recursive:true});
for(const [id,resource] of Object.entries(bundle.resources)){
  if(resource.kind!=='vector')continue;
  const [x,y,w,h]=resource.inkBounds;
  const width=Math.ceil(w+40),height=Math.ceil(h+40);
  const sample:Bundle={version:'0.1',title:id,units:'bp',duration:1,viewport:{width,height},camera:{x:0,y:0,zoom:1},
    nodes:[{id:'asset',kind:'tex',resourceId:id,x:20-x,y:20-y}],tracks:[],relations:[],resources:{[id]:resource}};
  await writeFile(resolve(output,`${id}.svg`),renderSvg(evaluate(sample,0)),'utf8');
}
