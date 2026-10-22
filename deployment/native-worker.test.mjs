import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import {nativeAssetManifestIdentity,nativeContentCatalogIdentity} from '../tools/native-build-manifest.mjs';
import {nativeReleaseObjects} from './prepare-native.mjs';
import {validateRelease} from './verify-native.mjs';
import {nativeRequestOrigin,nativeCorsResponse} from './native-origin.mjs';
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
const wasmFile=contentFile('werhd_bg.wasm',wasmBytes);
const entry=(file,contentType='application/octet-stream')=>({key:`vera20k/web-native/objects/sha256/${file.sha256}`,bytes:file.bytes,sha256:file.sha256,contentType});
const object=entry(coreFile);
const release={schema:1,catalogIdentity:resources.catalogIdentity,
  build:{schema:2,patchSha256:'1'.repeat(64),resourceManifestSha256:resourceIdentity,contentCatalogIdentity:resources.catalogIdentity,
    outputs:{'werhd_bg.wasm':{bytes:wasmFile.bytes,sha256:wasmFile.sha256,download:wasmFile.download}}},resources,objects:{}};
for(const file of [coreFile,optionalFile]) {
  release.objects[file.url]=entry(file);
  release.objects[file.download.url]=entry(file.download,'application/gzip');
}
release.objects['/native/werhd_bg.wasm']=entry(wasmFile,'application/wasm');
release.objects[wasmFile.download.url]=entry(wasmFile.download,'application/gzip');
const instrumentedRoomEntry=`
import worker,{NativeRooms as ActualNativeRooms} from './native-worker.mjs';
export class NativeRooms extends ActualNativeRooms {
  inspect(){return {watchdog:this.watchdog!==null,clients:this.coordinator?.clients.size??0,rooms:this.coordinator?.rooms.size??0,internalCallbacks:this.internalCallbacks??[]};}
  ageClients(){for(const client of this.coordinator.clients)client.lastSeenAt=Date.now()-60000;}
  trackInternalErrors(){
    const handle=this.coordinator.handleInternalError.bind(this.coordinator);this.internalCallbacks=[];
    this.coordinator.handleInternalError=(client,error,callback)=>{this.internalCallbacks.push(callback);return handle(client,error,callback);};
  }
  faultReceive(id){
    const receive=this.coordinator.receive.bind(this.coordinator);this.trackInternalErrors();
    this.coordinator.receive=(client,text)=>{if(client.id===id)throw new Error('TEST_SECRET_MUST_NOT_BE_LOGGED');return receive(client,text);};
  }
  faultConnect(){this.trackInternalErrors();this.coordinator.connect=()=>{throw new TypeError('TEST_SECRET_MUST_NOT_BE_LOGGED');};}
}
export default {async fetch(request,env){
  const url=new URL(request.url),room=env.NATIVE_ROOMS.getByName('native-v3-shard-0');
  if(url.pathname==='/__test/native-state')return Response.json(await room.inspect());
  if(url.pathname==='/__test/native-age'){await room.ageClients();return Response.json({ok:true});}
  if(url.pathname==='/__test/native-fault'){await room.faultReceive(url.searchParams.get('id'));return Response.json({ok:true});}
  if(url.pathname==='/__test/native-connect-fault'){await room.faultConnect();return Response.json({ok:true});}
  return worker.fetch(request,env);
}};`;
async function fixture(t,{directObjectName,instrumentRooms=false,staleEngineAssets=false}={}) {
  // A test-only outer handler can deliberately bypass normal shard routing to
  // exercise the Durable Object's own validation with an intact request URL.
  const entry=instrumentRooms?{stdin:{contents:instrumentedRoomEntry,resolveDir:directory}}:directObjectName?{stdin:{contents:`export {NativeRooms} from './native-worker.mjs';export default {fetch(request,env){return env.NATIVE_ROOMS.getByName(${JSON.stringify(directObjectName)}).fetch(request);}}`,resolveDir:directory}}:{entryPoints:[path.join(directory,'native-worker.mjs')]};
  const output=await build({...entry,bundle:true,format:'esm',write:false,external:['cloudflare:workers'],plugins:[{name:'release-fixture',setup(api){api.onResolve({filter:/generated\/release\.json$/},()=>({path:'release',namespace:'fixture'}));api.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:JSON.stringify(release),loader:'json'}));}}]});
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:output.outputFiles[0].text,compatibilityDate:'2026-10-19',durableObjects:{NATIVE_ROOMS:{className:'NativeRooms',useSQLite:true}},r2Buckets:['NATIVE_DATA'],serviceBindings:{ASSETS:request=>{
    const pathname=new URL(request.url).pathname;
    if(pathname==='/index.html')return new Response('native index');
    if(pathname==='/native/werhd.js')return new Response('WERHD browser module',{headers:{'Content-Type':'text/javascript','Vary':'Accept-Encoding'}});
    if(pathname==='/fonts/FiraSansCondensed-Medium.ttf')return new Response('font fixture',{headers:{'Content-Type':'font/ttf'}});
    if(staleEngineAssets&&['/native/vera20k.js','/native/vera20k_bg.wasm'].includes(pathname))return new Response('stale engine asset');
    return new Response('not found',{status:404});
  }}}));
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
  const head=await mf.dispatchFetch('https://game.test/native/werhd_bg.wasm',{method:'HEAD'});assert.equal(head.headers.get('Content-Type'),'application/wasm');assert.equal(head.headers.get('Content-Length'),String(wasmBytes.length));assert.equal((await head.arrayBuffer()).byteLength,0);
  assert.equal((await mf.dispatchFetch('https://game.test'+coreFile.url,{headers:{Range:'bytes=999-'}})).status,416);
  assert.equal((await mf.dispatchFetch('https://game.test'+coreFile.url,{headers:{'If-None-Match':`"${object.sha256}"`}})).status,304);
  assert.equal((await mf.dispatchFetch('https://game.test'+coreFile.url+'?sha256=wrong')).status,404);
  assert.equal((await mf.dispatchFetch('https://game.test/retail/ra2md.ini')).status,404);
  assert.equal((await mf.dispatchFetch('https://game.test'+coreFile.url,{method:'POST'})).status,405);
  assert.equal((await mf.dispatchFetch('https://game.test/')).status,200);
});
test('public engine routes use WERHD names and reject legacy aliases even in stale static assets',async t=>{
  const {mf}=await fixture(t,{staleEngineAssets:true});
  assert.equal((await mf.dispatchFetch('https://game.test/native/werhd.js')).status,200);
  assert.equal((await mf.dispatchFetch('https://game.test/native/werhd_bg.wasm',{method:'HEAD'})).status,200);
  for(const path of ['/native/vera20k.js','/native/vera20k_bg.wasm','/native/vera20k.js?sha256='+wasmFile.sha256,
    '/native/%76era20k.js','/native/werhd.js.map','/native/unknown.js'])
    assert.equal((await mf.dispatchFetch('https://game.test'+path)).status,404,path);
  for(const path of ['/api/health','/native/build.json','/api/native/resources']) {
    const response=await mf.dispatchFetch('https://game.test'+path),text=await response.text();
    assert.doesNotMatch(text,/vera20k|\bvera\b/i,path);
    assert.equal(text.includes('objectPrefix'),false,path);
    assert.equal(text.includes('youlidefuchou-res'),false,path);
    assert.equal(JSON.stringify([...response.headers]).includes('vera20k/web-native'),false,path);
    if(path==='/api/health')assert.equal(JSON.parse(text).app,'werhd-native');
  }
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

const toyOrigins=['https://bilibilitoy.com','https://www.bilibilitoy.com','https://preview-123.toy.bilibilitoy.com','https://bilibilitoy.com:443'];
const foreignOrigins=['null','https://other.test','http://bilibilitoy.com','https://bilibilitoy.com:444',
  'https://evilbilibilitoy.com','https://bilibilitoy.com.evil.test','https://bilibilitoy.com@evil.test',
  'https://evil.test@bilibilitoy.com','https://.bilibilitoy.com','https://a..bilibilitoy.com',
  'https://-preview.bilibilitoy.com','https://preview_.bilibilitoy.com','https://bilibilitoy.com.',
  'https://bilibilitoy.com/','https://bilibilitoy.com/path','https://bilibilitoy.com?query',
  'https://bilibilitoy.com#fragment','https://bilibilitoy.com https://other.test','not an origin'];
const originRequest=origin=>new Request('https://game.test/native/build.json',{headers:origin===undefined?{}:{Origin:origin}});
function assertCors(response,origin) {
  assert.equal(response.headers.get('Access-Control-Allow-Origin'),origin);
  assert.equal(response.headers.get('Access-Control-Allow-Credentials'),null);
  assert.match(response.headers.get('Vary'),/(?:^|,\s*)Origin(?:,|$)/i);
}
test('native Origin policy admits same-origin and HTTPS Toy domains with proper DNS boundaries',()=>{
  for(const origin of ['https://game.test',...toyOrigins])assert.equal(nativeRequestOrigin(originRequest(origin)),origin,origin);
  for(const origin of [undefined,...foreignOrigins])assert.equal(nativeRequestOrigin(originRequest(origin)),null,String(origin));
  const response=new Response('static',{headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Credentials':'true','Vary':'Accept-Encoding'}});
  const foreign=nativeCorsResponse(originRequest('https://other.test'),response);
  assertCors(foreign,null);assert.match(foreign.headers.get('Vary'),/Accept-Encoding/);
});
test('Toy CORS covers manifests, JS, fonts, HEAD and immutable full/range/304/error responses',async t=>{
  const {mf,bucket}=await fixture(t);
  for(const origin of toyOrigins)for(const path of ['/api/health','/api/native/resources','/native/build.json','/native/werhd.js','/fonts/FiraSansCondensed-Medium.ttf',coreFile.download.url]) {
    const response=await mf.dispatchFetch('https://game.test'+path,{headers:{Origin:origin}});
    assert.equal(response.status,200,path);assertCors(response,origin);
    assert.match(response.headers.get('Access-Control-Expose-Headers'),/ETag/);
    if(path==='/api/native/resources')assert.deepEqual(await response.json(),release.resources);
    else await response.arrayBuffer();
  }
  const origin='https://www.bilibilitoy.com';
  const head=await mf.dispatchFetch('https://game.test/native/werhd_bg.wasm',{method:'HEAD',headers:{Origin:origin}});
  assertCors(head,origin);assert.equal(head.headers.get('Content-Length'),String(wasmBytes.length));assert.equal((await head.arrayBuffer()).byteLength,0);
  for(const [headers,status] of [[{Range:'bytes=0-9'},206],[{'If-None-Match':`"${coreFile.download.sha256}"`},304],[{Range:'bytes=999-'},416]]) {
    const response=await mf.dispatchFetch('https://game.test'+coreFile.download.url,{headers:{Origin:origin,...headers}});
    assert.equal(response.status,status);assertCors(response,origin);assert.equal(response.headers.get('Content-Encoding'),null);
    if(status===206){assert.equal(response.headers.get('Content-Type'),'application/gzip');assert.equal(response.headers.get('Content-Range'),`bytes 0-9/${coreFile.download.bytes}`);}
    await response.arrayBuffer();
  }
  for(const path of ['/content/objects/'+'f'.repeat(64),'/native/unknown.js','/api/unknown']) {
    const response=await mf.dispatchFetch('https://game.test'+path,{headers:{Origin:origin}});
    assert.equal(response.status,404);assertCors(response,origin);await response.arrayBuffer();
  }
  await bucket.put(object.key,bytes,{customMetadata:{sha256:'0'.repeat(64)}});
  const unavailable=await mf.dispatchFetch('https://game.test'+coreFile.url,{headers:{Origin:origin}});
  assert.equal(unavailable.status,503);assertCors(unavailable,origin);await unavailable.arrayBuffer();
  for(const bad of foreignOrigins) {
    const response=await mf.dispatchFetch('https://game.test/api/native/resources',{headers:{Origin:bad}});
    assertCors(response,null);await response.arrayBuffer();
  }
});
test('Toy preflight allows only GET/HEAD and explicit range/conditional request headers without credentials',async t=>{
  const {mf}=await fixture(t),origin='https://www.bilibilitoy.com';
  for(const method of ['GET','HEAD']) {
    const response=await mf.dispatchFetch('https://game.test'+coreFile.download.url,{method:'OPTIONS',headers:{Origin:origin,
      'Access-Control-Request-Method':method,'Access-Control-Request-Headers':'Range, If-None-Match, If-Range'}});
    assert.equal(response.status,204);assertCors(response,origin);
    assert.equal(response.headers.get('Access-Control-Allow-Methods'),'GET, HEAD');
    assert.equal(response.headers.get('Access-Control-Allow-Headers'),'range, if-none-match, if-range');
    assert.match(response.headers.get('Vary'),/Access-Control-Request-Method/);
    assert.match(response.headers.get('Vary'),/Access-Control-Request-Headers/);
  }
  const simple=await mf.dispatchFetch('https://game.test/native/build.json',{method:'OPTIONS',headers:{Origin:origin,'Access-Control-Request-Method':'GET'}});
  assert.equal(simple.status,204);assertCors(simple,origin);assert.equal(simple.headers.get('Access-Control-Allow-Headers'),null);
  for(const headers of [
    {Origin:origin,'Access-Control-Request-Method':'POST'},
    {Origin:origin,'Access-Control-Request-Method':'GET','Access-Control-Request-Headers':'Authorization'},
    {Origin:origin,'Access-Control-Request-Method':'GET','Access-Control-Request-Headers':'Range, Cookie'},
    {Origin:origin,'Access-Control-Request-Method':'GET','Access-Control-Request-Headers':'Range,'},
    {Origin:origin},
    ...foreignOrigins.map(Origin=>({Origin,'Access-Control-Request-Method':'GET'})),
  ]) {
    const response=await mf.dispatchFetch('https://game.test/native/build.json',{method:'OPTIONS',headers});
    assert.equal(response.status,403);assertCors(response,null);await response.arrayBuffer();
  }
  const socket=await mf.dispatchFetch('https://game.test/ws/native',{method:'OPTIONS',headers:{Origin:origin,'Access-Control-Request-Method':'GET'}});
  assert.equal(socket.status,403);assertCors(socket,null);await socket.arrayBuffer();
});

for(const direct of [false,true])test(`Toy WebSocket Origin admission is enforced by ${direct?'the Durable Object directly':'the outer Worker and Durable Object'}`,async t=>{
  const {mf}=await fixture(t,direct?{directObjectName:'toy-origin-direct'}:{}),clients=[];
  t.after(()=>{for(const ws of clients)if(ws.readyState===1)ws.close();});
  for(const origin of toyOrigins) {
    const response=await mf.dispatchFetch('https://game.test/ws/native?shard=0',{headers:{Upgrade:'websocket',Origin:origin}});
    assert.equal(response.status,101,origin);const ws=response.webSocket;ws.accept();clients.push(ws);
    const hello=await new Promise(resolve=>ws.addEventListener('message',event=>resolve(JSON.parse(event.data)),{once:true}));
    assert.equal(hello.type,'hello');assert.equal(hello.protocol,3);
  }
  for(const origin of [undefined,...foreignOrigins]) {
    const response=await mf.dispatchFetch('https://game.test/ws/native?shard=0',{headers:{Upgrade:'websocket',...(origin===undefined?{}:{Origin:origin})}});
    assert.equal(response.status,403,String(origin));assert.equal(response.webSocket,null);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'),null);await response.arrayBuffer();
  }
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
    input=>{input.build.outputs['werhd_bg.wasm'].download.encoding='identity';}]) {
    const input=planningFixture();mutate(input);assert.throws(()=>nativeReleaseObjects(input));
  }
  const input=planningFixture();input.index.manifest.profiles.full.requiredResourceIdentity='0'.repeat(64);
  input.index.manifest.catalogIdentity=nativeContentCatalogIdentity(input.index.manifest);
  input.build.contentCatalogIdentity=input.index.manifest.catalogIdentity;
  assert.throws(()=>nativeReleaseObjects(input),/gameplay identity/);
});
test('release planning and verification reject legacy public branding without changing private R2 identity',()=>{
  for(const field of ['renderer','legacyOutput']) {
    const input=planningFixture();
    if(field==='renderer')input.build.renderer='VERA wgpu/WebGPU';
    else input.build.outputs['vera20k.js']={bytes:1,sha256:'0'.repeat(64)};
    assert.throws(()=>nativeReleaseObjects(input),/legacy engine name/);
    const value=structuredClone(release);value.build=input.build;
    assert.throws(()=>validateRelease(value),/WERHD names/);
  }
  assert.equal(nativeReleaseObjects(planningFixture()).release.deployment.objectPrefix,'vera20k/web-native/objects/sha256/');
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
    value=>{value.build.outputs['werhd_bg.wasm'].download.encoding='identity';}]) {
    const value=structuredClone(release);mutate(value);assert.throws(()=>validateRelease(value));
  }
  const value=structuredClone(release);
  value.resources.profiles.full.requiredResourceIdentity='0'.repeat(64);
  value.resources.catalogIdentity=nativeContentCatalogIdentity(value.resources);
  value.catalogIdentity=value.build.contentCatalogIdentity=value.resources.catalogIdentity;
  assert.throws(()=>validateRelease(value),/shared gameplay identity/);
});

async function socket(mf,query='') {
  const response=await mf.dispatchFetch('https://game.test/ws/native'+query,{headers:{Upgrade:'websocket',Origin:'https://game.test'}});
  assert.equal(response.status,101);const ws=response.webSocket,messages=[],waiters=[];
  const closed=new Promise(resolve=>ws.addEventListener('close',event=>resolve({code:event.code,wasClean:event.wasClean})));
  ws.addEventListener('message',event=>{const message=JSON.parse(event.data);messages.push(message);for(const waiter of [...waiters])if(waiter.type===message.type&&waiter.predicate(message)){waiters.splice(waiters.indexOf(waiter),1);waiter.resolve(message);}});
  ws.accept();
  return {ws,messages,closed,send:value=>ws.send(JSON.stringify(value)),wait:(type,predicate=()=>true)=>{
    const prior=messages.find(message=>message.type===type&&predicate(message));if(prior)return Promise.resolve(prior);
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Timed out waiting for '+type)),5000);waiters.push({type,predicate,resolve:value=>{clearTimeout(timer);resolve(value);}});});
  }};
}
async function launchPair(t,mf,query='') {
  const a=await socket(mf,query),b=await socket(mf,query);t.after(()=>{for(const client of [a,b])if(client.ws.readyState===1)client.ws.close();});
  assert.equal((await a.wait('hello')).protocol,3);
  for(const client of [a,b])client.send({type:'hello',protocol:3});
  a.send({type:'create',name:'Host'});const room=(await a.wait('room')).room;
  b.send({type:'join',name:'Guest',code:room.code});await b.wait('room');
  b.send({type:'ready'});await a.wait('room',message=>message.room?.canStart);
  a.send({type:'start'});const start=await a.wait('start');await b.wait('start');
  for(const client of [a,b])client.send({type:'progress',matchId:start.matchId,percent:100});
  await a.wait('progress',message=>message.source===1);
  // A full save includes player-local view state. Different diagnostic hashes
  // must still admit identical shared build/resources/owners/initial tick.
  for(const [index,client] of [a,b].entries())client.send({type:'loaded',protocol:3,matchId:start.matchId,tick:100,hash:`local-view-${index}`,owners:[0,14],build:'native-test',resourceManifest:resourceIdentity});
  const ready=await a.wait('ready');assert.equal(ready.tick,101);assert.equal(ready.bootstrap,start.matchId);assert.deepEqual(await b.wait('ready'),ready);
  return {a,b,start,ready,room};
}
async function until(predicate,timeoutMs=2000) {
  const started=Date.now();
  for(;;){const value=await predicate();if(value)return value;if(Date.now()-started>=timeoutMs)throw new Error('Timed out waiting for room lifecycle');await new Promise(resolve=>setTimeout(resolve,20));}
}
async function closedWithin(client,timeoutMs=2000) {
  let timer;
  try{return await Promise.race([client.closed,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Timed out waiting for socket close')),timeoutMs);})]);}
  finally{clearTimeout(timer);}
}
test('Durable Object watchdog starts only with clients and stops on last close or idle expiration',async t=>{
  const {mf}=await fixture(t,{instrumentRooms:true}),state=async()=>await (await mf.dispatchFetch('https://game.test/__test/native-state')).json();
  assert.deepEqual(await state(),{watchdog:false,clients:0,rooms:0,internalCallbacks:[]});
  const first=await socket(mf,'?shard=0');t.after(()=>{if(first.ws.readyState===1)first.ws.close();});await first.wait('hello');
  assert.deepEqual(await state(),{watchdog:true,clients:1,rooms:0,internalCallbacks:[]});
  first.ws.close();await until(async()=>!(await state()).watchdog);assert.equal((await state()).clients,0);
  const second=await socket(mf,'?shard=0');t.after(()=>{if(second.ws.readyState===1)second.ws.close();});await second.wait('hello');
  assert.equal((await state()).watchdog,true);
  await mf.dispatchFetch('https://game.test/__test/native-age');
  assert.equal((await closedWithin(second,6500)).code,1001);
  assert.deepEqual(await state(),{watchdog:false,clients:0,rooms:0,internalCallbacks:[]});
});
test('Durable Object callback faults stop only the affected room and report once',async t=>{
  const {mf}=await fixture(t,{instrumentRooms:true}),clients=[];t.after(()=>{for(const client of clients)if(client.ws.readyState===1)client.ws.close();});
  for(let index=0;index<4;index++){const client=await socket(mf,'?shard=0');clients.push(client);client.identity=await client.wait('hello');client.send({type:'hello',protocol:3});}
  const [a,b,c,d]=clients;
  a.send({type:'create',name:'Affected host'});const roomA=(await a.wait('room')).room;b.send({type:'join',name:'Affected guest',code:roomA.code});await b.wait('room');
  c.send({type:'create',name:'Healthy host'});const roomC=(await c.wait('room')).room;d.send({type:'join',name:'Healthy guest',code:roomC.code});await d.wait('room');
  await mf.dispatchFetch('https://game.test/__test/native-fault?id='+a.identity.playerId);
  a.send({type:'ping'});await b.wait('stopped');assert.equal((await closedWithin(a)).code,1011);
  const snapshot=await (await mf.dispatchFetch('https://game.test/__test/native-state')).json();
  assert.deepEqual(snapshot,{watchdog:true,clients:3,rooms:1,internalCallbacks:['message']});
  for(const client of [c,d]){client.send({type:'ping'});assert.deepEqual(await client.wait('pong'),{type:'pong'});}
  c.send({type:'config',config:{options:{credits:12000}}});assert.equal((await d.wait('room',message=>message.room?.config.options.credits===12000)).room.code,roomC.code);
});
test('Durable Object connect exceptions use internal-error closure rather than a capacity response',async t=>{
  const {mf}=await fixture(t,{instrumentRooms:true}),healthy=await socket(mf,'?shard=0');t.after(()=>{if(healthy.ws.readyState===1)healthy.ws.close();});
  await healthy.wait('hello');healthy.send({type:'hello',protocol:3});
  await mf.dispatchFetch('https://game.test/__test/native-connect-fault');
  const rejected=await socket(mf,'?shard=0');assert.equal((await closedWithin(rejected)).code,1011);
  healthy.send({type:'ping'});assert.deepEqual(await healthy.wait('pong'),{type:'pong'});
  assert.deepEqual(await (await mf.dispatchFetch('https://game.test/__test/native-state')).json(),{watchdog:true,clients:1,rooms:0,internalCallbacks:['connect']});
});
test('Worker exposes fixed room routing capacity without changing release identity',async t=>{
  const {mf}=await fixture(t),health=await (await mf.dispatchFetch('https://game.test/api/health')).json();
  assert.deepEqual(health.roomRouting,{shards:8,maxClientsPerShard:16,maxRoomsPerShard:8});
  assert.equal(health.protocol,3);assert.equal(health.patchSha256,release.build.patchSha256);
  assert.equal(health.resourceManifestSha256,resourceIdentity);assert.equal(health.contentCatalogIdentity,resources.catalogIdentity);
});
test('Worker rejects invalid shard queries and preserves same-origin upgrade checks',async t=>{
  const {mf}=await fixture(t),headers={Upgrade:'websocket',Origin:'https://game.test'};
  for(const query of ['?shard=','?shard=8','?shard=-1','?shard=00','?shard=1.0','?shard=0&shard=0','?shard=0&extra=1','?extra=1']) {
    const response=await mf.dispatchFetch('https://game.test/ws/native'+query,{headers});
    assert.equal(response.status,400,query);assert.deepEqual(await response.json(),{error:'Invalid room shard'});
  }
  assert.equal((await mf.dispatchFetch('https://game.test/ws/native?shard=0',{headers:{Upgrade:'websocket',Origin:'https://other.test'}})).status,403);
  assert.equal((await mf.dispatchFetch('https://game.test/ws/native?shard=0',{headers:{Origin:'https://game.test'}})).status,426);
});
test('Worker isolates all eight shard rooms and retains the legacy six-hex route',async t=>{
  const {mf}=await fixture(t),clients=[];t.after(()=>{for(const client of clients)if(client.ws.readyState===1)client.ws.close();});
  const rooms=[];
  for(let shard=0;shard<8;shard++) {
    const client=await socket(mf,`?shard=${shard}`);clients.push(client);
    await client.wait('hello');client.send({type:'hello',protocol:3});client.send({type:'create',name:'Shard host'});
    const {room}=await client.wait('room');assert.match(room.code,new RegExp(`^S${shard}[A-F0-9]{5}$`));rooms.push(room);
  }
  const legacy=await socket(mf);clients.push(legacy);await legacy.wait('hello');legacy.send({type:'hello',protocol:3});legacy.send({type:'create',name:'Legacy host'});
  assert.match((await legacy.wait('room')).room.code,/^[A-F0-9]{6}$/);
  const guest=await socket(mf,'?shard=1');clients.push(guest);await guest.wait('hello');guest.send({type:'hello',protocol:3});
  guest.send({type:'join',name:'Guest',code:rooms[0].code});assert.match((await guest.wait('error')).error,/找不到/);
  guest.send({type:'join',name:'Guest',code:rooms[1].code});assert.equal((await guest.wait('room')).room.code,rooms[1].code);
});
test('Worker enforces sixteen clients and eight rooms per shard while a neighboring shard stays available',async t=>{
  const {mf}=await fixture(t),clients=[];t.after(()=>{for(const client of clients)if(client.ws.readyState===1)client.ws.close();});
  for(let index=0;index<16;index++) {
    const client=await socket(mf,'?shard=0');clients.push(client);await client.wait('hello');client.send({type:'hello',protocol:3});
    if(index<8){client.send({type:'create',name:'Capacity host'});assert.match((await client.wait('room')).room.code,/^S0[A-F0-9]{5}$/);}
  }
  clients[8].send({type:'create',name:'Ninth room'});const capacity=await clients[8].wait('error');assert.match(capacity.error,/房间已满/);assert.equal(capacity.code,'ROOM_CAPACITY');
  const overflow=await socket(mf,'?shard=0');clients.push(overflow);assert.equal((await overflow.closed).code,1013);
  const neighbor=await socket(mf,'?shard=1');clients.push(neighbor);await neighbor.wait('hello');neighbor.send({type:'hello',protocol:3});neighbor.send({type:'create',name:'Available host'});
  assert.match((await neighbor.wait('room')).room.code,/^S1[A-F0-9]{5}$/);
});
test('Durable Object validates shard queries before accepting a socket and locks its coordinator route',async t=>{
  const {mf}=await fixture(t,{directObjectName:'direct-shard-test'});
  const headers={Upgrade:'websocket',Origin:'https://game.test'};
  const direct=query=>mf.dispatchFetch('https://game.test/ws/native'+query,{headers});
  assert.equal((await direct('?shard=8')).status,400);
  const accepted=await direct('?shard=4');assert.equal(accepted.status,101);
  accepted.webSocket.accept();t.after(()=>{if(accepted.webSocket.readyState===1)accepted.webSocket.close();});
  assert.equal((await direct('?shard=4&shard=4')).status,400);
  assert.equal((await direct('?shard=3')).status,409);
  assert.equal((await direct('')).status,409);
});
test('Durable Object shares v3 pipeline authority, ownership checks and independent CRC',async t=>{
  const {mf}=await fixture(t);
  assert.equal((await mf.dispatchFetch('https://game.test/ws/native',{headers:{Upgrade:'websocket'}})).status,403);
  assert.equal((await mf.dispatchFetch('https://game.test/ws/native',{headers:{Upgrade:'websocket',Origin:'https://other.test'}})).status,403);
  const {a,b,start,ready}=await launchPair(t,mf,'?shard=7');
  assert.equal(ready.protocol,3);assert.equal(ready.inputDelayTicks,8);
  a.send({type:'input',matchId:start.matchId,tick:101,prevHash:'old-v2',commands:[]});
  await a.wait('error');
  b.send({type:'input',matchId:start.matchId,tick:101,commands:[{owner:0,execute_tick:101,payload:'Stop'}]});
  assert.match((await b.wait('error')).error,/其他玩家/);
  // Two turns can be broadcast before either simulation supplies a checksum.
  for(const tick of [101,102])for(const client of [a,b])client.send({type:'input',matchId:start.matchId,tick,commands:[]});
  for(const tick of [101,102]){
    const turn=await a.wait('turn',message=>message.tick===tick);
    assert.deepEqual(turn.commands,[]);assert.deepEqual(await b.wait('turn',message=>message.tick===tick),turn);
  }
  a.send({type:'checksum',matchId:start.matchId,tick:101,checksum:'retail:100:1a2b3c4d'});
  b.send({type:'checksum',matchId:start.matchId,tick:101,checksum:'retail:100:1a2b3c4e'});
  assert.match((await a.wait('stopped')).reason,/校验/);
});
test('Durable Object confirms normal native results, clears the room and ignores completed-match output',async t=>{
  const {mf}=await fixture(t),{a,b,start,ready,room}=await launchPair(t,mf);
  for(const client of [a,b])client.send({type:'input',matchId:start.matchId,tick:101,commands:[]});
  await a.wait('turn',message=>message.tick===101);await b.wait('turn',message=>message.tick===101);
  for(const client of [a,b])client.send({type:'checksum',matchId:start.matchId,tick:101,checksum:'retail:100:1a2b3c4d'});
  const result={type:'finished',matchId:start.matchId,tick:101,checksum:'retail:100:1a2b3c4d'};
  for(const client of [a,b])client.send(result);
  assert.deepEqual(await a.wait('finished'),result);assert.deepEqual(await b.wait('finished'),result);
  await a.wait('room',message=>message.room===null);await b.wait('room',message=>message.room===null);
  const marker=a.messages.length;
  a.send({type:'input',matchId:start.matchId,tick:102,commands:[]});
  a.send(result);
  a.send({type:'create',name:'New match after results'});
  const next=await a.wait('room',message=>message.room&&message.room.code!==room.code);
  assert.equal(next.room.phase,'lobby');
  assert.equal(a.messages.slice(marker).some(message=>message.type==='error'||message.type==='stopped'),false);
});
