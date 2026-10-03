import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {build} from 'esbuild';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
/** Stable object keys; array order and all resource values remain unchanged. */
export function canonicalJson(value){
  const ordered=input=>Array.isArray(input)?input.map(ordered):input!==null&&typeof input==='object'
    ?Object.fromEntries(Object.keys(input).sort().map(key=>[key,ordered(input[key])])):input;
  return JSON.stringify(ordered(value))+'\n';
}
let corePromise;
async function core(){
  return corePromise??=build({entryPoints:[resolve(root,'src/index.ts')],bundle:true,platform:'node',format:'esm',write:false})
    .then(result=>import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64')));
}
async function publish(path,bytes){
  const temporary=path+'.tmp';await writeFile(temporary,bytes);await rename(temporary,path);
}
/** No TeX execution, network access, or asset URL inference occurs here. */
export async function packageScene(input,out,{mode='external'}={}){
  if(!['external','inline','packed'].includes(mode))throw new Error('PACKAGE_MODE: use external, inline or packed.');
  const api=await core(),bundle=JSON.parse(await readFile(input,'utf8'));
  api.assertBundle(bundle);api.createEvaluator(bundle);
  const {resources,...scene}=bundle,byHash=new Map(),entries=[];
  for(const id of Object.keys(resources).sort()){
    // Native text revisions fingerprint existing paint-key insertion order.
    // Preserve it exactly; only the package manifest uses canonical ordering.
    const resource=resources[id],data=JSON.stringify(resource)+'\n',bytes=Buffer.from(data,'utf8'),sha256=digest(bytes);
    const previous=byHash.get(sha256);
    if(previous&&!previous.bytes.equals(bytes))throw new Error('PACKAGE_HASH_COLLISION: resource bytes differ.');
    if(!previous)byHash.set(sha256,{data,bytes});
    entries.push({id,kind:resource.kind,mediaType:'application/vnd.texloom.resource+json',byteLength:bytes.length,sha256,
      bounds:resource.kind==='mesh'||resource.kind==='curve3d'?(resource.bounds===null?null:{min:[...resource.bounds.min],max:[...resource.bounds.max]}):
        resource.kind==='vector'?[...resource.inkBounds]:[0,0,1,1],
      source:mode==='inline'?{kind:'inline',data}:{kind:'external',uri:`assets/${sha256}.json`}});
  }
  let packed;
  if(mode==='packed'){
    let offset=0;const positions=new Map(),chunks=[];
    for(const [sha256,payload] of [...byHash.entries()].sort(([a],[b])=>a<b?-1:a>b?1:0)){
      positions.set(sha256,{offset,length:payload.bytes.length});chunks.push(payload.bytes);offset+=payload.bytes.length;
      if(!Number.isSafeInteger(offset))throw new Error('PACKAGE_SIZE: packed size exceeds safe integer bytes.');
    }
    const bytes=Buffer.concat(chunks),uri=`assets/${digest(bytes)}.bin`;
    packed={bytes,uri};
    for(const entry of entries)entry.source={kind:'external',uri,byteRange:positions.get(entry.sha256)};
  }
  const manifest={contract:'texloom-package/1',scene,assets:{version:1,requiredFeatures:api.sceneFeatures(bundle),entries}};
  const diagnostics=api.validateScenePackage(manifest);
  if(diagnostics.some(d=>d.severity==='error')){
    const error=new Error('PACKAGE_INVALID: generated package failed validation.');error.diagnostics=diagnostics;throw error;
  }
  // Validate all declarations before publishing any artifact. Resource files
  // are content addressed, and the manifest is the final atomic publication.
  await mkdir(out,{recursive:true});
  if(mode!=='inline'&&entries.length){
    await mkdir(resolve(out,'assets'),{recursive:true});
    if(packed)await publish(resolve(out,packed.uri),packed.bytes);
    else for(const [sha256,payload] of byHash)await publish(resolve(out,`assets/${sha256}.json`),payload.bytes);
  }
  await publish(resolve(out,'scene.json'),canonicalJson(manifest));
  return {output:resolve(out,'scene.json'),mode,entries:entries.length,uniquePayloads:byHash.size,
    resourceBytes:[...byHash.values()].reduce((sum,payload)=>sum+payload.bytes.length,0),
    manifestSha256:digest(Buffer.from(canonicalJson(manifest),'utf8'))};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const args=process.argv.slice(2),input=args.shift(),outIndex=args.indexOf('--out');
  try{
    if(!input||outIndex<0||!args[outIndex+1])throw new Error('Usage: node tools/package-scene.mjs bundle.json --out directory [--inline|--packed]');
    const out=args[outIndex+1];args.splice(outIndex,2);
    if(args.length>1||args.length===1&&!['--inline','--packed'].includes(args[0]))throw new Error('Choose only one of --inline or --packed.');
    console.log(JSON.stringify(await packageScene(resolve(input),resolve(out),{mode:args[0]==='--inline'?'inline':args[0]==='--packed'?'packed':'external'})));
  }catch(error){console.error(JSON.stringify({success:false,diagnostics:error.diagnostics??[{severity:'error',code:'PACKAGE_BUILD',message:error.message}]}));process.exitCode=1;}
}
