import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {gzip as gzipCallback,createGunzip} from 'node:zlib';
import {promisify} from 'node:util';
import {createResourceIndex,isPublicRetailFile} from './dev-server.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const gzip=promisify(gzipCallback);
export const NATIVE_WEB_OUTPUTS=Object.freeze(['werhd.js','werhd_bg.wasm']);
export const NATIVE_WEB_RENDERER='WERHD wgpu/WebGPU';
const legacyOutputs=Object.freeze(['vera20k.js','vera20k_bg.wasm','vera20k.d.ts','vera20k_bg.wasm.d.ts',
  'vera20k.js.map','vera20k_bg.wasm.map']);
/** Only obsolete compiler outputs in the owned public/native directory. Never
 * traverse or clear an asset, source, cache or user-data directory. */
export async function removeLegacyNativeOutputs({root}) {
  for(const name of legacyOutputs)await fs.rm(path.join(root,'public/native',name),{force:true});
}
export function nativeContentCatalogIdentity(catalog) {
  const {catalogIdentity,...body}=catalog;
  const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'
    ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
  return digest(JSON.stringify(canonical(body)));
}
const mediaNames=new Set(['thememd.mix','theme.mix','movmd01.mix','movmd02.mix','movmd03.mix','movies01.mix','movies02.mix','movies03.mix','audio.idx','audio.bag','audiomd.idx','audiomd.bag','werhd-menu.mp4']);
export function isNativeAssetName(name) {
  return isPublicRetailFile(name)||(name===path.basename(name)&&!name.includes('\\')&&mediaNames.has(name.toLowerCase()));
}
export function nativeAssetManifestIdentity(manifest) {
  if(!Array.isArray(manifest?.files))throw new Error('Native resource manifest has no files');
  const seen=new Set();
  const files=[...manifest.files].sort((a,b)=>a.name.localeCompare(b.name,'en')).map(({name,bytes,sha256})=>{
    if(typeof name!=='string'||!isNativeAssetName(name)||seen.has(name.toLowerCase())||!Number.isSafeInteger(bytes)||bytes<0||!/^[a-f0-9]{64}$/.test(sha256))throw new Error('Native resource manifest contains invalid or duplicate entries');
    seen.add(name.toLowerCase());return {name,bytes,sha256};
  });
  return digest(JSON.stringify(files));
}
export async function readNativeResourceManifest({assetRoot=process.env.VERA_ASSET_ROOT??path.join(os.homedir(),'Library/Application Support/VERA20k/retail-assets')}={}) {
  return createResourceIndex(assetRoot,{isAllowed:isNativeAssetName});
}
/** The public catalog contains logical content only. The private build plan is
 * the sole local mapping to immutable bytes; neither the lobby nor browser sees
 * source installation paths. Optional profiles share one gameplay identity. */
export async function readNativeContentIndex({root}={}) {
  root=path.resolve(root??path.join(path.dirname(fileURLToPath(import.meta.url)),'..'));
  const catalogPath=path.join(root,'public/native-content/catalog.json');
  const manifest=JSON.parse(await fs.readFile(catalogPath,'utf8'));
  const plan=JSON.parse(await fs.readFile(path.join(root,'.build/native-content/plan.json'),'utf8'));
  const identity=nativeAssetManifestIdentity(manifest);
  if(manifest.schema!==2||manifest.defaultProfile!=='skirmish'||manifest.identity!==identity||
    plan.schema!==1||plan.catalogIdentity!==manifest.catalogIdentity||plan.requiredResourceIdentity!==identity||
    !/^[a-f0-9]{64}$/.test(manifest.catalogIdentity)||nativeContentCatalogIdentity(manifest)!==manifest.catalogIdentity||!Array.isArray(plan.objects))
    throw new Error('Native content catalog and local build plan differ; rebuild content packs');
  const objects=new Map();
  for(const object of plan.objects) {
    if(!/^[a-f0-9]{64}$/.test(object.sha256)||!Number.isSafeInteger(object.bytes)||object.bytes<0||
      typeof object.path!=='string'||!path.isAbsolute(object.path)||objects.has(object.sha256))
      throw new Error('Invalid or duplicate native content object');
    objects.set(object.sha256,{...object,file:object.path,url:`/content/objects/${object.sha256}`});
  }
  const checkFile=file=>{
    nativeAssetManifestIdentity({files:[file]});
    const raw=objects.get(file.sha256);
    if(!raw||raw.bytes!==file.bytes||file.url!==raw.url)throw new Error('Native content file has no exact local object');
    if(file.download) {
      const wire=objects.get(file.download.sha256);
      if(!wire||wire.bytes!==file.download.bytes||wire.url!==file.download.url||
        !['gzip','identity'].includes(file.download.encoding))throw new Error('Native content transfer object differs from catalog');
    }
  };
  for(const [name,profile] of Object.entries(manifest.profiles??{})) {
    if(!['skirmish','full'].includes(name)||profile.requiredResourceIdentity!==identity||!Array.isArray(profile.files)||
      name==='skirmish'&&nativeAssetManifestIdentity({files:profile.files})!==identity)
      throw new Error('Native content profile has an invalid gameplay identity');
    nativeAssetManifestIdentity({files:profile.files});
    profile.files.forEach(checkFile);
    if(profile.totalBytes!==profile.files.reduce((sum,file)=>sum+file.bytes,0))throw new Error('Native content profile size differs');
  }
  if(!manifest.profiles?.full||!manifest.profiles?.skirmish||manifest.totalBytes!==manifest.profiles.skirmish.totalBytes)
    throw new Error('Native content profiles are incomplete');
  manifest.files.forEach(checkFile);
  return {manifest,plan,objects,catalogPath};
}
export async function hashNativeFile(file) {
  const hash=createHash('sha256');
  for await(const bytes of createReadStream(file))hash.update(bytes);
  return hash.digest('hex');
}
export function runNativeCommand(command,args,{root,env=process.env}={}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{cwd:root,stdio:'inherit',env});
    child.once('error',reject);
    child.once('exit',(code,signal)=>code===0?resolve():reject(new Error(`${command} failed (${signal??code})`)));
  });
}
export async function nativeSourceIdentity({root,sourceCheck=false,python=process.env.PYTHON??'python3'}) {
  root=path.resolve(root);
  const baselineBytes=await fs.readFile(path.join(root,'native-source.lock.json'));
  const baseline=JSON.parse(baselineBytes),baselineSha256=digest(baselineBytes);
  const patchLock=JSON.parse(await fs.readFile(path.join(root,'patches/native-client.lock.json'),'utf8'));
  if(patchLock.schema!==1||patchLock.integratedRevision!==baseline.integratedRevision||patchLock.baselineLockSha256!==baselineSha256||patchLock.patch?.path!=='patches/native-client.patch')throw new Error('Native browser patch is not pinned to this source baseline');
  const patchSha256=await hashNativeFile(path.join(root,patchLock.patch.path));
  if(patchSha256!==patchLock.patch.sha256)throw new Error('Native browser patch checksum mismatch');
  if(sourceCheck)await runNativeCommand(python,['tools/native-source.py','check'],{root});
  return {revision:baseline.integratedRevision,baselineSha256,patchSha256};
}
export async function writeNativeBuildManifest({root,profile,source,sourceChecked,tools,resourceManifestSha256,contentCatalogIdentity}) {
  const current=await nativeSourceIdentity({root});
  if(JSON.stringify(current)!==JSON.stringify(source))throw new Error('Native source patch changed during compilation; rebuild after recording it');
  const outputs={};
  for(const name of NATIVE_WEB_OUTPUTS) {
    const file=path.join(root,'public/native',name),stat=await fs.stat(file);
    if(!stat.isFile())throw new Error(`Missing native build output ${name}`);
    outputs[name]={bytes:stat.size,sha256:await hashNativeFile(file)};
    if(name.endsWith('.wasm')) {
      const bytes=await gzip(await fs.readFile(file),{level:6});
      if(bytes.length<stat.size) {
        const sha256=digest(bytes),directory=path.join(root,'.build/native-content/objects');
        await fs.mkdir(directory,{recursive:true});
        await fs.writeFile(path.join(directory,sha256),bytes);
        outputs[name].download={url:`/content/objects/${sha256}`,bytes:bytes.length,sha256,encoding:'gzip'};
      }
    }
  }
  const manifest={schema:2,renderer:NATIVE_WEB_RENDERER,...source,resourceManifestSha256,
    ...(contentCatalogIdentity?{contentCatalogIdentity}:{}),sourceChecked:Boolean(sourceChecked),profile,tools,outputs,builtAt:new Date().toISOString()};
  const target=path.join(root,'public/native/build.json');
  await fs.writeFile(target+'.tmp',JSON.stringify(manifest,null,2)+'\n');
  await fs.rename(target+'.tmp',target);
  return manifest;
}
export async function verifyNativeBuild({root,sourceCheck=false,requireChecked=false}={}) {
  root=path.resolve(root);
  const build=JSON.parse(await fs.readFile(path.join(root,'public/native/build.json'),'utf8'));
  if(build.schema!==2||!build.outputs)throw new Error('Native build manifest missing v2 output hashes; rebuild the native web client');
  if(build.renderer!==NATIVE_WEB_RENDERER||Object.keys(build.outputs).sort().join(',')!==[...NATIVE_WEB_OUTPUTS].sort().join(','))
    throw new Error('Native build manifest does not contain the current WERHD browser outputs; rebuild the native web client');
  if(requireChecked&&!build.sourceChecked)throw new Error('Native build skipped its source check; a checked build is required for release');
  const source=await nativeSourceIdentity({root,sourceCheck});
  for(const key of ['revision','baselineSha256','patchSha256'])if(build[key]!==source[key])throw new Error(`Native build ${key} differs from the current recorded source`);
  for(const name of NATIVE_WEB_OUTPUTS) {
    const expected=build.outputs[name],file=path.join(root,'public/native',name),stat=await fs.stat(file);
    if(!stat.isFile()||stat.size!==expected?.bytes||await hashNativeFile(file)!==expected.sha256)throw new Error(`Native build output integrity mismatch: ${name}`);
    if(expected.download) {
      const wire=expected.download;
      if(wire.encoding!=='gzip'||!/^[a-f0-9]{64}$/.test(wire.sha256)||wire.url!==`/content/objects/${wire.sha256}`||!Number.isSafeInteger(wire.bytes)||wire.bytes<=0)
        throw new Error('Native engine transfer descriptor is invalid');
      const compressed=path.join(root,'.build/native-content/objects',wire.sha256),wireStat=await fs.stat(compressed);
      if(wireStat.size!==wire.bytes||await hashNativeFile(compressed)!==wire.sha256)throw new Error('Native engine transfer checksum mismatch');
      const stream=createReadStream(compressed).pipe(createGunzip()),hash=createHash('sha256');let size=0;
      for await(const chunk of stream) {
        size+=chunk.length;
        if(size>expected.bytes)throw new Error('Native engine transfer expands beyond its pinned size');
        hash.update(chunk);
      }
      if(size!==expected.bytes||hash.digest('hex')!==expected.sha256)throw new Error('Native engine transfer does not reproduce this WASM');
    }
  }
  return build;
}
