import {build} from 'esbuild';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
if(!process.argv[2])throw new Error('Usage: node tools/build-chalkspace-runtime.mjs output-directory');
const out=resolve(process.argv[2]);await mkdir(out,{recursive:true});
const dirty=execFileSync('git',['status','--porcelain','--untracked-files=all','--','src','adapters','tools/build-chalkspace-runtime.mjs','tools/validate-lecture.ts','package.json','package-lock.json'],{cwd:root,encoding:'utf8'}).trim();
const sourceCommit=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
if(dirty&&!process.argv.includes('--development'))throw new Error('Commit all runtime inputs before generating a distributable. Use --development only for local iteration.');
const three=JSON.parse(await readFile(resolve(root,'node_modules/three/package.json'),'utf8'));
const threeLicense=await readFile(resolve(root,'node_modules/three/LICENSE'),'utf8');
const common={bundle:true,minify:true,sourcemap:false,legalComments:'inline',target:'es2022',
  banner:{js:`/*! Three.js ${three.version}\n${threeLicense.replaceAll('*/','* /')}\n*/`}};
await build({...common,entryPoints:[resolve(root,'adapters/chalkspace-lecture.ts')],platform:'browser',format:'iife',globalName:'TexloomChalkspace',outfile:resolve(out,'texloom-lecture.js')});
await build({...common,entryPoints:[resolve(root,'tools/validate-lecture.ts')],platform:'node',format:'cjs',outfile:resolve(out,'texloom-lecture-validate.cjs')});
const files={};for(const name of ['texloom-lecture.js','texloom-lecture-validate.cjs'])files[name]=createHash('sha256').update(await readFile(resolve(out,name))).digest('hex');
await writeFile(resolve(out,'texloom-lecture-provenance.json'),JSON.stringify({contract:'texloom-chalkspace-distribution/1',repository:'ddomology/Texloom',sourceCommit,development:!!dirty,
  node:process.version,esbuild:JSON.parse(await readFile(resolve(root,'node_modules/esbuild/package.json'),'utf8')).version,
  dependencies:{three:{version:three.version,license:'MIT',licenseSha256:createHash('sha256').update(threeLicense).digest('hex')}},files},null,2)+'\n');
console.log(JSON.stringify({directory:out,sourceCommit,development:!!dirty,files}));
