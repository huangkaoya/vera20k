import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {LoadPeer,loadOptions,loadStatistics,safeCloseReason,runNativeNetworkLoad} from '../tools/native-network-load.mjs';
import {attachNativeMultiplayer} from '../tools/services/native-websocket.mjs';
import {NATIVE_PROTOCOL,INPUT_DELAY_TICKS} from '../tools/services/native-room-coordinator.mjs';
import {NATIVE_ROOM_ROUTING} from '../tools/services/native-room-routing.mjs';

async function fixture(t,{invalidHealth=false,disconnectOnInput=false}={}){
  // Health identity is explicitly a fixture. No engine/build acceptance is
  // inferred; only the real coordinator, WebSockets and probe lifecycle run.
  const identity={patchSha256:'a'.repeat(64),resourceManifestSha256:'b'.repeat(64)};
  const server=http.createServer((request,response)=>{
    if(request.url!=='/api/health'){response.writeHead(404).end();return;}
    response.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({
      ok:true,app:invalidHealth?'another-project':'werhd-native',protocol:NATIVE_PROTOCOL,
      ...identity,roomRouting:{maxRoomsPerShard:NATIVE_ROOM_ROUTING.maxRoomsPerShard,
        maxClientsPerShard:NATIVE_ROOM_ROUTING.maxClientsPerShard,shards:NATIVE_ROOM_ROUTING.shards}}));
  });
  const multiplayer=attachNativeMultiplayer(server,{allowedOrigins:[]});
  if(disconnectOnInput)multiplayer.wss.on('connection',socket=>socket.on('message',raw=>{
    if(JSON.parse(raw.toString()).type==='input')socket.close(1011,'Fixture disconnect');
  }));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;multiplayer.allowOrigin(origin);
  t.after(async()=>{await multiplayer.close();await new Promise(resolve=>server.close(resolve));});
  return {origin,identity,multiplayer};
}

test('load options enforce project origins, bounded even concurrency and explicit parameters',()=>{
  const options=loadOptions([]);
  assert.equal(options.players,100);assert.equal(options.ticks,600);assert.equal(options.tickMillis,48);
  assert.equal(options.reentryTicks,16);assert.equal(options.selfEcho,false);
  assert.equal(options.heartbeat,false);
  assert.equal(loadOptions(['--heartbeat=true']).heartbeat,true);
  assert.equal(loadOptions(['--origin=https://wan.youlidefuchou.com','--players=128','--self-echo=true']).selfEcho,true);
  for(const args of [
    ['--players=99'],['--players=130'],['--players=0'],['--ticks=15'],['--ticks=2001'],
    ['--tick-ms=0'],['--reentry-ticks=65'],['--origin=https://example.com'],
    ['--origin=https://wan.youlidefuchou.com/?token=secret'],['--origin=http://wan.youlidefuchou.com'],
    ['--origin=https://user:secret@wan.youlidefuchou.com'],['--self-echo=yes'],['--heartbeat=yes'],
    ['--players=2','--players=4'],['--unknown=true'],['--players','100']])assert.throws(()=>loadOptions(args));
});

test('close reason diagnostics are bounded control information rather than application payloads',()=>{
  assert.equal(safeCloseReason('Fixture disconnect'),'Fixture disconnect');
  assert.equal(safeCloseReason('line\nnext\0'),'line next ');
  assert.equal(safeCloseReason('x'.repeat(1200)).length,1000);
  assert.equal(safeCloseReason('{"commands":["private"]}'),'[application payload omitted]');
  assert.equal(safeCloseReason('native-load-self-echo-v3:payload'),'[application payload omitted]');
});

test('load statistics report bounded measured values without inventing empty samples',()=>{
  assert.deepEqual(loadStatistics([]),{samples:0,min:null,mean:null,median:null,p95:null,max:null});
  assert.deepEqual(loadStatistics([10,2,6,4,8,NaN]),{samples:5,min:2,mean:6,median:6,p95:10,max:10});
});

test('real sharded WebSockets all advance concurrently, finish, detach and reenter with health binding',async t=>{
  const {origin,identity,multiplayer}=await fixture(t);
  const report=await runNativeNetworkLoad({origin,players:8,ticks:32,tickMillis:2,reentryTicks:16,selfEcho:true});
  assert.equal(report.ok,true,JSON.stringify(report.failures));
  assert.equal(report.engineGameplayVerified,false);
  assert.equal(report.healthUnchanged,true);assert.deepEqual(report.healthBefore,report.healthAfter);
  assert.deepEqual(report.buildIdentity,identity);
  assert.deepEqual(report.clientsPerShard,[2,2,2,2,0,0,0,0]);
  assert.equal(report.primary.simultaneousReadyClients,8);assert.equal(report.reentry.simultaneousReadyClients,8);
  assert.equal(report.primary.allClientsAdvancedTogether,true);assert.equal(report.reentry.allClientsAdvancedTogether,true);
  assert.equal(report.primary.tps.samples,8);assert.equal(report.reentry.tps.samples,8);
  for(const round of [report.primary,report.reentry])for(const room of round.rooms){
    assert.match(room.code,new RegExp(`^S${room.shard}[0-9A-F]{5}$`));
    assert.equal(room.matchingFinishedReceipts,true);assert.equal(room.returnedToLobby,true);
    for(const peer of room.peers){
      assert.equal(peer.finishedTick,round.ticks);assert.equal(peer.checksumsSent,round.ticks);
      assert.ok(peer.maxPendingInputs<=INPUT_DELAY_TICKS);assert.ok(peer.maxBufferedTurns<=INPUT_DELAY_TICKS);
      assert.ok(peer.orderedTurns>=round.ticks);assert.ok(peer.tps>0);
      assert.ok(peer.selfEchoRtt.milliseconds.samples>0);
    }
  }
  for(let index=0;index<report.matches;index++)assert.notEqual(report.primary.rooms[index].code,report.reentry.rooms[index].code);
  assert.equal(report.cleanup.length,8);assert.ok(report.cleanup.every(value=>value.closed));
  assert.equal(report.socketClosures.length,8);assert.ok(report.socketClosures.every(value=>value.close?.wasClean));
  assert.ok([...multiplayer.coordinators.values()].every(value=>value.rooms.size===0));
});

test('unexpected identity fails before connecting clients',async t=>{
  const {origin}=await fixture(t,{invalidHealth:true});
  const report=await runNativeNetworkLoad({origin,players:2,ticks:16,tickMillis:2,reentryTicks:8});
  assert.equal(report.ok,false);assert.match(report.failures[0].message,/expected native project/);
  assert.equal(report.cleanup.length,0);assert.equal(report.engineGameplayVerified,false);
});

test('transport failure records affected peers and cleans every connected socket',async t=>{
  const {origin,multiplayer}=await fixture(t,{disconnectOnInput:true});
  const report=await runNativeNetworkLoad({origin,players:4,ticks:32,tickMillis:2,reentryTicks:8});
  assert.equal(report.ok,false);assert.equal(report.engineGameplayVerified,false);
  assert.ok(report.failures.some(value=>value.label&&value.phase==='running'));
  assert.equal(report.abortSnapshot.rooms.length,2);assert.equal(report.abortSnapshot.engineGameplayVerified,false);
  for(const room of report.abortSnapshot.rooms)for(const peer of room.peers){
    assert.equal(peer.tps,null);assert.equal(peer.measurementComplete,false);assert.equal(peer.targetTicks,32);
    assert.match(peer.sampleScope,/partial progress/);assert.equal(typeof peer.lastSendAt,'string');assert.equal(typeof peer.lastReceiveAt,'string');
  }
  assert.ok(report.socketClosures.some(value=>value.close?.code===1011&&value.close.reason==='Fixture disconnect'));
  assert.equal(report.healthUnchanged,true);
  assert.equal(report.cleanup.length,4);assert.ok(report.cleanup.every(value=>value.closed));
  assert.ok([...multiplayer.coordinators.values()].every(value=>value.rooms.size===0));
});

test('optional control ping measures a real pong and cleans its timer without touching the game protocol',async t=>{
  const {origin}=await fixture(t);
  const peer=new LoadPeer({origin,roomIndex:0,shard:0,side:0,timeoutMillis:1000,selfEcho:false,heartbeat:true});
  t.after(()=>peer.close());
  await peer.open;await peer.wait('hello');
  peer.send({type:'hello',protocol:NATIVE_PROTOCOL});
  assert.ok(peer.heartbeatTimer);
  const pong=once(peer.ws,'pong');peer.sendHeartbeat();await pong;
  const snapshot=peer.report(true);
  assert.equal(snapshot.heartbeatRtt.enabled,true);assert.equal(snapshot.heartbeatRtt.sent,1);
  assert.equal(snapshot.heartbeatRtt.milliseconds.samples,1);assert.equal(snapshot.heartbeatRtt.pending,0);
  await peer.close();assert.equal(peer.heartbeatTimer,null);assert.equal(peer.heartbeatPending.size,0);
  assert.equal(peer.closeInfo.code,1000);assert.equal(peer.closeInfo.wasClean,true);
});
