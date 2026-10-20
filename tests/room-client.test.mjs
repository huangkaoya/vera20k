import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
mkdirSync('.build/tests', { recursive: true });
await build({ entryPoints: ['web/src/network/RoomClient.ts'], outfile: '.build/tests/room-client.mjs', bundle: true, platform: 'node', format: 'esm' });
const { RoomClient } = await import(pathToFileURL(process.cwd() + '/.build/tests/room-client.mjs').href);

function fixture(t, overrides = {}) {
  const savedSocket = globalThis.WebSocket, sockets = [], events = [];
  class FakeSocket {
    static OPEN = 1;
    readyState = 0;
    sent = [];
    constructor() { sockets.push(this); }
    send(value) { this.sent.push(JSON.parse(value)); }
    close() { this.readyState = 3; }
  }
  globalThis.WebSocket = FakeSocket;
  t.after(() => { globalThis.WebSocket = savedSocket; });
  const client = new RoomClient({
    onRoom: value => events.push(['room', value]),
    onStart: value => events.push(['start', value]),
    onReady: value => events.push(['ready', value]),
    onTurn: value => events.push(['turn', value]),
    onStop: value => events.push(['stop', value]),
    onError: value => events.push(['error', value]),
    ...overrides,
  }, 'ws://127.0.0.1:5280/ws/rooms');
  const open = async () => { const connected = client.connect(), socket = sockets.at(-1); socket.readyState = 1; socket.onopen(); await connected; return socket; };
  const receive = (socket, message) => socket.onmessage({ data: JSON.stringify(message) });
  t.after(() => client.close());
  return { client, sockets, events, open, receive };
}

test('RoomClient ignores stale socket open/message/error/close after reconnect and intentional close', async t => {
  const { client, sockets, events, open, receive } = fixture(t);
  const first = client.connect().catch(error => error.message), stale = sockets[0];
  client.close(); stale.onopen(); stale.onclose();
  assert.match(await first, /关闭|断开/); assert.deepEqual(events, []);
  const current = await open();
  receive(stale, { type: 'start', config: {}, playerIndex: 0, roomCode: 'OLD' });
  receive(stale, { type: 'turn', tick: 1, commands: [] });
  receive(stale, { type: 'room', room: { code: 'OLD' } });
  stale.onclose(); stale.onerror();
  assert.equal(client.connected, true); assert.deepEqual(events, []);
  receive(current, { type: 'room', room: { code: 'CURRENT' } });
  assert.equal(client.room.code, 'CURRENT'); assert.equal(events.length, 1);
  client.close(); receive(current, { type: 'ready', tick: 2 }); current.onclose();
  assert.equal(events.length, 1); assert.equal(client.connected, false);
});

test('an old socket close cannot reject a request belonging to the current connection', async t => {
  const { client, events, open, receive } = fixture(t), stale = await open();
  const first = client.create({ playerName: '甲' }).catch(error => error.message);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stale.sent.at(-1).type, 'create');
  client.close(); stale.onclose(); assert.match(await first, /关闭/);
  const current = await open(), joined = client.join('ABCDEF', '乙');
  await new Promise(resolve => setImmediate(resolve));
  const request = current.sent.at(-1); assert.equal(request.type, 'join');
  stale.onclose(); receive(stale, { type: 'error', error: 'old failure' });
  receive(current, { type: 'response', id: request.id, ok: true }); await joined;
  assert.equal(client.connected, true); assert.deepEqual(events, []);
});

test('an active unexpected disconnect clears the room and reports a stopped match', async t => {
  const { client, events, open, receive } = fixture(t), socket = await open();
  receive(socket, { type: 'room', room: { code: 'ACTIVE' } });
  socket.readyState = 3; socket.onclose();
  assert.equal(client.connected, false); assert.equal(client.room, null);
  assert.deepEqual(events.slice(0, 2), [['room', { code: 'ACTIVE' }], ['room', null]]);
  assert.equal(events[2][0], 'stop'); assert.match(events[2][1], /连接已断开/);
});


test('deferred callbacks from a closed socket cannot report errors into a replacement connection', async t => {
  const rejects = [];
  const deferred = () => new Promise((_resolve, reject) => { rejects.push(reject); });
  const { client, events, open, receive } = fixture(t, { onStart: deferred, onTurn: deferred });
  const stale = await open();
  receive(stale, { type: 'start', config: {}, playerIndex: 0, roomCode: 'OLD' });
  receive(stale, { type: 'turn', tick: 1, commands: [] });
  assert.equal(rejects.length, 2);
  client.close(); stale.onclose();
  const current = await open();
  rejects[0](new Error('old start failure')); rejects[1](new Error('old turn failure'));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, [], 'late errors from both old callback types are ignored');
  assert.equal(client.connected, true);
  receive(current, { type: 'turn', tick: 2, commands: [] });
  rejects[2](new Error('current turn failure'));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, [['error', 'current turn failure']], 'current connection failures are still visible');
});
