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
    constructor(url) { this.url = url; sockets.push(this); }
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

const flush = () => new Promise(resolve => setImmediate(resolve));
const splitStart = (matchId = 'MATCH-1') => ({
  type: 'start', roomCode: 'ROOM01', playerIndex: 0, config: { mapId: 'lobby-stale' },
  battle: { url: 'ws://127.0.0.1:5283/ws/battle', matchId, ticket: `ticket-${matchId}` },
});
function openSocket(socket) { socket.readyState = 1; socket.onopen(); }
function joinBattle(receive, socket, matchId = 'MATCH-1', config = { mapId: 'authoritative' }, playerIndex = 1) {
  openSocket(socket);
  receive(socket, { type: 'joined', matchId, roomCode: 'ROOM01', playerIndex, config });
}

test('split client awaits battle joined, uses its authoritative config and routes only battle inputs there', async t => {
  const { client, events, sockets, open, receive } = fixture(t), lobby = await open();
  receive(lobby, { type: 'room', room: { code: 'ROOM01' } });
  receive(lobby, splitStart()); const battle = sockets[1];
  assert.equal(battle.url, 'ws://127.0.0.1:5283/ws/battle');
  assert.equal(events.filter(event => event[0] === 'start').length, 0);
  assert.throws(() => client.loaded('hash0'), /战局尚未连接/);
  openSocket(battle);
  assert.deepEqual(battle.sent, [{ type: 'join', matchId: 'MATCH-1', ticket: 'ticket-MATCH-1' }]);
  assert.equal(events.filter(event => event[0] === 'start').length, 0, 'socket open alone cannot start WASM');
  const authoritative = { mapId: 'XMP03T4.MAP', playerName: '来自对战服务' };
  receive(battle, { type: 'joined', matchId: 'MATCH-1', roomCode: 'ROOM01', playerIndex: 1, config: authoritative });
  await flush();
  const start = events.find(event => event[0] === 'start')[1];
  assert.deepEqual(start.config, authoritative); assert.equal(start.playerIndex, 1); assert.equal(client.playerIndex, 1);
  assert.equal(client.connected, true); assert.equal(client.battleConnected, true); assert.equal(client.room.code, 'ROOM01');
  client.loaded('hash0'); client.submit(1, [{ kind: 'move', rx: 3, ry: 4 }], 'hash0');
  assert.deepEqual(battle.sent.slice(1).map(message => message.type), ['loaded', 'input']);
  assert.equal(lobby.sent.length, 0, 'lobby never receives simulation frames');
  receive(lobby, { type: 'ready', tick: 99 }); receive(lobby, { type: 'turn', tick: 99, commands: [] });
  assert.equal(events.filter(event => ['ready', 'turn'].includes(event[0])).length, 0);
  receive(battle, { type: 'ready', tick: 1 }); receive(battle, { type: 'turn', tick: 1, commands: [] });
  assert.deepEqual(events.slice(-2), [['ready', 1], ['turn', { type: 'turn', tick: 1, commands: [] }]]);
  receive(lobby, { type: 'room', room: { code: 'ROOM01', status: 'playing' } });
  assert.equal(client.room.status, 'playing', 'lobby metadata remains live during battle');
  client.close(); assert.equal(lobby.readyState, 3); assert.equal(battle.readyState, 3);
});

test('closing during split join cancels the handshake and suppresses every late battle callback', async t => {
  const { client, events, sockets, open, receive } = fixture(t), lobby = await open();
  receive(lobby, splitStart()); const battle = sockets[1];
  client.close(); openSocket(battle);
  receive(battle, { type: 'joined', matchId: 'MATCH-1', roomCode: 'ROOM01', playerIndex: 0, config: {} });
  receive(battle, { type: 'ready', tick: 1 }); receive(battle, { type: 'stopped', reason: 'old stop' });
  battle.onerror(); battle.onclose(); await flush();
  assert.deepEqual(events, []); assert.equal(battle.readyState, 3); assert.equal(lobby.readyState, 3);
  const replacement = await open();
  assert.equal(client.connected, true); assert.equal(replacement.url, 'ws://127.0.0.1:5280/ws/rooms');
});

test('unexpected battle disconnect stops once, preserves lobby metadata and cannot leak input onto lobby', async t => {
  const { client, events, sockets, open, receive } = fixture(t), lobby = await open();
  receive(lobby, { type: 'room', room: { code: 'ROOM01' } }); receive(lobby, splitStart());
  const battle = sockets[1]; joinBattle(receive, battle); await flush();
  battle.readyState = 3; battle.onclose(); battle.onerror(); battle.onclose();
  assert.equal(events.filter(event => event[0] === 'stop').length, 1);
  assert.equal(client.connected, true); assert.equal(client.room.code, 'ROOM01'); assert.equal(client.battleConnected, false);
  assert.throws(() => client.submit(1, [], 'hash'), /战局尚未连接/); assert.equal(lobby.sent.length, 0);
});

test('invalid battle joined or ticket rejection never starts a simulation and closes the failed battle', async t => {
  const { client, events, sockets, open, receive } = fixture(t), lobby = await open();
  receive(lobby, splitStart()); const battle = sockets[1]; openSocket(battle);
  receive(battle, { type: 'joined', matchId: 'DIFFERENT', roomCode: 'ROOM01', playerIndex: 0, config: {} });
  await flush();
  assert.equal(events.filter(event => event[0] === 'start').length, 0);
  assert.equal(events.filter(event => event[0] === 'stop').length, 1); assert.equal(battle.readyState, 3);
  assert.equal(client.connected, true);
  receive(lobby, splitStart('MATCH-2')); const next = sockets[2]; openSocket(next);
  receive(next, { type: 'error', error: 'ticket already consumed' }); await flush();
  assert.equal(events.filter(event => event[0] === 'start').length, 0);
  assert.equal(events.filter(event => event[0] === 'stop').length, 2); assert.equal(next.readyState, 3);
});

test('replacement split matches ignore prior joined, frames and deferred callback errors on the same lobby', async t => {
  const rejected = [];
  const { client, events, sockets, open, receive } = fixture(t, {
    onTurn: () => new Promise((_resolve, reject) => rejected.push(reject)),
  });
  const lobby = await open(); receive(lobby, splitStart()); const old = sockets[1];
  joinBattle(receive, old); await flush(); receive(old, { type: 'turn', tick: 1, commands: [] });
  assert.equal(rejected.length, 1);
  receive(lobby, splitStart('MATCH-2')); const current = sockets[2]; joinBattle(receive, current, 'MATCH-2'); await flush();
  const before = events.length;
  receive(old, { type: 'joined', matchId: 'MATCH-1', roomCode: 'ROOM01', playerIndex: 7, config: {} });
  receive(old, { type: 'ready', tick: 99 }); receive(old, { type: 'turn', tick: 99, commands: [] });
  receive(old, { type: 'stopped', reason: 'stale failure' }); old.onclose(); old.onerror();
  rejected[0](new Error('late first-match callback error')); await flush();
  assert.equal(events.length, before); assert.equal(client.playerIndex, 1); assert.equal(client.battleConnected, true);
  client.submit(1, [], 'hash'); assert.equal(current.sent.at(-1).type, 'input');
});

test('legacy start retains single-socket loaded/input compatibility', async t => {
  const { client, open, receive } = fixture(t), socket = await open();
  receive(socket, { type: 'start', config: {}, playerIndex: 0, roomCode: 'LEGACY' });
  client.loaded('hash0'); client.submit(1, [], 'hash0');
  assert.deepEqual(socket.sent.map(message => message.type), ['loaded', 'input']);
});

test('current split turn callback failures stop that battle while stale failures remain isolated', async t => {
  const { client, events, sockets, open, receive } = fixture(t, {
    onTurn: async () => { throw new Error('failed to advance WASM frame'); },
  });
  const lobby = await open(); receive(lobby, splitStart()); const battle = sockets[1];
  joinBattle(receive, battle); await flush(); receive(battle, { type: 'turn', tick: 1, commands: [] }); await flush();
  assert.equal(events.at(-2)[0], 'error'); assert.match(events.at(-2)[1], /WASM frame/);
  assert.deepEqual(events.at(-1), ['stop', 'failed to advance WASM frame']);
  assert.equal(battle.readyState, 3); assert.equal(client.battleConnected, false); assert.equal(client.connected, true);
});

test('a request waiting for connect cannot be sent into a replacement lobby after close', async t => {
  const { client, open } = fixture(t); await open();
  const staleRequest = client.create({ playerName: 'old connection' }).catch(error => error.message);
  client.close(); const replacement = await open();
  assert.match(await staleRequest, /关闭/);
  assert.deepEqual(replacement.sent, [], 'canceled create must not create a room on the replacement socket');
  assert.equal(client.connected, true);
});

test('a synchronous legacy start callback failure is reported for the active match', async t => {
  const { events, open, receive } = fixture(t, { onStart: () => { throw new Error('legacy init failed'); } });
  const socket = await open(); receive(socket, { type: 'start', config: {}, playerIndex: 0, roomCode: 'LEGACY' });
  assert.deepEqual(events, [['error', 'legacy init failed']]);
});
