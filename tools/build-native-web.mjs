import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {nativeSourceIdentity,writeNativeBuildManifest,nativeAssetManifestIdentity,readNativeContentIndex,removeLegacyNativeOutputs} from './native-build-manifest.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
async function buildPython() {
  const candidates = process.env.PYTHON ? [process.env.PYTHON] : ['python3', 'python3.14', 'python3.13', 'python3.12', 'python3.11'];
  for (const command of candidates) {
    try {
      await promisify(execFile)(command, ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)']);
      return command.includes(path.sep) ? path.resolve(command) : command;
    } catch {}
  }
  throw new Error('Native Cargo runner requires Python 3.11 or newer; set PYTHON to its executable');
}
const python = await buildPython();
function run(command,args,extra={}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{cwd:root,stdio:'inherit',env:{...process.env,CARGO_TARGET_DIR:path.join(root,'.build/cargo')},...extra});
    child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error(`${command} exited ${code}`)));
  });
}
const profile=process.env.VERA_WEB_PROFILE??'web';
if(!['web','release','dev'].includes(profile))throw new Error('VERA_WEB_PROFILE must be web, release, or dev');
const sourceChecked=process.env.VERA_WEB_SOURCE_CHECK!=='0';
await run(python,['tools/native-content.py','build']);
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
// The embedded native checkout has its own Cargo workspace while sharing this
// repository's Git root. Use the runner's explicit-root API so it serializes
// builds and selects the native workspace instead of the outer sim crate.
const nativeDirectory = path.join(root, 'native-client');
const runnerEnv = {...process.env, CARGO_TARGET_DIR: path.join(root, '.build/cargo')};
const nativeTarget = (await promisify(execFile)(python, ['-c',
  'from pathlib import Path; from tools.cargo_run import build_store, owned_target; root=Path.cwd(); print(owned_target(root, build_store(root)[1]))'],
  {cwd: nativeDirectory, env: runnerEnv})).stdout.trim();
await run(python, ['-c',
  'from pathlib import Path; import sys; from tools.cargo_run import run; sys.exit(run(Path.cwd(), sys.argv[1:], None, 3600))',
  'build', '--locked', '--target', 'wasm32-unknown-unknown', '--profile', profile, '--lib'],
  {cwd: nativeDirectory, env: {...runnerEnv, RUSTFLAGS: `${process.env.RUSTFLAGS ?? ''} -C link-arg=-zstack-size=16777216`.trim()}});
await fs.mkdir(path.join(root,'public/native'),{recursive:true});
// The Cargo crate name stays pinned to upstream internally. Public filenames
// and browser debug metadata use only the product's WERHD identity.
await run(bindgen,[path.join(nativeTarget,'wasm32-unknown-unknown',profile==='dev'?'debug':profile,'vera20k.wasm'),
  '--target','web','--out-dir',path.join(root,'public/native'),'--out-name','werhd',
  '--remove-name-section','--remove-producers-section']);
// A long Rust build must not certify source that was edited after preflight.
if(sourceChecked)await nativeSourceIdentity({root,sourceCheck:true});
await removeLegacyNativeOutputs({root});
await writeNativeBuildManifest({root,profile,source,sourceChecked,resourceManifestSha256,contentCatalogIdentity:content.manifest.catalogIdentity,
  tools:{rustc,wasmBindgen:version,stackBytes:16777216,wasmMetadata:{nameSection:false,producersSection:false,dwarf:false}}});
