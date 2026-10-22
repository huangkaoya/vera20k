import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {WebSocket} from 'ws';
import {attachNativeMultiplayer} from '../tools/services/native-websocket.mjs';

async function fixture(t,delay=30) {
  const server=http.createServer(),transport=attachNativeMultiplayer(server,{allowedOrigins:[],messageDelayMs:delay});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  transport.allowOrigin(origin);
  t.after(async()=>{await transport.close();await new Promise(resolve=>server.close(resolve));});
  const ws=new WebSocket(origin.replace('http:','ws:')+'/ws/native',{origin});
  const queue=[],waiters=[];
  ws.on('message',raw=>{const m=JSON.parse(raw);queue.push(m);for(const waiter of [...waiters])if(waiter.type===m.type){waiters.splice(waiters.indexOf(waiter),1);clearTimeout(waiter.timer);waiter.resolve(m);}});
  await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
  return {transport,ws,send:m=>ws.send(JSON.stringify(m)),wait:type=>{
    const found=queue.find(m=>m.type===type);if(found)return Promise.resolve(found);
    return new Promise((resolve,reject)=>{const waiter={type,resolve};waiter.timer=setTimeout(()=>reject(new Error('No '+type)),2000);waiters.push(waiter);});
  }};
}

test('diagnostic latency keeps hello and ordered client commands on the real WebSocket path',async t=>{
  const f=await fixture(t);assert.equal((await f.wait('hello')).protocol,3);
  f.send({type:'hello',protocol:3});f.send({type:'create',name:'Latency fixture'});
  const {room}=await f.wait('room');assert.equal(room.members[0].name,'Latency fixture');
  assert.equal(f.transport.coordinator.rooms.size,1);
  f.ws.close();await new Promise(resolve=>f.ws.once('close',resolve));
  assert.equal(f.transport.coordinator.rooms.size,0);
});

test('closing a delayed socket cancels queued create instead of leaving an orphan room',async t=>{
  const f=await fixture(t,60);await f.wait('hello');
  f.send({type:'hello',protocol:3});f.send({type:'create',name:'Cancelled fixture'});
  f.ws.close();await new Promise(resolve=>f.ws.once('close',resolve));
  await new Promise(resolve=>setTimeout(resolve,90));
  assert.equal(f.transport.coordinator.rooms.size,0);
  assert.equal(f.transport.coordinator.clients.size,0);
});

test('diagnostic delay bounds reject invalid or excessive values',()=>{
  for(const value of [-1,0.5,1001,NaN])assert.throws(()=>attachNativeMultiplayer(http.createServer(),{messageDelayMs:value}));
});
