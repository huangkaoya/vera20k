import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createBattleService } from '../tools/services/battle-server.mjs';
import { createLobbyService } from '../tools/services/lobby-server.mjs';

const secret = 'isolated-service-test-secret';
function config() {
  return { mapId: 'TWO.MAP', seed: 42, localHouse: 0, playerName: '房主', credits: 10000, unitCount: 0, gameSpeed: 3,
    shortGame: true, superWeapons: true, mcvRepacks: true, cratesAppear: false, buildOffAlly: true,
    slots: Array.from({ length: 8 }, (_, id) => ({ id, kind: id === 0 ? 'human' : id === 1 ? 'ai' : 'closed', country: 'America', color: id < 2 ? id : -2, start: -2, team: -2, difficulty: 'normal' })),
  };
}
async function setup(t, options = {}) {
  const battle = await createBattleService({ port: 0, serviceSecret: secret, allowedOrigins: ['http://web.local.test'], ...options });
  const lobby = await createLobbyService({ port: 0, serviceSecret: secret, battleUrl: battle.url, allowedOrigins: ['http://web.local.test'], mapLimits: new Map([['TWO.MAP', 2]]) });
  const peers = [];
  t.after(async () => { for (const peer of peers) peer.ws.terminate(); await lobby.close(); await battle.close(); });
  async function peer(url) {
    const ws = new WebSocket(url), messages = [], waiters = [];
    ws.on('error', () => {});
    ws.on('message', bytes => {
      const message = JSON.parse(bytes.toString()), index = waiters.findIndex(waiter => waiter.match(message));
      if (index < 0) messages.push(message);
      else { const [{ resolve, timer }] = waiters.splice(index, 1); clearTimeout(timer); resolve(message); }
    });
    function wait(type, predicate = () => true) {
      const match = message => message.type === type && predicate(message), index = messages.findIndex(match);
      if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { match, resolve, timer: setTimeout(() => { const index = waiters.indexOf(waiter); if (index >= 0) waiters.splice(index, 1); reject(new Error(`Missing ${type}; buffered ${JSON.stringify(messages)}`)); }, 2500) }; waiters.push(waiter);
      });
    }
    let id = 0;
    const value = { ws, wait, messages, send(type, fields = {}) { ws.send(JSON.stringify({ type, ...fields })); },
      async request(type, fields = {}) { const current = ++id; ws.send(JSON.stringify({ type, id: current, ...fields })); return wait('response', message => message.id === current); },
    };
    peers.push(value); await wait('hello'); return value;
  }
  async function handoff() {
    const host = await peer(lobby.wsUrl), guest = await peer(lobby.wsUrl);
    assert.equal((await host.request('create', { config: config() })).ok, true);
    const room = (await host.wait('room')).room;
    assert.equal((await guest.request('join', { code: room.code, name: '朋友' })).ok, true);
    await host.wait('room'); await guest.wait('room');
    await guest.request('ready'); assert.equal((await host.request('start')).ok, true);
    const a = await host.wait('start'), b = await guest.wait('start');
    return { host, guest, a, b };
  }
  async function connectBattle(handoff) {
    const host = await peer(handoff.a.battle.url), guest = await peer(handoff.b.battle.url);
    host.send('join', handoff.a.battle); guest.send('join', handoff.b.battle);
    const a = await host.wait('joined'), b = await guest.wait('joined');
    return { host, guest, a, b };
  }
  return { battle, lobby, peer, handoff, connectBattle };
}
async function ready(peers) {
  peers.host.send('loaded', { hash: 'abc123', tick: 0 }); peers.guest.send('loaded', { hash: 'abc123', tick: 0 });
  assert.equal((await peers.host.wait('ready')).tick, 1); assert.equal((await peers.guest.wait('ready')).tick, 1);
}

test('separate lobby hands off per-human tickets; battle owns loading, ordered player-bound turns and hashes', async t => {
  const s = await setup(t), lobbyPeers = await s.handoff();
  assert.notEqual(s.lobby.url, s.battle.url); assert.equal(lobbyPeers.a.battle.url, s.battle.wsUrl);
  assert.equal(lobbyPeers.a.battle.matchId, lobbyPeers.b.battle.matchId);
  assert.notEqual(lobbyPeers.a.battle.ticket, lobbyPeers.b.battle.ticket);
  assert.equal((await lobbyPeers.host.request('loaded', { hash: 'abc123', tick: 0 })).ok, false, 'lobby no longer accepts battle loading');
  assert.equal((await lobbyPeers.host.request('input', { tick: 1, prevHash: 'abc123', commands: [] })).ok, false, 'lobby no longer accepts battle turns');
  const p = await s.connectBattle(lobbyPeers);
  assert.equal(p.a.playerIndex, 0); assert.equal(p.b.playerIndex, 1); assert.deepEqual(p.a.config, p.b.config);
  const replay = await s.peer(s.battle.wsUrl); replay.send('join', lobbyPeers.a.battle);
  assert.match((await replay.wait('error')).error, /already used.*ticket/);
  const denial = await fetch(`${s.battle.url}/internal/matches/${lobbyPeers.a.battle.matchId}`, { method: 'DELETE' }); assert.equal(denial.status, 401);
  p.host.send('loaded', { hash: 'abc123', tick: 0 });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(p.host.messages.some(message => message.type === 'ready'), false);
  p.guest.send('loaded', { hash: 'abc123', tick: 0 }); await p.host.wait('ready'); await p.guest.wait('ready');
  p.guest.send('input', { tick: 1, prevHash: 'abc123', commands: [{ kind: 'move', player: 999, entityId: 4, rx: 3, ry: 4 }] });
  p.host.send('input', { tick: 1, prevHash: 'abc123', commands: [{ kind: 'deploy', player: 999, entityId: 1 }] });
  const a = await p.host.wait('turn'), b = await p.guest.wait('turn');
  assert.deepEqual(a, b); assert.equal(a.tick, 1);
  assert.deepEqual(a.commands.map(command => [command.kind, command.player]), [['deploy', 0], ['move', 1]]);
  p.host.send('input', { tick: 2, prevHash: 'after-turn', commands: [] }); p.guest.send('input', { tick: 2, prevHash: 'after-turn', commands: [] });
  assert.equal((await p.host.wait('turn')).tick, 2);
  assert.equal(s.lobby.rooms.roomCount, 1); assert.equal(s.battle.matchCount, 1);
});

test('battle initial hash mismatch stops the match and lobby leave cleans retained coordination state', async t => {
  const s = await setup(t), h = await s.handoff(), p = await s.connectBattle(h);
  p.host.send('loaded', { hash: 'first', tick: 0 }); p.guest.send('loaded', { hash: 'different', tick: 0 });
  assert.match((await p.host.wait('stopped')).reason, /初始.*校验不一致/); await p.guest.wait('stopped');
  assert.equal(s.battle.matchCount, 0); assert.equal(s.lobby.rooms.roomCount, 1);
  assert.equal((await h.host.request('leave')).ok, true); assert.equal(s.lobby.rooms.roomCount, 0);
});

test('battle preceding state mismatch never publishes another turn', async t => {
  const s = await setup(t), h = await s.handoff(), p = await s.connectBattle(h); await ready(p);
  p.host.send('input', { tick: 1, prevHash: 'first', commands: [] }); p.guest.send('input', { tick: 1, prevHash: 'wrong', commands: [] });
  assert.match((await p.host.wait('stopped')).reason, /第 1 帧.*校验不一致/); assert.equal(s.battle.matchCount, 0);
  assert.equal(p.host.messages.some(message => message.type === 'turn'), false);
});

test('battle disconnect stops all humans; lobby disconnect independently cancels an allocated match', async t => {
  const s = await setup(t), h = await s.handoff(), p = await s.connectBattle(h); await ready(p);
  p.guest.ws.close(); assert.match((await p.host.wait('stopped')).reason, /断开对战连接/); assert.equal(s.battle.matchCount, 0);
  await h.host.request('leave');
  const second = await s.handoff(), next = await s.connectBattle(second);
  second.host.ws.close(); assert.match((await next.guest.wait('stopped')).reason, /大厅房间已关闭/);
  assert.equal(s.lobby.rooms.roomCount, 0); assert.equal(s.battle.matchCount, 0);
});

test('internal match creation requires backend authorization and public origin restrictions apply to both sockets', async t => {
  const s = await setup(t);
  for (const service of [s.lobby, s.battle]) {
    assert.equal((await fetch(service.url + '/health')).status, 200);
    assert.equal((await fetch(service.url + '/api/health')).status, 200);
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(service.wsUrl, { origin: 'https://unapproved.invalid' });
      const timeout = setTimeout(() => { ws.terminate(); reject(new Error('Origin was not rejected')); }, 1000);
      ws.once('error', () => { clearTimeout(timeout); resolve(); }); ws.once('open', () => { clearTimeout(timeout); ws.terminate(); reject(new Error('Disallowed browser origin connected')); });
    });
  }
  assert.equal((await fetch(s.battle.url + '/internal/matches', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  assert.equal((await fetch(s.battle.url + '/internal/matches', { method: 'POST', headers: { Authorization: 'Bearer incorrect-but-long-secret', 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  const invalid = await fetch(s.battle.url + '/internal/matches', { method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(invalid.status, 400);
  const unauthenticated = await s.peer(s.battle.wsUrl); unauthenticated.send('join', { matchId: 'unknown', ticket: 'unknown' });
  assert.match((await unauthenticated.wait('error')).error, /unavailable/);
});

test('loading and input timeouts stop abandoned independent matches', async t => {
  const s = await setup(t, { loadingTimeoutMs: 140, turnTimeoutMs: 90 });
  const h = await s.handoff(), p = await s.connectBattle(h); p.host.send('loaded', { hash: 'abc123', tick: 0 });
  assert.match((await p.host.wait('stopped')).reason, /战场部署超时/); assert.equal(s.battle.matchCount, 0);
  await h.host.request('leave');
  const h2 = await s.handoff(), p2 = await s.connectBattle(h2); await ready(p2);
  p2.host.send('input', { tick: 1, prevHash: 'abc123', commands: [] });
  assert.match((await p2.host.wait('stopped')).reason, /玩家指令超时/); assert.equal(s.battle.matchCount, 0);
});

test('service factories refuse an absent or short shared backend secret', async () => {
  await assert.rejects(createBattleService({ port: 0 }), /serviceSecret/);
  await assert.rejects(createLobbyService({ port: 0, battleUrl: 'http://127.0.0.1:1', serviceSecret: 'short' }), /serviceSecret/);
});

test('factory public HTTP base paths are retained in lobby and battle WebSocket handoff URLs', async t => {
  const battle = await createBattleService({ port: 0, serviceSecret: secret, publicUrl: 'https://battle.example/vera' });
  const lobby = await createLobbyService({ port: 0, serviceSecret: secret, battleUrl: battle.url, publicUrl: 'https://lobby.example/room-site' });
  t.after(async () => { await lobby.close(); await battle.close(); });
  assert.equal(battle.wsUrl, 'wss://battle.example/vera/ws/battle');
  assert.equal(lobby.wsUrl, 'wss://lobby.example/room-site/ws/rooms');
  const response = await fetch(battle.url + '/internal/matches', { method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ roomCode: 'PREFIX', config: config(), members: [{ id: 'host', playerIndex: 0, name: '甲' }, { id: 'guest', playerIndex: 1, name: '乙' }] }) });
  assert.equal(response.status, 201); const handoff = await response.json();
  assert.equal(handoff.url, 'wss://battle.example/vera/ws/battle');
});
