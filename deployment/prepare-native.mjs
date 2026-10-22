import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {verifyNativeBuild,readNativeResourceManifest,nativeAssetManifestIdentity} from '../tools/native-build-manifest.mjs';
import {loadDeploymentTarget,deploymentIdentity} from './deployment-target.mjs';

const directory=path.dirname(fileURLToPath(import.meta.url)),root=path.resolve(directory,'..');
const target=await loadDeploymentTarget();
const build=await verifyNativeBuild({root,sourceCheck:true,requireChecked:true});
const index=await readNativeResourceManifest();
const resourceManifestSha256=nativeAssetManifestIdentity(index.manifest);
if(build.resourceManifestSha256!==resourceManifestSha256)throw new Error('Build and current retail resources differ; rebuild with the intended resource manifest');
const output=path.join(directory,'generated'),assets=path.join(output,'assets');
await fs.mkdir(output,{recursive:true});
await fs.rm(assets,{recursive:true,force:true});await fs.mkdir(assets);
const smallFiles=[];
async function copy(file,relative) {
  const stat=await fs.lstat(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>25*1024*1024)throw new Error(`Static asset must be a regular file <=25MiB: ${relative}`);
  const target=path.join(assets,relative);await fs.mkdir(path.dirname(target),{recursive:true});await fs.copyFile(file,target);
  smallFiles.push({path:relative,bytes:stat.size});
}
async function copyTree(source,prefix='') {
  for(const entry of await fs.readdir(source,{withFileTypes:true})) {
    if(entry.name.startsWith('.'))continue;
    const relative=path.posix.join(prefix,entry.name),file=path.join(source,entry.name);
    if(entry.isSymbolicLink())throw new Error(`Static asset symlink rejected: ${relative}`);
    if(entry.isDirectory())await copyTree(file,relative);
    else if(/\.(?:html|js|css|json|svg|png|woff2?|ttf)$/.test(entry.name))await copy(file,relative);
  }
}
await copyTree(path.join(root,'web-native'));
await copy(path.join(root,'public/native/vera20k.js'),'native/vera20k.js');
await copy(path.join(root,'public/native/build.json'),'native/build.json');
await copy(path.join(root,'native-client/art/branding/wannafire-app-icon.png'),'branding/icon.png');
for(const name of ['FiraSansCondensed-Medium.ttf','FiraSansCondensed-OFL'])await copy(path.join(root,'native-client/art/fonts',name),'fonts/'+name);
await fs.copyFile(path.join(assets,'branding/icon.png'),path.join(assets,'favicon.ico'));
const objects={},uploads=new Map();
function object(file,pathname,bytes,sha256,contentType) {
  const key=target.objectPrefix+sha256;
  objects[pathname]={key,bytes,sha256,contentType};
  if(!uploads.has(key))uploads.set(key,{file,key,bytes,sha256,contentType});
}
const wasm=build.outputs['vera20k_bg.wasm'];
object(path.join(root,'public/native/vera20k_bg.wasm'),'/native/vera20k_bg.wasm',wasm.bytes,wasm.sha256,'application/wasm');
for(const file of index.manifest.files) {
  const admitted=index.allowed.get(file.name.toLowerCase());
  object(admitted.filePath,'/retail/'+file.name.toLowerCase(),file.bytes,file.sha256,'application/octet-stream');
}
const resources={...index.manifest,identity:resourceManifestSha256,
  files:index.manifest.files.map(file=>({...file,url:file.url+'?sha256='+file.sha256}))};
const release={schema:1,deployment:deploymentIdentity(target),build,resources,objects};
const releaseBytes=JSON.stringify(release,null,2)+'\n';
await fs.writeFile(path.join(output,'release.json'),releaseBytes);
await fs.writeFile(path.join(output,'upload-plan.json'),JSON.stringify({schema:1,...deploymentIdentity(target),releaseSha256:createHash('sha256').update(releaseBytes).digest('hex'),objects:[...uploads.values()],smallFiles},null,2)+'\n');
console.log(JSON.stringify({prepared:true,patchSha256:build.patchSha256,resourceManifestSha256,staticFiles:smallFiles.length,r2Objects:uploads.size,r2Bytes:[...uploads.values()].reduce((sum,file)=>sum+file.bytes,0)}));
