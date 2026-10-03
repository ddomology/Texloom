import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {importGltfAsset,exportGltfAsset} from '../src/resources/gltf-profile.js';
const require=createRequire(import.meta.url);
const validator=require('gltf-validator');
const fixture=new URL('../examples/data/gltf-profile/',import.meta.url);

/** Independent Khronos validation catches format errors our profile may share. */
test('PR39 external-buffer glTF passes the pinned Khronos validator',async()=>{
  assert.equal(validator.version(),'2.0.0-dev.3.10');
  const result=await validator.validateString(await readFile(new URL('scene.gltf',fixture),'utf8'),{
    uri:'scene.gltf',maxIssues:100,
    externalResourceFunction:async(uri:string)=>{
      assert.equal(uri,'scene.bin');
      return new Uint8Array(await readFile(new URL(uri,fixture)));
    },
  });
  assert.equal(result.issues.numErrors,0,JSON.stringify(result.issues));
  assert.equal(result.issues.numWarnings,0,JSON.stringify(result.issues));
});

test('PR39 binary GLB passes the same independent validator',async()=>{
  const result=await validator.validateBytes(new Uint8Array(await readFile(new URL('scene.glb',fixture))),{
    uri:'scene.glb',maxIssues:100,
    externalResourceFunction:async()=>{throw new Error('GLB fixture must be self-contained');},
  });
  assert.equal(result.issues.numErrors,0,JSON.stringify(result.issues));
  assert.equal(result.issues.numWarnings,0,JSON.stringify(result.issues));
});

test('Texloom profile export is a conforming glTF asset in the independent validator',async()=>{
  const document=JSON.parse(await readFile(new URL('scene.gltf',fixture),'utf8'));
  const bytes=await readFile(new URL('scene.bin',fixture));
  const fragment=importGltfAsset({document,buffers:[bytes.toString('base64')]},'model',{camera:0});
  const output=exportGltfAsset(fragment);
  const exported=output.asset.document as {buffers:{uri:string}[]};
  const result=await validator.validateString(JSON.stringify(exported),{
    uri:'export.gltf',maxIssues:100,
    externalResourceFunction:async(uri:string)=>{
      const index=exported.buffers.findIndex(buffer=>buffer.uri===uri);
      assert.notEqual(index,-1);
      return new Uint8Array(Buffer.from(output.asset.buffers[index],'base64'));
    },
  });
  assert.equal(result.issues.numErrors,0,JSON.stringify(result.issues));
  assert.equal(result.issues.numWarnings,0,JSON.stringify(result.issues));
});
