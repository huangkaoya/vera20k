import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
mkdirSync('.build/tests', { recursive: true });
await build({ entryPoints: ['web/src/config/runtime.ts'], outfile: '.build/tests/runtime.mjs', bundle: true, platform: 'node', format: 'esm' });
await build({ entryPoints: ['web/src/render/urls.ts'], outfile: '.build/tests/art-urls.mjs', bundle: true, platform: 'node', format: 'esm' });
const { parseRuntimeConfig, loadRuntimeConfig, resolveResourceManifest, resolveHttpUrl, resolveSocketUrl } = await import(pathToFileURL(process.cwd() + '/.build/tests/runtime.mjs').href);
const { resolveArtManifest } = await import(pathToFileURL(process.cwd() + '/.build/tests/art-urls.mjs').href);
const config = () => ({ schema: 1, assets: { manifestUrl: 'https://art.example/game/generated/catalog.json', wasmUrl: 'https://cdn.example/engine/core.wasm', resourceManifestUrl: 'https://retail.example/ra2/resources.json' }, network: { lobbyUrl: 'wss://lobby.example/ws/rooms' } });
const page = 'https://game.example/play/';

test('runtime config separates site, art, WASM, retail and lobby addresses', () => {
  const parsed = parseRuntimeConfig(config(), 'https://game.example/api/config', page);
  assert.deepEqual(parsed, config());
  const relative = config();
  relative.assets.manifestUrl = '../generated/catalog.json';
  relative.assets.wasmUrl = '/wasm/core.wasm'; relative.network.lobbyUrl = '/ws/rooms';
  const resolved = parseRuntimeConfig(relative, 'https://config.example/v1/config', page);
  assert.equal(resolved.assets.manifestUrl, 'https://config.example/generated/catalog.json');
  assert.equal(resolved.assets.wasmUrl, 'https://config.example/wasm/core.wasm');
  assert.equal(resolved.network.lobbyUrl, 'wss://config.example/ws/rooms');
});

test('runtime bootstrap resolves returned relative URLs against the final config response URL', async () => {
  const calls = [], data = config(); data.assets.manifestUrl = './art/catalog.json';
  const parsed = await loadRuntimeConfig(page, async url => {
    calls.push(url); return { ok: true, url: 'https://config.example/release/current.json', json: async () => data };
  });
  assert.deepEqual(calls, ['https://game.example/api/config']);
  assert.equal(parsed.assets.manifestUrl, 'https://config.example/release/art/catalog.json');
  await assert.rejects(loadRuntimeConfig(page, async () => ({ ok: false, status: 503 })), /503/);
});

test('HTTPS pages reject mixed content and all endpoint types reject unsupported schemes and credentials', () => {
  for (const bad of ['data:text/plain,a', 'javascript:alert(1)', 'file:///tmp/game', 'ws://a/a']) assert.throws(() => resolveHttpUrl(bad, page), /协议/);
  for (const bad of ['http://lobby.example/ws', 'https://lobby.example/ws', 'data:a']) assert.throws(() => resolveSocketUrl(bad, page), /协议/);
  assert.throws(() => resolveHttpUrl('http://retail.example/a', page), /混合内容/);
  assert.throws(() => resolveSocketUrl('ws://battle.example/ws', page), /混合内容/);
  assert.throws(() => resolveHttpUrl('https://user:secret@cdn.example/a', page), /用户名或密码/);
  assert.equal(resolveSocketUrl('/ws/rooms', 'http://127.0.0.1:5280/'), 'ws://127.0.0.1:5280/ws/rooms');
  assert.equal(resolveHttpUrl('http://127.0.0.1:5281/a', 'http://127.0.0.1:5280/'), 'http://127.0.0.1:5281/a');
  for (const bad of [{}, { ...config(), schema: 2 }, { ...config(), assets: null }, { ...config(), network: {} }]) assert.throws(() => parseRuntimeConfig(bad, page));
});

test('every retail file resolves against the resource manifest owner and maintains integrity metadata', () => {
  const input = { schema: 1, totalBytes: 3, files: [
    { name: 'ra2.mix', bytes: 1, sha256: 'A'.repeat(64), url: './files/ra2.mix' },
    { name: 'ra2md.mix', bytes: 2, sha256: 'b'.repeat(64), url: '/retail/ra2md.mix' },
  ] };
  const manifest = resolveResourceManifest(input, 'https://retail.example/a/resources.json', page);
  assert.equal(manifest.files[0].url, 'https://retail.example/a/files/ra2.mix');
  assert.equal(manifest.files[1].url, 'https://retail.example/retail/ra2md.mix');
  assert.equal(manifest.files[0].sha256, 'a'.repeat(64));
  assert.equal(input.files[0].url, './files/ra2.mix', 'do not mutate the server payload');
  assert.throws(() => resolveResourceManifest({ ...input, totalBytes: 4 }, 'https://retail.example/a/resources.json', page), /总大小/);
  assert.throws(() => resolveResourceManifest({ ...input, files: [input.files[0], input.files[0]] }, 'https://retail.example/a/resources.json', page), /重复/);
  assert.throws(() => resolveResourceManifest({ ...input, files: [{ ...input.files[0], url: 'http://retail.example/a' }] }, 'https://retail.example/a/resources.json', page), /混合内容/);
});

test('art maps, remap masks and cameos resolve once against the art manifest, preserving CDN prefixes', () => {
  const input = { schema: 1, maps: [{ id: 'MAP', image: 'maps/map.png', minimap: './maps/mini.png' }], sprites: {
    AMCV: { image: 'sprites/amcv.png', remapImage: 'sprites/amcv-remap.png', cameo: 'https://cameo.example/amcv.png' },
  } };
  const resolved = resolveArtManifest(input, 'https://cdn.example/prefix/generated/catalog.json', page);
  assert.equal(resolved.maps[0].image, 'https://cdn.example/prefix/generated/maps/map.png');
  assert.equal(resolved.maps[0].minimap, 'https://cdn.example/prefix/generated/maps/mini.png');
  assert.equal(resolved.sprites.AMCV.image, 'https://cdn.example/prefix/generated/sprites/amcv.png');
  assert.equal(resolved.sprites.AMCV.remapImage, 'https://cdn.example/prefix/generated/sprites/amcv-remap.png');
  assert.equal(resolved.sprites.AMCV.cameo, 'https://cameo.example/amcv.png');
  assert.equal(input.maps[0].image, 'maps/map.png');
  assert.throws(() => resolveArtManifest({ ...input, sprites: { AMCV: { ...input.sprites.AMCV, cameo: 'javascript:bad' } } }, 'https://cdn.example/catalog.json', page), /协议/);
});

test('retail catalog null optional art is absent while required images still reject null', () => {
  const input = { schema: 1, maps: [{ image: 'maps/map.png', minimap: 'maps/mini.png' }], sprites: {
    AMBU: { image: 'sprites/ambu.png', remapImage: null, cameo: null },
  } };
  const resolved = resolveArtManifest(input, 'http://127.0.0.1:5281/generated/catalog.json', 'http://127.0.0.1:5280/');
  assert.equal(resolved.sprites.AMBU.image, 'http://127.0.0.1:5281/generated/sprites/ambu.png');
  assert.equal('cameo' in resolved.sprites.AMBU, false); assert.equal('remapImage' in resolved.sprites.AMBU, false);
  assert.throws(() => resolveArtManifest({ ...input, sprites: { AMBU: { ...input.sprites.AMBU, image: null } } }, 'http://127.0.0.1:5281/generated/catalog.json'), /有效 URL/);
});
