import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocket } from 'ws';
import { attachRooms } from '../tools/rooms.mjs';

function config() {
  return { mapId: 'TWO.MAP', seed: 42, localHouse: 0, playerName: '房主', credits: 10000, unitCount: 0, gameSpeed: 3,
    shortGame: true, superWeapons: true, mcvRepacks: true, cratesAppear: false, buildOffAlly: true,
    slots: Array.from({ length: 8 }, (_, id) => ({ id, kind: id === 0 ? 'human' : id === 1 ? 'ai' : 'closed', country: 'America', color: id < 2 ? id : -2, start: -2, team: -2, difficulty: 'normal' })),
  };
}
async function harness(t) {
  const server = http.createServer((_req, res) => res.end('rooms test'));
  const rooms = attachRooms(server, { getMapLimit: () => 2, loadingTimeoutMs: 5000, turnTimeoutMs: 5000 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const peers = [];
  t.after(async () => { for (const peer of peers) peer.ws.terminate(); await rooms.close(); await new Promise(resolve => server.close(resolve)); });
  async function peer() {
    const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws/rooms`), messages = [], waiters = [];
    ws.on('message', bytes => {
      const message = JSON.parse(bytes.toString());
      const index = waiters.findIndex(waiter => waiter.match(message));
      if (index < 0) messages.push(message);
      else { const [{ resolve, timer }] = waiters.splice(index, 1); clearTimeout(timer); resolve(message); }
    });
    const wait = (type, predicate = () => true) => {
      const match = message => message.type === type && predicate(message);
      const index = messages.findIndex(match); if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { match, resolve, timer: setTimeout(() => { const index = waiters.indexOf(waiter); if (index >= 0) waiters.splice(index, 1); reject(new Error(`Missing ${type} event; queued ${JSON.stringify(messages)}`)); }, 2000) };
        waiters.push(waiter);
      });
    };
    let id = 0;
    const result = { ws, messages, wait, send(type, fields = {}) { ws.send(JSON.stringify({ type, ...fields })); },
      async request(type, fields = {}) { const requestId = ++id; ws.send(JSON.stringify({ type, id: requestId, ...fields })); return wait('response', message => message.id === requestId); },
    };
    peers.push(result); await wait('hello'); return result;
  }
  const host = await peer(), guest = await peer();
  assert.equal((await host.request('create', { config: config() })).ok, true);
  const initial = (await host.wait('room')).room;
  assert.equal((await guest.request('join', { code: initial.code.toLowerCase(), name: '朋友' })).ok, true);
  await guest.wait('room'); await host.wait('room');
  return { rooms, host, guest, peer, code: initial.code };
}
async function start(h) {
  assert.equal((await h.guest.request('ready')).ok, true);
  assert.equal((await h.host.request('start')).ok, true);
  const hostStart = await h.host.wait('start'), guestStart = await h.guest.wait('start');
  return { hostStart, guestStart };
}
async function loaded(h) {
  h.host.send('loaded', { hash: 'abc123', tick: 0 }); h.guest.send('loaded', { hash: 'abc123', tick: 0 });
  assert.equal((await h.host.wait('ready')).tick, 1); assert.equal((await h.guest.wait('ready')).tick, 1);
}

test('real WebSocket room uses a loaded barrier and ordered player-bound lockstep commands', async t => {
  const h = await harness(t), { hostStart, guestStart } = await start(h);
  assert.equal(hostStart.playerIndex, 0); assert.equal(guestStart.playerIndex, 1);
  assert.deepEqual(hostStart.config, guestStart.config);
  assert.equal(hostStart.config.slots[1].kind, 'human'); assert.equal(hostStart.config.slots[1].name, '朋友');
  h.host.send('loaded', { hash: 'abc123', tick: 0 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.host.messages.some(message => message.type === 'ready'), false, 'one loaded player cannot start simulation');
  h.guest.send('loaded', { hash: 'abc123', tick: 0 }); await h.host.wait('ready'); await h.guest.wait('ready');
  h.guest.send('input', { tick: 1, prevHash: 'abc123', commands: [{ kind: 'move', player: 999, entityIds: [44], rx: 12, ry: 13 }] });
  h.host.send('input', { tick: 1, prevHash: 'abc123', commands: [{ kind: 'deploy', player: 999, entityId: 7 }] });
  const a = await h.host.wait('turn'), b = await h.guest.wait('turn');
  assert.deepEqual(a, b); assert.equal(a.tick, 1);
  assert.deepEqual(a.commands.map(command => [command.kind, command.player]), [['deploy', 0], ['move', 1]]);
  h.host.send('input', { tick: 2, prevHash: 'def456', commands: [] });
  h.guest.send('input', { tick: 2, prevHash: 'def456', commands: [] });
  assert.deepEqual((await h.host.wait('turn')).commands, []);
});

test('host cannot start until every guest is ready and a guest cannot change room rules', async t => {
  const h = await harness(t);
  assert.equal((await h.host.request('start')).ok, false);
  assert.equal((await h.guest.request('config', { config: config() })).ok, false);
  assert.equal((await h.guest.request('start')).ok, false);
  await start(h);
});

test('initial state hash disagreement stops the room before inputs can run', async t => {
  const h = await harness(t); await start(h);
  h.host.send('loaded', { hash: 'abc123', tick: 0 }); h.guest.send('loaded', { hash: 'different', tick: 0 });
  assert.match((await h.host.wait('stopped')).reason, /初始.*校验不一致/);
  await h.guest.wait('stopped'); assert.equal(h.rooms.roomCount, 0);
});

test('preceding state hash disagreement stops instead of advancing another turn', async t => {
  const h = await harness(t); await start(h); await loaded(h);
  h.host.send('input', { tick: 1, prevHash: 'abc123', commands: [] }); h.guest.send('input', { tick: 1, prevHash: 'wrong', commands: [] });
  assert.match((await h.host.wait('stopped')).reason, /第 1 帧.*校验不一致/);
  assert.equal(h.rooms.roomCount, 0);
});

test('a disconnected human stops the running room for the remaining human', async t => {
  const h = await harness(t); await start(h); await loaded(h); h.guest.ws.close();
  assert.match((await h.host.wait('stopped')).reason, /玩家离开/); assert.equal(h.rooms.roomCount, 0);
});

test('map spawn capacity limits joins and changing host options clears guest readiness', async t => {
  const h = await harness(t), extra = await h.peer();
  assert.equal((await extra.request('join', { code: h.code, name: '第三位' })).ok, false);
  await h.guest.request('ready'); const updated = config(); updated.credits = 20000;
  assert.equal((await h.host.request('config', { config: updated })).ok, true);
  const changed = await h.guest.wait('room', message => message.room?.config.credits === 20000);
  assert.equal(changed.room.members.find(member => !member.host).ready, false);
  assert.equal(changed.room.config.slots[1].kind, 'human');
});

test('shared retail policy and production HTTP expose only approved immutable local resources', async t => {
  const { promises: fs } = await import('node:fs');
  const path = await import('node:path');
  const { createHash } = await import('node:crypto');
  const { createResourceIndex, createDevServer, isPublicRetailFile } = await import('../tools/dev-server.mjs');
  const base = await fs.mkdtemp(path.resolve('.build/retail-http-test-'));
  const assets = path.join(base, 'assets'), dist = path.join(base, 'dist');
  await fs.mkdir(assets); await fs.mkdir(dist);
  const original = Buffer.from('retail-bytes-for-http-integrity-test');
  await fs.writeFile(path.join(assets, 'ra2.mix'), original);
  await fs.writeFile(path.join(assets, 'rulesmd.ini'), '[General]\nTest=1\n');
  for (const name of ['RA2MD.INI', 'keyboard.ini', 'keyboardmd.ini', 'movmd03.mix', 'thememd.mix']) await fs.writeFile(path.join(assets, name), 'private or media');
  await fs.mkdir(path.join(assets, 'profile')); await fs.writeFile(path.join(assets, 'profile', 'player.ini'), 'private');
  await fs.writeFile(path.join(dist, 'index.html'), '<title>王二火大</title>');
  await fs.writeFile(path.join(dist, 'core.wasm'), Buffer.from([0, 97, 115, 109]));
  t.after(async () => { await fs.rm(base, { recursive: true, force: true }); });
  assert.equal(isPublicRetailFile('../ra2.mix'), false); assert.equal(isPublicRetailFile('RA2MD.INI'), false);
  const index = await createResourceIndex(assets);
  assert.deepEqual(index.manifest.files.map(file => file.name), ['ra2.mix', 'rulesmd.ini']);
  assert.equal(index.manifest.files[0].sha256, createHash('sha256').update(original).digest('hex'));
  const app = await createDevServer({ port: 0, assetRoot: assets, production: true, distDir: path.relative(process.cwd(), dist) });
  t.after(() => app.close());
  const health = await (await fetch(app.url + '/api/health')).json(); assert.equal(health.ok, true);
  const manifest = await (await fetch(app.url + '/api/resources')).json(); assert.equal(manifest.files.length, 2);
  assert.equal((await fetch(app.url + '/retail/RA2MD.INI')).status, 404);
  assert.equal((await fetch(app.url + '/retail/profile%2Fplayer.ini')).status, 404);
  assert.equal((await fetch(app.url + '/retail/movmd03.mix')).status, 404);
  const full = await fetch(app.url + '/retail/ra2.mix'); assert.equal(full.status, 200); assert.deepEqual(Buffer.from(await full.arrayBuffer()), original);
  const partial = await fetch(app.url + '/retail/ra2.mix', { headers: { Range: 'bytes=7-11' } });
  assert.equal(partial.status, 206); assert.equal(await partial.text(), original.subarray(7, 12).toString());
  const head = await fetch(app.url + '/retail/ra2.mix', { method: 'HEAD' }); assert.equal(Number(head.headers.get('content-length')), original.length);
  assert.equal((await fetch(app.url + '/core.wasm')).headers.get('content-type'), 'application/wasm');
  assert.match(await (await fetch(app.url + '/')).text(), /王二火大/);
  assert.deepEqual(await fs.readFile(path.join(assets, 'ra2.mix')), original, 'read-only streaming leaves the source bytes intact');
});
