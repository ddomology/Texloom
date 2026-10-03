import {build} from 'esbuild';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile, readdir} from 'node:fs/promises';
import {dirname, resolve, relative} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2];
if (!target) throw new Error('Usage: node tools/build-lemniro-package.mjs output-directory');
const out = resolve(target);
const commit = execFileSync('git', ['rev-parse', 'HEAD'], {cwd:root, encoding:'utf8'}).trim();
// Publish only a reviewed commit, never a dirty working-tree build under its ID.
if (execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {cwd:root, encoding:'utf8'}).trim())
  throw new Error('Commit tracked changes before building the public runtime package.');
await mkdir(out, {recursive:true});
if ((await readdir(out)).length) throw new Error('Choose an empty output directory to exclude stale artifacts.');

const entryPoints = {index:resolve(root,'src/index.ts'), lemniro:resolve(root,'adapters/lemniro.ts')};
await build({entryPoints, outdir:out, outExtension:{'.js':'.mjs'}, bundle:true,
  platform:'browser', format:'esm', target:'es2022', splitting:true,
  minify:true, sourcemap:false, legalComments:'none'});
const config = {compilerOptions:{
  target:'ES2022', module:'NodeNext', moduleResolution:'NodeNext', strict:true,
  declaration:true, emitDeclarationOnly:true, allowImportingTsExtensions:true,
  skipLibCheck:true, rootDir:root, declarationDir:resolve(out,'types'),
  lib:['ES2022','DOM'], types:[], removeComments:true,
}, files:Object.values(entryPoints)};
const configPath = `${out}.tsconfig.json`;
await writeFile(configPath, JSON.stringify(config,null,2)+'\n');
execFileSync(process.execPath, [resolve(root,'node_modules/typescript/bin/tsc'), '--project', configPath], {cwd:root,stdio:'inherit'});

const packageJson = JSON.parse(await readFile(resolve(root,'package.json'),'utf8'));
await writeFile(resolve(out,'package.json'), JSON.stringify({
  name:'texloom', version:packageJson.version, private:true, type:'module',
  description:'Compiled Texloom runtime for Lemniro; source revision recorded in provenance.json.',
  exports:{'.':{types:'./types/src/index.d.ts',import:'./index.mjs'},
    './lemniro':{types:'./types/adapters/lemniro.d.ts',import:'./lemniro.mjs'}},
  files:['*.mjs','types','provenance.json'], engines:{node:'>=22'},
},null,2)+'\n');

const files = (await readdir(out,{recursive:true})).filter(file=>/\.(mjs|d\.ts)$/.test(file)).sort();
const hashes = {};
for (const file of files) hashes[file.replaceAll('\\','/')] = createHash('sha256').update(await readFile(resolve(out,file))).digest('hex');
await writeFile(resolve(out,'provenance.json'), JSON.stringify({
  contract:'texloom-lemniro-distribution/1', repository:'ddomology/Texloom', sourceCommit:commit,
  generator:'tools/build-lemniro-package.mjs', node:process.version,
  esbuild:JSON.parse(await readFile(resolve(root,'node_modules/esbuild/package.json'),'utf8')).version,
  typescript:JSON.parse(await readFile(resolve(root,'node_modules/typescript/package.json'),'utf8')).version, files:hashes,
},null,2)+'\n');
console.log(JSON.stringify({directory:out,sourceCommit:commit,files:files.length,
  pack:`npm pack ${relative(process.cwd(),out)} --pack-destination <output-directory>`}));
