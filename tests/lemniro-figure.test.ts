import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {validateLemniroFigureReference,assertLemniroFigureReference,prepareLemniroFigure} from '../adapters/lemniro-figure.ts';
import {prepareScene} from '../src/runtime.ts';
import {sceneFeatures} from '../src/capabilities.ts';
import type {Bundle} from '../src/schema.ts';

const base='https://example.test/Lemniro/';
const hash=(data:string|Uint8Array)=>createHash('sha256').update(data).digest('hex');
const encoded=(value:string)=>new TextEncoder().encode(value);
const failure=(code:RegExp)=>(error:any)=>error?.name!=='TypeError'&&code.test(JSON.stringify(error?.diagnostics??error?.message??error));
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>resolve=yes);return {promise,resolve};}
async function until(predicate:()=>boolean){const end=Date.now()+3000;while(Date.now()<end){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,1));}assert.ok(predicate(),'Async milestone was not reached');}
function fixture(inline=false){
  const bundle:Bundle={version:'0.3',title:'Portable figure',duration:2,units:'bp',viewport:{width:100,height:60},camera:{x:0,y:0,zoom:1},relations:[],
    nodes:[{id:'label',kind:'tex',resourceId:'native',x:10,y:20,clip:{d:'M0 0H100V60H0Z'}}],tracks:[{target:'label',property:'x',keys:[[0,10],[2,30]]}],
    resources:{native:{kind:'vector',metrics:{width:8,height:9,depth:1},inkBounds:[0,-9,8,10],items:[{kind:'group',clip:{d:'M0 -10H10V1H0Z'},children:[{kind:'path',d:'M0 0L8 0L4 -9Z',style:{fill:'#123456'}}]}]}}};
  const {resources,...scene}=structuredClone(bundle),assetText=JSON.stringify(resources.native);
  const pkg:any={contract:'texloom-package/1',scene,assets:{version:1,requiredFeatures:sceneFeatures(bundle),entries:[{id:'native',kind:'vector',mediaType:'application/vnd.texloom.resource+json',byteLength:encoded(assetText).byteLength,sha256:hash(assetText),bounds:[0,-9,8,10],source:inline?{kind:'inline',data:assetText}:{kind:'external',uri:'assets/native.json'}}]}};
  const ref:any={contract:'texloom-figure/1',id:'portable-figure',manifestPath:'figures/circle/scene.json',manifestSha256:'',posterPath:'figures/circle/poster.svg',title:'A portable figure',description:'Native text and a moving point.',width:100,height:60,duration:2};
  const result={bundle,pkg,ref,assetText,manifestText:''};refresh(result);return result;
}
function refresh(data:ReturnType<typeof fixture>){data.manifestText=JSON.stringify(data.pkg);data.ref.manifestSha256=hash(data.manifestText);}
function transport(data:ReturnType<typeof fixture>,assetResponse?:(url:string,init?:RequestInit)=>Promise<Response>|Response){
  const calls:{url:string;init?:RequestInit}[]=[];
  const fetcher:typeof fetch=async(input,init)=>{const url=String(input);calls.push({url,init});return url.endsWith('/scene.json')?new Response(data.manifestText):assetResponse?assetResponse(url,init):new Response(data.assetText);};
  return {fetcher,calls};
}

test('reference validation rejects malformed IDs, hashes, dimensions, accessors and escaping paths without side effects',()=>{
  const good=fixture().ref;assert.deepEqual(validateLemniroFigureReference(good),[]);assert.doesNotThrow(()=>assertLemniroFigureReference(good));
  for(const patch of [{id:'Upper'},{id:'bad id'},{manifestSha256:'z'.repeat(64)},{width:0},{height:16385},{duration:-1},{title:'x'.repeat(257)},{description:'x'.repeat(4097)}])assert.ok(validateLemniroFigureReference({...good,...patch}).length);
  for(const path of ['../scene.json','a/../scene.json','a/./scene.json','a//scene.json','/scene.json','//offsite.test/x.json','https://offsite.test/x.json','a\\x.json','a/%2e%2e/x.json','a/x.json?q=1','a/x.json#x'])
    assert.ok(validateLemniroFigureReference({...good,manifestPath:path}).length,path);
  assert.ok(validateLemniroFigureReference({...good,posterPath:'poster.html'}).length);
  let reads=0;const bad={...good};Object.defineProperty(bad,'width',{enumerable:true,get(){reads++;return 100;}});
  assert.ok(validateLemniroFigureReference(bad).length);assert.equal(reads,0);assert.ok(validateLemniroFigureReference(null).length);
});

test('prefix-relative external loading matches synchronous samples and namespaces all inline SVG references',async()=>{
  const data=fixture(),a=transport(data),b=transport(data);
  const [left,right]=await Promise.all([prepareLemniroFigure(data.ref,{baseUrl:base,instanceId:'figure-left',fetch:a.fetcher}),prepareLemniroFigure(data.ref,{baseUrl:base,instanceId:'figure-right',fetch:b.fetcher})]);
  const sync=prepareScene(data.bundle);for(const time of [0,.5,2,.25])assert.deepEqual(left.sample(time),sync.sample(time));
  assert.equal(left.state,'ready');assert.equal(left.manifest.duration,2);assert.ok(Object.isFrozen(left.manifest));
  assert.deepEqual(a.calls.map(c=>c.url),[base+'figures/circle/scene.json',base+'figures/circle/assets/native.json']);
  for(const call of a.calls){assert.equal(call.init?.redirect,'error');assert.equal(call.init?.credentials,'same-origin');}
  const svgA=left.render(1),svgB=right.render(1),ids=(svg:string)=>[...svg.matchAll(/\sid="([^"]+)"/g)].map(m=>m[1]);
  const leftIds=ids(svgA),rightIds=ids(svgB);assert.ok(leftIds.length>=2);assert.equal(new Set([...leftIds,...rightIds]).size,leftIds.length+rightIds.length);
  for(const svg of [svgA,svgB]){const local=ids(svg);for(const reference of svg.matchAll(/url\(#([^)]*)\)|(?:href|xlink:href)="#([^"]+)"/g))assert.ok(local.includes(reference[1]??reference[2]));}
  assert.equal(a.calls.length,2,'sample/render must not issue I/O');left.dispose();assert.equal(left.state,'disposed');assert.throws(()=>left.render(0),failure(/DISPOSED/));
  assert.deepEqual(right.sample(1),sync.sample(1));right.dispose();right.dispose();assert.throws(()=>right.sample(0),failure(/DISPOSED/));
});

test('reference, URL and options snapshots survive caller mutations during manifest fetch',async()=>{
  const data=fixture(),gate=deferred<Response>(),baseUrl=new URL(base),calls:string[]=[],options={baseUrl,instanceId:'snapshot-figure',fetch:async(input:any)=>{const url=String(input);calls.push(url);return url.endsWith('/scene.json')?gate.promise:new Response(data.assetText);}};
  const promise=prepareLemniroFigure(data.ref,options);data.ref.width=999;data.ref.manifestSha256='0'.repeat(64);data.ref.manifestPath='wrong.json';baseUrl.href='https://other.test/';options.instanceId='changed';
  options.fetch=async()=>{throw new Error('mutated fetch must not run');};gate.resolve(new Response(data.manifestText));const figure=await promise;
  assert.deepEqual(calls,[base+'figures/circle/scene.json',base+'figures/circle/assets/native.json']);assert.equal(figure.sample(0).viewport.width,100);assert.ok(figure.render(0).includes('snapshot-figure'));figure.dispose();
});

test('inline manifests require only their manifest request; invalid instances or bases fail before requests',async()=>{
  const data=fixture(true),network=transport(data),figure=await prepareLemniroFigure(data.ref,{baseUrl:base,instanceId:'inline-figure',fetch:network.fetcher});
  assert.equal(network.calls.length,1);figure.render(1);assert.equal(network.calls.length,1);figure.dispose();
  for(const instanceId of ['', 'unsafe id','x"/><script>'])await assert.rejects(prepareLemniroFigure(data.ref,{baseUrl:base,instanceId,fetch:network.fetcher}));
  for(const baseUrl of ['file:///tmp/','https://user:pass@example.test/','https://example.test/?x=1','https://example.test/#x','data:text/plain,x'])
    await assert.rejects(prepareLemniroFigure(data.ref,{baseUrl,instanceId:'valid',fetch:network.fetcher}));
  assert.equal(network.calls.length,1);
});

test('manifest integrity and viewport/duration mismatch fail before any asset request',async()=>{
  for(const mode of ['hash','width','height','duration'] as const){const data=fixture();if(mode==='hash')data.ref.manifestSha256='0'.repeat(64);else data.ref[mode]+=1;
    const network=transport(data);await assert.rejects(prepareLemniroFigure(data.ref,{baseUrl:base,instanceId:'bad-manifest',fetch:network.fetcher}));assert.equal(network.calls.length,1,mode);}
});

test('resource transport cannot escape the manifest directory or follow redirected responses',async()=>{
  for(const uri of ['../native.json','/native.json','https://offsite.test/native.json','//offsite.test/native.json','assets/%2e%2e/native.json','assets\\native.json']){
    const data=fixture();data.pkg.assets.entries[0].source.uri=uri;refresh(data);const network=transport(data);
    await assert.rejects(prepareLemniroFigure(data.ref,{baseUrl:base,instanceId:'blocked-uri',fetch:network.fetcher}));assert.equal(network.calls.length,1,uri);
  }
  const data=fixture(),network=transport(data),redirected=new Response(data.manifestText);Object.defineProperty(redirected,'url',{value:'https://other.test/scene.json'});
  await assert.rejects(prepareLemniroFigure(data.ref,{baseUrl:base,instanceId:'redirected',fetch:async()=>redirected}));assert.equal(network.calls.length,0);
});

test('missing or corrupted resource bytes fail preparation without returning a partial renderer',async()=>{
  for(const mode of ['missing','corrupt'] as const){const data=fixture(),network=transport(data,()=>mode==='missing'?new Response('missing',{status:404}):new Response(data.assetText.replace('#123456','#654321')));
    await assert.rejects(prepareLemniroFigure(data.ref,{baseUrl:base,instanceId:'broken-asset',fetch:network.fetcher}));assert.equal(network.calls.length,2);}
});

test('packed resources require exact 206 range metadata and payload bytes; full 200 fallback is rejected',async()=>{
  for(const mode of ['valid','wrong-range','full-body','short'] as const){const data=fixture(),size=encoded(data.assetText).byteLength,offset=7;
    data.pkg.assets.entries[0].source={kind:'external',uri:'assets/packed.bin',byteRange:{offset,length:size}};refresh(data);
    const network=transport(data,(_url,init)=>{assert.equal(new Headers(init?.headers).get('Range'),`bytes=${offset}-${offset+size-1}`);
      return new Response(mode==='short'?data.assetText.slice(1):data.assetText,{status:mode==='full-body'?200:206,headers:{'Content-Range':`bytes ${mode==='wrong-range'?offset+1:offset}-${offset+size-1}/${offset+size+9}`}});});
    const promise=prepareLemniroFigure(data.ref,{baseUrl:base,instanceId:'packed-figure',fetch:network.fetcher});
    if(mode==='valid'){const figure=await promise;assert.deepEqual(figure.sample(1),prepareScene(data.bundle).sample(1));figure.dispose();}else await assert.rejects(promise);
  }
});

test('pre-aborted signals issue no requests and cancellation wins over a manifest fetch ignoring abort',async()=>{
  const data=fixture(),network=transport(data),controller=new AbortController();controller.abort();
  await assert.rejects(prepareLemniroFigure(data.ref,{baseUrl:base,instanceId:'pre-aborted',signal:controller.signal,fetch:network.fetcher}));assert.equal(network.calls.length,0);
  const pending=deferred<Response>(),signal=new AbortController();let requested:AbortSignal|null|undefined;
  const promise=prepareLemniroFigure(data.ref,{baseUrl:base,instanceId:'abort-manifest',signal:signal.signal,fetch:async(_url,init)=>{requested=init?.signal;return pending.promise;}});
  await until(()=>!!requested);signal.abort();await assert.rejects(promise,failure(/ABORT|CANCEL/));assert.equal(requested!.aborted,true);
  pending.resolve(new Response(data.manifestText));await tick();await tick();
});

test('abort during resource fetching cannot revive the scene and abort after ready disposes sample/render',async()=>{
  const data=fixture(),asset=deferred<Response>(),signal=new AbortController();let assetSignal:AbortSignal|null|undefined;
  const network=transport(data,(_url,init)=>{assetSignal=init?.signal;return asset.promise;});
  const promise=prepareLemniroFigure(data.ref,{baseUrl:base,instanceId:'abort-asset',signal:signal.signal,fetch:network.fetcher});await until(()=>!!assetSignal);signal.abort();
  await assert.rejects(promise,failure(/ABORT|CANCEL/));assert.equal(assetSignal!.aborted,true);asset.resolve(new Response(data.assetText));await tick();
  const readySignal=new AbortController(),ready=await prepareLemniroFigure(data.ref,{baseUrl:base,instanceId:'abort-ready',signal:readySignal.signal,fetch:transport(data).fetcher});
  const frame=ready.sample(1);readySignal.abort();assert.equal(ready.state,'disposed');assert.throws(()=>ready.sample(1),failure(/DISPOSED/));assert.throws(()=>ready.render(1),failure(/DISPOSED/));assert.deepEqual(frame,prepareScene(data.bundle).sample(1));
});

test('manifest stream actual bytes are bounded and a never-settling reader is abortable',async()=>{
  const data=fixture(),huge=new Uint8Array(4*1024*1024+1);let cancelled=false;
  const response=new Response(new ReadableStream<Uint8Array>({start(controller){controller.enqueue(huge);},cancel(){cancelled=true;}}));
  await assert.rejects(prepareLemniroFigure(data.ref,{baseUrl:base,instanceId:'too-large',fetch:async()=>response}),failure(/SIZE|BUDGET|LIMIT|LENGTH/));assert.equal(cancelled,true);
  const controller=new AbortController();let started=false,readerCancelled=false;
  const stalled=new Response(new ReadableStream<Uint8Array>({pull(){started=true;return new Promise(()=>{});},cancel(){readerCancelled=true;}}));
  const promise=prepareLemniroFigure(data.ref,{baseUrl:base,instanceId:'abort-reader',signal:controller.signal,fetch:async()=>stalled});await until(()=>started);controller.abort();
  await assert.rejects(promise,failure(/ABORT|CANCEL/));await tick();assert.equal(readerCancelled,true);
});
