// Post-deployment HTTP and native-v2 TRANSPORT probe. No engine is loaded or
// simulated: the test receipts/CRC below are deliberately synthetic. A passing
// result does not replace a real two-browser WebGPU battle.
import fs from 'node:fs/promises';
import {createHash, randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import WebSocket from '../node_modules/ws/wrapper.mjs';
import {nativeAssetManifestIdentity} from '../tools/native-build-manifest.mjs';

const TIMEOUT = 20000;
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const equal = (actual, expected, label) => assert.equal(canonical(actual), canonical(expected), label);
const mime = response => response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
const deadline = (promise, label, milliseconds = TIMEOUT) => {
  let timer;
  return Promise.race([promise, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${label}: timed out`)), milliseconds); })])
    .finally(() => clearTimeout(timer));
};

function originArgument() {
  const args = process.argv.slice(2);
  assert.equal(args.length, 1, 'Usage: node deployment/verify-native.mjs --origin=https://example.com');
  assert.ok(args[0].startsWith('--origin='), '--origin=https://... is required');
  const url = new URL(args[0].slice('--origin='.length));
  assert.ok(url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash,
    '--origin must be an HTTPS origin without credentials, path, query or fragment');
  return url.origin;
}

async function smallBody(response, limit, label) {
  assert.ok(response.body, `${label}: response body is missing`);
  const reader = response.body.getReader(), chunks = [];
  let length = 0;
  try {
    for (;;) {
      const {done, value} = await deadline(reader.read(), label);
      if (done) break;
      length += value.byteLength;
      assert.ok(length <= limit, `${label}: response exceeds ${limit} bytes`);
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, length);
  } finally {
    await deadline(reader.cancel().catch(() => {}), `${label} cleanup`, 2000);
    reader.releaseLock();
  }
}

function createHttp(origin) {
  let downloadedBytes = 0;
  const request = (pathname, options = {}) => {
    const url = new URL(pathname, origin);
    assert.equal(url.origin, origin, 'Verification requests must stay on the selected origin');
    return fetch(url, {...options, redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT)});
  };
  return {
    request,
    get downloadedBytes() { return downloadedBytes; },
    async json(pathname) {
      const response = await deadline(request(pathname), pathname);
      if (response.status !== 200 || mime(response) !== 'application/json') {
        await deadline(response.body?.cancel().catch(() => {}), `${pathname} cleanup`, 2000);
        throw new Error(`${pathname}: expected 200 application/json, got ${response.status}`);
      }
      const bytes = await smallBody(response, 256 * 1024, pathname);
      downloadedBytes += bytes.length;
      return JSON.parse(bytes.toString('utf8'));
    },
    async wasmHeader(pathname, entry) {
      const response = await deadline(request(pathname, {headers: {Range: 'bytes=0-7'}}), 'WASM range');
      // Cancel before reading if Range was ignored; never download the WASM.
      if (response.status !== 206) {
        await deadline(response.body?.cancel().catch(() => {}), 'WASM range cleanup', 2000);
        throw new Error(`WASM range: expected 206, got ${response.status}`);
      }
      try {
        assert.equal(mime(response), 'application/wasm', 'WASM range MIME');
        assert.equal(response.headers.get('Content-Range'), `bytes 0-7/${entry.bytes}`, 'WASM range extent');
        assert.equal(response.headers.get('Content-Length'), '8', 'WASM range length');
        assert.equal(response.headers.get('ETag'), `"${entry.sha256}"`, 'WASM range ETag');
        const bytes = await smallBody(response, 8, 'WASM range');
        downloadedBytes += bytes.length;
        assert.deepEqual([...bytes], [0, 97, 115, 109, 1, 0, 0, 0], 'WASM magic/version');
      } finally {
        await deadline(response.body?.cancel().catch(() => {}), 'WASM response cleanup', 2000);
      }
    },
  };
}

async function objectHeads(http, objects) {
  const entries = Object.entries(objects);
  let next = 0;
  const workers = await Promise.allSettled(Array.from({length: Math.min(4, entries.length)}, async () => {
    for (;;) {
      const index = next++;
      if (index >= entries.length) return;
      const [pathname, entry] = entries[index];
      assert.ok(Number.isSafeInteger(entry.bytes) && entry.bytes >= 0 && /^[a-f0-9]{64}$/.test(entry.sha256), `Invalid release object: ${pathname}`);
      const response = await deadline(http.request(`${pathname}?sha256=${entry.sha256}`, {method: 'HEAD'}), `HEAD ${pathname}`);
      assert.equal(response.status, 200, `HEAD ${pathname}: status`);
      assert.equal(response.headers.get('Content-Length'), String(entry.bytes), `HEAD ${pathname}: bytes`);
      assert.equal(response.headers.get('ETag'), `"${entry.sha256}"`, `HEAD ${pathname}: ETag`);
      assert.equal(mime(response), entry.contentType, `HEAD ${pathname}: MIME`);
      assert.equal(response.headers.get('Accept-Ranges'), 'bytes', `HEAD ${pathname}: ranges`);
    }
  }));
  const failure = workers.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
  return {count: entries.length, totalBytes: entries.reduce((sum, [, entry]) => sum + entry.bytes, 0), concurrency: Math.min(4, entries.length)};
}

async function rejectedOrigin(url, origin) {
  const socket = new WebSocket(url, {handshakeTimeout: TIMEOUT, ...(origin ? {origin} : {})});
  let settled = false;
  try {
    await deadline(new Promise((resolve, reject) => {
      socket.once('unexpected-response', (_request, response) => {
        settled = true;
        response.destroy();
        try { assert.equal(response.statusCode, 403, 'Origin rejection must be HTTP 403'); resolve(); }
        catch (error) { reject(error); }
      });
      socket.once('open', () => { settled = true; reject(new Error('WebSocket accepted a missing or foreign Origin')); });
      socket.on('error', error => { if (!settled) reject(error); });
    }), 'WebSocket Origin rejection');
  } finally {
    socket.terminate();
  }
}

class ProbePeer {
  constructor(url, origin, label) {
    this.label = label; this.inbox = []; this.waiters = new Set(); this.closing = false;
    this.socket = new WebSocket(url, {origin, handshakeTimeout: TIMEOUT, maxPayload: 262144, followRedirects: false});
    this.opened = deadline(new Promise((resolve, reject) => {
      this.socket.once('open', resolve);
      this.socket.once('error', reject);
      this.socket.once('close', () => reject(new Error(`${label}: closed before open`)));
    }), `${label} open`);
    this.socket.on('message', (bytes, binary) => {
      try {
        assert.equal(binary, false, `${label}: JSON messages required`);
        const message = JSON.parse(bytes.toString());
        assert.equal(typeof message?.type, 'string', `${label}: invalid message`);
        let matched = false;
        for (const waiter of [...this.waiters]) {
          if (message.type === waiter.type && waiter.predicate(message)) {
            matched = true; this.waiters.delete(waiter); clearTimeout(waiter.timer); waiter.resolve(message);
          }
        }
        if (!matched && ['error', 'stopped'].includes(message.type)) throw new Error(`${label}: unexpected native ${message.type}`);
        if (!matched) this.inbox.push(message);
      } catch (error) { this.fail(error); }
    });
    this.socket.on('error', () => this.fail(new Error(`${label}: socket error`)));
    this.socket.on('close', () => this.fail(new Error(`${label}: socket closed`)));
  }
  fail(error) {
    if (this.closing) return;
    this.failure ??= error;
    for (const waiter of this.waiters) { clearTimeout(waiter.timer); waiter.reject(error); }
    this.waiters.clear();
  }
  wait(type, predicate = () => true) {
    if (this.failure) return Promise.reject(this.failure);
    const index = this.inbox.findIndex(message => message.type === type && predicate(message));
    if (index >= 0) return Promise.resolve(this.inbox.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = {type, predicate, resolve, reject};
      waiter.timer = setTimeout(() => { this.waiters.delete(waiter); reject(new Error(`${this.label}: waiting for ${type} timed out`)); }, TIMEOUT);
      this.waiters.add(waiter);
    });
  }
  send(message) {
    if (this.failure) throw this.failure;
    assert.equal(this.socket.readyState, WebSocket.OPEN, `${this.label}: socket is not open`);
    this.socket.send(JSON.stringify(message));
  }
  async close() {
    this.closing = true;
    for (const waiter of this.waiters) { clearTimeout(waiter.timer); waiter.reject(new Error('Probe cleanup')); }
    this.waiters.clear();
    if (this.socket.readyState === WebSocket.CLOSED) return;
    const closed = new Promise(resolve => this.socket.once('close', resolve));
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({type: 'leave'}));
      this.socket.close(1000, 'Transport probe complete');
    } else this.socket.terminate();
    try { await deadline(closed, `${this.label} close`, 3000); }
    finally { this.socket.terminate(); }
  }
}

async function transportProbe(origin, release) {
  const url = new URL('/ws/native', origin); url.protocol = 'wss:';
  await rejectedOrigin(url, undefined);
  await rejectedOrigin(url, 'https://native-transport-probe.invalid');
  const peers = [];
  try {
    const host = new ProbePeer(url, origin, 'probe host'), guest = new ProbePeer(url, origin, 'probe guest');
    peers.push(host, guest);
    await Promise.all(peers.map(peer => peer.opened));
    const hellos = await Promise.all(peers.map(peer => peer.wait('hello')));
    hellos.forEach(message => assert.equal(message.protocol, 2, 'Native protocol'));
    assert.notEqual(hellos[0].playerId, hellos[1].playerId, 'Distinct server-assigned probe identities');
    peers.forEach(peer => peer.send({type: 'hello', protocol: 2, playerId: randomUUID()}));
    const suffix = randomUUID().slice(0, 8);
    host.send({type: 'create', name: `ProbeHost-${suffix}`, config: {map: 'XMP29U2.MAP', seed: 0x56455241}});
    const room = (await host.wait('room', message => message.room?.isHost && message.room.members.length === 1)).room;
    assert.ok(typeof room.code === 'string' && room.code.length > 0, 'Probe room code');
    guest.send({type: 'join', code: room.code, name: `ProbeGuest-${suffix}`});
    await guest.wait('room', message => message.room?.code === room.code && message.room.members.length === 2);
    guest.send({type: 'ready'});
    await host.wait('room', message => message.room?.code === room.code && message.room.canStart);
    host.send({type: 'start'});
    const starts = await Promise.all(peers.map(peer => peer.wait('start'))), [start] = starts;
    assert.equal(start.playerIndex, 0, 'Host source index'); assert.equal(starts[1].playerIndex, 1, 'Guest source index');
    assert.equal(starts[1].matchId, start.matchId, 'Shared probe match');
    equal(starts[1].config, start.config, 'Authoritative shared launch config');
    peers.forEach(peer => peer.send({type: 'progress', matchId: start.matchId, percent: 100}));
    await Promise.all(peers.flatMap(peer => [0, 1].map(source => peer.wait('progress', message => message.matchId === start.matchId && message.source === source && message.percent === 100))));
    const initialTick = 100;
    // These receipts describe no actual engine. Both sources use an isolated
    // test build and fixed owners; empty commands never mutate a real room.
    peers.forEach((peer, index) => peer.send({type: 'loaded', matchId: start.matchId, tick: initialTick,
      hash: `transport-probe-local-${index}`, owners: [0, 1], build: 'native-transport-probe-v2',
      resourceManifest: release.build.resourceManifestSha256}));
    const ready = await Promise.all(peers.map(peer => peer.wait('ready', message => message.matchId === start.matchId)));
    ready.forEach(message => { assert.equal(message.tick, initialTick + 1, 'First probe turn'); assert.equal(message.bootstrap, start.matchId, 'Launch receipt'); });
    peers.forEach(peer => peer.send({type: 'input', matchId: start.matchId, tick: initialTick + 1, prevHash: `launch:${start.matchId}`, commands: []}));
    const turns = await Promise.all(peers.map(peer => peer.wait('turn', message => message.matchId === start.matchId)));
    turns.forEach(turn => { assert.equal(turn.tick, initialTick + 1, 'Ordered probe turn'); equal(turn.commands, [], 'Empty probe turn'); });
    const result = {type: 'finished', matchId: start.matchId, tick: initialTick + 1, checksum: 'retail:100:00000000'};
    peers.forEach(peer => peer.send(result));
    const finished = await Promise.all(peers.map(peer => peer.wait('finished', message => message.matchId === start.matchId)));
    finished.forEach(message => equal(message, result, 'Matching synthetic result ACK'));
    await Promise.all(peers.map(peer => peer.wait('room', message => message.room === null)));
    const rejectedJoin = host.wait('error');
    rejectedJoin.catch(() => {});
    host.send({type: 'join', code: room.code, name: `ProbeHost-${suffix}`});
    assert.match((await rejectedJoin).error, /找不到可加入的房间/, 'Old probe room is no longer joinable');
    host.send({type: 'create', name: `ProbeNext-${suffix}`});
    const next = await host.wait('room', message => message.room?.isHost && message.room.code !== room.code);
    assert.equal(next.room.phase, 'lobby', 'Probe can reenter a fresh lobby');
    const leaving = Promise.all([host.wait('stopped', message => message.matchId === null), host.wait('room', message => message.room === null)]);
    leaving.catch(() => {});
    host.send({type: 'leave'}); await leaving;
    return {scope: 'transport-only; synthetic receipts and CRC; no engine gameplay',
      missingOriginRejected: true, foreignOriginRejected: true, peers: 2, orderedEmptyTurns: 1,
      matchingFinishedAck: true, clientsDetached: true, oldRoomJoinRejected: true, freshRoomCreatedAndRemoved: true};
  } finally {
    const cleanup = await Promise.allSettled(peers.map(peer => peer.close()));
    const failure = cleanup.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
  }
}

const report = {ok: false, scope: 'published HTTP assets and native-v2 transport probe', engineGameplayVerified: false, checks: {}};
let stage = 'arguments';
try {
  const origin = originArgument(); report.origin = origin;
  stage = 'local-release';
  const raw = await deadline(fs.readFile(new URL('./generated/release.json', import.meta.url)), 'Read local release');
  const release = JSON.parse(raw.toString('utf8'));
  assert.equal(release.schema, 1, 'Release schema');
  const resourceIdentity = nativeAssetManifestIdentity(release.resources);
  assert.equal(resourceIdentity, release.build.resourceManifestSha256, 'Local canonical resource identity');
  assert.equal(release.resources.identity, resourceIdentity, 'Local resource receipt');
  assert.equal(Object.keys(release.objects).length, release.resources.files.length + 1, 'Release object coverage');
  const wasm = release.objects['/native/vera20k_bg.wasm']; assert.ok(wasm, 'Release WASM object');
  report.releaseSha256 = createHash('sha256').update(raw).digest('hex');
  const http = createHttp(origin);
  stage = 'health';
  const health = await http.json('/api/health');
  assert.ok(health.ok && health.app === 'werhd-vera-native' && health.protocol === 2, 'Native service health/protocol');
  assert.equal(health.patchSha256, release.build.patchSha256, 'Published native patch');
  assert.equal(health.resourceManifestSha256, resourceIdentity, 'Published native resources');
  report.checks.health = true;
  stage = 'build'; equal(await http.json('/native/build.json'), release.build, 'Published build identity'); report.checks.build = true;
  stage = 'resources';
  const resources = await http.json('/api/native/resources');
  assert.equal(nativeAssetManifestIdentity(resources), resourceIdentity, 'Published canonical resource identity');
  assert.equal(resources.identity, resourceIdentity, 'Published resource identity receipt');
  assert.equal(resources.totalBytes, release.resources.totalBytes, 'Published resource total');
  equal(resources, release.resources, 'Published resource URLs and manifest');
  report.checks.resourceManifest = true;
  stage = 'object-heads'; report.checks.objectHeads = await objectHeads(http, release.objects);
  stage = 'wasm-range'; await http.wasmHeader('/native/vera20k_bg.wasm', wasm); report.checks.wasmHeader = true;
  report.httpBodyBytes = http.downloadedBytes;
  stage = 'websocket-transport'; report.checks.webSocket = await transportProbe(origin, release);
  report.ok = true;
} catch (error) {
  report.stage = stage;
  report.error = (error instanceof Error ? error.message : String(error)).split('\n')[0].slice(0, 400);
  process.exitCode = 1;
}
console.log(JSON.stringify(report));
