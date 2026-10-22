import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, webcrypto} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {createResourcePackFetch, ResourcePackError} from '../web-native/resource-packs.js';
import {ContentStore} from '../web-native/content-store.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const text = value => new TextEncoder().encode(value);
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return {promise, resolve}; }
function cache() {
  const entries = new Map();
  return {entries, async match(key) { return entries.get(key)?.clone(); },
    async put(key, value) { entries.set(key, new Response(await value.arrayBuffer(), {headers: value.headers})); },
    async delete(key) { return entries.delete(key); }};
}
function fixture() {
  const make = (name, value) => {
    const raw = text(value), wire = new Uint8Array(gzipSync(raw));
    return {raw, wire, file: {name, bytes: raw.length, sha256: sha(raw), url: `/content/objects/${sha(raw)}`,
      download: {url: `/content/objects/${sha(wire)}`, bytes: wire.length, sha256: sha(wire), encoding: 'gzip'}}};
  };
  const core = make('core.mix', 'Cross-shard source offsets retain the original deterministic gzip archive. '.repeat(20));
  const optional = make('campaign.mix', 'Optional campaigns must be covered before selecting this resource source.');
  const catalog = {schema: 2, identity: sha('required'), catalogIdentity: sha('catalog'), files: [core.file],
    profiles: {skirmish: {files: [core.file]}, full: {files: [core.file, optional.file]}},
    packs: {campaign: {files: [optional.file]}}};
  const locations = ['https://www.bilibilitoy.com/toy/core/v2/manifest.json', 'https://www.bilibilitoy.com/toy/addon/v2/manifest.json'];
  const routes = new Map(), calls = [], fallbackCalls = [];
  const manifest = (packId, parts) => ({schema: 1, kind: 'werhd-resource-shard', catalogIdentity: catalog.catalogIdentity,
    requiredResourceIdentity: catalog.identity, packId, parts});
  const part = (entry, start, end, location) => {
    const bytes = entry.wire.slice(start, end), hash = sha(bytes), path = `parts/${hash}.bin`;
    routes.set(new URL(path, location).href, bytes);
    return {wireSha256: entry.file.download.sha256, wireBytes: entry.wire.length,
      offset: start, bytes: bytes.length, sha256: hash, path};
  };
  const a = Math.floor(core.wire.length / 3), b = Math.floor(core.wire.length * 2 / 3);
  const first = part(core, 0, a, locations[0]);
  const second = part(core, a, b, locations[1]), third = part(core, b, core.wire.length, locations[1]);
  const other = part(optional, 0, optional.wire.length, locations[0]);
  const manifests = [manifest('core-001', [other, first]), manifest('core-002', [third, second])];
  const sync = () => manifests.forEach((value, index) => routes.set(locations[index], text(JSON.stringify(value))));
  sync();
  const fetch = async (url, options) => {
    calls.push({url: String(url), options});
    const bytes = routes.get(String(url));
    return bytes ? new Response(bytes) : new Response('missing', {status: 404});
  };
  const fallbackFetch = async (...args) => { fallbackCalls.push(args); return new Response('engine stays on Cloudflare'); };
  const sources = () => [locations[0].replace('manifest.json', ''), {url: locations[1], sha256: sha(routes.get(locations[1]))}];
  const create = options => createResourcePackFetch({sources: sources(), catalog, crypto: webcrypto, fetch, fallbackFetch, ...options});
  return {core, optional, catalog, locations, manifests, routes, calls, fallbackCalls, fetch, fallbackFetch, sync, sources, create};
}

test('empty production configuration returns the original Cloudflare fetch without loading manifests', async () => {
  const original = () => { throw new Error('No request expected during setup'); };
  assert.equal(await createResourcePackFetch({sources: [], fallbackFetch: original}), original);
});

test('multiple pinned/unpinned shard addresses reassemble exact gzip and retain original Store cache/progress', async () => {
  const f = fixture(), transport = await f.create(), cached = cache(), progress = [];
  const store = new ContentStore({crypto: webcrypto, cacheStorage: {open: async () => cached}, fetch: transport, retries: 0});
  assert.deepEqual(await store.loadFile(f.core.file, {onProgress: event => progress.push(event)}), f.core.raw);
  assert.equal(progress.at(-1).wireBytes, f.core.wire.length);
  assert.equal(progress.at(-1).loadedBytes, f.core.raw.length);
  assert.equal(progress.at(-1).fromCache, false);
  assert.equal(f.fallbackCalls.length, 0);
  assert.equal(f.calls.filter(call => call.url.endsWith('.bin')).length, 3);
  const count = f.calls.length;
  assert.deepEqual(await store.loadFile(f.core.file), f.core.raw);
  assert.equal(f.calls.length, count, 'a verified old raw cache avoids Toy downloads');
  assert.equal(cached.entries.size, 1);
  assert.ok([...cached.entries.keys()][0].endsWith(f.core.file.sha256));
  assert.deepEqual(await store.loadFile(f.optional.file), f.optional.raw);
  for (const call of f.calls) assert.equal(call.options.credentials, 'omit');
});

test('mapped art errors never fall back to Cloudflare, while the unrelated engine does', async () => {
  const f = fixture(), transport = await f.create();
  const first = f.manifests[0].parts.find(part => part.wireSha256 === f.core.file.download.sha256);
  f.routes.delete(new URL(first.path, f.locations[0]).href);
  await assert.rejects((await transport(f.core.file.download.url)).arrayBuffer(), /HTTP 404/);
  assert.equal(f.fallbackCalls.length, 0);
  const engine = '/content/objects/' + sha('engine');
  assert.equal(await (await transport(engine)).text(), 'engine stays on Cloudflare');
  assert.equal(f.fallbackCalls[0][0], engine);
});

test('source directory pins and all-catalog coverage are checked before art downloads', async t => {
  const cases = {
    'bad manifest pin': f => { f.routes.set(f.locations[1], text('{}')); },
    'missing optional object': f => { f.manifests[0].parts.shift(); f.sync(); },
    'wrong catalog': f => { f.manifests[0].catalogIdentity = sha('other'); f.sync(); },
    'wrong required identity': f => { f.manifests[0].requiredResourceIdentity = sha('other'); f.sync(); },
    'duplicate pack ID': f => { f.manifests[1].packId = f.manifests[0].packId; f.sync(); },
    'unknown wire': f => { f.manifests[0].parts[0].wireSha256 = sha('unknown'); f.sync(); },
    'wrong wire length': f => { f.manifests[0].parts[0].wireBytes++; f.sync(); },
    'overlapping offset': f => { f.manifests[1].parts[0].offset--; f.sync(); },
    'missing offset': f => { f.manifests[1].parts[0].offset++; f.sync(); },
    'oversize part': f => { f.manifests[0].parts[0].bytes = 48_000_001; f.sync(); },
    'escaping path': f => { f.manifests[0].parts[0].path = '../private.bin'; f.sync(); },
    'absolute path': f => { f.manifests[0].parts[0].path = '/parts/file.bin'; f.sync(); },
    'encoded path': f => { f.manifests[0].parts[0].path = 'parts/%2e%2e/file.bin'; f.sync(); },
  };
  for (const [name, mutate] of Object.entries(cases)) await t.test(name, async () => {
    const f = fixture();
    if (name === 'bad manifest pin') {
      const sources = f.sources(); mutate(f);
      await assert.rejects(f.create({sources}), ResourcePackError);
    } else { mutate(f); await assert.rejects(f.create(), ResourcePackError); }
    assert.equal(f.calls.some(call => call.url.endsWith('.bin')), false);
    assert.equal(f.fallbackCalls.length, 0);
  });
});

test('corrupt, short and overflowing part payloads never reach the raw cache', async t => {
  for (const mode of ['checksum', 'short', 'overflow']) await t.test(mode, async () => {
    const f = fixture(), transport = await f.create(), cached = cache();
    const first = f.manifests[0].parts.find(part => part.wireSha256 === f.core.file.download.sha256);
    const url = new URL(first.path, f.locations[0]).href, bytes = f.routes.get(url);
    const changed = mode === 'short' ? bytes.slice(1) : mode === 'overflow' ? new Uint8Array(bytes.length + 1) : bytes.slice();
    if (mode === 'checksum') changed[0] ^= 255;
    f.routes.set(url, changed);
    const store = new ContentStore({crypto: webcrypto, cacheStorage: {open: async () => cached}, fetch: transport, retries: 0});
    await assert.rejects(store.loadFile(f.core.file), ResourcePackError);
    assert.equal(cached.entries.size, 0);
    assert.equal(f.fallbackCalls.length, 0);
    assert.equal(f.calls.filter(call => call.url.endsWith('.bin')).length, 1);
  });
});

test('original full gzip and raw SHA checks remain required after verified shard delivery', async t => {
  for (const mode of ['wire', 'raw']) await t.test(mode, async () => {
    const f = fixture();
    if (mode === 'raw') f.core.file.sha256 = sha('wrong raw');
    else {
      const previous = f.core.file.download.sha256, changed = sha('wrong wire');
      f.core.file.download.sha256 = changed; f.core.file.download.url = `/content/objects/${changed}`;
      for (const manifest of f.manifests) for (const part of manifest.parts)
        if (part.wireSha256 === previous) part.wireSha256 = changed;
      f.sync();
    }
    const transport = await f.create(), store = new ContentStore({crypto: webcrypto, cacheStorage: null, fetch: transport, retries: 0});
    await assert.rejects(store.loadFile(f.core.file), /checksum mismatch/);
  });
});

test('abort between verified parts stops before another request and immediately errors the body', async () => {
  const f = fixture(), transport = await f.create(), controller = new AbortController();
  const reader = (await transport(f.core.file.download.url, {signal: controller.signal})).body.getReader();
  const first = await reader.read(); assert.ok(first.value.length);
  controller.abort();
  await assert.rejects(reader.read(), {name: 'AbortError'});
  assert.equal(f.calls.filter(call => call.url.endsWith('.bin')).length, 1);
});

test('reader cancellation aborts its active operation and does not prefetch the next part', async () => {
  const f = fixture(), transport = await f.create();
  const reader = (await transport(f.core.file.download.url)).body.getReader();
  await reader.read(); await reader.cancel(); await flush();
  const parts = f.calls.filter(call => call.url.endsWith('.bin'));
  assert.equal(parts.length, 1);
  assert.equal(parts[0].options.signal.aborted, true);
});

test('a late fetch resolving after abort has its body cancelled and cannot publish or cache', async () => {
  const f = fixture(), entered = deferred(), late = deferred(), controller = new AbortController();
  let cancelled = false;
  const transport = await f.create({fetch: async (url, options) => {
    if (!url.endsWith('.bin')) return f.fetch(url, options);
    f.calls.push({url, options}); entered.resolve(); return late.promise;
  }});
  const cached = cache(), progress = [];
  const store = new ContentStore({crypto: webcrypto, cacheStorage: {open: async () => cached}, fetch: transport, retries: 0});
  const pending = store.loadFile(f.core.file, {signal: controller.signal, onProgress: value => progress.push(value)});
  await entered.promise; controller.abort();
  await assert.rejects(pending, {name: 'AbortError'});
  const count = progress.length;
  late.resolve(new Response(new ReadableStream({cancel() { cancelled = true; }})));
  await flush();
  assert.equal(cancelled, true);
  assert.equal(progress.length, count);
  assert.equal(cached.entries.size, 0);
  assert.equal(f.calls.filter(call => call.url.endsWith('.bin')).length, 1);
});

test('source URL validation rejects credentials, protocols and ambiguous duplicate directories', async () => {
  for (const url of ['javascript:alert(1)', 'http://remote.test/v2/', 'https://name:password@game.test/v2/', '/relative/manifest.json']) {
    const f = fixture(); await assert.rejects(f.create({sources: [url]}), ResourcePackError);
    assert.equal(f.calls.length, 0);
  }
  const f = fixture();
  await assert.rejects(f.create({sources: [f.locations[0], f.locations[0]]}), /重复/);
});
