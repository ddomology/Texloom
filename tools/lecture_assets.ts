/** Public-runtime bridge for the Python lecture authoring orchestrator. */
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {assertBundle,createEvaluator,type Bundle} from '../src/index.js';
import {renderSvg} from '../src/render-svg.js';
import {SVG_2D_PROFILE,CANVAS_2D_PROFILE,GPU_3D_PROFILE,sceneFeatures} from '../src/capabilities.js';

const [command,input,output]=process.argv.slice(2);
if(command==='capabilities') {
  console.log(JSON.stringify({contract:'texloom-authoring-capabilities/1',renderers:[SVG_2D_PROFILE,CANVAS_2D_PROFILE,GPU_3D_PROFILE],
    operations:['capture','compile','validate','preview','sample','repair','video'],
    authoring:{input:'executed TeX lecture wrappers',mathReview:'manual',layout:'measured paragraph blocks; explicit scene associations',
      speech:'explicit English narration; duration estimated unless a measured audio track is supplied'},
    templates:['hausdorff-compact-closed','commuting-square','uniform-limit-continuity']}));
} else if(command==='text') {
  const bundle:Bundle=JSON.parse(readFileSync(input,'utf8'));assertBundle(bundle);
  mkdirSync(output,{recursive:true});
  const rows=[];
  for(const original of bundle.nodes) {
    if(!/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(original.id)||/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(original.id)||bundle.nodes.slice(0,bundle.nodes.indexOf(original)).some(node=>node.id.toLowerCase()===original.id.toLowerCase()))throw new Error('Unsafe or case-colliding paragraph identifier.');
    if(original.kind!=='tex')throw new Error('Lecture paragraph bundle accepts tex nodes only.');
    const resource=bundle.resources[original.resourceId];
    if(resource.kind!=='vector')throw new Error('Paragraph needs measured vector resource.');
    const [ix,iy,iw,ih]=resource.inkBounds;
    const m=resource.metrics;
    const left=Math.min(0,ix), top=Math.min(-m.height,iy);
    const right=Math.max(m.width,ix+iw), bottom=Math.max(m.depth,iy+ih);
    const width=Math.ceil(right-left+8),height=Math.ceil(bottom-top+8);
    const paragraph:Bundle={...bundle,viewport:{width,height},nodes:[{...original,x:4-left,y:4-top}],tracks:[],relations:[],
      camera:{x:0,y:0,zoom:1}};
    assertBundle(paragraph);
    const frame=createEvaluator(paragraph)(0);
    const file=original.id+'.svg';
    writeFileSync(resolve(output,file),renderSvg(frame,{background:'transparent',idPrefix:'lecture-'+original.id}));
    rows.push({id:original.id,file,width,height,inkBounds:resource.inkBounds,metrics:m,
      overflow:Math.max(0,iw-m.width),features:sceneFeatures(paragraph)});
  }
  writeFileSync(resolve(output,'metrics.json'),JSON.stringify(rows,null,2));
  console.log(JSON.stringify(rows));
} else if(command==='sample') {
  const bundle:Bundle=JSON.parse(readFileSync(input,'utf8'));assertBundle(bundle);
  const time=Number(process.argv[5]??0);
  if(!Number.isFinite(time)||time<0||time>bundle.duration)throw new Error('Sample time outside scene.');
  writeFileSync(output,renderSvg(createEvaluator(bundle)(time),{background:'#162b28'}));
  console.log(JSON.stringify({file:output,time,features:sceneFeatures(bundle)}));
} else throw new Error('Use capabilities, text bundle.json output-dir, or sample bundle.json frame.svg seconds.');
