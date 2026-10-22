import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, webcrypto} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {ContentStore, ContentError} from '../web-native/content-store.js';

const raw = value => new TextEncoder().encode(value);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const descriptor = (bytes, name = 'core.mix') => ({name, bytes: bytes.length, sha256: sha(bytes), url: `https://assets.example/${name}`});
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return {promise, resolve, reject}; }
function memoryCache() {
  const entries = new Map(), deleted = []; let puts = 0;
  return {entries, deleted, get puts() { return puts; },
    async match(key) { return entries.get(key)?.clone(); },
    async put(key, response) { puts++; entries.set(key, new Response(await response.arrayBuffer(), {headers: response.headers})); },
    async delete(key) { deleted.push(key); return entries.delete(key); },
  };
}
function fixture({fetch = async () => { throw new Error('unexpected fetch'); }, cache = memoryCache(), cacheStorage, ...options} = {}) {
  const statuses = [], requests = [];
  const store = new ContentStore({crypto: webcrypto, retries: 0, retryDelayMs: 0, cacheStorage: cacheStorage ?? {open: async () => cache},
    fetch: async (...args) => { requests.push(args); return await fetch(...args); }, onCacheStatus: status => statuses.push(status), ...options});
  return {store, cache, statuses, requests};
}
function chunksResponse(parts) { return new Response(new ReadableStream({start(controller) { for (const part of parts) controller.enqueue(part); controller.close(); }})); }

test('streamed content uses real SHA, reports wire bytes, and revalidates a persistent cache hit', async () => {
  const bytes = raw('verified retail bytes'), file = descriptor(bytes), progress = [];
  const f = fixture({fetch: async () => chunksResponse([bytes.subarray(0, 5), bytes.subarray(5)])});
  assert.deepEqual(await f.store.loadFile(file, {onProgress: event => progress.push(event)}), bytes);
  assert.equal(f.store.cacheStatus(file), 'stored'); assert.equal(f.cache.puts, 1);
  assert.deepEqual(progress.filter(event => event.stage === 'download').map(event => event.wireBytes), [5, bytes.length]);
  assert.equal(progress.at(-1).stage, 'complete'); assert.equal(progress.at(-1).fromCache, false);
  const hit = [];
  assert.deepEqual(await f.store.loadFile(file, {onProgress: event => hit.push(event)}), bytes);
  assert.equal(f.requests.length, 1); assert.equal(f.store.cacheStatus(file), 'hit');
  assert.equal(hit.at(-1).wireBytes, 0); assert.equal(hit.at(-1).fromCache, true);
});

test('a corrupt cache entry only deletes its SHA object before a verified replacement', async () => {
  const bytes = raw('correct'), file = descriptor(bytes), f = fixture({fetch: async () => new Response(bytes)});
  const key = f.store.key(file), unrelated = `${key}-another`;
  f.cache.entries.set(key, new Response(raw('broken!'))); f.cache.entries.set(unrelated, new Response('keep'));
  assert.deepEqual(await f.store.loadFile(file), bytes);
  assert.deepEqual(f.cache.deleted, [key]); assert.equal(await f.cache.entries.get(unrelated).text(), 'keep');
  assert.ok(f.statuses.some(event => event.state === 'corrupt')); assert.equal(f.store.cacheStatus(file), 'stored');
});

test('incorrect response length, overflow and checksum never enter the cache', async t => {
  const bytes = raw('expected'), file = descriptor(bytes);
  for (const [name, actual] of [['short', bytes.subarray(1)], ['overflow', raw('expected!')], ['checksum', raw('different')]]) {
    await t.test(name, async () => {
      const sameLength = name === 'checksum' ? raw('mismatch') : actual;
      const f = fixture({fetch: async () => new Response(sameLength)});
      await assert.rejects(f.store.loadFile(file), /length|checksum/); assert.equal(f.cache.puts, 0);
    });
  }
});

test('bounded retry recovers a transient response and counts attempted wire bytes', async () => {
  const bytes = raw('retry-data'), file = descriptor(bytes), progress = []; let calls = 0;
  const f = fixture({retries: 1, fetch: async () => new Response(++calls === 1 ? bytes.subarray(0, 3) : bytes)});
  await f.store.loadFile(file, {onProgress: event => progress.push(event)});
  assert.equal(calls, 2); assert.equal(progress.at(-1).wireBytes, bytes.length + 3); assert.equal(progress.at(-1).attempt, 2);
  const denied = fixture({retries: 3, fetch: async () => new Response('missing', {status: 404})});
  await assert.rejects(denied.store.loadFile(file), /HTTP 404/); assert.equal(denied.requests.length, 1);
  const offline = fixture({retries: 1, fetch: async () => { throw new TypeError('network offline'); }});
  await assert.rejects(offline.store.loadFile(file), /offline/); assert.equal(offline.requests.length, 2); assert.equal(offline.cache.puts, 0);
});

test('gzip transport and raw content both require their own exact SHA and lengths', async () => {
  const bytes = raw('skirmish sprite data '.repeat(100)), wire = new Uint8Array(gzipSync(bytes)), file = {...descriptor(bytes),
    download: {url: 'https://assets.example/core.mix.gz', bytes: wire.length, sha256: sha(wire), encoding: 'gzip'}};
  const progress = [], f = fixture({fetch: async () => chunksResponse([wire.subarray(0, 8), wire.subarray(8)])});
  assert.deepEqual(await f.store.loadFile(file, {onProgress: event => progress.push(event)}), bytes);
  assert.equal(f.requests[0][0], file.download.url); assert.equal(progress.at(-1).wireBytes, wire.length);
  assert.equal(progress.at(-1).loadedBytes, bytes.length);
  assert.deepEqual(new Uint8Array(await f.cache.entries.get(f.store.key(file)).arrayBuffer()), bytes);
  for (const altered of [
    {...file, sha256: '0'.repeat(64)},
    {...file, download: {...file.download, sha256: '0'.repeat(64)}},
    {...file, download: {...file.download, bytes: wire.length - 1}},
  ]) {
    const broken = fixture({fetch: async () => new Response(wire)});
    await assert.rejects(broken.store.loadFile(altered), /checksum|length/); assert.equal(broken.cache.puts, 0);
  }
});

test('gzip expansion cannot exceed the raw manifest allocation limit', async () => {
  const expanded = raw('a'.repeat(100_000)), wire = new Uint8Array(gzipSync(expanded));
  const file = {...descriptor(raw('tiny')), download: {url: 'https://assets.example/bomb.gz', bytes: wire.length, sha256: sha(wire), encoding: 'gzip'}};
  const f = fixture({fetch: async () => new Response(wire)});
  await assert.rejects(f.store.loadFile(file), /exceeds 4 bytes/); assert.equal(f.cache.puts, 0);
});

test('abort cancels a pending body and suppresses subsequent progress/cache commits', async () => {
  const bytes = raw('unfinished'), controller = new AbortController(), events = [], received = deferred(); let cancelled = false;
  const f = fixture({fetch: async () => new Response(new ReadableStream({start(stream) { stream.enqueue(bytes.subarray(0, 2)); received.resolve(); }, cancel() { cancelled = true; }}))});
  const pending = f.store.loadFile(descriptor(bytes), {signal: controller.signal, onProgress: event => events.push(event)});
  await received.promise; await flush(); controller.abort();
  await assert.rejects(pending, {name: 'AbortError'}); const count = events.length; await flush();
  assert.equal(cancelled, true); assert.equal(f.cache.puts, 0); assert.equal(events.length, count);
});

test('a fetch or crypto adapter that resolves after abort cannot publish bytes or cache success', async () => {
  const bytes = raw('late bytes'), file = descriptor(bytes), late = deferred(), requested = deferred(), controller = new AbortController(); let cancelled = false;
  const f = fixture({fetch: async () => { requested.resolve(); return await late.promise; }});
  const pending = f.store.loadFile(file, {signal: controller.signal}); await requested.promise;
  controller.abort(); await assert.rejects(pending, {name: 'AbortError'});
  late.resolve(new Response(new ReadableStream({cancel() { cancelled = true; }}))); await flush();
  assert.equal(cancelled, true); assert.equal(f.cache.puts, 0); assert.ok(!f.statuses.some(event => event.state === 'stored'));
  const hashing = deferred(), started = deferred(), cancelHash = new AbortController();
  const delayed = fixture({fetch: async () => new Response(bytes), crypto: {subtle: {digest: async () => { started.resolve(); return await hashing.promise; }}}});
  const checking = delayed.store.loadFile(file, {signal: cancelHash.signal}); await started.promise;
  cancelHash.abort(); await assert.rejects(checking, {name: 'AbortError'});
  hashing.resolve(await webcrypto.subtle.digest('SHA-256', bytes)); await flush(); assert.equal(delayed.cache.puts, 0);
});

test('an uncancellable Cache.put settling after abort is removed and never marked installed', async () => {
  const bytes = raw('cache commit'), file = descriptor(bytes), cache = memoryCache(), commit = deferred(), started = deferred(), controller = new AbortController();
  cache.put = async (key, response) => { const body = await response.arrayBuffer(); started.resolve(); await commit.promise; cache.entries.set(key, new Response(body)); };
  const f = fixture({cache, fetch: async () => new Response(bytes)}), pending = f.store.loadFile(file, {signal: controller.signal});
  await started.promise; controller.abort(); await assert.rejects(pending, {name: 'AbortError'});
  commit.resolve(); await flush(); await flush();
  assert.equal(cache.entries.has(f.store.key(file)), false); assert.ok(!f.statuses.some(event => event.state === 'stored'));
});

test('unavailable storage and quota errors allow verified play and report not installed', async () => {
  const bytes = raw('play without cache'), file = descriptor(bytes);
  const unavailable = fixture({cacheStorage: {open: async () => { throw new DOMException('denied', 'SecurityError'); }}, fetch: async () => new Response(bytes)});
  assert.deepEqual(await unavailable.store.loadFile(file), bytes); assert.equal(unavailable.store.cacheStatus(file), 'unavailable');
  assert.equal(unavailable.store.cacheAvailable, false);
  const cache = memoryCache(); cache.put = async () => { throw new DOMException('full', 'QuotaExceededError'); };
  const quota = fixture({cache, fetch: async () => new Response(bytes)}), result = await quota.store.prefetch([file]);
  assert.equal(result.cacheAvailable, true); assert.equal(result.installed, false); assert.equal(result.files[0].cacheStatus, 'write-failed');
});

test('prefetch is bounded, reports aggregate wire progress, and never retains result byte arrays', {timeout: 1000}, async () => {
  const files = [0, 1, 2].map(index => descriptor(raw(`file-${index}`), `${index}.mix`)), gates = files.map(() => deferred()), started = files.map(() => deferred()), entered = []; let active = 0, peak = 0;
  const f = fixture({fetch: async url => { const index = Number(new URL(url).pathname.split('/').pop().split('.')[0]); entered.push(index); peak = Math.max(peak, ++active); started[index].resolve(); await gates[index].promise; active--; return new Response(raw(`file-${index}`)); }}), progress = [];
  const pending = f.store.prefetch(files, {concurrency: 2, onProgress: event => progress.push(event)});
  await Promise.all([started[0].promise, started[1].promise]);
  assert.deepEqual(entered, [0, 1]); gates[0].resolve();
  // Wait for actual delivery admission; native WebCrypto completion need not
  // fit into an arbitrary number of event-loop turns on a busy build host.
  await started[2].promise;
  assert.deepEqual(entered, [0, 1, 2]); gates[1].resolve(); gates[2].resolve();
  const result = await pending;
  assert.equal(peak, 2); assert.equal(result.installed, true); assert.deepEqual(result.files.map(file => file.name), files.map(file => file.name));
  assert.ok(result.files.every(file => typeof file.bytes === 'number'));
  assert.equal(progress.at(-1).completedFiles, 3); assert.equal(progress.at(-1).transferredWireBytes, files.reduce((total, file) => total + file.bytes, 0));
  const cached = []; await f.store.prefetch(files, {onProgress: event => cached.push(event)});
  assert.equal(cached.at(-1).completedFiles, 3); assert.equal(cached.at(-1).transferredWireBytes, 0);
});

test('prefetch cancellation and first failure stop remaining work without late cache writes', async () => {
  const bytes = raw('content'), files = [0, 1, 2].map(index => descriptor(bytes, `${index}.mix`)), entered = deferred(), late = deferred(), controller = new AbortController();
  const f = fixture({fetch: async () => { entered.resolve(); return await late.promise; }});
  const pending = f.store.prefetch(files, {signal: controller.signal, concurrency: 1}); await entered.promise;
  controller.abort(); await assert.rejects(pending, {name: 'AbortError'});
  late.resolve(new Response(bytes)); await flush(); assert.equal(f.requests.length, 1); assert.equal(f.cache.puts, 0);
  const failing = fixture({fetch: async () => new Response('no', {status: 404})});
  await assert.rejects(failing.store.prefetch(files, {concurrency: 1}), /HTTP 404/); assert.equal(failing.requests.length, 1);
});

test('cancelling during retry backoff clears the timer and does not issue another request', {timeout: 1000}, async () => {
  const controller = new AbortController(), waiting = deferred(), f = fixture({retries: 1, retryDelayMs: 60_000,
    fetch: async () => new Response('retry', {status: 503})});
  const pending = f.store.loadFile(descriptor(raw('bytes')), {signal: controller.signal, onProgress: event => { if (event.stage === 'retry') waiting.resolve(); }});
  await waiting.promise; controller.abort(); await assert.rejects(pending, {name: 'AbortError'});
  assert.equal(f.requests.length, 1);
});

test('CacheStorage read failures fall back to verified delivery without claiming installation', async () => {
  const bytes = raw('read failure'), cache = memoryCache(); cache.match = async () => { throw new Error('storage disconnected'); };
  const f = fixture({cache, fetch: async () => new Response(bytes)}), result = await f.store.prefetch([descriptor(bytes)]);
  assert.equal(result.installed, false); assert.equal(result.files[0].cacheStatus, 'unavailable'); assert.equal(cache.puts, 0);
});

test('invalid descriptors and unreasonable concurrency fail before touching storage or network', async () => {
  const f = fixture(), file = descriptor(raw('valid'));
  for (const invalid of [{...file, bytes: -1}, {...file, sha256: 'no'}, {...file, bytes: 1024 ** 3 + 1}, {...file, download: {...file, encoding: 'zip'}}, {...file, download: {...file, bytes: file.bytes - 1, encoding: 'identity'}}]) {
    await assert.rejects(f.store.loadFile(invalid), ContentError);
  }
  await assert.rejects(f.store.prefetch([file], {concurrency: 5}), ContentError); assert.equal(f.requests.length, 0);
});

const currentCacheName = 'werhd-native-content-v1', legacyCacheName = 'vera-native-content-v1';
const legacyKey = file => `https://werhd-content.invalid/.vera-content-cache/v1/${file.sha256}`;
function namedCaches({current = memoryCache(), legacy = memoryCache(), hasLegacy = true} = {}) {
  const opened = [], names = new Map([[currentCacheName, current]]);
  if (hasLegacy) names.set(legacyCacheName, legacy);
  return {current, legacy, opened, names,
    storage: {has: async name => names.has(name), open: async name => {
      opened.push(name); if (!names.has(name)) names.set(name, memoryCache()); return names.get(name);
    }}};
}

test('new cache names and headers lazily migrate a verified legacy SHA without fetching', async () => {
  const bytes = raw('already downloaded retail bytes'), file = descriptor(bytes), caches = namedCaches();
  const oldKey = legacyKey(file), events = [];
  caches.legacy.entries.set(oldKey, new Response(bytes, {headers: {'X-Vera-Content-SHA256': file.sha256}}));
  const unrelated = oldKey + '-unread'; caches.legacy.entries.set(unrelated, new Response('leave this alone'));
  const f = fixture({cacheStorage: caches.storage});
  assert.equal(f.store.key(file), `https://werhd-content.invalid/.werhd-content-cache/v1/${file.sha256}`);
  assert.deepEqual(await f.store.loadFile(file, {onProgress: event => events.push(event)}), bytes);
  assert.equal(f.requests.length, 0); assert.deepEqual(caches.opened, [currentCacheName, legacyCacheName]);
  assert.equal(caches.legacy.entries.has(oldKey), false); assert.equal(caches.legacy.entries.has(unrelated), true);
  const copied = caches.current.entries.get(f.store.key(file));
  assert.deepEqual(new Uint8Array(await copied.clone().arrayBuffer()), bytes);
  assert.equal(copied.headers.get('X-Werhd-Content-SHA256'), file.sha256);
  assert.equal(copied.headers.has('X-Vera-Content-SHA256'), false);
  assert.equal(events.at(-1).legacyCache, true); assert.equal(events.at(-1).migratedCache, true);
  assert.equal(events.at(-1).wireBytes, 0); assert.equal(events.at(-1).fromCache, true);
});

test('a verified new cache hit wins before any legacy namespace is opened or inspected', async () => {
  const bytes = raw('same exact known object'), file = descriptor(bytes), caches = namedCaches();
  const f = fixture({cacheStorage: caches.storage});
  caches.current.entries.set(f.store.key(file), new Response(bytes));
  caches.legacy.entries.set(legacyKey(file), new Response('corrupt old bytes must not matter'));
  assert.deepEqual(await f.store.loadFile(file), bytes);
  assert.deepEqual(caches.opened, [currentCacheName]); assert.equal(f.requests.length, 0);
  assert.deepEqual(caches.legacy.deleted, []); assert.equal(f.store.cacheStatus(file), 'hit');
});

test('failed migration writes preserve a verified legacy cache and remain playable without re-download', async () => {
  const bytes = raw('keep installed resources'), file = descriptor(bytes), caches = namedCaches();
  caches.legacy.entries.set(legacyKey(file), new Response(bytes));
  caches.current.put = async () => { throw new DOMException('full', 'QuotaExceededError'); };
  const f = fixture({cacheStorage: caches.storage});
  assert.deepEqual(await f.store.loadFile(file), bytes); assert.deepEqual(await f.store.loadFile(file), bytes);
  assert.equal(f.requests.length, 0); assert.equal(caches.legacy.entries.has(legacyKey(file)), true);
  assert.deepEqual(caches.legacy.deleted, []); assert.equal(f.store.cacheStatus(file), 'hit');
  assert.ok(f.statuses.some(event => event.state === 'write-failed'));
});

test('a missing legacy namespace is not created while normal new downloads use only WERHD names', async () => {
  const bytes = raw('new installation'), file = descriptor(bytes), caches = namedCaches({hasLegacy: false});
  const f = fixture({cacheStorage: caches.storage, fetch: async () => new Response(bytes)});
  assert.deepEqual(await f.store.loadFile(file), bytes);
  assert.deepEqual(caches.opened, [currentCacheName]); assert.equal(caches.names.has(legacyCacheName), false);
  assert.equal(f.requests.length, 1); assert.ok(caches.current.entries.has(f.store.key(file)));
});

test('an unavailable new cache still serves verified old bytes without any network fallback', async () => {
  const bytes = raw('old cache survives new-cache denial'), file = descriptor(bytes), caches = namedCaches();
  caches.legacy.entries.set(legacyKey(file), new Response(bytes));
  const open = caches.storage.open; caches.storage.open = name => {
    if (name === currentCacheName) throw new DOMException('denied', 'SecurityError'); return open(name);
  };
  const f = fixture({cacheStorage: caches.storage});
  assert.deepEqual(await f.store.loadFile(file), bytes); assert.equal(f.requests.length, 0);
  assert.equal(caches.legacy.entries.has(legacyKey(file)), true); assert.deepEqual(caches.legacy.deleted, []);
});

test('abort during legacy copy keeps old bytes and suppresses late migration success', async () => {
  const bytes = raw('copy in flight'), file = descriptor(bytes), caches = namedCaches();
  const commit = deferred(), started = deferred(), controller = new AbortController(), events = [];
  caches.legacy.entries.set(legacyKey(file), new Response(bytes));
  caches.current.put = async (key, response) => {
    const body = await response.arrayBuffer(); started.resolve(); await commit.promise;
    caches.current.entries.set(key, new Response(body, {headers: response.headers}));
  };
  const f = fixture({cacheStorage: caches.storage});
  const pending = f.store.loadFile(file, {signal: controller.signal, onProgress: event => events.push(event)});
  await started.promise; controller.abort(); await assert.rejects(pending, {name: 'AbortError'});
  const count = events.length; commit.resolve(); await flush(); await flush();
  assert.equal(caches.legacy.entries.has(legacyKey(file)), true); assert.deepEqual(caches.legacy.deleted, []);
  assert.equal(events.length, count); assert.equal(f.requests.length, 0);
  assert.ok(!events.some(event => event.cacheStatus === 'stored' || event.stage === 'complete'));
});

test('an uncancellable legacy deletion completing after abort restores the old entry', async () => {
  const bytes = raw('delete migration in flight'), file = descriptor(bytes), caches = namedCaches();
  const commit = deferred(), started = deferred(), controller = new AbortController();
  const oldKey = legacyKey(file); caches.legacy.entries.set(oldKey, new Response(bytes));
  caches.legacy.delete = async key => { started.resolve(); await commit.promise; return caches.legacy.entries.delete(key); };
  const f = fixture({cacheStorage: caches.storage}), pending = f.store.loadFile(file, {signal: controller.signal});
  await started.promise; controller.abort(); await assert.rejects(pending, {name: 'AbortError'});
  commit.resolve(); await flush(); await flush();
  assert.deepEqual(new Uint8Array(await caches.legacy.entries.get(oldKey).clone().arrayBuffer()), bytes);
  assert.ok(caches.current.entries.has(f.store.key(file))); assert.equal(f.requests.length, 0);
});

test('legacy content is independently size and SHA validated before use or migration', async () => {
  const bytes = raw('valid old entry'), file = descriptor(bytes);
  for (const bad of [raw('wrong old entry'), bytes.subarray(1)]) {
    const caches = namedCaches(); caches.legacy.entries.set(legacyKey(file), new Response(bad));
    const f = fixture({cacheStorage: caches.storage, fetch: async () => new Response(bytes)});
    assert.deepEqual(await f.store.loadFile(file), bytes); assert.equal(f.requests.length, 1);
    assert.deepEqual(caches.legacy.deleted, [legacyKey(file)]);
    assert.ok(f.statuses.some(event => event.state === 'corrupt'));
  }
});

test('cache adapters aliasing names do not retire or delete entries from the active cache', async () => {
  const bytes = raw('aliased test adapter'), file = descriptor(bytes), shared = memoryCache();
  shared.entries.set(legacyKey(file), new Response(bytes));
  const f = fixture({cache: shared, cacheStorage: {has: async () => true, open: async () => shared}, fetch: async () => new Response(bytes)});
  assert.deepEqual(await f.store.loadFile(file), bytes);
  assert.equal(shared.entries.has(legacyKey(file)), true); assert.deepEqual(shared.deleted, []);
  assert.deepEqual(await f.store.loadFile(file), bytes); assert.equal(f.requests.length, 0);
});

test('CacheStorage keys discovery supports older adapters without creating a missing legacy cache', async () => {
  const bytes = raw('keys-based legacy discovery'), file = descriptor(bytes), caches = namedCaches();
  caches.legacy.entries.set(legacyKey(file), new Response(bytes));
  delete caches.storage.has; caches.storage.keys = async () => [...caches.names.keys()];
  const f = fixture({cacheStorage: caches.storage});
  assert.deepEqual(await f.store.loadFile(file), bytes); assert.equal(f.requests.length, 0);
  assert.deepEqual(caches.opened, [currentCacheName, legacyCacheName]);
});
