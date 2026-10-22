// Transport-only regression. These peers deliberately use synthetic CRCs and
// no SimRuntime; actual native/WASM gameplay remains a separate acceptance gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import {NativeRoomCoordinator, NATIVE_PROTOCOL, INPUT_DELAY_TICKS} from '../tools/services/native-room-coordinator.mjs';

class Clock {
  now=0; sequence=0; events=[];
  at(time,run) { this.events.push({time,run,sequence:this.sequence++}); }
  next() {
    this.events.sort((a,b)=>a.time-b.time||a.sequence-b.sequence);
    const event=this.events.shift();assert.ok(event,'simulation has an event');
    this.now=event.time;event.run();
  }
}

function runTransport({rtt,jitter=0,ticks=240,tickMillis=48,window=INPUT_DELAY_TICKS,disconnectAt}={}) {
  const clock=new Clock(),service=new NativeRoomCoordinator(),peers=[];
  let active=false,matchId,deliverySequence=0;
  function wire(peer,direction,run) {
    if(!active){run();return;}
    // Preserve ordered WebSocket semantics, while varying each delivery's
    // delay. Jitter is deterministic so timing assertions are reproducible.
    const noise=jitter?((deliverySequence++*17)%11)/10*jitter:0;
    const due=Math.max(clock.now+rtt/2+noise,(peer[direction]??0)+0.001);
    peer[direction]=due;clock.at(due,run);
  }
  function peer(owner) {
    const p={owner,messages:[],turns:new Map(),tick:0,commits:[],stopped:null,finished:null};
    p.client=service.connect({send:raw=>wire(p,'down',()=>{
      const m=JSON.parse(raw);p.messages.push(m);
      if(m.type==='turn'){assert.equal(p.turns.has(m.tick),false);p.turns.set(m.tick,m);}
      if(m.type==='error')assert.fail(m.error);
      if(m.type==='stopped')p.stopped=m;
      if(m.type==='finished')p.finished=m;
    }),close(){}});
    p.send=m=>wire(p,'up',()=>service.receive(p.client,JSON.stringify(m)));
    p.send({type:'hello',protocol:NATIVE_PROTOCOL});peers.push(p);return p;
  }
  const a=peer(7),b=peer(13);
  try {
    a.send({type:'create',name:'Synthetic A',config:{seed:1}});
    b.send({type:'join',name:'Synthetic B',code:a.client.room.code});
    b.send({type:'ready'});a.send({type:'start'});matchId=a.client.room.matchId;
    for(const p of peers)p.send({type:'progress',matchId,percent:100});
    for(const p of peers)p.send({type:'loaded',protocol:NATIVE_PROTOCOL,matchId,tick:0,hash:'synthetic-local-view',owners:[7,13],build:'synthetic-latency-regression',resourceManifest:'a'.repeat(64)});
    assert.ok(peers.every(p=>p.messages.some(m=>m.type==='ready'&&m.inputDelayTicks===INPUT_DELAY_TICKS)));
    active=true;
    const input=(p,tick)=>p.send({type:'input',matchId,tick,commands:tick%31===0?[{owner:p.owner,execute_tick:tick,payload:'Cheer'}]:[]});
    for(const p of peers)for(let tick=1;tick<=window;tick++)input(p,tick);
    function pump(p) {
      if(p.stopped||p.finished||p.tick>=ticks)return;
      const turn=p.turns.get(p.tick+1);
      if(turn){
        p.tick++;p.turns.delete(p.tick);p.commits.push(clock.now);
        if(p.tick%31===0)assert.deepEqual(turn.commands.map(c=>c.player),[0,1]);
        const checksum=`retail:${p.tick-1}:12345678`;
        p.send({type:'checksum',matchId,tick:p.tick,checksum});
        if(p.tick===ticks)p.send({type:'finished',matchId,tick:p.tick,checksum});
        else input(p,p.tick+window);
      }
      if(p.tick<ticks)clock.at(clock.now+tickMillis,()=>pump(p));
    }
    for(const p of peers)clock.at(0,()=>pump(p));
    if(disconnectAt)clock.at(disconnectAt,()=>service.disconnect(b.client));
    for(let event=0;event<100000&&!(peers.every(p=>p.finished)||peers.every(p=>p.stopped));event++)clock.next();
    if(disconnectAt){assert.ok(peers.every(p=>p.stopped));assert.equal(service.rooms.size,0);return;}
    assert.ok(peers.every(p=>p.finished));assert.equal(service.rooms.size,0);
    for(const p of peers){assert.equal(p.tick,ticks);assert.equal(p.finished.tick,ticks);assert.equal(p.finished.checksum,`retail:${ticks-1}:12345678`);}
    return peers.map(p=>({tps:(ticks-1)*1000/(p.commits.at(-1)-p.commits[0]),commits:p.commits}));
  } finally {service.close();}
}

for(const rtt of [150,250])test(`transport-only: eight-frame pipeline sustains native cadence at ${rtt} ms RTT with jitter`,()=>{
  const peers=runTransport({rtt,jitter:35});
  for(const peer of peers)assert.ok(peer.tps>=20,`synthetic paced transport achieved ${peer.tps.toFixed(2)} TPS`);
});

test('transport-only: one frame in flight remains RTT-bound under the same delayed link',()=>{
  const [serial]=runTransport({rtt:150,ticks:30,window:1});
  const [pipeline]=runTransport({rtt:150,ticks:30});
  assert.ok(serial.tps<7);assert.ok(pipeline.tps>20);
});

test('transport-only: peer disconnection retires queued future turns instead of advancing alone',()=>{
  runTransport({rtt:250,jitter:35,disconnectAt:1200});
});
