import test from 'node:test';
import assert from 'node:assert/strict';
import {NativeRoomCoordinator,NATIVE_PROTOCOL,INPUT_DELAY_TICKS} from '../tools/services/native-room-coordinator.mjs';
import {nativeInternalErrorDetails} from '../tools/services/native-room-diagnostics.mjs';

function peer(service,{handshake=true}={}) {
  const messages=[],closures=[];let client;
  client=service.connect({send:raw=>messages.push(JSON.parse(raw)),close:(code,reason)=>{
    closures.push({code,reason,connected:service.clients.has(client),room:client.room});
  }});
  const send=message=>service.receive(client,JSON.stringify(message));
  if(handshake)send({type:'hello',protocol:NATIVE_PROTOCOL});
  return {client,messages,closures,send,last:type=>messages.findLast(message=>message.type===type)};
}

function runningRoom(service) {
  const host=peer(service),guest=peer(service);
  host.send({type:'create'});guest.send({type:'join',code:host.last('room').room.code});
  guest.send({type:'ready'});host.send({type:'start'});
  const matchId=host.last('start').matchId;
  for(const p of [host,guest])p.send({type:'progress',matchId,percent:100});
  for(const p of [host,guest])p.send({type:'loaded',protocol:NATIVE_PROTOCOL,matchId,tick:0,hash:'state0',owners:[7,13],build:'same-build',resourceManifest:'a'.repeat(64)});
  assert.equal(host.client.room.phase,'running');
  return {host,guest,matchId,room:host.client.room};
}

function clock(t,initial=100000) {
  let now=initial;t.mock.method(Date,'now',()=>now);
  return value=>{if(value!==undefined)now=value;return now;};
}

test('idle half-open clients release capacity before transport close and announce count changes',t=>{
  const now=clock(t),counts=[];
  const service=new NativeRoomCoordinator({maxClients:2,onClientCountChanged:count=>counts.push(count)});t.after(()=>service.close());
  const idle=peer(service),active=peer(service);
  assert.deepEqual(counts,[1,2]);assert.throws(()=>peer(service),error=>error.code==='CLIENT_CAPACITY');
  now(145000);active.send({type:'ping'});
  assert.deepEqual(active.last('pong'),{type:'pong'});
  assert.equal(service.expireIdleClients({now:now()}),1);
  assert.deepEqual(idle.closures,[{code:1001,reason:'Idle connection expired',connected:false,room:null}]);
  assert.equal(active.closures.length,0);assert.deepEqual(counts,[1,2,1]);
  const replacement=peer(service);assert.ok(service.clients.has(replacement.client));assert.equal(service.clients.size,2);
  assert.equal(service.expireIdleClients({now:now()}),0,'expired clients are retired only once');
  service.disconnect(replacement.client);service.disconnect(replacement.client);
  assert.deepEqual(counts,[1,2,1,2,1],'duplicate teardown must not emit a second count change');
});

test('app pings, transport pong activity and real inputs keep healthy clients while an idle room stops alone',t=>{
  const now=clock(t),service=new NativeRoomCoordinator();t.after(()=>service.close());
  const idleMatch=runningRoom(service),activeMatch=runningRoom(service),transport=peer(service);
  now(145000);idleMatch.host.send({type:'ping'});service.markClientActive(transport.client,now());
  for(const p of [activeMatch.host,activeMatch.guest])p.send({type:'input',matchId:activeMatch.matchId,tick:1,commands:[]});
  for(const p of [activeMatch.host,activeMatch.guest])p.send({type:'checksum',matchId:activeMatch.matchId,tick:1,checksum:'retail:0:12345678'});
  const before={tick:activeMatch.room.tick,committed:[...activeMatch.room.committed],submitted:[...activeMatch.room.submitted]};
  assert.equal(service.expireIdleClients({now:now()}),1);
  assert.equal(idleMatch.guest.closures[0].code,1001);
  assert.match(idleMatch.host.last('stopped').reason,/离开/);assert.equal(idleMatch.host.client.room,null);
  assert.equal(idleMatch.host.closures.length,0,'a healthy opponent remains connected to the lobby');
  assert.ok(service.clients.has(transport.client));assert.equal(transport.closures.length,0);
  assert.equal(service.rooms.size,1);assert.equal(activeMatch.room.phase,'running');
  assert.equal(activeMatch.host.last('stopped'),undefined);assert.equal(activeMatch.guest.last('stopped'),undefined);
  assert.deepEqual({tick:activeMatch.room.tick,committed:[...activeMatch.room.committed],submitted:[...activeMatch.room.submitted]},before);
  for(const p of [activeMatch.host,activeMatch.guest])p.send({type:'input',matchId:activeMatch.matchId,tick:2,commands:[]});
  assert.equal(activeMatch.host.last('turn').tick,2,'the other room still relays ordered turns');
  service.disconnect(transport.client);const seen=transport.client.lastSeenAt;
  service.markClientActive(transport.client,200000);assert.equal(transport.client.lastSeenAt,seen,'pong activity cannot resurrect a removed client');
});

test('heartbeat pong never grants a world turn, checksum receipt or additional future input credit',t=>{
  const now=clock(t),service=new NativeRoomCoordinator();t.after(()=>service.close());
  const {host,guest,room,matchId}=runningRoom(service);
  for(let tick=1;tick<=INPUT_DELAY_TICKS;tick++)for(const p of [host,guest])p.send({type:'input',matchId,tick,commands:[]});
  const before={tick:room.tick,committed:[...room.committed],submitted:[...room.submitted],frames:[...room.frames],checksums:[...room.checksums],turns:host.messages.filter(m=>m.type==='turn').length};
  now(140000);host.send({type:'ping',matchId:'another-match',tick:999999});guest.send({type:'ping'});
  assert.deepEqual(host.last('pong'),{type:'pong'});assert.equal(host.client.lastSeenAt,140000);
  assert.deepEqual({tick:room.tick,committed:[...room.committed],submitted:[...room.submitted],frames:[...room.frames],checksums:[...room.checksums],turns:host.messages.filter(m=>m.type==='turn').length},before);
  host.send({type:'input',matchId,tick:INPUT_DELAY_TICKS+1,commands:[]});
  assert.match(host.last('error').error,/窗口/);assert.equal(room.submitted[0],INPUT_DELAY_TICKS);
  assert.equal(service.expireIdleClients({now:184999}),0);
});

test('malformed JSON and an incompatible hello cannot postpone idle expiration',t=>{
  const now=clock(t),service=new NativeRoomCoordinator();t.after(()=>service.close());
  const p=peer(service,{handshake:false});assert.equal(p.client.lastSeenAt,100000);
  now(144000);service.receive(p.client,'{broken');p.send({type:'hello',protocol:2});p.send({type:'ping'});
  assert.equal(p.client.lastSeenAt,100000);assert.equal(p.last('pong'),undefined);
  assert.equal(service.expireIdleClients({now:145000}),1);assert.equal(p.closures[0].code,1001);
  const good=peer(service,{handshake:false});now(150000);good.send({type:'hello',protocol:NATIVE_PROTOCOL});
  assert.equal(good.client.lastSeenAt,150000);assert.equal(service.expireIdleClients({now:194999}),0);
  for(const options of [{now:NaN},{now:0,idleMs:0},{now:0,idleMs:-1},{now:0,idleMs:Infinity}])assert.throws(()=>service.expireIdleClients(options),/idle deadline/);
});

test('internal callback diagnostics retain only approved source frames and stop the associated room',t=>{
  const service=new NativeRoomCoordinator();t.after(()=>service.close());
  const failing=runningRoom(service),healthy=runningRoom(service),logs=[];
  t.mock.method(console,'error',line=>logs.push(JSON.parse(line)));
  const secret='payload-token-private-player';const error=new TypeError(secret);
  error.stack=`TypeError: ${secret}\n at receive (/private/${secret}/native-room-coordinator.mjs:211:9)\n at callback (https://example.invalid/${secret}/native-worker.mjs:82:5)\n at unrelated (/private/${secret}/secret.js:4:8)`;
  service.handleInternalError(failing.host.client,error,'message');
  assert.equal(logs.length,1);assert.deepEqual(logs[0].frames,['native-room-coordinator.mjs:211:9','native-worker.mjs:82:5']);
  assert.equal(logs[0].event,'native-internal-error');assert.equal(logs[0].errorName,'TypeError');assert.equal(logs[0].callback,'message');
  assert.doesNotMatch(JSON.stringify(logs),new RegExp(secret));assert.equal(Object.hasOwn(logs[0],'message'),false);assert.equal(Object.hasOwn(logs[0],'stack'),false);
  assert.equal(failing.host.closures[0].code,1011);assert.equal(failing.host.closures[0].connected,false);
  assert.match(failing.guest.last('stopped').reason,/内部错误/);assert.equal(failing.guest.client.room,null);
  assert.equal(healthy.host.client.room,healthy.room);assert.equal(healthy.room.phase,'running');assert.equal(healthy.host.last('stopped'),undefined);
  for(const p of [healthy.host,healthy.guest])p.send({type:'input',matchId:healthy.matchId,tick:1,commands:[]});
  assert.equal(healthy.host.last('turn').tick,1);
  const unsafe=nativeInternalErrorDetails({name:secret,stack:error.stack},secret);
  assert.equal(unsafe.errorName,'Error');assert.equal(unsafe.callback,'unknown');assert.doesNotMatch(JSON.stringify(unsafe),new RegExp(secret));
});

test('a throwing room timer is reported and isolated without escaping to another room',t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const service=new NativeRoomCoordinator();t.after(()=>service.close());
  const failing=runningRoom(service),healthy=runningRoom(service),logs=[];
  t.mock.method(console,'error',line=>logs.push(JSON.parse(line)));
  const original=service.stop,error=new RangeError('private timer details');
  error.stack='RangeError: private timer details\n at stop (native-room-coordinator.mjs:116:4)';
  t.mock.method(service,'stop',function(room,reason){if(room===failing.room)throw error;return original.call(this,room,reason);});
  service.arm(failing.room,5,'test timeout');
  assert.doesNotThrow(()=>t.mock.timers.tick(5));
  assert.equal(logs.length,1);assert.equal(logs[0].callback,'room-timer');assert.equal(logs[0].errorName,'RangeError');
  assert.deepEqual(logs[0].frames,['native-room-coordinator.mjs:116:4']);assert.doesNotMatch(JSON.stringify(logs),/private timer details/);
  assert.equal(failing.room.phase,'stopped');assert.match(failing.guest.last('stopped').reason,/内部错误/);
  assert.equal(failing.host.closures[0].code,1011);assert.equal(service.rooms.size,1);
  assert.equal(healthy.room.phase,'running');assert.equal(healthy.host.last('stopped'),undefined);
  healthy.host.send({type:'ping'});assert.deepEqual(healthy.host.last('pong'),{type:'pong'});
});
