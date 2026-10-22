import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {verifyNativeBuild,readNativeContentIndex,nativeAssetManifestIdentity,nativeContentCatalogIdentity,hashNativeFile} from '../tools/native-build-manifest.mjs';
import {loadDeploymentTarget,deploymentIdentity} from './deployment-target.mjs';

const directory=path.dirname(fileURLToPath(import.meta.url)),root=path.resolve(directory,'..');

/** Pure planning boundary, exercised without a native build or authentication.
 * Physical paths belong only to the local upload plan, never the public release.
 */
export function nativeReleaseObjects({build,index,target,root}) {
  const resourceManifestSha256=nativeAssetManifestIdentity(index.manifest);
  const catalogIdentity=nativeContentCatalogIdentity(index.manifest);
  if(index.manifest.schema!==2||index.manifest.defaultProfile!=='skirmish'||
    index.manifest.identity!==resourceManifestSha256||index.manifest.catalogIdentity!==catalogIdentity||
    build.resourceManifestSha256!==resourceManifestSha256||build.contentCatalogIdentity!==catalogIdentity)
    throw new Error('Build and current native content catalog differ; rebuild with the intended content catalog');
  const objects={},uploads=new Map();
  function object(file,pathname,bytes,sha256,contentType) {
    if(typeof file!=='string'||!path.isAbsolute(file)||!Number.isSafeInteger(bytes)||bytes<0||
      !/^[a-f0-9]{64}$/.test(sha256)||!['application/octet-stream','application/gzip','application/wasm','video/mp4'].includes(contentType)||
      !(pathname==='/native/vera20k_bg.wasm'||pathname===`/content/objects/${sha256}`))
      throw new Error('Invalid immutable native content object');
    const key=target.objectPrefix+sha256;
    const entry={key,bytes,sha256,contentType},prior=objects[pathname];
    if(prior&&JSON.stringify(prior)!==JSON.stringify(entry))throw new Error('Conflicting native content object URL');
    objects[pathname]=entry;
    const upload=uploads.get(key);
    if(upload&&(upload.bytes!==bytes||upload.contentType!==contentType))throw new Error('Conflicting native content object identity');
    if(!upload)uploads.set(key,{file,key,bytes,sha256,contentType});
  }
  for(const [sha256,entry] of index.objects) {
    if(sha256!==entry.sha256)throw new Error('Content index object key differs');
    object(entry.file??entry.path,entry.url,entry.bytes,sha256,entry.contentType);
  }
  const checkFile=file=>{
    for(const record of [file,...(file.download?[file.download]:[])]) {
      const admitted=objects[record.url];
      if(!admitted||admitted.sha256!==record.sha256||admitted.bytes!==record.bytes)
        throw new Error('Content catalog references an unpublished object');
    }
    if(file.download?.encoding!=='gzip'||objects[file.download.url]?.contentType!=='application/gzip')
      throw new Error('Content file needs an explicit gzip transfer object');
  };
  index.manifest.files.forEach(checkFile);
  for(const profile of Object.values(index.manifest.profiles??{})) {
    if(profile.requiredResourceIdentity!==resourceManifestSha256)throw new Error('Optional profile changes required gameplay identity');
    profile.files.forEach(checkFile);
  }
  for(const pack of Object.values(index.manifest.packs??{}))pack.files.forEach(checkFile);
  if(!index.manifest.profiles?.full||!index.manifest.profiles?.skirmish)throw new Error('Content profiles are incomplete');
  const wasm=build.outputs?.['vera20k_bg.wasm'];
  if(!wasm)throw new Error('Native build has no WASM output');
  object(path.join(root,'public/native/vera20k_bg.wasm'),'/native/vera20k_bg.wasm',wasm.bytes,wasm.sha256,'application/wasm');
  const wire=wasm.download;
  if(!wire||wire.encoding!=='gzip'||wire.url!==`/content/objects/${wire.sha256}`)
    throw new Error('Native build has no valid compressed WASM transfer');
  object(path.join(root,'.build/native-content/objects',wire.sha256),wire.url,wire.bytes,wire.sha256,'application/gzip');
  const resources=index.manifest;
  const release={schema:1,deployment:deploymentIdentity(target),catalogIdentity,build,resources,objects};
  return {release,uploads,resourceManifestSha256,catalogIdentity};
}

export async function prepareNative() {
  const target=await loadDeploymentTarget();
  const build=await verifyNativeBuild({root,sourceCheck:true,requireChecked:true});
  const index=await readNativeContentIndex({root});
  const {release,uploads,resourceManifestSha256,catalogIdentity}=nativeReleaseObjects({build,index,target,root});
  for(const object of uploads.values()) {
    const stat=await fs.lstat(object.file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==object.bytes||await hashNativeFile(object.file)!==object.sha256)
      throw new Error('Local native content object differs from the immutable catalog');
  }
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
  const releaseBytes=JSON.stringify(release,null,2)+'\n';
  await fs.writeFile(path.join(output,'release.json'),releaseBytes);
  await fs.writeFile(path.join(output,'upload-plan.json'),JSON.stringify({schema:1,...deploymentIdentity(target),releaseSha256:createHash('sha256').update(releaseBytes).digest('hex'),objects:[...uploads.values()],smallFiles},null,2)+'\n');
  console.log(JSON.stringify({prepared:true,patchSha256:build.patchSha256,resourceManifestSha256,catalogIdentity,
    defaultProfile:release.resources.defaultProfile,defaultDownloadBytes:release.resources.downloadBytes,
    staticFiles:smallFiles.length,r2Objects:uploads.size,r2Bytes:[...uploads.values()].reduce((sum,file)=>sum+file.bytes,0)}));
  return release;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await prepareNative();
