import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {build} from '../node_modules/esbuild/lib/main.js';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';

const directory=path.dirname(fileURLToPath(import.meta.url)),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const bytes=new TextEncoder().encode('actual native retail data fixture');
const object={key:`vera20k/web-native/objects/sha256/${sha(bytes)}`,bytes:bytes.length,sha256:sha(bytes),contentType:'application/octet-stream'};
const release={schema:1,build:{patchSha256:'1'.repeat(64),resourceManifestSha256:'2'.repeat(64)},resources:{schema:1,files:[{name:'ra2.mix',bytes:bytes.length,sha256:sha(bytes),url:'/retail/ra2.mix'}],totalBytes:bytes.length},objects:{'/retail/ra2.mix':object,'/native/vera20k_bg.wasm':{...object,contentType:'application/wasm'}}};
async function fixture(t) {
  const output=await build({entryPoints:[path.join(directory,'native-worker.mjs')],bundle:true,format:'esm',write:false,external:['cloudflare:workers'],plugins:[{name:'release-fixture',setup(api){api.onResolve({filter:/generated\/release\.json$/},()=>({path:'release',namespace:'fixture'}));api.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:JSON.stringify(release),loader:'json'}));}}]});
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:output.outputFiles[0].text,compatibilityDate:'2026-10-19',durableObjects:{NATIVE_ROOMS:{className:'NativeRooms',useSQLite:true}},r2Buckets:['NATIVE_DATA'],serviceBindings:{ASSETS:request=>new Response(new URL(request.url).pathname==='/index.html'?'native index':'not found',{status:new URL(request.url).pathname==='/index.html'?200:404})}}));
  t.after(()=>mf.dispose());
  const bucket=await mf.getR2Bucket('NATIVE_DATA');await bucket.put(object.key,bytes,{customMetadata:{sha256:object.sha256}});
  return {mf,bucket};
}
test('Worker serves locked resource manifest and streams full/range/HEAD/conditional R2 objects',async t=>{
  const {mf}=await fixture(t);
  const manifest=await mf.dispatchFetch('https://game.test/api/native/resources');assert.deepEqual(await manifest.json(),release.resources);
  const full=await mf.dispatchFetch('https://game.test/retail/ra2.mix');assert.equal(full.status,200);assert.deepEqual(new Uint8Array(await full.arrayBuffer()),bytes);
  const range=await mf.dispatchFetch('https://game.test/retail/ra2.mix',{headers:{Range:'bytes=7-12'}});assert.equal(range.status,206);assert.equal(range.headers.get('Content-Range'),`bytes 7-12/${bytes.length}`);assert.equal(await range.text(),new TextDecoder().decode(bytes.slice(7,13)));
  const suffix=await mf.dispatchFetch('https://game.test/retail/ra2.mix',{headers:{Range:'bytes=-7'}});assert.equal(suffix.status,206);assert.equal((await suffix.arrayBuffer()).byteLength,7);
  const head=await mf.dispatchFetch('https://game.test/native/vera20k_bg.wasm',{method:'HEAD'});assert.equal(head.headers.get('Content-Type'),'application/wasm');assert.equal(head.headers.get('Content-Length'),String(bytes.length));assert.equal((await head.arrayBuffer()).byteLength,0);
  assert.equal((await mf.dispatchFetch('https://game.test/retail/ra2.mix',{headers:{Range:'bytes=999-'}})).status,416);
  assert.equal((await mf.dispatchFetch('https://game.test/retail/ra2.mix',{headers:{'If-None-Match':`"${object.sha256}"`}})).status,304);
  assert.equal((await mf.dispatchFetch('https://game.test/retail/ra2.mix?sha256=wrong')).status,404);
  assert.equal((await mf.dispatchFetch('https://game.test/retail/ra2md.ini')).status,404);
  assert.equal((await mf.dispatchFetch('https://game.test/retail/ra2.mix',{method:'POST'})).status,405);
  assert.equal((await mf.dispatchFetch('https://game.test/')).status,200);
});
test('Worker fails closed when stored object metadata differs from the release',async t=>{
  const {mf,bucket}=await fixture(t);await bucket.put(object.key,bytes,{customMetadata:{sha256:'0'.repeat(64)}});
  assert.equal((await mf.dispatchFetch('https://game.test/retail/ra2.mix')).status,503);
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
  for(const [index,client] of [a,b].entries())client.send({type:'loaded',matchId:start.matchId,tick:100,hash:`local-view-${index}`,owners:[0,14],build:'native-test',resourceManifest:'2'.repeat(64)});
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
