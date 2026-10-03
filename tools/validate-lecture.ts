import {readFileSync} from 'node:fs';
import {prepareChalkspaceLecture} from '../adapters/chalkspace-lecture.js';
async function main(){
  let runtime;
  try{
    const bytes=readFileSync(0);if(bytes.byteLength>96*1024*1024)throw new Error('LECTURE_SIZE: input exceeds 96 MiB.');
    runtime=await prepareChalkspaceLecture(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));
    console.log(JSON.stringify({success:true,scenes:Object.fromEntries(Object.entries(runtime.manifest.scenes)
      .map(([id,scene])=>[id,{duration:scene.duration,viewport:scene.viewport}])),clips:runtime.manifest.clips}));
  }catch(error){console.log(JSON.stringify({success:false,error:error instanceof Error?error.message:String(error)}));process.exitCode=1;}
  finally{runtime?.dispose();}
}
void main();
