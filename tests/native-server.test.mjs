import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createNativeServer} from '../tools/native-server.mjs';

function request(url, route, {method='GET', headers={}}={}) {
  return new Promise((resolve,reject)=>{
    const target=new URL(url);
    const req=http.request({hostname:target.hostname,port:target.port,path:route,method,headers},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));
      res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));
    });req.on('error',reject);req.end();
  });
}
async function setup(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'vera-native-'));
  const retail=path.join(root,'retail');
  for (const dir of ['retail','web-native','public/native','native-client/art/fonts','native-client/art/branding']) await fs.mkdir(path.join(root,dir),{recursive:true});
  await fs.writeFile(path.join(root,'web-native/index.html'),'<title>王二火大</title><canvas id="game"></canvas>');
  await fs.writeFile(path.join(root,'web-native/bootstrap.js'),'export const native=true;');
  for (const name of ['pointer-capture.js','menu-animation.js']) await fs.writeFile(path.join(root,'web-native',name),'export const adapter=true;');
  await fs.writeFile(path.join(root,'public/native/werhd_bg.wasm'),Buffer.from([0,97,115,109,1,0,0,0]));
  await fs.writeFile(path.join(root,'public/native/werhd.js'),'export const start_browser=()=>{};');
  // Deliberately retained old output bytes must still be inaccessible.
  await fs.writeFile(path.join(root,'public/native/vera20k_bg.wasm'),'obsolete engine');
  await fs.writeFile(path.join(root,'public/native/vera20k.js'),'obsolete bindings');
  await fs.writeFile(path.join(root,'public/native/other.js'),'unpublished');
  await fs.writeFile(path.join(root,'native-client/art/fonts/FiraSansCondensed-Medium.ttf'),'font');
  await fs.writeFile(path.join(root,'native-client/art/branding/wannafire-app-icon.png'),'approved-icon');
  for (const name of ['ra2.mix','movmd03.mix','thememd.mix','rulesmd.ini','RA2MD.INI','keyboard.ini']) await fs.writeFile(path.join(retail,name),'0123456789');
  await fs.writeFile(path.join(root,'secret.json'),'private');
  await fs.symlink(path.join(root,'secret.json'),path.join(retail,'ra2md.mix'));
  await fs.symlink(path.join(root,'secret.json'),path.join(root,'public/native/leak.js'));
  const app=await createNativeServer({root,assetRoot:retail,port:0,verifyBuild:false});
  t.after(async()=>{await app.close();await fs.rm(root,{recursive:true,force:true});});
  return {root,retail,app};
}
test('native shell serves real WASM and native media, preserving private profiles',async t=>{
  const {app}=await setup(t);
  assert.match((await request(app.url,'/')).body.toString(),/canvas/);
  for (const route of ['/pointer-capture.js','/menu-animation.js']) {
    const response=await request(app.url,route);
    assert.equal(response.status,200); assert.match(response.body.toString(),/adapter/);
  }
  const wasm=await request(app.url,'/native/werhd_bg.wasm');
  assert.equal(wasm.status,200);assert.equal(wasm.headers['content-type'],'application/wasm');
  const bindings=await request(app.url,'/native/werhd.js');
  assert.equal(bindings.status,200);assert.match(bindings.body.toString(),/start_browser/);
  const icon=await request(app.url,'/branding/icon.png');
  assert.equal(icon.status,200);assert.equal(icon.headers['content-type'],'image/png');assert.equal(icon.body.toString(),'approved-icon');
  const manifest=JSON.parse((await request(app.url,'/api/native/resources')).body);
  assert.deepEqual(manifest.files.map(file=>file.name),['movmd03.mix','ra2.mix','rulesmd.ini','thememd.mix']);
  assert.equal(manifest.totalBytes,40);
  const health=JSON.parse((await request(app.url,'/api/health')).body);
  assert.equal(health.ok,true);assert.equal(health.app,'werhd-native');
  assert.equal(health.renderer,'WERHD wgpu/WebGPU');
  assert.deepEqual(health.roomRouting,{shards:8,maxClientsPerShard:16,maxRoomsPerShard:8});
  assert.equal(health.multiplayer.rooms,0);assert.equal(app.multiplayer.coordinators.size,9);
  for (const route of ['/retail/RA2MD.INI','/retail/keyboard.ini','/retail/ra2md.mix','/native/leak.js',
    '/native/vera20k.js','/native/vera20k_bg.wasm','/native/other.js',
    '/native/../../secret.json','/native/%2e%2e/secret.json','/native-client/src/lib.rs','/tools/native-server.mjs']) {
    assert.ok([400,404].includes((await request(app.url,route)).status),route);
  }
  assert.equal((await request(app.url,'/',{method:'POST'})).status,405);
});
test('native resource range and identity checks retain the admitted exact bytes',async t=>{
  const {app,retail}=await setup(t);
  const part=await request(app.url,'/retail/MOVMD03.MIX',{headers:{Range:'bytes=2-5'}});
  assert.equal(part.status,206);assert.equal(part.body.toString(),'2345');
  const head=await request(app.url,'/retail/ra2.mix',{method:'HEAD'});
  assert.equal(head.body.length,0);assert.equal(Number(head.headers['content-length']),10);
  assert.equal((await request(app.url,'/retail/ra2.mix',{headers:{'If-None-Match':head.headers.etag}})).status,304);
  await fs.writeFile(path.join(retail,'ra2.mix'),'changed');
  assert.equal((await request(app.url,'/retail/ra2.mix')).status,409);
});
