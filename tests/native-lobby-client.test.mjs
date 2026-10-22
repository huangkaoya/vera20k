import test from 'node:test';
import assert from 'node:assert/strict';
import {installNativeLobby} from '../web-native/lobby.js';

// Exercise the actual DOM-free transport. Any attempt to create a visible
// shell fails immediately; only visibility events and canvas focus are ports.
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture(t) {
  const saved = new Map(), sockets = [], calls = [], states = [], timers = new Map(); let timerId = 0, focused = 0;
  const replace = (name, value) => { saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, {configurable: true, writable: true, value}); };
  const window = new EventTarget(), document = new EventTarget();
  Object.assign(document, {hidden: false, createElement() { throw new Error('transport must not create DOM'); }});
  const storage = () => { const values = new Map(); return {getItem: key => values.get(key), setItem: (key, value) => values.set(key, value)}; };
  class Socket extends EventTarget {
    static OPEN = 1;
    readyState = 0; sent = [];
    constructor() { super(); sockets.push(this); }
    send(raw) { this.sent.push(JSON.parse(raw)); }
    close() { this.readyState = 3; }
    open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
    receive(message) { const event = new Event('message'); event.data = JSON.stringify(message); this.dispatchEvent(event); }
    disconnect() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
    error() { this.dispatchEvent(new Event('error')); }
  }
  for (const [name, value] of Object.entries({window, document, WebSocket: Socket,
    location: {href: 'http://127.0.0.1:5280/'}, sessionStorage: storage(), localStorage: storage(),
    setTimeout: (callback, ms) => { const id = ++timerId; timers.set(id, {callback, ms}); return id; }, clearTimeout: id => timers.delete(id)})) replace(name, value);
  let status = {phase: 'idle'}, confirmOnReceive = true, rejectAck = false, outbox = [];
  const native = {
    network_start(raw) { const config = JSON.parse(raw); calls.push(['start', config]); status = {matchId: config.matchId, phase: 'running'}; },
    network_receive(raw) {
      const message = JSON.parse(raw);
      if (message.type === 'finished' && rejectAck) throw new Error('invalid result receipt');
      calls.push(['receive', message]);
      if (message.type === 'finished' && confirmOnReceive) status = {matchId: message.matchId, phase: 'finished', finishedTick: message.tick, hash: message.checksum};
    },
    network_leave(matchId) { calls.push(['leave', matchId]); },
    network_drain_outbox: () => JSON.stringify(outbox.splice(0)), network_status: () => status,
  };
  const canvas = {dataset: {}, focus() { focused++; }};
  const controller = installNativeLobby({native, canvas, onState: state => states.push(state)});
  const event = name => window.dispatchEvent(new Event(name));
  t.after(() => { controller.dispose(); for (const [name, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; } });
  return {calls, sockets, controller, states, timers, canvas, document, event,
    get current() { return states.at(-1); }, get focused() { return focused; },
    emit(message) { outbox.push(message); },
    setStatus(value) { status = value; },
    deferAck() { confirmOnReceive = false; }, rejectAck() { rejectAck = true; },
    async start(matchId = 'MATCH-1') {
      await controller.dispatch({action: 'open'}); const creating = controller.dispatch({action: 'create'}); const socket = sockets.at(-1); socket.open(); await creating;
      socket.receive({type: 'start', matchId, playerIndex: 1, config: {map: 'XMP29U2.MAP'}});
      event('vera-native-network-started'); assert.equal(states.at(-1).open, false); return socket;
    },
  };
}
const result = (matchId = 'MATCH-1') => ({type: 'finished', matchId, tick: 8340, checksum: 'retail:8340:6c44133f'});
const stopped = f => f.calls.filter(([type, message]) => type === 'receive' && message.type === 'stopped');

test('a native-confirmed result keeps its page after socket errors and close', async t => {
  const f = fixture(t), socket = await f.start();
  socket.receive(result()); socket.receive({type: 'room', room: null});
  socket.receive({type: 'error', error: 'late transport error'}); socket.error(); socket.disconnect();
  f.event('vera-native-network-service');
  assert.equal(f.current.open, false); assert.equal(stopped(f).length, 0);
});

test('close between ACK delivery and native validation waits for the actual finished phase', async t => {
  const f = fixture(t), socket = await f.start(); f.deferAck();
  f.setStatus({matchId: 'MATCH-1', phase: 'finishing'});
  socket.receive(result()); socket.disconnect(); assert.equal(f.current.open, false);
  f.setStatus({matchId: 'MATCH-1', phase: 'finished', finishedTick: 8340, hash: result().checksum});
  f.event('vera-native-network-service'); assert.equal(f.current.open, false); assert.equal(stopped(f).length, 0);
});

test('an ACK later rejected by native validation still reports failure', async t => {
  const f = fixture(t), socket = await f.start(); f.deferAck();
  socket.receive(result()); socket.disconnect();
  f.setStatus({matchId: 'MATCH-1', phase: 'stopped', error: 'result checksum differs'});
  f.event('vera-native-network-service');
  assert.equal(f.current.open, true); assert.match(f.current.error, /result checksum differs/); assert.equal(stopped(f).length, 1);
});

test('unacknowledged or wrong-match disconnects still stop the live match', async t => {
  const f = fixture(t), socket = await f.start();
  socket.receive(result('OLD-MATCH')); socket.disconnect();
  assert.equal(f.current.open, true); assert.equal(stopped(f).length, 1); assert.equal(stopped(f)[0][1].matchId, 'MATCH-1');
});

test('Continue clears completion and old socket epochs cannot protect a new unfinished match', async t => {
  const f = fixture(t), old = await f.start(); old.receive(result());
  f.event('vera-native-network-return');
  const current = await f.start('MATCH-2');
  old.receive(result()); old.error(); old.disconnect();
  assert.equal(f.current.open, false); assert.equal(stopped(f).length, 0);
  current.disconnect(); assert.equal(f.current.open, true); assert.equal(stopped(f).length, 1);
  assert.equal(stopped(f)[0][1].matchId, 'MATCH-2');
});

const room = (isHost = true) => ({code: 'ABCD12', isHost, localMemberId: isHost ? 'host' : 'guest', canStart: true, phase: 'lobby', status: '双方已准备',
  members: [{id: 'host', name: '房主', ready: true, host: true, slot: 0}, {id: 'guest', name: '战友', ready: true, host: false, slot: 1}],
  config: {seed: 7, map: 'XMP29U2.MAP', players: [
    {slot: 0, name: '房主', country: 'America', color: 0, start: 0, team: -1, human: true, difficulty: 'normal'},
    {slot: 1, name: '战友', country: 'Russia', color: 1, start: 1, team: -1, human: true, difficulty: 'normal'},
  ], options: {credits: 10000, unitCount: 10, gameSpeed: 3, crates: false}}});

test('semantic actions drive host settings and preserve a detached server-authoritative snapshot without creating DOM', async t => {
  const f = fixture(t); assert.equal(f.current.schema, 1); assert.equal(f.current.phase, 'entry'); assert.equal(f.current.open, false);
  await f.controller.dispatch({action: 'open'});
  await f.controller.dispatch({action: 'setName', name: '指挥官测试'});
  await f.controller.dispatch({action: 'setCode', code: ' ab cd12 '});
  assert.equal(f.current.name, '指挥官测试'); assert.equal(f.current.code, 'ABCD12');
  const creating = f.controller.dispatch({action: 'create'}), socket = f.sockets.at(-1); socket.open(); await creating;
  assert.equal(socket.sent[0].type, 'hello'); assert.equal(socket.sent[0].protocol, 3);
  assert.deepEqual(socket.sent[1], {type: 'create', name: '指挥官测试'});
  socket.receive({type: 'room', room: room()}); assert.equal(f.current.phase, 'room');
  f.current.room.config.options.credits = 1;
  await f.controller.dispatch({action: 'updateSettings', settings: {gameSpeed: 2, crates: true}});
  const config = socket.sent.at(-1).config;
  assert.equal(config.options.credits, 10000, 'consumer mutations cannot change the live authority');
  assert.equal(config.options.gameSpeed, 2); assert.equal(config.options.crates, true);
  socket.receive({type: 'room', room: {...room(), config}});
  await f.controller.dispatch({action: 'updatePlayer', slot: 1, player: {country: 'Yuri', color: 3}});
  assert.equal(socket.sent.at(-1).config.players[1].country, 'Yuri'); assert.equal(socket.sent.at(-1).config.players[1].color, 3);
  socket.receive({type: 'room', room: room()}); const count = socket.sent.length;
  assert.equal(await f.controller.dispatch({action: 'ready'}), false); assert.equal(socket.sent.length, count, 'host does not toggle ready');
  await f.controller.dispatch({action: 'start'}); assert.deepEqual(socket.sent.at(-1), {type: 'start'});
});

test('guest readiness is available while settings, foreign players and repeated requests stay gated', async t => {
  const f = fixture(t); await f.controller.dispatch('open');
  const joining = f.controller.dispatch({action: 'join', name: '访客', code: ' abcd12 '}), socket = f.sockets.at(-1); socket.open(); await joining;
  assert.deepEqual(socket.sent.at(-1), {type: 'join', name: '访客', code: 'ABCD12'});
  socket.receive({type: 'room', room: room(false)}); const count = socket.sent.length;
  assert.equal(await f.controller.dispatch({action: 'start'}), false);
  assert.equal(await f.controller.dispatch({action: 'updateSettings', settings: {credits: 30000}}), false);
  assert.equal(await f.controller.dispatch({action: 'updatePlayer', slot: 0, player: {country: 'Yuri'}}), false);
  assert.equal(socket.sent.length, count);
  await f.controller.dispatch('ready'); assert.deepEqual(socket.sent.at(-1), {type: 'ready'});
  assert.equal(await f.controller.dispatch('ready'), false, 'one outstanding request remains busy until authority responds');
  socket.receive({type: 'room', room: room(false)}); await f.controller.dispatch('leave');
  assert.deepEqual(socket.sent.at(-1), {type: 'leave'}); assert.equal(f.current.phase, 'entry'); assert.equal(f.current.open, true);
  await f.controller.dispatch('returnMenu'); assert.equal(f.current.open, false); assert.equal(f.current.connected, false);
});

test('the initial native barrier retains early messages and relays exact outbox receipts without rendering turns', async t => {
  const f = fixture(t); await f.controller.dispatch('open');
  const creating = f.controller.dispatch('create'), socket = f.sockets.at(-1); socket.open(); await creating;
  socket.receive({type: 'start', matchId: 'BARRIER', playerIndex: 1, config: room().config});
  assert.equal(f.current.phase, 'loading'); assert.equal(f.current.starting, true);
  const early = [{type: 'progress', matchId: 'BARRIER', source: 0, percent: 100},
    {type: 'ready', matchId: 'BARRIER', tick: 1, bootstrap: 'launch:BARRIER'},
    {type: 'turn', matchId: 'BARRIER', tick: 1, commands: []}];
  for (const message of early) socket.receive(message);
  assert.equal(f.calls.filter(([type]) => type === 'receive').length, 0);
  f.event('vera-native-network-started'); assert.equal(f.current.phase, 'battle'); assert.equal(f.current.open, false);
  assert.deepEqual(f.calls.filter(([type]) => type === 'receive').map(([, message]) => message), early);
  const receipt = {type: 'loaded', matchId: 'BARRIER', tick: 0, hash: 'diagnostic', owners: ['A', 'B'], build: 'pinned'};
  f.emit(receipt); const snapshots = f.states.length; f.event('vera-native-network-service');
  assert.deepEqual(socket.sent.at(-1), receipt); assert.equal(f.states.length, snapshots, 'transport turns never redraw a shell');
  f.document.hidden = true; f.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal([...f.timers.values()].at(-1).ms, 100);
});

test('closing or disposing during connect suppresses stale callbacks, sends and state writes', async t => {
  const f = fixture(t); await f.controller.dispatch('open'); const pending = f.controller.dispatch('create'), old = f.sockets.at(-1);
  await f.controller.dispatch('close'); assert.equal(await pending, false); const snapshots = f.states.length;
  old.open(); old.error(); old.disconnect(); await flush();
  assert.equal(old.sent.length, 0); assert.equal(f.states.length, snapshots); assert.equal(f.current.error, '');
  await f.controller.dispatch('open'); const joining = f.controller.dispatch({action: 'join', code: 'ABC123'}), current = f.sockets.at(-1);
  f.controller.dispose(); assert.equal(await joining, false); const disposedSnapshots = f.states.length;
  current.open(); current.receive({type: 'room', room: room()}); f.event('vera-native-network'); await flush();
  assert.equal(f.states.length, disposedSnapshots); assert.equal(f.timers.size, 0);
});

test('a confirmed finished snapshot publishes once while preserving native result and return semantics', async t => {
  const f = fixture(t), socket = await f.start(); socket.receive(result()); f.event('vera-native-network-service');
  assert.equal(f.current.phase, 'finished'); assert.equal(f.current.open, false); const snapshots = f.states.length;
  f.event('vera-native-network-service'); f.event('vera-native-network-service'); assert.equal(f.states.length, snapshots);
  await f.controller.dispatch('returnMenu'); assert.deepEqual(f.calls.at(-1), ['leave', 'MATCH-1']);
  f.event('vera-native-network-return'); assert.equal(f.current.phase, 'entry'); assert.equal(f.current.matchId, null); assert.equal(f.current.open, false);
});
