import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {requestPath, openRegularFile, fingerprint, sendFile, sendJson, methods, failRequest, listen, closeServer, httpError} from './services/http-files.mjs';
import {attachNativeMultiplayer} from './services/native-websocket.mjs';
import {NATIVE_PROTOCOL} from './services/native-room-coordinator.mjs';
import {NATIVE_ROOM_ROUTING} from './services/native-room-routing.mjs';
import {isNativeAssetName,readNativeResourceManifest,readNativeContentIndex,verifyNativeBuild,nativeAssetManifestIdentity,NATIVE_WEB_OUTPUTS,NATIVE_WEB_RENDERER} from './native-build-manifest.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const isNativeRetailFile = isNativeAssetName;
export async function createNativeServer({root=projectRoot, host='127.0.0.1', port=5280,
  verifyBuild=true,requireChecked=false,sourceCheck=false,
  diagnosticRttMs=0,
  assetRoot=process.env.VERA_ASSET_ROOT ?? path.join(os.homedir(),'Library/Application Support/VERA20k/retail-assets')} = {}) {
  if(!Number.isInteger(diagnosticRttMs)||diagnosticRttMs<0||diagnosticRttMs>2000||diagnosticRttMs%2)throw new Error('Diagnostic RTT must be an even integer from 0 to 2000 ms');
  if(diagnosticRttMs&&!['127.0.0.1','localhost','::1'].includes(host))throw new Error('Network delay diagnostics require a loopback listener');
  root = await fs.realpath(path.resolve(root));
  const retailRoot = await fs.realpath(path.resolve(assetRoot));
  let content;
  try {content=await readNativeContentIndex({root});}
  catch(error){if(verifyBuild||error.code!=='ENOENT')throw error;}
  // The legacy branch is restricted to tiny isolated server fixtures. Ordinary
  // local play and release packaging require the generated content catalog.
  const index = content??await readNativeResourceManifest({assetRoot:retailRoot});
  const build = verifyBuild ? await verifyNativeBuild({root,requireChecked,sourceCheck}) : null;
  if(build && build.resourceManifestSha256!==nativeAssetManifestIdentity(index.manifest)) {
    throw new Error('Native resource manifest differs from the compiled client; rebuild with these resources');
  }
  if(build&&build.contentCatalogIdentity!==content?.manifest.catalogIdentity)throw new Error('Native content catalog differs from this client build');
  const admitted = new Map();
  for (const [name, file] of index.allowed??[]) {
    const opened = await openRegularFile(retailRoot, file.name);
    admitted.set(name, {...file, fingerprint:fingerprint(opened.stat)});
    await opened.handle.close();
  }
  const contentObjects=new Map(content?.objects??[]);
  if(build?.outputs['werhd_bg.wasm'].download) {
    const download=build.outputs['werhd_bg.wasm'].download;
    contentObjects.set(download.sha256,{...download,path:path.join(root,'.build/native-content/objects',download.sha256),contentType:'application/gzip'});
  }
  for(const [sha256,object] of contentObjects) {
    const opened=await openRegularFile(path.dirname(object.path),path.basename(object.path));
    if(opened.stat.size!==object.bytes)throw new Error('Native content object length differs from its build plan');
    contentObjects.set(sha256,{...object,fingerprint:fingerprint(opened.stat)});await opened.handle.close();
  }
  const nativeRoot = path.join(root,'public/native'), sourceRoot=path.join(root,'web-native');
  const cache = new Map();
  const server = http.createServer(async (request,response) => {
    try {
      const pathname=requestPath(request);
      if (!methods(request,response)) return;
      if (pathname==='/api/health') {
        let ready=false;
        try {ready=(await fs.stat(path.join(nativeRoot,'werhd_bg.wasm'))).isFile();}catch{}
        sendJson(request,response,ready?200:503,{ok:ready,app:'werhd-native',protocol:NATIVE_PROTOCOL,patchSha256:build?.patchSha256,resourceManifestSha256:build?.resourceManifestSha256??nativeAssetManifestIdentity(index.manifest),renderer:NATIVE_WEB_RENDERER,roomRouting:NATIVE_ROOM_ROUTING,multiplayer:{protocol:NATIVE_PROTOCOL,rooms:[...multiplayer.coordinators.values()].reduce((total,value)=>total+value.rooms.size,0),diagnosticRttMs},resources:{count:index.manifest.files.length,bytes:index.manifest.totalBytes}}); return;
      }
      if (pathname==='/api/native/resources') {sendJson(request,response,200,index.manifest);return;}
      if(/^\/content\/objects\/[a-f0-9]{64}$/.test(pathname)) {
        const sha256=pathname.split('/').pop(),object=contentObjects.get(sha256);
        if(!object)throw httpError(404,'Content object not published');
        await sendFile(request,response,await openRegularFile(path.dirname(object.path),path.basename(object.path)),{
          digest:sha256,expectedFingerprint:object.fingerprint,mime:object.contentType});return;
      }
      if (pathname.startsWith('/retail/')) {
        const name=pathname.slice('/retail/'.length), item=isNativeRetailFile(name)?admitted.get(name.toLowerCase()):undefined;
        if (!item) throw httpError(404,'Resource not exposed');
        await sendFile(request,response,await openRegularFile(retailRoot,item.name),{digest:item.sha256,expectedFingerprint:item.fingerprint});return;
      }
      let directory, relative;
      if (pathname==='/' || pathname==='/index.html') {directory=sourceRoot;relative='index.html';}
      else if (['/bootstrap.js','/host.js','/host-config.js','/resource-packs.js','/lobby.js','/content-store.js','/content-plan.js','/runtime-adapter.js','/runtime-failure.js','/content-controller.js','/shell-bridge.js','/pointer-capture.js','/menu-animation.js'].includes(pathname)) {directory=sourceRoot;relative=pathname.slice(1);}
      else if (pathname==='/branding/icon.png' || pathname==='/favicon.ico') {directory=path.join(root,'native-client/art/branding');relative='wannafire-app-icon.png';}
      else if (pathname==='/fonts/FiraSansCondensed-Medium.ttf' || pathname==='/fonts/FiraSansCondensed-OFL') {
        directory=path.join(root,'native-client/art/fonts');relative=path.basename(pathname);
      } else if (['/native/build.json',...NATIVE_WEB_OUTPUTS.map(name=>`/native/${name}`)].includes(pathname)) {
        directory=nativeRoot;relative=pathname.slice('/native/'.length);
      } else throw httpError(404,'Route not exposed');
      const mime=relative.endsWith('.ttf')?'font/ttf':undefined;
      await sendFile(request,response,await openRegularFile(directory,relative),{cache,mime});
    }catch(error){failRequest(request,response,error);}
  });
  // The HTTP listener is not exposed until the same-origin WebSocket gate is attached.
  const multiplayer=attachNativeMultiplayer(server,{allowedOrigins:[],messageDelayMs:diagnosticRttMs/2});
  const url=await listen(server,port,host);
  // Port 0 is useful for integration tests. Admission uses the actual bound origin.
  multiplayer.allowOrigin(url);
  const localhostOrigin=new URL(url);localhostOrigin.hostname='localhost';multiplayer.allowOrigin(localhostOrigin.origin);
  let closing;
  return {server,url,manifest:index.manifest,multiplayer,close(){return closing??=(async()=>{await multiplayer.close();await closeServer(server);})();}};
}
if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const app=await createNativeServer({port:Number(process.env.PORT??5280),diagnosticRttMs:Number(process.env.VERA_NATIVE_DIAGNOSTIC_RTT_MS??0)});
  console.log(`王二火大 · WERHD WebGPU ${app.url}`);
  console.log(`只读游戏资源 ${app.manifest.files.length} 项；${Math.round(app.manifest.totalBytes/1048576)} MB`);
  let closing=false;
  const close=async()=>{if(closing)return;closing=true;await app.close();process.exit(0);};
  process.on('SIGINT',close);process.on('SIGTERM',close);
}
