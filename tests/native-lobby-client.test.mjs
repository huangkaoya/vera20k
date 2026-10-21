import test from 'node:test';
import assert from 'node:assert/strict';
import {installNativeLobby} from '../web-native/lobby.js';

// Exercise the real lobby's transport/native lifecycle without a renderer or
// browser dependency. Only the DOM operations used by the room view are stubbed.
class Node extends EventTarget {
  children = []; parent = null; style = {}; dataset = {}; hidden = false; ownText = '';
  constructor(tag = '') { super(); this.tag = tag; }
  set textContent(value) { this.ownText = String(value); this.children = []; }
  get textContent() { return this.ownText + this.children.map(child => child.textContent).join(''); }
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  replaceChildren(...nodes) { this.children = []; this.ownText = ''; this.append(...nodes); }
  setAttribute(name, value) { this[name] = value; }
  find(predicate) { if (predicate(this)) return this; for (const child of this.children) { const found = child.find(predicate); if (found) return found; } }
  querySelector() { return this.find(node => node.tag === 'input' || node.tag === 'button'); }
  focus() {}
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); }
  click() { if (!this.disabled) this.dispatchEvent(new Event('click')); }
}
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture(t) {
  const saved = new Map(), sockets = [], calls = [];
  const replace = (name, value) => { saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, {configurable: true, writable: true, value}); };
  const window = new EventTarget(), document = new EventTarget();
  Object.assign(document, {head: new Node('head'), body: new Node('body'), hidden: false,
    createElement: tag => new Node(tag), createTextNode: text => { const node = new Node(); node.textContent = text; return node; }});
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
    setTimeout: () => 1, clearTimeout: () => {}})) replace(name, value);
  let status = {phase: 'idle'}, confirmOnReceive = true, rejectAck = false;
  const native = {
    network_start(raw) { const config = JSON.parse(raw); calls.push(['start', config]); status = {matchId: config.matchId, phase: 'running'}; },
    network_receive(raw) {
      const message = JSON.parse(raw);
      if (message.type === 'finished' && rejectAck) throw new Error('invalid result receipt');
      calls.push(['receive', message]);
      if (message.type === 'finished' && confirmOnReceive) status = {matchId: message.matchId, phase: 'finished', finishedTick: message.tick, hash: message.checksum};
    },
    network_leave(matchId) { calls.push(['leave', matchId]); },
    network_drain_outbox: () => '[]', network_status: () => status,
  };
  const controller = installNativeLobby({native, canvas: new Node('canvas')});
  const shell = document.body.children[0], event = name => window.dispatchEvent(new Event(name));
  const click = text => { const button = shell.find(node => node.tag === 'button' && node.textContent === text); assert.ok(button, text); button.click(); };
  t.after(() => { controller.dispose(); for (const [name, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; } });
  return {shell, calls, sockets, controller, click, event,
    setStatus(value) { status = value; },
    deferAck() { confirmOnReceive = false; }, rejectAck() { rejectAck = true; },
    async start(matchId = 'MATCH-1') {
      controller.open(); click('创建房间'); const socket = sockets.at(-1); socket.open(); await flush();
      socket.receive({type: 'start', matchId, playerIndex: 1, config: {map: 'XMP29U2.MAP'}});
      event('vera-native-network-started'); assert.equal(shell.hidden, true); return socket;
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
  assert.equal(f.shell.hidden, true); assert.equal(stopped(f).length, 0);
});

test('close between ACK delivery and native validation waits for the actual finished phase', async t => {
  const f = fixture(t), socket = await f.start(); f.deferAck();
  f.setStatus({matchId: 'MATCH-1', phase: 'finishing'});
  socket.receive(result()); socket.disconnect(); assert.equal(f.shell.hidden, true);
  f.setStatus({matchId: 'MATCH-1', phase: 'finished', finishedTick: 8340, hash: result().checksum});
  f.event('vera-native-network-service'); assert.equal(f.shell.hidden, true); assert.equal(stopped(f).length, 0);
});

test('an ACK later rejected by native validation still reports failure', async t => {
  const f = fixture(t), socket = await f.start(); f.deferAck();
  socket.receive(result()); socket.disconnect();
  f.setStatus({matchId: 'MATCH-1', phase: 'stopped', error: 'result checksum differs'});
  f.event('vera-native-network-service');
  assert.equal(f.shell.hidden, false); assert.match(f.shell.textContent, /result checksum differs/); assert.equal(stopped(f).length, 1);
});

test('unacknowledged or wrong-match disconnects still stop the live match', async t => {
  const f = fixture(t), socket = await f.start();
  socket.receive(result('OLD-MATCH')); socket.disconnect();
  assert.equal(f.shell.hidden, false); assert.equal(stopped(f).length, 1); assert.equal(stopped(f)[0][1].matchId, 'MATCH-1');
});

test('Continue clears completion and old socket epochs cannot protect a new unfinished match', async t => {
  const f = fixture(t), old = await f.start(); old.receive(result());
  f.event('vera-native-network-return');
  const current = await f.start('MATCH-2');
  old.receive(result()); old.error(); old.disconnect();
  assert.equal(f.shell.hidden, true); assert.equal(stopped(f).length, 0);
  current.disconnect(); assert.equal(f.shell.hidden, false); assert.equal(stopped(f).length, 1);
  assert.equal(stopped(f)[0][1].matchId, 'MATCH-2');
});
