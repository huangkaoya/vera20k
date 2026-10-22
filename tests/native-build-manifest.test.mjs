import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {nativeSourceIdentity,writeNativeBuildManifest,verifyNativeBuild,nativeAssetManifestIdentity,removeLegacyNativeOutputs,NATIVE_WEB_OUTPUTS,NATIVE_WEB_RENDERER} from '../tools/native-build-manifest.mjs';
const sha=value=>createHash('sha256').update(value).digest('hex');
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'native-build-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.mkdir(path.join(root,'patches'));await fs.mkdir(path.join(root,'public/native'),{recursive:true});
 const baseline=JSON.stringify({schema:1,integratedRevision:'a'.repeat(40),sourceFiles:{}});
 await fs.writeFile(path.join(root,'native-source.lock.json'),baseline);
 await fs.writeFile(path.join(root,'patches/native-client.patch'),'');
 await fs.writeFile(path.join(root,'patches/native-client.lock.json'),JSON.stringify({schema:1,integratedRevision:'a'.repeat(40),baselineLockSha256:sha(baseline),patch:{path:'patches/native-client.patch',sha256:sha('')},files:{}}));
 await fs.writeFile(path.join(root,'public/native/werhd.js'),'export const originalRenderer=true;');
 await fs.writeFile(path.join(root,'public/native/werhd_bg.wasm'),new Uint8Array([0,97,115,109,1,0,0,0]));return root;
}
test('native build manifest fingerprints actual JS/WASM and recorded browser patch',async t=>{
 const root=await fixture(t),source=await nativeSourceIdentity({root});
 const manifest=await writeNativeBuildManifest({root,profile:'web',source,sourceChecked:true,tools:{}});
 assert.equal(manifest.schema,2);assert.equal(manifest.outputs['werhd_bg.wasm'].bytes,8);
 assert.deepEqual(Object.keys(manifest.outputs),NATIVE_WEB_OUTPUTS);
 assert.equal(manifest.renderer,NATIVE_WEB_RENDERER);
 assert.doesNotMatch(JSON.stringify(manifest),/vera20k/i);
 assert.equal((await verifyNativeBuild({root,requireChecked:true})).patchSha256,sha(''));
 await fs.appendFile(path.join(root,'public/native/werhd.js'),'tampered');
 await assert.rejects(verifyNativeBuild({root}),/output integrity mismatch/);
});
test('native release rejects a legacy filename or renderer instead of accepting a mixed publication',async t=>{
 const root=await fixture(t),source=await nativeSourceIdentity({root});
 const manifest=await writeNativeBuildManifest({root,profile:'web',source,sourceChecked:true,tools:{}});
 const target=path.join(root,'public/native/build.json');
 await fs.writeFile(target,JSON.stringify({...manifest,outputs:{...manifest.outputs,'vera20k.js':manifest.outputs['werhd.js']}}));
 await assert.rejects(verifyNativeBuild({root}),/current WERHD browser outputs/);
 await fs.writeFile(target,JSON.stringify({...manifest,renderer:'VERA wgpu/WebGPU'}));
 await assert.rejects(verifyNativeBuild({root}),/current WERHD browser outputs/);
});
test('obsolete compiler cleanup is bounded and never follows a link into source or user data',async t=>{
 const root=await fixture(t),directory=path.join(root,'public/native');
 const userdata=path.join(root,'private-user-data');
 await fs.writeFile(userdata,'keep user data');
 for(const name of ['vera20k.js','vera20k.d.ts','vera20k_bg.wasm.d.ts','vera20k.js.map','vera20k_bg.wasm.map'])
   await fs.writeFile(path.join(directory,name),'obsolete');
 await fs.symlink(userdata,path.join(directory,'vera20k_bg.wasm'));
 await fs.mkdir(path.join(directory,'art'));await fs.writeFile(path.join(directory,'art','keep.png'),'keep art');
 await fs.writeFile(path.join(directory,'saved-game.json'),'keep save');
 await removeLegacyNativeOutputs({root});
 assert.deepEqual((await fs.readdir(directory)).sort(),['art','saved-game.json',...NATIVE_WEB_OUTPUTS].sort());
 assert.equal(await fs.readFile(userdata,'utf8'),'keep user data');
 assert.equal(await fs.readFile(path.join(directory,'art','keep.png'),'utf8'),'keep art');
 await removeLegacyNativeOutputs({root});
});
test('native release rejects an unchecked development build and modified patch',async t=>{
 const root=await fixture(t),source=await nativeSourceIdentity({root});
 await writeNativeBuildManifest({root,profile:'dev',source,sourceChecked:false,tools:{}});
 await assert.rejects(verifyNativeBuild({root,requireChecked:true}),/skipped its source check/);
 await fs.appendFile(path.join(root,'patches/native-client.patch'),'changed');
 await assert.rejects(verifyNativeBuild({root}),/patch checksum mismatch/);
});
test('native resource identity excludes hosting URLs and uses one canonical order',()=>{
 const files=[{name:'ra2md.mix',bytes:20,sha256:'a'.repeat(64),url:'/retail/ra2md.mix'},{name:'ra2.mix',bytes:10,sha256:'b'.repeat(64),url:'https://old.invalid/ra2.mix'}];
 const a=nativeAssetManifestIdentity({files});
 const b=nativeAssetManifestIdentity({files:[...files].reverse().map(file=>({...file,url:'https://new.invalid/'+file.name}))});
 assert.equal(a,b);assert.notEqual(a,nativeAssetManifestIdentity({files:files.map(file=>({...file,bytes:file.bytes+1}))}));
 assert.throws(()=>nativeAssetManifestIdentity({files:[files[0],files[0]]}),/duplicate/);
 assert.throws(()=>nativeAssetManifestIdentity({files:[{...files[0],name:'ra2md.ini'}]}),/invalid/);
});
