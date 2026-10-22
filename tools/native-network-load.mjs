// Real WebSocket concurrency probe using synthetic inputs and checksums.
// No WASM, game world or renderer is loaded; never use this as engine acceptance.
import WebSocket from '../node_modules/ws/wrapper.mjs';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {NATIVE_PROTOCOL,INPUT_DELAY_TICKS} from './services/native-room-coordinator.mjs';
import {NATIVE_ROOM_ROUTING,NATIVE_ROOM_SHARDS} from './services/native-room-routing.mjs';

const MAX_INBOX=64,MAX_WAITERS=8,MAX_SAMPLES=4096,MAX_ECHO_PENDING=4,ECHO_TIMEOUT_MS=10000;
const ECHO_PREFIX='native-load-self-echo-v3:';
const PING_PREFIX='native-load-ping-v3:';
const allowedPublicHosts=new Set(['wan.youlidefuchou.com','werhd-vera-native.chdhyc.workers.dev']);
const integer=(value,min,max,label)=>{if(!Number.isInteger(value)||value<min||value>max)throw new Error(`${label} must be ${min}..${max}`);return value;};
const requireValue=(condition,message)=>{if(!condition)throw new Error(message);};

export function loadOptions(argv=[]) {
  const args=new Map();
  for(const raw of argv){
    const index=raw.indexOf('=');
    if(!raw.startsWith('--')||index<0)throw new Error('Expected --name=value');
    const name=raw.slice(2,index);
    if(args.has(name)||!['origin','players','ticks','tick-ms','reentry-ticks','self-echo','heartbeat'].includes(name))throw new Error(`Unknown or duplicate argument: ${name}`);
    args.set(name,raw.slice(index+1));
  }
  const url=new URL(args.get('origin')??'http://127.0.0.1:5280');
  const loopback=['127.0.0.1','localhost','[::1]'].includes(url.hostname);
  requireValue((loopback&&['http:','https:'].includes(url.protocol))||
    (url.protocol==='https:'&&allowedPublicHosts.has(url.hostname)), 'Origin must be this project public host or a loopback native server');
  requireValue(!url.username&&!url.password&&!url.search&&!url.hash&&url.pathname==='/', 'Supply an origin without credentials, path or query');
  const players=integer(Number(args.get('players')??100),2,128,'players');
  requireValue(players%2===0,'players must be even');
  const selfEcho=args.get('self-echo')??'false';
  requireValue(['true','false'].includes(selfEcho),'self-echo must be true or false');
  const heartbeat=args.get('heartbeat')??'false';
  requireValue(['true','false'].includes(heartbeat),'heartbeat must be true or false');
  return {origin:url.origin,players,ticks:integer(Number(args.get('ticks')??600),16,2000,'ticks'),
    tickMillis:integer(Number(args.get('tick-ms')??48),1,1000,'tick-ms'),
    reentryTicks:integer(Number(args.get('reentry-ticks')??16),8,64,'reentry-ticks'),selfEcho:selfEcho==='true',heartbeat:heartbeat==='true'};
}

export function loadStatistics(values) {
  const sorted=values.filter(Number.isFinite).sort((a,b)=>a-b);
  if(!sorted.length)return {samples:0,min:null,mean:null,median:null,p95:null,max:null};
  const rounded=x=>Number(x.toFixed(3));
  return {samples:sorted.length,min:rounded(sorted[0]),mean:rounded(sorted.reduce((a,b)=>a+b,0)/sorted.length),
    median:rounded(sorted[Math.floor((sorted.length-1)*.5)]),p95:rounded(sorted[Math.ceil(sorted.length*.95)-1]),max:rounded(sorted.at(-1))};
}

function sample(list,value){if(list.length===MAX_SAMPLES)list.shift();list.push(value);}
export function safeCloseReason(value){
  const text=String(value??'');
  // Diagnostics retain close-control information, never application packets,
  // synthetic chat text or the payload of an invalid JSON message.
  if(text.includes(ECHO_PREFIX)||text.includes(PING_PREFIX)||/\"(?:commands|checksum|matchId|resourceManifest)\"\s*:/.test(text))return '[application payload omitted]';
  return text.replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,1000);
}
function checksum(room,tick){return `retail:${tick-1}:${((((room+1)*2654435761)^tick)>>>0).toString(16).padStart(8,'0')}`;}
function timeout(promise,label,milliseconds){
  let timer;
  return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`Timed out: ${label}`)),milliseconds);})]).finally(()=>clearTimeout(timer));
}

export class LoadPeer {
  constructor({origin,roomIndex,shard,side,timeoutMillis,selfEcho,heartbeat=false}) {
    Object.assign(this,{roomIndex,shard,side,timeoutMillis,selfEcho,heartbeat});
    this.label=`room-${roomIndex}-${side===0?'host':'guest'}`;
    this.inbox=[];this.waiters=[];this.failure=null;this.phase='connecting';this.closing=false;
    this.echoKey=randomUUID();this.echoSequence=0;this.echoPending=new Map();this.echoSamples=[];
    this.echoSent=0;this.echoExpired=0;this.echoCancelled=0;this.nextEcho=0;
    this.heartbeatPending=new Map();this.heartbeatSamples=[];this.heartbeatSent=0;this.heartbeatExpired=0;this.heartbeatCancelled=0;
    this.tick=0;this.received=0;this.targetTicks=null;this.turns=new Map();this.submitted=new Map();this.wireSamples=[];
    this.firstCommit=null;this.lastCommit=null;this.maxTurns=0;this.maxSubmitted=0;this.sentChecksums=0;
    this.lastSendAt=null;this.lastReceiveAt=null;this.closeInfo=null;
    const url=new URL('/ws/native',origin);url.searchParams.set('shard',String(shard));
    url.protocol=url.protocol==='https:'?'wss:':'ws:';
    this.ws=new WebSocket(url,{origin,handshakeTimeout:15000,maxPayload:262144,followRedirects:false});
    this.open=timeout(new Promise((resolve,reject)=>{
      this.ws.once('open',resolve);this.ws.once('error',reject);this.ws.once('close',()=>reject(new Error(`${this.label}: closed before open`)));
    }),`${this.label} open`,20000);
    this.ws.once('open',()=>{if(this.heartbeat)this.heartbeatTimer=setInterval(()=>{try{this.sendHeartbeat();}catch(error){this.fail(error);}},15000);});
    this.ws.on('message',(bytes,binary)=>{
      if(this.closing)return;
      this.lastReceiveAt=new Date().toISOString();
      try{
        requireValue(!binary,'Binary server message');
        let message;try{message=JSON.parse(bytes.toString());}catch{throw new Error('Invalid server JSON');}
        this.receive(message);
      }
      catch(error){this.fail(error);}
    });
    this.ws.on('pong',bytes=>{
      this.lastReceiveAt=new Date().toISOString();
      const key=bytes.toString(),sent=this.heartbeatPending.get(key);
      if(sent!==undefined){this.heartbeatPending.delete(key);sample(this.heartbeatSamples,performance.now()-sent);}
    });
    this.ws.on('error',()=>this.fail(new Error('WebSocket error')));
    this.ws.addEventListener('close',event=>{
      clearInterval(this.heartbeatTimer);this.heartbeatTimer=null;
      this.closeInfo={code:event.code,wasClean:typeof event.wasClean==='boolean'?event.wasClean:null,
        at:new Date().toISOString(),reason:safeCloseReason(event.reason)};
      if(!this.closing)this.fail(new Error('WebSocket closed during probe'));
    });
  }
  fail(error){
    if(this.closing||this.failure)return;
    this.failure=error instanceof Error?error:new Error(String(error));
    for(const waiter of [...this.waiters])waiter.reject(this.failure);
  }
  send(message){
    if(this.failure)throw this.failure;
    requireValue(this.ws.readyState===WebSocket.OPEN,`${this.label}: socket is not open`);
    requireValue(this.ws.bufferedAmount<524288,`${this.label}: output backlog exceeded bound`);
    this.lastSendAt=new Date().toISOString();
    this.ws.send(JSON.stringify(message));
  }
  receive(message){
    requireValue(message&&typeof message.type==='string','Invalid server message');
    if(['error','stopped'].includes(message.type))throw new Error(message.error??message.reason??message.type);
    if(message.type==='turn'){
      requireValue(message.matchId===this.matchId,'Turn belongs to another match');
      requireValue(message.tick===this.received+1,'Duplicate, stale or unordered turn');
      requireValue(this.submitted.has(message.tick),'Turn was not submitted by this peer');
      requireValue(this.turns.size<INPUT_DELAY_TICKS,'Turn buffer exceeded input window');
      requireValue(Array.isArray(message.commands)&&message.commands.length===0,'Synthetic empty turn changed');
      this.received=message.tick;this.turns.set(message.tick,message);
      sample(this.wireSamples,performance.now()-this.submitted.get(message.tick));this.submitted.delete(message.tick);
      this.maxTurns=Math.max(this.maxTurns,this.turns.size);return;
    }
    if(message.type==='chat'&&message.matchId===this.matchId&&message.source===this.playerIndex&&typeof message.text==='string'&&message.text.startsWith(ECHO_PREFIX)){
      const sent=this.echoPending.get(message.text);
      if(sent!==undefined){this.echoPending.delete(message.text);sample(this.echoSamples,performance.now()-sent);}
      return;
    }
    if(message.type==='finished')this.clearEchoes();
    const waiter=this.waiters.find(value=>value.type===message.type&&value.predicate(message));
    if(waiter){waiter.resolve(message);return;}
    requireValue(this.inbox.length<MAX_INBOX,'Unconsumed message inbox exceeded bound');
    this.inbox.push(message);
  }
  wait(type,predicate=()=>true){
    if(this.failure)return Promise.reject(this.failure);
    const index=this.inbox.findIndex(message=>message.type===type&&predicate(message));
    if(index>=0)return Promise.resolve(this.inbox.splice(index,1)[0]);
    if(this.waiters.length>=MAX_WAITERS)return Promise.reject(new Error('Too many pending protocol waits'));
    return new Promise((resolve,reject)=>{
      const clear=()=>{clearTimeout(timer);const index=this.waiters.indexOf(waiter);if(index>=0)this.waiters.splice(index,1);};
      const waiter={type,predicate,resolve:value=>{clear();resolve(value);},reject:error=>{clear();reject(error);}};
      const timer=setTimeout(()=>waiter.reject(new Error(`Timed out waiting for ${type}`)),this.timeoutMillis);
      this.waiters.push(waiter);
    });
  }
  reset(start,ticks,tickMillis){
    this.phase='loading';this.matchId=start.matchId;this.playerIndex=start.playerIndex;
    this.targetTicks=ticks;this.tickMillis=tickMillis;this.tick=0;this.received=0;
    this.turns=new Map();this.submitted=new Map();this.wireSamples=[];
    this.firstCommit=null;this.lastCommit=null;this.maxTurns=0;this.maxSubmitted=0;this.sentChecksums=0;
    this.nextEcho=0;this.clearEchoes();
  }
  input(tick){
    requireValue(this.submitted.size<INPUT_DELAY_TICKS,'Pending input window exceeded bound');
    this.submitted.set(tick,performance.now());this.maxSubmitted=Math.max(this.maxSubmitted,this.submitted.size);
    this.send({type:'input',matchId:this.matchId,tick,commands:[]});
  }
  begin(now){this.phase='running';this.nextDue=now;for(let tick=1;tick<=INPUT_DELAY_TICKS;tick++)this.input(tick);}
  echo(now){
    if(!this.selfEcho)return;
    for(const [key,sent] of this.echoPending)if(now-sent>ECHO_TIMEOUT_MS){this.echoPending.delete(key);this.echoExpired++;}
    if(now<this.nextEcho||this.echoPending.size>=MAX_ECHO_PENDING)return;
    this.nextEcho=now+1000;
    const text=`${ECHO_PREFIX}${this.echoKey}:${this.echoSequence++}`;
    this.echoPending.set(text,now);this.echoSent++;
    this.send({type:'chat',matchId:this.matchId,recipients:[this.playerIndex],text});
  }
  pump(now){
    if(this.failure||this.phase!=='running')return;
    this.echo(now);
    if(now<this.nextDue||!this.turns.has(this.tick+1))return;
    this.turns.delete(++this.tick);this.firstCommit??=now;this.lastCommit=now;this.nextDue=now+this.tickMillis;
    const value=checksum(this.roomIndex,this.tick);this.sentChecksums++;
    this.send({type:'checksum',matchId:this.matchId,tick:this.tick,checksum:value});
    if(this.tick===this.targetTicks){this.phase='finishing';this.send({type:'finished',matchId:this.matchId,tick:this.tick,checksum:value});}
    else this.input(this.tick+INPUT_DELAY_TICKS);
  }
  clearEchoes(){this.echoCancelled+=this.echoPending.size;this.echoPending.clear();}
  sendHeartbeat(){
    if(this.closing||this.failure||this.ws.readyState!==WebSocket.OPEN)return;
    const now=performance.now();
    for(const [key,sent] of this.heartbeatPending)if(now-sent>ECHO_TIMEOUT_MS){this.heartbeatPending.delete(key);this.heartbeatExpired++;}
    if(this.heartbeatPending.size>=MAX_ECHO_PENDING)return;
    const key=`${PING_PREFIX}${this.echoKey}:${this.heartbeatSent++}`;
    this.heartbeatPending.set(key,now);this.lastSendAt=new Date().toISOString();this.ws.ping(key);
  }
  report(partial=false){
    const rate=this.tick>1&&this.lastCommit>this.firstCommit?(this.tick-1)*1000/(this.lastCommit-this.firstCommit):null;
    return {label:this.label,playerIndex:this.playerIndex,phase:this.phase,finishedTick:this.tick,
      targetTicks:this.targetTicks,measurementComplete:!partial&&this.phase==='finished'&&this.tick===this.targetTicks,
      sampleScope:partial?'partial progress at abort; not a completed target-tick measurement':'completed round',
      tps:partial?null:rate,partialTps:partial?rate:null,
      durationMs:this.firstCommit===null?null:this.lastCommit-this.firstCommit,
      firstCommitAtMs:this.firstCommit,lastCommitAtMs:this.lastCommit,
      elapsedSinceFirstCommitMs:this.firstCommit===null?null:performance.now()-this.firstCommit,
      lastSendAt:this.lastSendAt,lastReceiveAt:this.lastReceiveAt,close:this.closeInfo,
      orderedTurns:this.received,checksumsSent:this.sentChecksums,
      maxPendingInputs:this.maxSubmitted,maxBufferedTurns:this.maxTurns,turnWireMs:loadStatistics(this.wireSamples),
      selfEchoRtt:this.selfEcho?{scope:'self-recipient application chat round trip; excludes paired input barrier',
        milliseconds:loadStatistics(this.echoSamples),sent:this.echoSent,expired:this.echoExpired,cancelled:this.echoCancelled}:null,
      heartbeatRtt:{enabled:this.heartbeat,intervalMs:15000,
        scope:'WebSocket control ping/pong round trip; not engine timing or a paired-input barrier',
        milliseconds:loadStatistics(this.heartbeatSamples),sent:this.heartbeatSent,expired:this.heartbeatExpired,
        cancelled:this.heartbeatCancelled,pending:this.heartbeatPending.size}};
  }
  async close(){
    this.closing=true;this.clearEchoes();for(const waiter of [...this.waiters])waiter.reject(new Error('Probe cleanup'));
    clearInterval(this.heartbeatTimer);this.heartbeatTimer=null;
    this.heartbeatCancelled+=this.heartbeatPending.size;this.heartbeatPending.clear();
    if(this.ws.readyState===WebSocket.CLOSED)return {label:this.label,closed:true,terminated:false};
    const closed=new Promise(resolve=>this.ws.once('close',resolve));
    if(this.ws.readyState===WebSocket.OPEN){this.ws.send(JSON.stringify({type:'leave'}));this.ws.close(1000,'Synthetic concurrency probe complete');}
    else this.ws.terminate();
    try{await timeout(closed,`${this.label} cleanup`,3000);return {label:this.label,closed:true,terminated:false};}
    catch{this.ws.terminate();return {label:this.label,closed:true,terminated:true};}
  }
}

function healthIdentity(value){return {app:value.app,protocol:value.protocol,patchSha256:value.patchSha256,
  resourceManifestSha256:value.resourceManifestSha256,roomRouting:value.roomRouting};}

async function health(origin){
  const response=await fetch(new URL('/api/health',origin),{signal:AbortSignal.timeout(20000)});
  requireValue(response.ok,`Health HTTP ${response.status}`);
  const value=await response.json();
  requireValue(value.ok&&value.app==='werhd-native'&&value.protocol===NATIVE_PROTOCOL,'Origin is not the expected native project/protocol');
  for(const key of ['patchSha256','resourceManifestSha256'])requireValue(/^[a-f0-9]{64}$/.test(value[key]??''),`Health lacks ${key}`);
  requireValue(Object.entries(NATIVE_ROOM_ROUTING).every(([key,expected])=>value.roomRouting?.[key]===expected),'Health shard routing/capacity differs from this probe');
  return value;
}

async function prepare(room,{ticks,tickMillis,build,resourceManifest},reentry=false){
  const [host,guest]=room.peers;
  for(const peer of room.peers){peer.inbox=[];peer.phase='lobby';}
  host.send({type:'create',name:`LoadHost${room.index}`,config:{seed:(0x56455241+room.index)>>>0}});
  const entry=(await host.wait('room',message=>message.room?.isHost&&message.room.members.length===1)).room;
  requireValue(new RegExp(`^S${room.shard}[0-9A-F]{5}$`).test(entry.code),'Room code does not identify its explicit shard');
  if(reentry)requireValue(entry.code!==room.code,'Reentry reused an old room code');
  room.code=entry.code;
  guest.send({type:'join',name:`LoadGuest${room.index}`,code:entry.code});
  await guest.wait('room',message=>message.room?.code===entry.code&&message.room.members.length===2);
  guest.send({type:'ready'});await host.wait('room',message=>message.room?.code===entry.code&&message.room.canStart);
  host.send({type:'start'});
  const starts=await Promise.all(room.peers.map(peer=>peer.wait('start')));
  requireValue(starts[0].matchId===starts[1].matchId,'Peers received different match identities');
  requireValue(starts[0].playerIndex===0&&starts[1].playerIndex===1,'Peer source identity differs');
  for(const [index,peer] of room.peers.entries()){
    peer.reset(starts[index],ticks,tickMillis);peer.send({type:'progress',matchId:peer.matchId,percent:100});
  }
  for(const source of [0,1])await Promise.all(room.peers.map(peer=>peer.wait('progress',message=>message.matchId===peer.matchId&&message.source===source&&message.percent===100)));
  for(const peer of room.peers)peer.send({type:'loaded',protocol:NATIVE_PROTOCOL,matchId:peer.matchId,tick:0,
    hash:`synthetic-load-local-${peer.playerIndex}`,owners:[0,14],build,resourceManifest});
  const ready=await Promise.all(room.peers.map(peer=>peer.wait('ready')));
  requireValue(ready.every(message=>message.protocol===NATIVE_PROTOCOL&&message.inputDelayTicks===INPUT_DELAY_TICKS&&message.tick===1&&message.bootstrap===starts[0].matchId),'Pipeline ready contract differs');
  for(const peer of room.peers)peer.phase='ready';
}

async function runRound(rooms,{ticks,tickMillis,build,resourceManifest},reentry=false){
  await Promise.all(rooms.map(room=>prepare(room,{ticks,tickMillis,build,resourceManifest},reentry)));
  const peers=rooms.flatMap(room=>room.peers);
  requireValue(peers.every(peer=>peer.phase==='ready'),'All clients must be ready before concurrent pumping');
  const finishes=peers.map(peer=>peer.wait('finished',message=>message.matchId===peer.matchId));
  // Attach the aggregate rejection handler before starting the pump.
  const finished=Promise.all(finishes);finished.catch(()=>{});
  const started=performance.now();for(const peer of peers)peer.begin(started);
  let allAdvancedTogether=false;
  const pumping=setInterval(()=>{
    const now=performance.now();
    for(const peer of peers){try{peer.pump(now);}catch(error){peer.fail(error);}}
    allAdvancedTogether||=peers.every(peer=>peer.tick>=Math.min(16,ticks));
  },1);
  try{
    const receipts=await finished;
    receipts.forEach((receipt,index)=>{
      requireValue(receipt.tick===ticks&&receipt.checksum===checksum(peers[index].roomIndex,ticks),'Synthetic CRC/final receipt differs');
      peers[index].phase='finished';
    });
    await Promise.all(peers.map(peer=>peer.wait('room',message=>message.room===null)));
    return {ticks,tickMillis,simultaneousReadyClients:peers.length,concurrentPumpStartedAtMs:started,
      allClientsAdvancedTogether:allAdvancedTogether,elapsedMs:performance.now()-started,
      commonCommitOverlapMs:Math.max(0,Math.min(...peers.map(peer=>peer.lastCommit))-Math.max(...peers.map(peer=>peer.firstCommit))),
      tps:loadStatistics(peers.map(peer=>peer.report().tps)),
      rooms:rooms.map(room=>({index:room.index,shard:room.shard,code:room.code,
        matchingFinishedReceipts:true,returnedToLobby:true,peers:room.peers.map(peer=>peer.report())}))};
  }finally{clearInterval(pumping);}
}

export async function runNativeNetworkLoad(options){
  // Apply the same limits to programmatic callers as to the command line.
  options=loadOptions([`--origin=${options.origin}`,`--players=${options.players??100}`,`--ticks=${options.ticks??600}`,
    `--tick-ms=${options.tickMillis??48}`,`--reentry-ticks=${options.reentryTicks??16}`,`--self-echo=${options.selfEcho??false}`,
    `--heartbeat=${options.heartbeat??false}`]);
  const peers=[],rooms=[];
  const report={schema:1,ok:false,origin:options.origin,
    scope:'real WebSocket concurrency, ordered synthetic inputs/checksums and lifecycle; no WASM or game simulation',
    resultMeaning:'ok means protocol/lifecycle checks passed; compare observed TPS with targetTps separately',
    engineGameplayVerified:false,protocol:NATIVE_PROTOCOL,inputDelayTicks:INPUT_DELAY_TICKS,
    players:options.players,matches:options.players/2,shards:NATIVE_ROOM_SHARDS,targetTps:1000/options.tickMillis,
    requestedTicks:options.ticks,heartbeat:options.heartbeat,
    sampleLimit:MAX_SAMPLES,startedAt:new Date().toISOString(),failures:[]};
  try{
    const current=await health(options.origin);
    report.healthBefore=healthIdentity(current);
    report.buildIdentity={patchSha256:current.patchSha256,resourceManifestSha256:current.resourceManifestSha256};
    report.roomRouting=current.roomRouting;
    for(let index=0;index<options.players/2;index++){
      const shard=index%NATIVE_ROOM_SHARDS;
      const pair=[0,1].map(side=>new LoadPeer({...options,roomIndex:index,shard,side,
        timeoutMillis:Math.max(30000,options.ticks*options.tickMillis*4+30000)}));
      peers.push(...pair);rooms.push({index,shard,peers:pair});
    }
    report.clientsPerShard=Array.from({length:NATIVE_ROOM_SHARDS},(_,shard)=>peers.filter(peer=>peer.shard===shard).length);
    await Promise.all(peers.map(peer=>peer.open));
    await Promise.all(peers.map(async peer=>{
      const hello=await peer.wait('hello');requireValue(hello.protocol===NATIVE_PROTOCOL,'Server hello protocol differs');
      peer.send({type:'hello',protocol:NATIVE_PROTOCOL,playerId:randomUUID()});
    }));
    const binding={tickMillis:options.tickMillis,build:`load-probe-v3:${current.patchSha256}`,resourceManifest:current.resourceManifestSha256};
    report.primary=await runRound(rooms,{...binding,ticks:options.ticks});
    report.reentry=await runRound(rooms,{...binding,ticks:options.reentryTicks},true);
    report.ok=true;
  }catch(error){
    report.failures.push({scope:'load-run',message:String(error.message??error).slice(0,1000)});
    for(const peer of peers)if(peer.failure)report.failures.push({label:peer.label,room:peer.roomIndex,shard:peer.shard,
      phase:peer.phase,tick:peer.tick??0,message:peer.failure.message.slice(0,1000)});
    report.abortSnapshot={capturedAt:new Date().toISOString(),engineGameplayVerified:false,
      sampleScope:'partial progress at early abort; not a completed requestedTicks concurrency result',
      rooms:rooms.map(room=>({index:room.index,shard:room.shard,code:room.code??null,
        peers:room.peers.map(peer=>peer.report(true))}))};
  }finally{
    report.cleanup=await Promise.all(peers.map(peer=>peer.close()));
    report.socketClosures=peers.map(peer=>({label:peer.label,room:peer.roomIndex,shard:peer.shard,close:peer.closeInfo}));
    try{
      report.healthAfter=healthIdentity(await health(options.origin));
      report.healthUnchanged=!!report.healthBefore&&JSON.stringify(report.healthBefore)===JSON.stringify(report.healthAfter);
      if(!report.healthUnchanged&&report.healthBefore){report.ok=false;report.failures.push({scope:'post-run-health',message:'Published build or routing changed during load probe'});}
    }catch(error){report.ok=false;report.healthAfter={unavailable:true,error:String(error.message??error).slice(0,1000)};
      report.failures.push({scope:'post-run-health',message:'Could not verify project health after cleanup'});}
    report.finishedAt=new Date().toISOString();
  }
  return report;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const report=await runNativeNetworkLoad(loadOptions(process.argv.slice(2)));console.log(JSON.stringify(report));if(!report.ok)process.exitCode=1;}
  catch(error){console.log(JSON.stringify({ok:false,engineGameplayVerified:false,error:String(error.message??error)}));process.exitCode=1;}
}
