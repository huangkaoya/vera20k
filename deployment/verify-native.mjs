// Post-deployment HTTP and native-v3 TRANSPORT probe. No engine is loaded or
// simulated: the test receipts/CRC below are deliberately synthetic. A passing
// result does not replace a real two-browser WebGPU battle.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash, randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import WebSocket from '../node_modules/ws/wrapper.mjs';
import {nativeAssetManifestIdentity,nativeContentCatalogIdentity} from '../tools/native-build-manifest.mjs';

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

/** Pure release validation; importing this module never starts an HTTP/WS probe. */
export function validateRelease(release) {
  assert.equal(release?.schema, 1, 'Release schema');
  assert.equal(release.build?.schema, 2, 'Build schema');
  const resources = release.resources;
  assert.equal(resources?.schema, 2, 'Layered content catalog schema');
  assert.equal(resources.defaultProfile, 'skirmish', 'Default content profile');
  const resourceIdentity = nativeAssetManifestIdentity(resources);
  const catalogIdentity = nativeContentCatalogIdentity(resources);
  assert.match(catalogIdentity, /^[a-f0-9]{64}$/, 'Catalog identity format');
  assert.equal(resources.identity, resourceIdentity, 'Local required resource identity');
  assert.equal(resources.catalogIdentity, catalogIdentity, 'Local canonical catalog identity');
  assert.equal(release.catalogIdentity, catalogIdentity, 'Release catalog identity');
  assert.equal(release.build.contentCatalogIdentity, catalogIdentity, 'Build catalog identity');
  assert.equal(release.build.resourceManifestSha256, resourceIdentity, 'Compiled required resources');
  const objects = release.objects;
  assert.ok(objects && typeof objects === 'object' && !Array.isArray(objects), 'Release objects');
  const requiredUrls = new Set();
  function descriptor(url, file, label) {
    assert.equal(typeof url, 'string', `${label}: object URL`);
    assert.ok(url.startsWith('/') && !url.startsWith('//') && !/[?#]/.test(url), `${label}: local immutable object path`);
    assert.ok(Number.isSafeInteger(file?.bytes) && file.bytes >= 0 && /^[a-f0-9]{64}$/.test(file.sha256), `${label}: descriptor`);
    const entry = Object.hasOwn(objects, url) ? objects[url] : null;
    assert.ok(entry, `${label}: release object coverage`);
    assert.equal(entry.bytes, file.bytes, `${label}: release object bytes`);
    assert.equal(entry.sha256, file.sha256, `${label}: release object SHA`);
    assert.equal(typeof entry.contentType, 'string', `${label}: release object MIME`);
    requiredUrls.add(url);
    return entry;
  }
  function fileDescriptor(file, label) {
    nativeAssetManifestIdentity({files: [file]});
    assert.equal(file.url, `/content/objects/${file.sha256}`, `${label}: content-addressed raw URL`);
    descriptor(file.url, file, `${label} raw`);
    if (file.download) {
      assert.ok(['gzip', 'identity'].includes(file.download.encoding), `${label}: transfer encoding`);
      assert.equal(file.download.url, `/content/objects/${file.download.sha256}`, `${label}: content-addressed transfer URL`);
      descriptor(file.download.url, file.download, `${label} transfer`);
      if (file.download.encoding === 'identity') {
        assert.equal(file.download.sha256, file.sha256, `${label}: identity transfer SHA`);
        assert.equal(file.download.bytes, file.bytes, `${label}: identity transfer bytes`);
      }
    }
  }
  function group(group, label) {
    assert.ok(Array.isArray(group?.files), `${label}: files`);
    nativeAssetManifestIdentity(group);
    group.files.forEach((file, index) => fileDescriptor(file, `${label} file ${index}`));
    assert.equal(group.totalBytes, group.files.reduce((sum, file) => sum + file.bytes, 0), `${label}: total bytes`);
    assert.equal(group.downloadBytes, group.files.reduce((sum, file) => sum + (file.download?.bytes ?? file.bytes), 0), `${label}: transfer bytes`);
  }
  const profiles = resources.profiles;
  assert.ok(profiles?.skirmish && profiles?.full, 'Default and full content profiles');
  for (const [name, profile] of Object.entries(profiles)) {
    group(profile, `Profile ${name}`);
    assert.equal(profile.requiredResourceIdentity, resourceIdentity, `Profile ${name}: shared gameplay identity`);
  }
  assert.equal(nativeAssetManifestIdentity(profiles.skirmish), resourceIdentity, 'Default profile required identity');
  equal(resources.files, profiles.skirmish.files, 'Default manifest file selection');
  assert.equal(resources.totalBytes, profiles.skirmish.totalBytes, 'Default manifest raw size');
  assert.equal(resources.downloadBytes, profiles.skirmish.downloadBytes, 'Default manifest transfer size');
  const packs = resources.packs;
  assert.ok(packs && typeof packs === 'object' && !Array.isArray(packs), 'Optional content packs');
  for (const [name, pack] of Object.entries(packs)) group(pack, `Pack ${name}`);

  const wasmOutput = release.build.outputs?.['vera20k_bg.wasm'];
  const wasm = descriptor('/native/vera20k_bg.wasm', wasmOutput, 'WASM raw');
  assert.ok(wasm.bytes >= 8, 'WASM raw header extent');
  assert.equal(wasm.contentType, 'application/wasm', 'WASM raw object MIME');
  const wasmDownload = wasmOutput.download;
  assert.equal(wasmDownload?.encoding, 'gzip', 'WASM compressed transfer descriptor');
  assert.ok(wasmDownload.bytes >= 10, 'WASM gzip header extent');
  assert.equal(wasmDownload.url, `/content/objects/${wasmDownload.sha256}`, 'WASM transfer object URL');
  assert.equal(descriptor(wasmDownload.url, wasmDownload, 'WASM gzip').contentType, 'application/gzip', 'WASM transfer MIME');
  return {resourceIdentity, catalogIdentity, wasm, wasmDownload,
    coverage: {profiles: Object.fromEntries(Object.entries(profiles).map(([name, profile]) => [name, profile.files.length])),
      packs: Object.fromEntries(Object.entries(packs).map(([name, pack]) => [name, pack.files.length])),
      objects: Object.keys(objects).length, requiredObjectUrls: requiredUrls.size}};
}

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
        assert.equal(response.headers.get('Content-Encoding'), null, 'WASM raw range must not carry HTTP content encoding');
        const bytes = await smallBody(response, 8, 'WASM range');
        downloadedBytes += bytes.length;
        assert.deepEqual([...bytes], [0, 97, 115, 109, 1, 0, 0, 0], 'WASM magic/version');
      } finally {
        await deadline(response.body?.cancel().catch(() => {}), 'WASM response cleanup', 2000);
      }
    },
    async gzipHeader(pathname, entry) {
      const response = await deadline(request(`${pathname}?sha256=${entry.sha256}`, {headers: {Range: 'bytes=0-9'}}), 'WASM gzip range');
      if (response.status !== 206) {
        await deadline(response.body?.cancel().catch(() => {}), 'WASM gzip range cleanup', 2000);
        throw new Error(`WASM gzip range: expected 206, got ${response.status}`);
      }
      try {
        assert.equal(response.headers.get('Content-Range'), `bytes 0-9/${entry.bytes}`, 'WASM gzip extent');
        assert.equal(response.headers.get('Content-Length'), '10', 'WASM gzip range bytes');
        assert.equal(response.headers.get('ETag'), `"${entry.sha256}"`, 'WASM gzip range ETag');
        assert.equal(mime(response), 'application/gzip', 'WASM gzip range MIME');
        assert.equal(response.headers.get('Content-Encoding'), null, 'Gzip object bytes must not carry HTTP content encoding');
        const bytes = await smallBody(response, 10, 'WASM gzip range');
        downloadedBytes += bytes.length;
        assert.equal(bytes.length, 10, 'WASM gzip header length');
        assert.deepEqual([...bytes.subarray(0, 3)], [31, 139, 8], 'WASM gzip magic/method');
      } finally {
        await deadline(response.body?.cancel().catch(() => {}), 'WASM gzip response cleanup', 2000);
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
      assert.equal(response.headers.get('Content-Encoding'), null, `HEAD ${pathname}: object bytes must not carry HTTP content encoding`);
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
    hellos.forEach(message => assert.equal(message.protocol, 3, 'Native protocol'));
    assert.notEqual(hellos[0].playerId, hellos[1].playerId, 'Distinct server-assigned probe identities');
    peers.forEach(peer => peer.send({type: 'hello', protocol: 3, playerId: randomUUID()}));
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
    peers.forEach((peer, index) => peer.send({type: 'loaded', protocol: 3, matchId: start.matchId, tick: initialTick,
      hash: `transport-probe-local-${index}`, owners: [0, 1], build: 'native-transport-probe-v3',
      resourceManifest: release.build.resourceManifestSha256}));
    const ready = await Promise.all(peers.map(peer => peer.wait('ready', message => message.matchId === start.matchId)));
    ready.forEach(message => { assert.equal(message.tick, initialTick + 1, 'First probe turn'); assert.equal(message.bootstrap, start.matchId, 'Launch receipt'); assert.equal(message.protocol, 3, 'Pipeline protocol'); assert.equal(message.inputDelayTicks, 8, 'Bounded pipeline window'); });
    peers.forEach(peer => peer.send({type: 'input', matchId: start.matchId, tick: initialTick + 1, commands: []}));
    const turns = await Promise.all(peers.map(peer => peer.wait('turn', message => message.matchId === start.matchId)));
    turns.forEach(turn => { assert.equal(turn.tick, initialTick + 1, 'Ordered probe turn'); equal(turn.commands, [], 'Empty probe turn'); });
    peers.forEach(peer => peer.send({type: 'checksum', matchId: start.matchId, tick: initialTick + 1, checksum: 'retail:100:00000000'}));
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

async function main() {
  const report = {ok: false, scope: 'published HTTP assets and native-v3 transport probe', engineGameplayVerified: false, checks: {}};
  let stage = 'arguments';
  try {
    const origin = originArgument(); report.origin = origin;
    stage = 'local-release';
    const raw = await deadline(fs.readFile(new URL('./generated/release.json', import.meta.url)), 'Read local release');
    const release = JSON.parse(raw.toString('utf8'));
    const {resourceIdentity, catalogIdentity, wasm, wasmDownload, coverage} = validateRelease(release);
    report.catalogIdentity = catalogIdentity;
    report.requiredResourceIdentity = resourceIdentity;
    report.checks.localCatalog = coverage;
    report.releaseSha256 = createHash('sha256').update(raw).digest('hex');
    const http = createHttp(origin);
    stage = 'health';
    const health = await http.json('/api/health');
    assert.ok(health.ok && health.app === 'werhd-vera-native' && health.protocol === 3, 'Native service health/protocol');
    assert.equal(health.patchSha256, release.build.patchSha256, 'Published native patch');
    assert.equal(health.resourceManifestSha256, resourceIdentity, 'Published native resources');
    assert.equal(health.contentCatalogIdentity, catalogIdentity, 'Published native catalog');
    report.checks.health = true;
    stage = 'build'; equal(await http.json('/native/build.json'), release.build, 'Published build identity'); report.checks.build = true;
    stage = 'resources';
    const resources = await http.json('/api/native/resources');
    assert.equal(resources.schema, 2, 'Published layered content catalog');
    assert.equal(nativeAssetManifestIdentity(resources), resourceIdentity, 'Published required resource identity');
    assert.equal(nativeContentCatalogIdentity(resources), catalogIdentity, 'Published canonical catalog identity');
    assert.equal(resources.identity, resourceIdentity, 'Published resource identity receipt');
    assert.equal(resources.catalogIdentity, catalogIdentity, 'Published catalog identity receipt');
    assert.equal(resources.totalBytes, release.resources.totalBytes, 'Published default resource total');
    equal(resources, release.resources, 'Published resource URLs and manifest');
    report.checks.resourceManifest = true;
    stage = 'object-heads'; report.checks.objectHeads = await objectHeads(http, release.objects);
    stage = 'wasm-range'; await http.wasmHeader('/native/vera20k_bg.wasm', wasm); report.checks.wasmHeader = true;
    stage = 'wasm-gzip-range'; await http.gzipHeader(wasmDownload.url, wasmDownload); report.checks.wasmGzipHeader = true;
    report.httpBodyBytes = http.downloadedBytes;
    stage = 'websocket-transport'; report.checks.webSocket = await transportProbe(origin, release);
    report.ok = true;
  } catch (error) {
    report.stage = stage;
    report.error = (error instanceof Error ? error.message : String(error)).split('\n')[0].slice(0, 400);
    process.exitCode = 1;
  }
  console.log(JSON.stringify(report));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
