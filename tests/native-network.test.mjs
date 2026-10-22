import test from 'node:test';
import assert from 'node:assert/strict';
import {NativeRoomCoordinator, NATIVE_PROTOCOL, INPUT_DELAY_TICKS} from '../tools/services/native-room-coordinator.mjs';
import http from 'node:http';
import {WebSocket} from 'ws';
import {attachNativeMultiplayer} from '../tools/services/native-websocket.mjs';

function harness(t) {
  const service=new NativeRoomCoordinator();t.after(()=>service.close());
  const peer=()=>{const messages=[];const client=service.connect({send:raw=>messages.push(JSON.parse(raw)),close(){}});const result={client,messages,send:value=>service.receive(client,JSON.stringify(value)),last:type=>messages.findLast(message=>message.type===type)};result.send({type:'hello',protocol:NATIVE_PROTOCOL});return result;};
  const host=peer(),guest=peer();host.send({type:'create',name:'甲'});const code=host.last('room').room.code;
  guest.send({type:'join',name:'乙',code});return {service,host,guest,peer,code};
}
function start({host,guest}) {
  guest.send({type:'ready'});host.send({type:'start'});return host.last('start').matchId;
}
function load(peers,matchId,{guestHash='state0',guestBuild='same-build'}={}) {
  for(const peer of peers)peer.send({type:'progress',matchId,percent:100});
  peers.forEach((peer,index)=>peer.send({type:'loaded',protocol:NATIVE_PROTOCOL,matchId,tick:0,hash:index===0?'state0':guestHash,owners:[7,13],build:index===0?'same-build':guestBuild,resourceManifest:'a'.repeat(64)}));
}
const checksum=(peer,matchId,tick,value=`retail:${tick-1}:12345678`)=>peer.send({type:'checksum',matchId,tick,checksum:value});
test('native rooms bind player names and rules, invalidate readiness when host changes setup',t=>{
  const h=harness(t);h.guest.send({type:'ready'});assert.equal(h.host.last('room').room.canStart,true);
  h.guest.send({type:'config',config:{map:'XMP29U2.MAP'}});assert.match(h.guest.last('error').error,/房主/);
  h.host.send({type:'config',config:{map:'XMP29U2.MAP',options:{gameSpeed:4}}});
  const room=h.host.last('room').room;assert.equal(room.canStart,false);assert.equal(room.config.options.gameSpeed,4);
  assert.deepEqual(room.config.players.map(player=>player.name),['甲','乙']);
  h.host.send({type:'config',config:{map:'../../private.map'}});assert.match(h.host.last('error').error,/火线冲突/);
});
test('browser handoff defaults satisfy native identity and resolved-roster requirements',t=>{
  const h=harness(t),other=h.peer();
  other.send({type:'hello',protocol:NATIVE_PROTOCOL,playerId:h.host.client.id});assert.equal(other.last('error'),undefined);
  h.guest.send({type:'leave'});h.guest.send({type:'join',name:'甲',code:h.code});
  const room=h.host.last('room').room;
  assert.deepEqual(room.config.players.map(player=>player.name),['甲','甲 2']);
  assert.deepEqual(room.config.players.map(player=>player.start),[0,1]);
  assert.deepEqual(room.config.players.map(player=>player.difficulty),['normal','normal']);
  const config=structuredClone(room.config);config.players[0].start=-1;
  h.host.send({type:'config',config});
  assert.deepEqual(h.host.last('room').room.config.players.map(player=>player.start),[0,1]);
  h.guest.send({type:'ready'});h.host.send({type:'start'});
  assert.equal(h.host.last('start').playerIndex,0);assert.equal(h.guest.last('start').playerIndex,1);
});
test('native progress and launch receipt barrier start the same tick for both local views',t=>{
  const h=harness(t),matchId=start(h);
  h.host.send({type:'loaded',protocol:NATIVE_PROTOCOL,matchId,tick:0,hash:'state0',owners:[7,13],build:'same-build',resourceManifest:'a'.repeat(64)});
  assert.match(h.host.last('error').error,/全部玩家/);assert.equal(h.host.last('ready'),undefined);
  load([h.host,h.guest],matchId,{guestHash:'local-view-other'});
  assert.deepEqual(h.host.last('ready'),{type:'ready',matchId,tick:1,bootstrap:matchId,protocol:NATIVE_PROTOCOL,inputDelayTicks:INPUT_DELAY_TICKS});assert.deepEqual(h.host.last('ready'),h.guest.last('ready'));
});
test('native result receipts finish together without timeout or another world turn',t=>{
  const h=harness(t),matchId=start(h);load([h.host,h.guest],matchId);
  for(const peer of [h.host,h.guest])peer.send({type:'input',matchId,tick:1,commands:[]});
  for(const peer of [h.host,h.guest])checksum(peer,matchId,1);
  h.host.send({type:'finished',matchId,tick:1,checksum:'retail:0:12345678'});
  const turns=h.host.messages.filter(message=>message.type==='turn').length;
  h.guest.send({type:'input',matchId,tick:2,commands:[]});
  assert.equal(h.host.messages.filter(message=>message.type==='turn').length,turns);
  assert.equal(h.host.last('finished'),undefined);
  h.guest.send({type:'finished',matchId,tick:1,checksum:'retail:0:12345678'});
  assert.deepEqual(h.host.last('finished'),{type:'finished',matchId,tick:1,checksum:'retail:0:12345678'});
  assert.deepEqual(h.host.last('finished'),h.guest.last('finished'));assert.equal(h.service.rooms.size,0);
  h.host.send({type:'input',matchId,tick:2,commands:[]});assert.equal(h.host.last('error'),undefined);
  h.host.send({type:'create',name:'下一局'});assert.ok(h.host.last('room').room.code);
});
// Exercise the real terminal-call wire shape: ordered turn 2 runs native
// frame 1, produces CRC frame 1, and intentionally keeps the committed tick 1.
function terminalReceipts(h) {
  const matchId=start(h);load([h.host,h.guest],matchId);
  for(const peer of [h.host,h.guest])peer.send({type:'input',matchId,tick:1,commands:[]});
  for(const peer of [h.host,h.guest])peer.send({type:'input',matchId,tick:2,commands:[]});
  for(const peer of [h.host,h.guest])checksum(peer,matchId,1);
  return {type:'finished',matchId,tick:1,checksum:'retail:1:89abcdef'};
}
test('confirmed result owner can Continue before the slower peer finishes',t=>{
  const h=harness(t),receipt=terminalReceipts(h),room=h.host.client.room,order=[...room.order];
  h.host.send(receipt);h.host.send({type:'leave'});
  assert.equal(h.host.client.room,null);assert.equal(h.host.client.ready,false);
  assert.deepEqual(room.members,[h.guest.client]);assert.deepEqual(room.order,order);
  assert.deepEqual(room.finished.get(0),{tick:receipt.tick,checksum:receipt.checksum});
  assert.equal(h.guest.last('stopped'),undefined);assert.equal(h.host.last('room').room,null);
  h.guest.send(receipt);
  assert.deepEqual(h.guest.last('finished'),receipt);assert.equal(h.guest.last('stopped'),undefined);
  assert.equal(h.service.rooms.size,0);
});
test('confirmed result survives its owner disconnecting before the slower peer finishes',t=>{
  const h=harness(t),receipt=terminalReceipts(h);
  h.guest.send(receipt);h.service.disconnect(h.guest.client);
  assert.equal(h.service.clients.has(h.guest.client),false);assert.equal(h.guest.client.room,null);
  assert.equal(h.host.last('stopped'),undefined);
  h.host.send(receipt);
  assert.deepEqual(h.host.last('finished'),receipt);assert.equal(h.host.last('stopped'),undefined);
  assert.equal(h.service.rooms.size,0);
});
test("old result completion never changes an early leaver's new room",t=>{
  const h=harness(t),receipt=terminalReceipts(h);
  h.host.send(receipt);h.host.send({type:'leave'});h.host.send({type:'create',name:'下一局'});
  const nextRoom=h.host.client.room,code=nextRoom.code,before=h.host.messages.length;
  h.guest.send(receipt);
  assert.equal(h.host.client.room,nextRoom);assert.equal(h.host.client.ready,true);
  assert.equal(h.host.messages.length,before,'old finish cannot send room:null or ACK into a new room');
  assert.equal(h.host.last('room').room.code,code);assert.equal(h.service.rooms.get(code),nextRoom);
  assert.deepEqual(h.guest.last('finished'),receipt);assert.equal(h.guest.last('stopped'),undefined);
  assert.equal(h.service.rooms.size,1);
  for(const type of ['chat','taunt','input'])h.host.send({type,matchId:receipt.matchId});
  assert.equal(h.host.last('error'),undefined);assert.equal(h.host.client.room,nextRoom);
});
test('leaving or disconnecting without a result receipt still stops the match',t=>{
  for(const disconnect of [false,true]){
    const h=harness(t),receipt=terminalReceipts(h);h.host.send(receipt);
    if(disconnect)h.service.disconnect(h.guest.client);else h.guest.send({type:'leave'});
    assert.match(h.host.last('stopped').reason,/离开/);assert.equal(h.service.rooms.size,0);
  }
});
test('result receipts are idempotent only when identical and late chat is harmless',t=>{
  const h=harness(t),receipt=terminalReceipts(h);h.host.send(receipt);h.host.send(receipt);
  assert.equal(h.host.last('error'),undefined);assert.equal(h.host.client.room.finished.size,1);
  h.host.send({...receipt,checksum:'retail:1:11111111'});
  assert.match(h.host.last('error').error,/内容不一致/);
  const before=h.guest.messages.length;
  h.guest.send({type:'chat',matchId:receipt.matchId,recipients:[0],text:'迟到聊天'});
  h.guest.send({type:'taunt',matchId:receipt.matchId,recipients:[0],byte:3});
  assert.equal(h.guest.messages.length,before);assert.equal(h.host.last('chat'),undefined);
  h.guest.send(receipt);const after=h.guest.messages.length;
  h.guest.send(receipt);
  for(const type of ['chat','taunt','input'])h.guest.send({type,matchId:receipt.matchId});
  assert.equal(h.guest.messages.length,after,'completed result absorbs late messages');
  h.guest.send({...receipt,tick:2});assert.match(h.guest.last('error').error,/内容不一致/);
});
test('native turns require every source, preserve raw payloads and deterministic player order',t=>{
  const h=harness(t),matchId=start(h);load([h.host,h.guest],matchId);
  const a={owner:7,execute_tick:1,payload:{Move:{entity_id:12,x:5,y:8}}};
  const b={owner:13,execute_tick:1,payload:{Deploy:{entity_id:24}}};
  h.guest.send({type:'input',matchId,tick:1,commands:[b]});assert.equal(h.host.last('turn'),undefined);
  h.host.send({type:'input',matchId,tick:1,commands:[a]});
  assert.deepEqual(h.host.last('turn'),{type:'turn',matchId,tick:1,commands:[{player:0,envelope:a},{player:1,envelope:b}]});
  assert.deepEqual(h.host.last('turn'),h.guest.last('turn'));
});
test('protocol v3 rejects old clients and requires the explicit handshake and loaded version',t=>{
  const service=new NativeRoomCoordinator();t.after(()=>service.close());
  const messages=[],client=service.connect({send:raw=>messages.push(JSON.parse(raw)),close(){}});
  const send=message=>service.receive(client,JSON.stringify(message));
  send({type:'create',name:'未握手'});assert.match(messages.at(-1).error,/协议/);assert.equal(service.rooms.size,0);
  send({type:'hello',protocol:2});assert.match(messages.at(-1).error,/协议/);
  send({type:'create',name:'旧客户端'});assert.equal(service.rooms.size,0);
  const h=harness(t),matchId=start(h);
  for(const peer of [h.host,h.guest])peer.send({type:'progress',matchId,percent:100});
  h.host.send({type:'loaded',protocol:2,matchId,tick:0,hash:'state',owners:[7,13],build:'same',resourceManifest:'a'.repeat(64)});
  assert.match(h.host.last('error').error,/协议/);assert.equal(h.host.last('ready'),undefined);
});
test('future inputs pipeline without CRC round-trip and preserve exact per-tick ordering',t=>{
  const h=harness(t),matchId=start(h);load([h.host,h.guest],matchId);
  for(let tick=1;tick<=INPUT_DELAY_TICKS;tick++)h.guest.send({type:'input',matchId,tick,commands:[{owner:13,execute_tick:tick,payload:'Cheer'}]});
  assert.equal(h.host.last('turn'),undefined);
  for(let tick=1;tick<=INPUT_DELAY_TICKS;tick++)h.host.send({type:'input',matchId,tick,commands:[{owner:7,execute_tick:tick,payload:'Cheer'}]});
  const turns=h.host.messages.filter(message=>message.type==='turn');
  assert.deepEqual(turns.map(turn=>turn.tick),[1,2,3,4,5,6,7,8]);
  assert.ok(turns.every(turn=>turn.commands.map(command=>command.player).join(',')==='0,1'));
  assert.equal(h.host.client.room.checksums.size,0,'no checksum was required to broadcast the initial window');
  assert.equal(h.host.client.room.frames.size,0);
  for(const peer of [h.host,h.guest])checksum(peer,matchId,1);
  for(const peer of [h.host,h.guest])peer.send({type:'input',matchId,tick:9,commands:[]});
  assert.equal(h.host.last('turn').tick,9);assert.equal(h.host.last('error'),undefined);
});
test('executed progress bounds speculation even when both peers exchange empty inputs',t=>{
  const h=harness(t),matchId=start(h);load([h.host,h.guest],matchId);
  for(let tick=1;tick<=INPUT_DELAY_TICKS;tick++)for(const peer of [h.host,h.guest])peer.send({type:'input',matchId,tick,commands:[]});
  h.host.send({type:'input',matchId,tick:INPUT_DELAY_TICKS+1,commands:[]});
  assert.match(h.host.last('error').error,/窗口/);assert.equal(h.host.client.room.submitted[0],INPUT_DELAY_TICKS);
  h.guest.send({type:'checksum',matchId,tick:INPUT_DELAY_TICKS+1,checksum:'retail:8:12345678'});
  assert.match(h.guest.last('error').error,/顺序/);
  checksum(h.host,matchId,1);h.host.send({type:'input',matchId,tick:INPUT_DELAY_TICKS+1,commands:[]});
  assert.equal(h.host.client.room.submitted[0],INPUT_DELAY_TICKS+1);
  assert.equal(h.host.client.room.frames.size,1);
});
test('duplicate, skipped and stale future input cannot overwrite an admitted frame',t=>{
  const h=harness(t),matchId=start(h);load([h.host,h.guest],matchId);
  h.host.send({type:'input',matchId,tick:2,commands:[]});assert.match(h.host.last('error').error,/顺序/);
  h.host.send({type:'input',matchId,tick:1,commands:[{owner:7,execute_tick:1,payload:'Cheer'}]});
  h.host.send({type:'input',matchId,tick:1,commands:[]});assert.match(h.host.last('error').error,/重复/);
  h.guest.send({type:'input',matchId,tick:1,commands:[]});
  assert.equal(h.host.last('turn').commands[0].envelope.payload,'Cheer');
  h.host.send({type:'input',matchId,tick:1,commands:[]});assert.match(h.host.last('error').error,/顺序/);
  h.host.send({type:'input',matchId,tick:2,prevHash:'retail:0:12345678',commands:[]});assert.match(h.host.last('error').error,/旧版/);
});
test('independent checksums reject unseen frames, duplicates and divergence without blocking prior turns',t=>{
  const h=harness(t),matchId=start(h);load([h.host,h.guest],matchId);
  checksum(h.host,matchId,1);assert.match(h.host.last('error').error,/尚未广播/);
  for(let tick=1;tick<=INPUT_DELAY_TICKS;tick++)for(const peer of [h.host,h.guest])peer.send({type:'input',matchId,tick,commands:[]});
  checksum(h.host,matchId,1);checksum(h.host,matchId,1);assert.match(h.host.last('error').error,/重复/);
  assert.equal(h.host.client.room.checksums.size,1);
  checksum(h.guest,matchId,1,'retail:0:abcdef12');
  assert.match(h.host.last('stopped').reason,/校验不一致/);assert.equal(h.service.rooms.size,0);
  assert.equal(h.host.messages.filter(message=>message.type==='turn').length,INPUT_DELAY_TICKS);
});
test('native result can retire the complete speculative window and still authenticates the last executed frame',t=>{
  const h=harness(t),matchId=start(h);load([h.host,h.guest],matchId);
  for(let tick=1;tick<=INPUT_DELAY_TICKS;tick++)for(const peer of [h.host,h.guest])peer.send({type:'input',matchId,tick,commands:[]});
  h.host.send({type:'finished',matchId,tick:1,checksum:'retail:1:89abcdef'});assert.match(h.host.last('error').error,/已执行/);
  for(const peer of [h.host,h.guest])checksum(peer,matchId,1);
  for(const peer of [h.host,h.guest])peer.send({type:'input',matchId,tick:9,commands:[]});
  const result={type:'finished',matchId,tick:1,checksum:'retail:1:89abcdef'};
  h.host.send(result);assert.equal(h.host.client.room.phase,'finishing');
  h.guest.send({type:'input',matchId,tick:10,commands:[]});h.guest.send({type:'checksum',matchId,tick:2,checksum:'retail:1:12345678'});
  assert.equal(h.guest.last('error'),undefined);h.guest.send(result);
  assert.deepEqual(h.host.last('finished'),result);assert.equal(h.service.rooms.size,0);
});
test('native relay rejects source forgery, Select, stale match and wrong execution tick',t=>{
  const h=harness(t),matchId=start(h);load([h.host,h.guest],matchId);
  const send=envelope=>h.host.send({type:'input',matchId,tick:1,commands:[envelope]});
  send({owner:13,execute_tick:1,payload:'Cheer'});assert.match(h.host.last('error').error,/其他玩家/);
  send({owner:7,execute_tick:1,payload:{Select:{entity_ids:[1]}}});assert.match(h.host.last('error').error,/本地选择/);
  send({owner:7,execute_tick:0,payload:'Cheer'});assert.match(h.host.last('error').error,/执行帧/);
  h.host.send({type:'input',matchId:'other',tick:1,commands:[]});assert.match(h.host.last('error').error,/会话/);
  send({owner:7,execute_tick:1,payload:'Cheer'});h.guest.send({type:'input',matchId,tick:1,commands:[]});assert.equal(h.host.last('turn').commands[0].envelope.payload,'Cheer');
});
test('native divergence stops the whole match and disconnect closes both sides',t=>{
  const h=harness(t),matchId=start(h);load([h.host,h.guest],matchId);
  for(const peer of [h.host,h.guest])peer.send({type:'input',matchId,tick:1,commands:[]});
  checksum(h.host,matchId,1,'retail:0:12345678');checksum(h.guest,matchId,1,'retail:0:abcdef12');
  assert.match(h.host.last('stopped').reason,/校验不一致/);assert.equal(h.guest.last('room').room,null);assert.equal(h.service.rooms.size,0);
  h.host.send({type:'create',name:'甲'});h.guest.send({type:'join',name:'乙',code:h.host.last('room').room.code});start(h);h.service.disconnect(h.guest.client);
  assert.match(h.host.last('stopped').reason,/离开/);assert.equal(h.service.rooms.size,0);
});
test('different native builds are stopped before any world advancement',t=>{
  const h=harness(t),matchId=start(h);load([h.host,h.guest],matchId,{guestBuild:'other-build'});
  assert.match(h.host.last('stopped').reason,/客户端版本/);assert.equal(h.host.last('ready'),undefined);
});
test('native chat and taunts bind source and respect explicit recipients',t=>{
  const h=harness(t),matchId=start(h);load([h.host,h.guest],matchId);
  h.host.send({type:'chat',matchId,source:1,recipients:[1],text:'测试'});
  assert.deepEqual(h.guest.last('chat'),{type:'chat',matchId,source:0,text:'测试'});assert.equal(h.host.last('chat'),undefined);
  h.guest.send({type:'taunt',matchId,source:0,recipients:[0],byte:3});assert.deepEqual(h.host.last('taunt'),{type:'taunt',matchId,source:1,byte:3});
  h.guest.send({type:'chat',matchId,recipients:[2],text:'越界'});assert.match(h.guest.last('error').error,/接收者/);
});
test('native WebSocket adapter admits exact local origins and carries real room messages',async t=>{
  const server=http.createServer((req,res)=>res.end());const multiplayer=attachNativeMultiplayer(server,{allowedOrigins:[]});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;multiplayer.allowOrigin(origin);
  t.after(async()=>{await multiplayer.close();await new Promise(resolve=>server.close(resolve));});
  const ws=new WebSocket(origin.replace('http:','ws:')+'/ws/native',{origin});
  const messages=[],waiters=[];ws.on('message',bytes=>{const message=JSON.parse(bytes);messages.push(message);for(const wake of [...waiters])wake();});
  const wait=type=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(`Timed out: ${type}`)),1000);const wake=()=>{const index=messages.findIndex(message=>message.type===type);if(index>=0){clearTimeout(timer);waiters.splice(waiters.indexOf(wake),1);resolve(messages.splice(index,1)[0]);}};waiters.push(wake);wake();});
  const hello=await wait('hello');assert.equal(hello.protocol,NATIVE_PROTOCOL);
  ws.send(JSON.stringify({type:'hello',protocol:NATIVE_PROTOCOL}));
  ws.send(JSON.stringify({type:'create',name:'真实套接字'}));const room=await wait('room');assert.equal(room.room.members[0].name,'真实套接字');
  const rejected=new WebSocket(origin.replace('http:','ws:')+'/ws/native',{origin:'https://other.example'});
  await new Promise(resolve=>{rejected.once('error',resolve);rejected.once('open',()=>assert.fail('Cross-origin socket opened'));});
  ws.close();
});
