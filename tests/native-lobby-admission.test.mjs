import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {setMaxListeners} from 'node:events';
import {WebSocket} from 'ws';
import {installNativeLobby} from '../web-native/lobby.js';
import {attachNativeMultiplayer} from '../tools/services/native-websocket.mjs';
import {NATIVE_ROOM_ROUTING} from '../tools/services/native-room-routing.mjs';

// Admission only: the actual browser controller talks to the real local WS
// adapter/coordinators. No WASM, world state, turns or renderer are simulated.
async function waitFor(predicate, label, timeoutMs = 10000) {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function fixture(t) {
  const server = http.createServer();
  const transport = attachNativeMultiplayer(server, {allowedOrigins: []});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  transport.allowOrigin(origin);
  const saved = new Map(), sockets = [], clients = [];
  const replace = (name, value) => {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {configurable: true, writable: true, value});
  };
  const window = new EventTarget(), document = new EventTarget();
  setMaxListeners(0, window, document);
  Object.assign(document, {
    hidden: false,
    createElement() { throw new Error('admission must not create a DOM overlay'); },
  });
  const storage = () => {
    const values = new Map();
    return {getItem: key => values.get(key), setItem: (key, value) => values.set(key, value)};
  };
  class SameOriginWebSocket extends WebSocket {
    constructor(address) {
      super(address, {origin});
      sockets.push(this);
    }
  }
  for (const [name, value] of Object.entries({
    window, document, WebSocket: SameOriginWebSocket, location: {href: origin + '/'},
    sessionStorage: storage(), localStorage: storage(),
  })) replace(name, value);

  const dispose = () => { for (const client of clients) client.controller.dispose(); };
  t.after(async () => {
    dispose();
    try {
      await transport.close();
      await new Promise(resolve => server.close(resolve));
    } finally {
      for (const [name, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    }
  });

  function client() {
    const value = {state: null};
    const native = {
      network_status: () => ({phase: 'idle'}),
      network_drain_outbox: () => '[]',
      network_start() { throw new Error('admission must not start a game'); },
      network_receive() { throw new Error('admission must not deliver simulation messages'); },
      network_leave() { throw new Error('admission has no active match to leave'); },
    };
    value.controller = installNativeLobby({
      native, canvas: {dataset: {}, focus() {}}, onState: state => { value.state = state; },
    });
    clients.push(value);
    return value;
  }
  const rooms = () => [...transport.coordinators.values()].flatMap(value => [...value.rooms.values()]);
  const connected = () => [...transport.coordinators.values()].reduce((total, value) => total + value.clients.size, 0);
  async function assertClean() {
    dispose();
    await waitFor(() => rooms().length === 0 && connected() === 0
      && transport.wss.clients.size === 0 && sockets.every(socket => socket.readyState === WebSocket.CLOSED),
    'all controllers and rejected attempts release rooms and connections');
    assert.equal(rooms().length, 0);
    assert.equal(connected(), 0);
  }
  return {transport, sockets, client, rooms, connected, assertClean};
}

async function admitted(clients, members, label) {
  await waitFor(() => {
    const rejected = clients.find(client => client.state.error && !client.state.busy && !client.state.room);
    assert.equal(rejected?.state.error, undefined, `${label}: ${rejected?.state.error}`);
    return clients.every(client => client.state.room?.members.length === members && !client.state.busy);
  }, label);
}

test('100 real lobby controllers randomly create 50 rooms, join by actual codes and release admission state', async t => {
  const f = await fixture(t);
  const hosts = Array.from({length: 50}, () => f.client());
  const guests = Array.from({length: 50}, () => f.client());
  await Promise.all([...hosts, ...guests].map(client => client.controller.dispatch('open')));

  // Deliberately use the controller's ordinary random selection and bounded
  // capacity retries. The test never assigns or balances a host's shard.
  await Promise.all(hosts.map((client, index) => client.controller.dispatch({action: 'create', name: `Host ${index}`})));
  await admitted(hosts, 1, 'all 50 hosts receive their authoritative room');
  await waitFor(() => f.connected() === 50, 'capacity retries release rejected host connections');
  const codes = hosts.map(client => client.state.room.code);
  assert.equal(new Set(codes).size, 50, 'every host owns one distinct room');
  assert.equal(f.rooms().length, 50, 'retries never leave duplicate or orphan rooms');
  assert.ok(codes.every(code => /^S[0-7][0-9A-F]{5}$/.test(code)));

  await Promise.all(guests.map((client, index) => client.controller.dispatch({
    action: 'join', name: `Guest ${index}`, code: codes[index],
  })));
  await admitted([...hosts, ...guests], 2, 'all 100 members enter their intended rooms');
  assert.equal(f.connected(), 100);
  assert.equal(f.rooms().length, 50);
  assert.equal(new Set(f.rooms().flatMap(room => room.members.map(member => member.id))).size, 100);
  for (let index = 0; index < hosts.length; index++) {
    assert.equal(hosts[index].state.room.code, codes[index]);
    assert.equal(guests[index].state.room.code, codes[index]);
    assert.equal(hosts[index].state.room.isHost, true);
    assert.equal(guests[index].state.room.isHost, false);
    assert.deepEqual(hosts[index].state.room.members, guests[index].state.room.members);
  }
  for (const [shard, coordinator] of f.transport.coordinators) {
    if (shard === null) {
      assert.equal(coordinator.rooms.size, 0);
      assert.equal(coordinator.clients.size, 0);
    } else {
      assert.ok(coordinator.rooms.size <= NATIVE_ROOM_ROUTING.maxRoomsPerShard);
      assert.ok(coordinator.clients.size <= NATIVE_ROOM_ROUTING.maxClientsPerShard);
      assert.equal(coordinator.clients.size, coordinator.rooms.size * 2);
    }
  }
  await f.assertClean();
});

test('a real room-capacity rejection moves create to the next shard without leaving a duplicate room or socket', async t => {
  const f = await fixture(t), originalRandom = Math.random;
  t.after(() => { Math.random = originalRandom; });
  Math.random = () => 0;
  const hosts = [];
  for (let index = 0; index < 8; index++) {
    const host = f.client(); hosts.push(host);
    await host.controller.dispatch('open');
    await host.controller.dispatch({action: 'create', name: `Hotspot ${index}`});
    await admitted([host], 1, 'hotspot host acknowledged');
    assert.match(host.state.room.code, /^S0[0-9A-F]{5}$/);
  }
  const priorSockets = f.sockets.length, overflow = f.client(); hosts.push(overflow);
  await overflow.controller.dispatch('open');
  await overflow.controller.dispatch({action: 'create', name: 'Capacity fallback'});
  await admitted([overflow], 1, 'overflow host acknowledged on another shard');
  Math.random = originalRandom;
  assert.match(overflow.state.room.code, /^S1[0-9A-F]{5}$/);
  assert.deepEqual(f.sockets.slice(priorSockets).map(socket => new URL(socket.url).searchParams.get('shard')), ['0', '1']);
  await waitFor(() => f.connected() === 9 && f.sockets[priorSockets].readyState === WebSocket.CLOSED,
    'rejected capacity attempt closes');
  assert.equal(f.rooms().length, 9);
  assert.equal(new Set(hosts.map(host => host.state.room.code)).size, 9);
  await f.assertClean();
});

test('a failed real join releases its unassigned socket without disposing the controller', async t => {
  const f = await fixture(t), guest = f.client();
  await guest.controller.dispatch('open');
  await guest.controller.dispatch({action: 'join', name: 'Missing room', code: 'S7FFFFF'});
  await waitFor(() => Boolean(guest.state.error) && !guest.state.busy, 'failed join is shown');
  assert.match(guest.state.error, /找不到/);
  assert.equal(guest.state.room, null);
  await waitFor(() => f.connected() === 0 && f.sockets.every(socket => socket.readyState === WebSocket.CLOSED),
    'failed join releases the unassigned connection');
  assert.equal(guest.state.connected, false);
  assert.equal(guest.state.open, true, 'the native entry remains available for another attempt');
  assert.equal(f.rooms().length, 0);
  await f.assertClean();
});
