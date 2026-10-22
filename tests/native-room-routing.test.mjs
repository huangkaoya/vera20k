import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {WebSocket} from 'ws';
import {NativeRoomCoordinator,NATIVE_PROTOCOL} from '../tools/services/native-room-coordinator.mjs';
import {attachNativeMultiplayer} from '../tools/services/native-websocket.mjs';
import {NATIVE_ROOM_SHARDS,NATIVE_ROOM_ROUTING,parseNativeRoomShard,nativeRoomObjectName,nativeRoomCoordinatorOptions} from '../tools/services/native-room-routing.mjs';

function peer(service) {
  const messages=[];
  const client=service.connect({send:raw=>messages.push(JSON.parse(raw)),close(){}});
  const send=message=>service.receive(client,JSON.stringify(message));
  send({type:'hello',protocol:NATIVE_PROTOCOL});
  return {client,send,last:type=>messages.findLast(message=>message.type===type)};
}

test('fixed shard routes are strict and preserve the unsharded legacy name',()=>{
  assert.deepEqual(NATIVE_ROOM_ROUTING,{shards:8,maxClientsPerShard:16,maxRoomsPerShard:8});
  assert.equal(parseNativeRoomShard(new URL('https://game.example/ws/native')),null);
  assert.equal(nativeRoomObjectName(null),'native-v3');assert.deepEqual(nativeRoomCoordinatorOptions(null),{});
  for(let shard=0;shard<NATIVE_ROOM_SHARDS;shard++) {
    assert.equal(parseNativeRoomShard(`https://game.example/ws/native?shard=${shard}`),shard);
    assert.equal(nativeRoomObjectName(shard),`native-v3-shard-${shard}`);
    assert.deepEqual(nativeRoomCoordinatorOptions(shard),{maxClients:16,maxRooms:8,codePrefix:`S${shard}`});
  }
  for(const query of ['shard=','shard=-1','shard=8','shard=00','shard=1.0','shard=1e0','shard=NaN','shard=1&shard=1','shard=1&shard=2','Shard=1','other=0','shard=0&other=1']) {
    assert.throws(()=>parseNativeRoomShard(`https://game.example/ws/native?${query}`),/Invalid native room/,query);
  }
  for(const value of [undefined,-1,8,0.5,'0',NaN]) {
    assert.throws(()=>nativeRoomObjectName(value),/Invalid native room shard/);
    assert.throws(()=>nativeRoomCoordinatorOptions(value),/Invalid native room shard/);
  }
});

test('sharded room codes cannot be confused with legacy codes and enforce isolated capacity',t=>{
  const legacy=new NativeRoomCoordinator();t.after(()=>legacy.close());
  const legacyHost=peer(legacy);legacyHost.send({type:'create'});
  assert.match(legacyHost.last('room').room.code,/^[0-9A-F]{6}$/);
  for(let shard=0;shard<NATIVE_ROOM_SHARDS;shard++) {
    const service=new NativeRoomCoordinator(nativeRoomCoordinatorOptions(shard));t.after(()=>service.close());
    const hosts=Array.from({length:8},()=>peer(service));
    for(const host of hosts)host.send({type:'create'});
    assert.equal(service.rooms.size,8);
    assert.ok(hosts.every(host=>new RegExp(`^S${shard}[0-9A-F]{5}$`).test(host.last('room').room.code)));
    const extra=peer(service);extra.send({type:'create'});assert.match(extra.last('error').error,/房间已满/);
    assert.equal(extra.last('error').code,'ROOM_CAPACITY');assert.equal(extra.client.room,null);
    assert.equal(service.rooms.size,8,'capacity rejection must not allocate a ninth room');
    const createdRoom=hosts[0].client.room;
    hosts[0].send({type:'create'});assert.equal(hosts[0].last('error').code,undefined);
    assert.equal(hosts[0].client.room,createdRoom,'duplicate create cannot close an established room');
    extra.send({type:'join',code:legacyHost.last('room').room.code});assert.match(extra.last('error').error,/找不到/);
    extra.send({type:'join',code:hosts[0].last('room').room.code.toLowerCase()});assert.equal(hosts[0].client.room.members.length,2);
    while(service.clients.size<16)peer(service);
    assert.throws(()=>peer(service),/人数已满/);
    assert.equal(legacy.rooms.size,1,'shard occupancy cannot alter the legacy coordinator');
  }
  for(const prefix of ['0','S8','S00','s0','',0])assert.throws(()=>new NativeRoomCoordinator({codePrefix:prefix}),/code prefix/);
  const invalid=peer(legacy);invalid.send({type:'join',code:'S8ABCDE'});assert.match(invalid.last('error').error,/无效的房间号/);
});

async function adapter(t) {
  const server=http.createServer(),transport=attachNativeMultiplayer(server,{allowedOrigins:[]});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;transport.allowOrigin(origin);
  t.after(async()=>{await transport.close();await new Promise(resolve=>server.close(resolve));});
  return {transport,origin,url:origin.replace('http:','ws:')+'/ws/native'};
}

async function socketPeer(url,origin) {
  const socket=new WebSocket(url,{origin}),messages=[],waiters=new Set();
  socket.on('error',()=>{});
  socket.on('message',raw=>{messages.push(JSON.parse(raw));for(const wake of [...waiters])wake();});
  const wait=type=>new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{waiters.delete(wake);reject(new Error(`Timed out waiting for ${type}`));},2000);
    const wake=()=>{const index=messages.findIndex(message=>message.type===type);if(index<0)return;clearTimeout(timer);waiters.delete(wake);resolve(messages.splice(index,1)[0]);};
    waiters.add(wake);wake();
  });
  await wait('hello');
  const send=message=>socket.send(JSON.stringify(message));send({type:'hello',protocol:NATIVE_PROTOCOL});
  return {socket,wait,send};
}

test('local WebSocket transport routes all eight shards and isolates joins from legacy',async t=>{
  const {transport,origin,url}=await adapter(t);
  const hosts=await Promise.all([null,...Array.from({length:8},(_,index)=>index)].map(async shard=>{
    const host=await socketPeer(url+(shard===null?'':`?shard=${shard}`),origin);host.send({type:'create'});
    const {room}=await host.wait('room');
    assert.match(room.code,shard===null?/^[0-9A-F]{6}$/:new RegExp(`^S${shard}[0-9A-F]{5}$`));
    return {shard,room,host};
  }));
  assert.equal(transport.coordinators.size,9);assert.equal(transport.coordinator,transport.coordinators.get(null));
  for(const {shard} of hosts)assert.equal(transport.coordinators.get(shard).rooms.size,1);
  const guest=await socketPeer(url+'?shard=3',origin);
  guest.send({type:'join',code:hosts.find(entry=>entry.shard===4).room.code});
  assert.match((await guest.wait('error')).error,/找不到/);
  const ownRoom=hosts.find(entry=>entry.shard===3).room;
  guest.send({type:'join',code:ownRoom.code});
  assert.equal((await guest.wait('room')).room.members.length,2);
  assert.equal(transport.coordinators.get(3).clients.size,2);
  assert.equal(transport.coordinators.get(4).clients.size,1);
});

test('local WebSocket transport rejects malformed shard queries before admission',async t=>{
  const {transport,origin,url}=await adapter(t);
  for(const query of ['shard=','shard=8','shard=00','shard=0&shard=1','other=0','shard=1&other=0']) {
    const error=await new Promise((resolve,reject)=>{
      const socket=new WebSocket(`${url}?${query}`,{origin});
      const timer=setTimeout(()=>{socket.terminate();reject(new Error('Malformed shard handshake did not close'));},2000);
      socket.once('error',error=>{clearTimeout(timer);resolve(error);});
      socket.once('open',()=>{clearTimeout(timer);socket.terminate();reject(new Error('Malformed shard was admitted'));});
    });
    assert.match(error.message,/400/);
  }
  assert.ok([...transport.coordinators.values()].every(service=>service.clients.size===0));
});

test('a full local shard closes only the new socket with 1013 and a different shard remains available',async t=>{
  const {transport,origin,url}=await adapter(t);
  const peers=await Promise.all(Array.from({length:16},()=>socketPeer(url+'?shard=0',origin)));
  assert.equal(transport.coordinators.get(0).clients.size,16);
  const close=await new Promise((resolve,reject)=>{
    const socket=new WebSocket(url+'?shard=0',{origin});socket.on('error',reject);
    const timer=setTimeout(()=>{socket.terminate();reject(new Error('Full shard did not close'));},2000);
    socket.once('close',code=>{clearTimeout(timer);resolve(code);});
  });
  assert.equal(close,1013);assert.ok(peers.every(peer=>peer.socket.readyState===WebSocket.OPEN));
  const next=await socketPeer(url+'?shard=1',origin);next.send({type:'create'});
  assert.match((await next.wait('room')).room.code,/^S1[0-9A-F]{5}$/);
  assert.equal(transport.coordinators.get(0).clients.size,16);
  assert.equal(transport.coordinators.get(1).clients.size,1);
});

test('real WebSocket pongs refresh local liveness and expired sockets release their coordinator slot',async t=>{
  const {transport,origin,url}=await adapter(t),peer=await socketPeer(url+'?shard=0',origin);
  const service=transport.coordinators.get(0),client=[...service.clients][0],serverSocket=[...transport.wss.clients][0];
  client.lastSeenAt=Date.now()-46000;
  const before=Date.now(),pong=new Promise(resolve=>serverSocket.once('pong',resolve));
  serverSocket.ping();await pong;
  assert.ok(client.lastSeenAt>=before,'the actual protocol pong updates coordinator liveness');
  assert.equal(service.expireIdleClients(),0);
  const close=new Promise(resolve=>peer.socket.once('close',code=>resolve(code)));
  client.lastSeenAt=Date.now()-46000;
  assert.equal(service.expireIdleClients(),1);assert.equal(service.clients.size,0);
  assert.equal(await close,1001);
  const replacement=await socketPeer(url+'?shard=0',origin);replacement.send({type:'ping'});
  assert.deepEqual(await replacement.wait('pong'),{type:'pong'});
});
