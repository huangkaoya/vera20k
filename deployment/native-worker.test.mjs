import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import {nativeAssetManifestIdentity,nativeContentCatalogIdentity} from '../tools/native-build-manifest.mjs';
import {nativeReleaseObjects} from './prepare-native.mjs';
import {validateRelease} from './verify-native.mjs';
import {build} from '../node_modules/esbuild/lib/main.js';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';

const directory=path.dirname(fileURLToPath(import.meta.url)),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const bytes=new TextEncoder().encode('actual native retail data fixture');
const optionalBytes=new TextEncoder().encode('optional cinematic data fixture');
const wasmBytes=Uint8Array.from([0,97,115,109,1,0,0,0,0,0,0,0]);
const payloads=new Map();
function contentFile(name,raw) {
  const compressed=gzipSync(raw,{level:6});
  for(const value of [raw,compressed])payloads.set(sha(value),value);
  return {name,bytes:raw.length,sha256:sha(raw),url:`/content/objects/${sha(raw)}`,
    download:{url:`/content/objects/${sha(compressed)}`,bytes:compressed.length,sha256:sha(compressed),encoding:'gzip'}};
}
const coreFile=contentFile('ra2.mix',bytes),optionalFile=contentFile('movmd03.mix',optionalBytes);
const resourceIdentity=nativeAssetManifestIdentity({files:[coreFile]});
const capabilities={campaign:false,movies:false,music:false,menuAnimation:false};
const profile=(files,flags)=>({files,totalBytes:files.reduce((sum,file)=>sum+file.bytes,0),downloadBytes:files.reduce((sum,file)=>sum+file.download.bytes,0),requiredResourceIdentity:resourceIdentity,capabilities:flags});
const resources={schema:2,defaultProfile:'skirmish',files:[coreFile],totalBytes:coreFile.bytes,downloadBytes:coreFile.download.bytes,identity:resourceIdentity,
  profiles:{skirmish:profile([coreFile],capabilities),full:profile([coreFile,optionalFile],{campaign:true,movies:true,music:true,menuAnimation:true})},
  packs:{campaign:{files:[],totalBytes:0,downloadBytes:0,dependsOn:['cinematics'],capabilities:{campaign:true},requiresReload:true},
    cinematics:{files:[optionalFile],totalBytes:optionalFile.bytes,downloadBytes:optionalFile.download.bytes,dependsOn:[],capabilities:{movies:true},requiresReload:true}},theaterGroups:[]};
resources.catalogIdentity=nativeContentCatalogIdentity(resources);
const wasmFile=contentFile('vera20k_bg.wasm',wasmBytes);
const entry=(file,contentType='application/octet-stream')=>({key:`vera20k/web-native/objects/sha256/${file.sha256}`,bytes:file.bytes,sha256:file.sha256,contentType});
const object=entry(coreFile);
const release={schema:1,catalogIdentity:resources.catalogIdentity,
  build:{schema:2,patchSha256:'1'.repeat(64),resourceManifestSha256:resourceIdentity,contentCatalogIdentity:resources.catalogIdentity,
    outputs:{'vera20k_bg.wasm':{bytes:wasmFile.bytes,sha256:wasmFile.sha256,download:wasmFile.download}}},resources,objects:{}};
for(const file of [coreFile,optionalFile]) {
  release.objects[file.url]=entry(file);
  release.objects[file.download.url]=entry(file.download,'application/gzip');
}
release.objects['/native/vera20k_bg.wasm']=entry(wasmFile,'application/wasm');
release.objects[wasmFile.download.url]=entry(wasmFile.download,'application/gzip');
async function fixture(t) {
  const output=await build({entryPoints:[path.join(directory,'native-worker.mjs')],bundle:true,format:'esm',write:false,external:['cloudflare:workers'],plugins:[{name:'release-fixture',setup(api){api.onResolve({filter:/generated\/release\.json$/},()=>({path:'release',namespace:'fixture'}));api.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:JSON.stringify(release),loader:'json'}));}}]});
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:output.outputFiles[0].text,compatibilityDate:'2026-10-19',durableObjects:{NATIVE_ROOMS:{className:'NativeRooms',useSQLite:true}},r2Buckets:['NATIVE_DATA'],serviceBindings:{ASSETS:request=>new Response(new URL(request.url).pathname==='/index.html'?'native index':'not found',{status:new URL(request.url).pathname==='/index.html'?200:404})}}));
  t.after(()=>mf.dispose());
  const bucket=await mf.getR2Bucket('NATIVE_DATA');
  for(const value of Object.values(release.objects))await bucket.put(value.key,payloads.get(value.sha256),{customMetadata:{sha256:value.sha256},httpMetadata:{contentType:value.contentType,...(value.contentType==='application/gzip'?{contentEncoding:'gzip'}:{})}});
  return {mf,bucket};
}
test('Worker serves locked resource manifest and streams full/range/HEAD/conditional R2 objects',async t=>{
  const {mf}=await fixture(t);
  const manifest=await mf.dispatchFetch('https://game.test/api/native/resources');assert.deepEqual(await manifest.json(),release.resources);
  const full=await mf.dispatchFetch('https://game.test'+coreFile.url);assert.equal(full.status,200);assert.deepEqual(new Uint8Array(await full.arrayBuffer()),bytes);
  const range=await mf.dispatchFetch('https://game.test'+coreFile.url,{headers:{Range:'bytes=7-12'}});assert.equal(range.status,206);assert.equal(range.headers.get('Content-Range'),`bytes 7-12/${bytes.length}`);assert.equal(await range.text(),new TextDecoder().decode(bytes.slice(7,13)));
  const suffix=await mf.dispatchFetch('https://game.test'+coreFile.url,{headers:{Range:'bytes=-7'}});assert.equal(suffix.status,206);assert.equal((await suffix.arrayBuffer()).byteLength,7);
  const head=await mf.dispatchFetch('https://game.test/native/vera20k_bg.wasm',{method:'HEAD'});assert.equal(head.headers.get('Content-Type'),'application/wasm');assert.equal(head.headers.get('Content-Length'),String(wasmBytes.length));assert.equal((await head.arrayBuffer()).byteLength,0);
  assert.equal((await mf.dispatchFetch('https://game.test'+coreFile.url,{headers:{Range:'bytes=999-'}})).status,416);
  assert.equal((await mf.dispatchFetch('https://game.test'+coreFile.url,{headers:{'If-None-Match':`"${object.sha256}"`}})).status,304);
  assert.equal((await mf.dispatchFetch('https://game.test'+coreFile.url+'?sha256=wrong')).status,404);
  assert.equal((await mf.dispatchFetch('https://game.test/retail/ra2md.ini')).status,404);
  assert.equal((await mf.dispatchFetch('https://game.test'+coreFile.url,{method:'POST'})).status,405);
  assert.equal((await mf.dispatchFetch('https://game.test/')).status,200);
});
test('Worker fails closed when stored object metadata differs from the release',async t=>{
  const {mf,bucket}=await fixture(t);await bucket.put(object.key,bytes,{customMetadata:{sha256:'0'.repeat(64)}});
  assert.equal((await mf.dispatchFetch('https://game.test'+coreFile.url)).status,503);
});
test('Worker exposes optional content by exact SHA and leaves explicit gzip bytes encoded',async t=>{
  const {mf}=await fixture(t);
  const response=await mf.dispatchFetch('https://game.test'+optionalFile.download.url);
  assert.equal(response.status,200);
  assert.equal(response.headers.get('Content-Type'),'application/gzip');
  assert.equal(response.headers.get('Content-Encoding'),null);
  assert.match(response.headers.get('Cache-Control'),/31536000, immutable, no-transform/);
  const encoded=Buffer.from(await response.arrayBuffer());
  assert.equal(sha(encoded),optionalFile.download.sha256);
  assert.deepEqual(gunzipSync(encoded),Buffer.from(optionalBytes));
  assert.equal(resources.files.some(file=>file.name===optionalFile.name),false);
  assert.equal(resources.profiles.full.files.some(file=>file.name===optionalFile.name),true);
  assert.equal((await mf.dispatchFetch('https://game.test/content/objects/'+'f'.repeat(64))).status,404);
  assert.equal((await mf.dispatchFetch('https://game.test/content/objects/../../target.json')).status,404);
  const range=await mf.dispatchFetch('https://game.test'+wasmFile.download.url,{headers:{Range:'bytes=0-9'}});
  assert.equal(range.status,206);assert.equal(range.headers.get('Content-Encoding'),null);
  const prefix=new Uint8Array(await range.arrayBuffer());assert.equal(prefix.length,10);
  assert.deepEqual([...prefix.slice(0,3)],[31,139,8]);
});

const fixtureTarget={accountId:'a143c234b30a44c323ed2f2273c9c9da',bucket:'youlidefuchou-res',objectPrefix:'vera20k/web-native/objects/sha256/'};
function planningFixture() {
  const index={manifest:structuredClone(resources),objects:new Map()};
  for(const [url,object] of Object.entries(release.objects))if(url.startsWith('/content/'))
    index.objects.set(object.sha256,{...object,path:'/fixture/'+object.sha256,url});
  // Engine transfer objects are admitted separately from the content catalog.
  index.objects.delete(wasmFile.download.sha256);
  return {build:structuredClone(release.build),index,target:fixtureTarget,root:'/fixture'};
}
test('release plan publishes all raw and compressed profile/pack objects with isolated target identity',()=>{
  const input=planningFixture(),planned=nativeReleaseObjects(input);
  assert.deepEqual(planned.release.resources,resources);
  assert.deepEqual(planned.release.deployment,fixtureTarget);
  assert.equal(planned.release.catalogIdentity,resources.catalogIdentity);
  assert.equal(planned.uploads.size,6);
  assert.equal(Object.keys(planned.release.objects).length,6);
  for(const object of Object.values(planned.release.objects))assert.equal(object.key,fixtureTarget.objectPrefix+object.sha256);
  assert.equal(JSON.stringify(planned.release).includes('/fixture/'),false);
  assert.equal(planned.release.objects[wasmFile.download.url].contentType,'application/gzip');
});
test('release plan rejects stale catalog/build, missing transfer objects and divergent required identity',()=>{
  for(const mutate of [input=>{input.build.contentCatalogIdentity='0'.repeat(64);},
    input=>{input.build.resourceManifestSha256='0'.repeat(64);},
    input=>{input.index.objects.delete(optionalFile.download.sha256);},
    input=>{input.build.outputs['vera20k_bg.wasm'].download.encoding='identity';}]) {
    const input=planningFixture();mutate(input);assert.throws(()=>nativeReleaseObjects(input));
  }
  const input=planningFixture();input.index.manifest.profiles.full.requiredResourceIdentity='0'.repeat(64);
  input.index.manifest.catalogIdentity=nativeContentCatalogIdentity(input.index.manifest);
  input.build.contentCatalogIdentity=input.index.manifest.catalogIdentity;
  assert.throws(()=>nativeReleaseObjects(input),/gameplay identity/);
});
test('post-deployment release gate validates layered coverage without assuming files plus one',()=>{
  const checked=validateRelease(release);
  assert.equal(checked.resourceIdentity,resourceIdentity);
  assert.equal(checked.catalogIdentity,resources.catalogIdentity);
  assert.equal(checked.coverage.objects,6);
  assert.equal(checked.coverage.requiredObjectUrls,6);
  assert.deepEqual(checked.coverage.profiles,{skirmish:1,full:2});
});
test('post-deployment release gate rejects catalog drift, optional gaps and missing engine transfer',()=>{
  for(const mutate of [value=>{value.resources.packs.campaign.dependsOn=[];},
    value=>{delete value.objects[optionalFile.url];},value=>{delete value.objects[wasmFile.download.url];},
    value=>{value.build.contentCatalogIdentity='0'.repeat(64);},
    value=>{value.build.outputs['vera20k_bg.wasm'].download.encoding='identity';}]) {
    const value=structuredClone(release);mutate(value);assert.throws(()=>validateRelease(value));
  }
  const value=structuredClone(release);
  value.resources.profiles.full.requiredResourceIdentity='0'.repeat(64);
  value.resources.catalogIdentity=nativeContentCatalogIdentity(value.resources);
  value.catalogIdentity=value.build.contentCatalogIdentity=value.resources.catalogIdentity;
  assert.throws(()=>validateRelease(value),/shared gameplay identity/);
});

async function socket(mf) {
  const response=await mf.dispatchFetch('https://game.test/ws/native',{headers:{Upgrade:'websocket',Origin:'https://game.test'}});
  assert.equal(response.status,101);const ws=response.webSocket,messages=[],waiters=[];
  ws.addEventListener('message',event=>{const message=JSON.parse(event.data);messages.push(message);for(const waiter of [...waiters])if(waiter.type===message.type&&waiter.predicate(message)){waiters.splice(waiters.indexOf(waiter),1);waiter.resolve(message);}});
  ws.accept();
  return {ws,messages,send:value=>ws.send(JSON.stringify(value)),wait:(type,predicate=()=>true)=>{
    const prior=messages.find(message=>message.type===type&&predicate(message));if(prior)return Promise.resolve(prior);
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Timed out waiting for '+type)),5000);waiters.push({type,predicate,resolve:value=>{clearTimeout(timer);resolve(value);}});});
  }};
}
async function launchPair(t,mf) {
  const a=await socket(mf),b=await socket(mf);t.after(()=>{for(const client of [a,b])if(client.ws.readyState===1)client.ws.close();});
  assert.equal((await a.wait('hello')).protocol,2);
  a.send({type:'create',name:'Host'});const room=(await a.wait('room')).room;
  b.send({type:'join',name:'Guest',code:room.code});await b.wait('room');
  b.send({type:'ready'});await a.wait('room',message=>message.room?.canStart);
  a.send({type:'start'});const start=await a.wait('start');await b.wait('start');
  for(const client of [a,b])client.send({type:'progress',matchId:start.matchId,percent:100});
  await a.wait('progress',message=>message.source===1);
  // A full save includes player-local view state. Different diagnostic hashes
  // must still admit identical shared build/resources/owners/initial tick.
  for(const [index,client] of [a,b].entries())client.send({type:'loaded',matchId:start.matchId,tick:100,hash:`local-view-${index}`,owners:[0,14],build:'native-test',resourceManifest:resourceIdentity});
  const ready=await a.wait('ready');assert.equal(ready.tick,101);assert.equal(ready.bootstrap,start.matchId);assert.deepEqual(await b.wait('ready'),ready);
  return {a,b,start,ready,room};
}
test('Durable Object reuses native v2 authority for two clients, barrier, turn order, ownership and disconnect',async t=>{
  const {mf}=await fixture(t);
  assert.equal((await mf.dispatchFetch('https://game.test/ws/native',{headers:{Upgrade:'websocket'}})).status,403);
  assert.equal((await mf.dispatchFetch('https://game.test/ws/native',{headers:{Upgrade:'websocket',Origin:'https://other.test'}})).status,403);
  const {a,b,start,ready}=await launchPair(t,mf);
  const bootstrap=`launch:${ready.bootstrap}`;
  a.send({type:'input',matchId:start.matchId,tick:101,prevHash:'local-view-0',commands:[]});
  assert.match((await a.wait('error')).error,/初始装载凭据/);
  b.send({type:'input',matchId:start.matchId,tick:101,prevHash:bootstrap,commands:[{owner:0,execute_tick:101,payload:'Stop'}]});
  assert.match((await b.wait('error')).error,/其他玩家/);
  a.send({type:'input',matchId:start.matchId,tick:101,prevHash:bootstrap,commands:[{owner:0,execute_tick:101,payload:'Stop'}]});
  b.send({type:'input',matchId:start.matchId,tick:101,prevHash:bootstrap,commands:[]});
  const turn=await a.wait('turn');assert.equal(turn.tick,101);assert.equal(turn.commands.length,1);assert.equal(turn.commands[0].player,0);
  assert.deepEqual(await b.wait('turn'),turn);
  a.send({type:'input',matchId:start.matchId,tick:102,prevHash:bootstrap,commands:[]});
  assert.match((await a.wait('error',message=>/原生逐帧校验凭据/.test(message.error))).error,/原生逐帧校验凭据/);
  for(const client of [a,b])client.send({type:'input',matchId:start.matchId,tick:102,prevHash:'retail:101:1a2b3c4d',commands:[]});
  const second=await a.wait('turn',message=>message.tick===102);assert.deepEqual(second.commands,[]);
  assert.deepEqual(await b.wait('turn',message=>message.tick===102),second);
  b.ws.close(1000,'exit');assert.match((await a.wait('stopped')).reason,/离开/);
});
test('Durable Object confirms normal native results, clears the room and ignores completed-match output',async t=>{
  const {mf}=await fixture(t),{a,b,start,ready,room}=await launchPair(t,mf);
  for(const client of [a,b])client.send({type:'input',matchId:start.matchId,tick:101,prevHash:`launch:${ready.bootstrap}`,commands:[]});
  await a.wait('turn',message=>message.tick===101);await b.wait('turn',message=>message.tick===101);
  const result={type:'finished',matchId:start.matchId,tick:101,checksum:'retail:100:1a2b3c4d'};
  for(const client of [a,b])client.send(result);
  assert.deepEqual(await a.wait('finished'),result);assert.deepEqual(await b.wait('finished'),result);
  await a.wait('room',message=>message.room===null);await b.wait('room',message=>message.room===null);
  const marker=a.messages.length;
  a.send({type:'input',matchId:start.matchId,tick:102,prevHash:'retail:101:1a2b3c4d',commands:[]});
  a.send(result);
  a.send({type:'create',name:'New match after results'});
  const next=await a.wait('room',message=>message.room&&message.room.code!==room.code);
  assert.equal(next.room.phase,'lobby');
  assert.equal(a.messages.slice(marker).some(message=>message.type==='error'||message.type==='stopped'),false);
});
