// Real-WebSocket, synthetic-input throughput probe. This intentionally does not
// load a game engine, so a passing result is never native gameplay acceptance.
import WebSocket from '../node_modules/ws/wrapper.mjs';
import {randomUUID} from 'node:crypto';
import {NATIVE_PROTOCOL, INPUT_DELAY_TICKS} from './services/native-room-coordinator.mjs';

const args=new Map(process.argv.slice(2).map(value=>{const split=value.indexOf('=');if(!value.startsWith('--')||split<0)throw new Error('Expected --name=value');return [value.slice(2,split),value.slice(split+1)];}));
for(const key of args.keys())if(!['origin','ticks','tick-ms'].includes(key))throw new Error(`Unknown argument: ${key}`);
const origin=new URL(args.get('origin')??'http://127.0.0.1:5280').origin;
const ticks=Number(args.get('ticks')??60),tickMillis=Number(args.get('tick-ms')??48);
if(!Number.isInteger(ticks)||ticks<16||ticks>2000||!Number.isInteger(tickMillis)||tickMillis<1||tickMillis>1000)throw new Error('ticks must be 16..2000; tick-ms must be 1..1000');
const timeout=Math.max(20000,ticks*tickMillis*3),peers=[];
const SELF_ECHO_PREFIX='native-probe-self-echo-v3:',MAX_PENDING_ECHOES=8,ECHO_TIMEOUT_MS=10000;
let pumping;
function deadline(promise,label,ms=timeout) {
  let timer;
  return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`Timed out: ${label}`)),ms);})]).finally(()=>clearTimeout(timer));
}
class Peer {
  constructor(label) {
    this.label=label;this.inbox=[];this.waiters=[];this.turns=new Map();this.submitted=new Map();this.wireTimes=[];this.commits=[];this.tick=0;
    this.echoId=randomUUID();this.echoSequence=0;this.echoPending=new Map();this.echoTimes=[];
    this.echoSent=0;this.echoExpired=0;this.echoCancelled=0;this.nextEchoDue=0;
    const url=new URL('/ws/native',origin);url.protocol=url.protocol==='https:'?'wss:':'ws:';
    this.ws=new WebSocket(url,{origin,handshakeTimeout:15000,maxPayload:262144});
    this.open=deadline(new Promise((resolve,reject)=>{this.ws.once('open',resolve);this.ws.once('error',reject);}),`${label} open`);
    this.ws.on('error',()=>this.fail(new Error(`${label}: WebSocket error`)));
    this.ws.on('close',()=>{if(!this.closing)this.fail(new Error(`${label}: WebSocket closed`));});
    this.ws.on('message',bytes=>{
      try {
        const message=JSON.parse(bytes.toString());
        if(['error','stopped'].includes(message.type))throw new Error(`${label}: ${message.error??message.reason}`);
        if(message.type==='turn'){
          if(message.tick!==this.received+1)throw new Error(`${label}: unordered turn`);
          this.received=message.tick;this.turns.set(message.tick,message);
          this.wireTimes.push(performance.now()-this.submitted.get(message.tick));this.submitted.delete(message.tick);
        }
        if(message.type==='chat'&&message.matchId===this.matchId&&message.source===this.playerIndex
          &&typeof message.text==='string'&&message.text.startsWith(SELF_ECHO_PREFIX)){
          const sentAt=this.echoPending.get(message.text);
          if(sentAt!==undefined){this.echoPending.delete(message.text);this.echoTimes.push(performance.now()-sentAt);}
          return;
        }
        if(message.type==='finished')this.clearEchoes();
        const index=this.waiters.findIndex(waiter=>waiter.type===message.type&&waiter.predicate(message));
        if(index>=0)this.waiters.splice(index,1)[0].resolve(message);else this.inbox.push(message);
      } catch(error){this.fail(error);}
    });
  }
  fail(error) {if(this.closing)return;this.failure??=error;this.clearEchoes();for(const waiter of this.waiters.splice(0))waiter.reject(error);}
  send(message) {if(this.failure)throw this.failure;this.ws.send(JSON.stringify(message));}
  wait(type,predicate=()=>true) {
    if(this.failure)return Promise.reject(this.failure);
    const index=this.inbox.findIndex(message=>message.type===type&&predicate(message));
    if(index>=0)return Promise.resolve(this.inbox.splice(index,1)[0]);
    return deadline(new Promise((resolve,reject)=>this.waiters.push({type,predicate,resolve,reject})),`${this.label} ${type}`);
  }
  input(tick) {this.submitted.set(tick,performance.now());this.send({type:'input',matchId:this.matchId,tick,commands:[]});}
  clearEchoes() {this.echoCancelled+=this.echoPending.size;this.echoPending.clear();}
  selfEcho(now) {
    for(const [text,sentAt] of this.echoPending)if(now-sentAt>=ECHO_TIMEOUT_MS){this.echoPending.delete(text);this.echoExpired++;}
    if(now<this.nextEchoDue)return;
    this.nextEchoDue=now+1000;
    if(this.echoPending.size>=MAX_PENDING_ECHOES)return;
    const text=`${SELF_ECHO_PREFIX}${this.echoId}:${this.echoSequence++}`;
    this.echoPending.set(text,now);this.echoSent++;
    this.send({type:'chat',matchId:this.matchId,recipients:[this.playerIndex],text});
  }
  pump() {
    if(this.failure||this.tick>=ticks)return;
    const observed=performance.now();this.selfEcho(observed);
    if(observed<this.nextDue||!this.turns.has(this.tick+1))return;
    this.turns.delete(++this.tick);const now=performance.now();this.commits.push(now);this.nextDue=now+tickMillis;
    const checksum=`retail:${this.tick-1}:12345678`;
    this.send({type:'checksum',matchId:this.matchId,tick:this.tick,checksum});
    if(this.tick===ticks)this.send({type:'finished',matchId:this.matchId,tick:this.tick,checksum});
    else this.input(this.tick+INPUT_DELAY_TICKS);
  }
  async close() {
    this.closing=true;this.clearEchoes();for(const waiter of this.waiters.splice(0))waiter.reject(new Error('Probe cleanup'));
    if(this.ws.readyState===WebSocket.CLOSED)return;
    if(this.ws.readyState===WebSocket.OPEN){this.ws.send(JSON.stringify({type:'leave'}));this.ws.close(1000,'Synthetic transport probe complete');}
    else this.ws.terminate();
    await deadline(new Promise(resolve=>this.ws.once('close',resolve)),`${this.label} close`,3000).catch(()=>this.ws.terminate());
  }
}
const statistics=values=>{
  const sorted=values.filter(Number.isFinite).sort((a,b)=>a-b);
  if(!sorted.length)return {samples:0,meanMs:null,p50Ms:null,p95Ms:null};
  return {samples:sorted.length,meanMs:sorted.reduce((sum,value)=>sum+value,0)/sorted.length,p50Ms:sorted[Math.floor(sorted.length*.5)],p95Ms:sorted[Math.floor(sorted.length*.95)]};
};
try {
  const health=await deadline(fetch(new URL('/api/health',origin)).then(response=>{if(!response.ok)throw new Error(`Health HTTP ${response.status}`);return response.json();}),'health',15000);
  if(health.protocol!==NATIVE_PROTOCOL||!health.resourceManifestSha256)throw new Error('Published native protocol/resource identity unavailable');
  peers.push(new Peer('host'),new Peer('guest'));const [a,b]=peers;
  await Promise.all(peers.map(peer=>peer.open));
  for(const peer of peers){const hello=await peer.wait('hello');if(hello.protocol!==NATIVE_PROTOCOL)throw new Error('Protocol mismatch');peer.send({type:'hello',protocol:NATIVE_PROTOCOL,playerId:randomUUID()});}
  a.send({type:'create',name:'PipelineProbeHost',config:{seed:0x56455241}});
  const room=(await a.wait('room',message=>message.room?.members.length===1)).room;
  b.send({type:'join',name:'PipelineProbeGuest',code:room.code});await b.wait('room',message=>message.room?.members.length===2);
  b.send({type:'ready'});await a.wait('room',message=>message.room?.canStart);a.send({type:'start'});
  const starts=await Promise.all(peers.map(peer=>peer.wait('start')));
  for(const [index,peer] of peers.entries()){peer.matchId=starts[index].matchId;peer.playerIndex=starts[index].playerIndex;peer.send({type:'progress',matchId:peer.matchId,percent:100});}
  for(const source of [0,1])await Promise.all(peers.map(peer=>peer.wait('progress',message=>message.source===source&&message.percent===100)));
  for(const peer of peers)peer.send({type:'loaded',protocol:NATIVE_PROTOCOL,matchId:peer.matchId,tick:0,hash:'synthetic-local-view',owners:[0,14],build:'synthetic-pipeline-probe-v3',resourceManifest:health.resourceManifestSha256});
  const ready=await Promise.all(peers.map(peer=>peer.wait('ready')));
  if(ready.some(message=>message.protocol!==NATIVE_PROTOCOL||message.inputDelayTicks!==INPUT_DELAY_TICKS||message.tick!==1))throw new Error('Pipeline contract mismatch');
  for(const peer of peers){peer.received=0;peer.nextDue=performance.now();for(let tick=1;tick<=INPUT_DELAY_TICKS;tick++)peer.input(tick);}
  pumping=setInterval(()=>{for(const peer of peers){try{peer.pump();}catch(error){peer.fail(error);}}},1);
  const finished=await Promise.all(peers.map(peer=>peer.wait('finished')));
  if(finished.some(message=>message.tick!==ticks||message.checksum!==`retail:${ticks-1}:12345678`))throw new Error('Synthetic finish receipt mismatch');
  console.log(JSON.stringify({ok:true,origin,scope:'real WebSocket synthetic-input transport throughput; no game engine or renderer',engineGameplayVerified:false,protocol:NATIVE_PROTOCOL,inputDelayTicks:INPUT_DELAY_TICKS,ticks,tickMillis,
    peers:peers.map(peer=>({label:peer.label,finishedTick:peer.tick,tps:(ticks-1)*1000/(peer.commits.at(-1)-peer.commits[0]),turnWire:statistics(peer.wireTimes),
      selfEchoRtt:{scope:'Durable Object application round trip via self-recipient chat; excludes paired input barrier; includes client/network scheduling',
        ...statistics(peer.echoTimes),sent:peer.echoSent,expired:peer.echoExpired,cancelled:peer.echoCancelled}}))}));
} catch(error) {console.error(JSON.stringify({ok:false,origin,engineGameplayVerified:false,error:error.message}));process.exitCode=1;}
finally {clearInterval(pumping);await Promise.allSettled(peers.map(peer=>peer.close()));}
