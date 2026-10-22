import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {nativeSourceIdentity,writeNativeBuildManifest,nativeAssetManifestIdentity,readNativeContentIndex} from './native-build-manifest.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
function run(command,args,extra={}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{cwd:root,stdio:'inherit',env:{...process.env,CARGO_TARGET_DIR:path.join(root,'.build/cargo')},...extra});
    child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error(`${command} exited ${code}`)));
  });
}
const profile=process.env.VERA_WEB_PROFILE??'web';
if(!['web','release','dev'].includes(profile))throw new Error('VERA_WEB_PROFILE must be web, release, or dev');
const sourceChecked=process.env.VERA_WEB_SOURCE_CHECK!=='0';
await run(process.env.PYTHON??'python3',['tools/native-content.py','build']);
const content=await readNativeContentIndex({root});
const source=await nativeSourceIdentity({root,sourceCheck:sourceChecked});
process.env.VERA_WEB_SOURCE_REVISION=source.revision;
process.env.VERA_WEB_BROWSER_PATCH_HASH=source.patchSha256;
const resourceManifestSha256=nativeAssetManifestIdentity(content.manifest);
process.env.VERA_WEB_ASSET_MANIFEST_SHA256=resourceManifestSha256;
let bindgen=process.env.WASM_BINDGEN??path.join(root,'.build/wasm-tools/bin/wasm-bindgen');
if (!process.env.WASM_BINDGEN) {
  try {await fs.access(bindgen);}catch{bindgen=path.join(root,'.build/wasm-tools/wasm-bindgen');}
}
try {await fs.access(bindgen);}catch{throw new Error('wasm-bindgen CLI missing: install version 0.2.114 into .build/wasm-tools or set WASM_BINDGEN');}
const version=(await promisify(execFile)(bindgen,['--version'])).stdout.trim();
if(version!=='wasm-bindgen 0.2.114')throw new Error('Native web build requires wasm-bindgen CLI 0.2.114');
const rustc=(await promisify(execFile)('rustc',['--version'])).stdout.trim();
await run('cargo',['rustc','--locked','--manifest-path','native-client/Cargo.toml','--target','wasm32-unknown-unknown','--profile',profile,'--lib','--','-C','link-arg=-zstack-size=16777216']);
await fs.mkdir(path.join(root,'public/native'),{recursive:true});
await run(bindgen,[path.join(root,'.build/cargo/wasm32-unknown-unknown',profile==='dev'?'debug':profile,'vera20k.wasm'),'--target','web','--out-dir',path.join(root,'public/native'),'--out-name','vera20k']);
// A long Rust build must not certify source that was edited after preflight.
if(sourceChecked)await nativeSourceIdentity({root,sourceCheck:true});
await writeNativeBuildManifest({root,profile,source,sourceChecked,resourceManifestSha256,contentCatalogIdentity:content.manifest.catalogIdentity,tools:{rustc,wasmBindgen:version,stackBytes:16777216}});
