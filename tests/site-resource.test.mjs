import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createResourceServer } from '../tools/services/resource-server.mjs';
import { createSiteServer } from '../tools/services/site-server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const frontendOrigin = 'http://127.0.0.1:5280';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function rawRequest(url, pathname, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const endpoint = new URL(url);
    const request = http.request({ hostname: endpoint.hostname, port: endpoint.port, path: pathname, method, headers }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.on('error', reject); request.end(body);
  });
}

async function harness(t, { publicUrl } = {}) {
  await fs.mkdir(path.join(root, '.build'), { recursive: true });
  const base = await fs.mkdtemp(path.join(root, '.build/site-resource-'));
  const project = path.join(base, 'project'), retail = path.join(base, 'retail');
  for (const directory of ['public/generated/maps', 'public/wasm', 'dist/assets', 'web/src']) await fs.mkdir(path.join(project, directory), { recursive: true });
  await fs.mkdir(retail);
  const retailBytes = Buffer.from('0123456789-real-retail-test-bytes');
  const wasmBytes = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
  const pngBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  await fs.writeFile(path.join(retail, 'ra2.mix'), retailBytes);
  await fs.writeFile(path.join(retail, 'rulesmd.ini'), '[General]\nTest=1');
  for (const name of ['RA2MD.INI', 'keyboard.ini', 'movmd03.mix', 'private.cfg']) await fs.writeFile(path.join(retail, name), 'private profile or unused movie');
  await fs.writeFile(path.join(base, 'private.json'), '{"private":"do-not-serve"}');
  await fs.symlink(path.join(base, 'private.json'), path.join(retail, 'ra2md.mix'));
  const catalog = JSON.stringify({ maps: [{ id: 'TEST.MAP', image: '/generated/maps/test.png', minimap: '/generated/maps/test.png', terrainImage: 'maps/test.png' }], sprites: { E1: { image: '/generated/maps/test.png', remapImage: '/generated/maps/test.png', cameo: '/generated/maps/test.png', source: 'E1.SHP' } } });
  await fs.writeFile(path.join(project, 'public/generated/catalog.json'), catalog);
  await fs.writeFile(path.join(project, 'public/generated/manifest.json'), catalog);
  await fs.writeFile(path.join(project, 'public/generated/maps/test.png'), pngBytes);
  await fs.writeFile(path.join(project, 'public/generated/private.ts'), 'private source');
  await fs.symlink(path.join(base, 'private.json'), path.join(project, 'public/generated/leak.json'));
  await fs.symlink(base, path.join(project, 'public/generated/linked'));
  await fs.writeFile(path.join(project, 'public/wasm/vera_web_core.wasm'), wasmBytes);
  await fs.writeFile(path.join(project, 'public/index.html'), 'must not appear on resource host');
  const html = '<!doctype html><title>王二火大</title><script type="module" src="/assets/index.js"></script>';
  await fs.writeFile(path.join(project, 'dist/index.html'), html);
  await fs.writeFile(path.join(project, 'dist/assets/index.js'), 'console.log("王二火大");');
  await fs.writeFile(path.join(project, 'dist/assets/style.css'), 'body{color:white}');
  await fs.writeFile(path.join(project, 'dist/private.json'), 'private-config');
  await fs.symlink(path.join(base, 'private.json'), path.join(project, 'dist/assets/leak.js'));
  await fs.symlink(base, path.join(project, 'dist/linked'));
  await fs.writeFile(path.join(project, 'web/src/main.ts'), 'export const title="王二火大";');
  const resources = await createResourceServer({ root: project, assetRoot: retail, port: 0, publicUrl, allowedOrigins: [frontendOrigin] });
  const runtime = { schema: 1, assets: { manifestUrl: `${resources.url}/generated/catalog.json`, wasmUrl: `${resources.url}/wasm/vera_web_core.wasm`, resourceManifestUrl: `${resources.url}/api/resources` }, network: { lobbyUrl: 'ws://127.0.0.1:5282/ws/rooms' } };
  const site = await createSiteServer({ root: project, port: 0, runtimeConfig: runtime });
  t.after(async () => { await site.close(); await resources.close(); await fs.rm(base, { recursive: true, force: true }); });
  return { base, project, retail, resources, site, runtime, retailBytes, wasmBytes, pngBytes, html };
}

test('split site publishes runtime URLs and serves production assets while resources stay on their host', async t => {
  const h = await harness(t);
  const response = await rawRequest(h.site.url, '/api/config');
  assert.equal(response.status, 200); assert.deepEqual(JSON.parse(response.body), h.runtime);
  assert.equal(response.headers['cache-control'], 'no-store');
  const head = await rawRequest(h.site.url, '/api/config', { method: 'HEAD' });
  assert.equal(head.body.length, 0); assert.equal(Number(head.headers['content-length']), response.body.length);
  assert.equal((await rawRequest(h.site.url, '/')).body.toString(), h.html);
  assert.equal((await rawRequest(h.site.url, '/lobby/local-room')).body.toString(), h.html);
  const js = await rawRequest(h.site.url, '/assets/index.js');
  assert.equal(js.status, 200); assert.match(js.headers['content-type'], /^text\/javascript/);
  const css = await rawRequest(h.site.url, '/assets/style.css'); assert.match(css.headers['content-type'], /^text\/css/);
  for (const route of ['/retail/ra2.mix', '/api/resources', '/generated/catalog.json', '/wasm/vera_web_core.wasm', '/tools/dev-server.mjs', '/vendor/vera20k/src/core_lib.rs', '/private.json']) {
    assert.equal((await rawRequest(h.site.url, route)).status, 404, route);
  }
  for (const [app, service] of [[h.site, 'site'], [h.resources, 'resources']]) {
    const health = JSON.parse((await rawRequest(app.url, '/api/health')).body);
    assert.equal(health.ok, true); assert.equal(health.service, service);
  }
});

test('resource manifest uses the shared whitelist, absolute integrity URLs and prefix-aware public URL', async t => {
  const h = await harness(t, { publicUrl: 'https://resources.example/game-assets' });
  const response = await rawRequest(h.resources.url, '/api/resources', { headers: { Origin: frontendOrigin } });
  assert.equal(response.status, 200); assert.equal(response.headers['access-control-allow-origin'], frontendOrigin);
  const manifest = JSON.parse(response.body);
  assert.deepEqual(manifest.files.map(file => file.name), ['ra2.mix', 'rulesmd.ini']);
  assert.equal(manifest.files[0].url, 'https://resources.example/game-assets/retail/ra2.mix');
  assert.equal(manifest.files[0].sha256, sha(h.retailBytes));
  assert.equal(manifest.files[0].bytes, h.retailBytes.length);
  assert.equal((await rawRequest(h.resources.url, '/api/resources', { headers: { 'If-None-Match': response.headers.etag } })).status, 304);
  for (const route of ['/index.html', '/', '/api/config', '/tools/dev-server.mjs', '/generated/private.ts', '/retail/RA2MD.INI', '/retail/keyboard.ini', '/retail/movmd03.mix', '/retail/private.cfg', '/retail/ra2md.mix']) {
    assert.equal((await rawRequest(h.resources.url, route)).status, 404, route);
  }
});

test('resource MIME, SHA ETags, HEAD and single byte ranges describe the exact served bytes', async t => {
  const h = await harness(t);
  const full = await rawRequest(h.resources.url, '/retail/RA2.MIX');
  assert.equal(full.status, 200); assert.deepEqual(full.body, h.retailBytes);
  assert.equal(full.headers.etag, `"${sha(h.retailBytes)}"`); assert.equal(full.headers['x-content-sha256'], sha(h.retailBytes));
  assert.equal(full.headers['accept-ranges'], 'bytes');
  const head = await rawRequest(h.resources.url, '/retail/ra2.mix', { method: 'HEAD' });
  assert.equal(head.body.length, 0); assert.equal(Number(head.headers['content-length']), h.retailBytes.length);
  assert.equal(head.headers.etag, full.headers.etag);
  assert.equal((await rawRequest(h.resources.url, '/retail/ra2.mix', { headers: { 'If-None-Match': `W/${full.headers.etag}` } })).status, 304);
  for (const [range, expected] of [['bytes=2-5', h.retailBytes.subarray(2, 6)], ['bytes=10-', h.retailBytes.subarray(10)], ['bytes=-4', h.retailBytes.subarray(-4)]]) {
    const part = await rawRequest(h.resources.url, '/retail/ra2.mix', { headers: { Range: range } });
    assert.equal(part.status, 206); assert.deepEqual(part.body, expected); assert.match(part.headers['content-range'], /^bytes \d+-\d+\/\d+$/);
  }
  for (const range of ['bytes=9999-', 'bytes=5-2', 'bytes=-0', 'bytes=0-1,3-4', 'not-bytes']) {
    const invalid = await rawRequest(h.resources.url, '/retail/ra2.mix', { headers: { Range: range } });
    assert.equal(invalid.status, 416, range); assert.equal(invalid.headers['content-range'], `bytes */${h.retailBytes.length}`);
  }
  const oldRange = await rawRequest(h.resources.url, '/retail/ra2.mix', { headers: { Range: 'bytes=0-1', 'If-Range': '"old"' } });
  assert.equal(oldRange.status, 200); assert.deepEqual(oldRange.body, h.retailBytes);
  const wasm = await rawRequest(h.resources.url, '/wasm/vera_web_core.wasm');
  assert.equal(wasm.headers['content-type'], 'application/wasm'); assert.deepEqual(wasm.body, h.wasmBytes); assert.equal(wasm.headers['x-content-sha256'], sha(h.wasmBytes));
  const png = await rawRequest(h.resources.url, '/generated/maps/test.png'); assert.equal(png.headers['content-type'], 'image/png'); assert.deepEqual(png.body, h.pngBytes);
});

test('catalog responses retain reverse-proxy prefixes without modifying exported JSON on disk', async t => {
  const h = await harness(t, { publicUrl: 'https://resources.example/assets/v1/' });
  const original = await fs.readFile(path.join(h.project, 'public/generated/catalog.json'), 'utf8');
  for (const name of ['catalog.json', 'manifest.json']) {
    const response = await rawRequest(h.resources.url, `/generated/${name}`);
    assert.equal(response.status, 200); const data = JSON.parse(response.body);
    assert.equal(data.maps[0].image, 'maps/test.png'); assert.equal(data.maps[0].minimap, 'maps/test.png');
    assert.equal(data.sprites.E1.image, 'maps/test.png'); assert.equal(data.sprites.E1.remapImage, 'maps/test.png'); assert.equal(data.sprites.E1.cameo, 'maps/test.png');
    assert.equal(data.sprites.E1.source, 'E1.SHP');
    assert.equal(new URL(data.maps[0].image, `https://resources.example/assets/v1/generated/${name}`).href, 'https://resources.example/assets/v1/generated/maps/test.png');
    assert.equal(response.headers['x-content-sha256'], sha(response.body));
    assert.equal(response.headers.etag, `"${sha(response.body)}"`);
    const part = await rawRequest(h.resources.url, `/generated/${name}`, { headers: { Range: 'bytes=0-15' } });
    assert.equal(part.status, 206); assert.deepEqual(part.body, response.body.subarray(0, 16));
  }
  assert.equal(await fs.readFile(path.join(h.project, 'public/generated/catalog.json'), 'utf8'), original);
});

test('resource CORS permits only configured frontend origins and readonly preflights', async t => {
  const h = await harness(t);
  const valid = await rawRequest(h.resources.url, '/wasm/vera_web_core.wasm', { method: 'OPTIONS', headers: {
    Origin: frontendOrigin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'range, if-none-match' } });
  assert.equal(valid.status, 204); assert.equal(valid.headers['access-control-allow-origin'], frontendOrigin); assert.equal(valid.headers.vary, 'Origin');
  assert.match(valid.headers['access-control-allow-methods'], /GET, HEAD/); assert.equal(valid.headers['access-control-allow-credentials'], undefined);
  for (const origin of ['https://other.example', 'null', 'http://127.0.0.1:5280.evil.example']) {
    const denied = await rawRequest(h.resources.url, '/api/resources', { headers: { Origin: origin } });
    assert.equal(denied.status, 403); assert.equal(denied.headers['access-control-allow-origin'], undefined);
  }
  assert.equal((await rawRequest(h.resources.url, '/api/resources', { method: 'OPTIONS', headers: { Origin: frontendOrigin, 'Access-Control-Request-Method': 'POST' } })).status, 403);
  assert.equal((await rawRequest(h.resources.url, '/api/resources', { method: 'OPTIONS', headers: { Origin: frontendOrigin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' } })).status, 403);
});

test('both services reject raw traversal, symlinks and HTTP writes without changing source or retail data', async t => {
  const h = await harness(t);
  for (const app of [h.resources, h.site]) {
    for (const pathname of ['/generated/../private.json', '/generated/%2e%2e/private.json', '/generated/%2f..%2fprivate.json', '/generated/%5c..%5cprivate.json', '/%00', '/%zz', '/.git/config']) {
      assert.equal((await rawRequest(app.url, pathname)).status, 400, pathname);
    }
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal((await rawRequest(app.url, app === h.site ? '/api/config' : '/retail/ra2.mix', { method, body: 'overwrite' })).status, 405);
  }
  for (const pathname of ['/generated/leak.json', '/generated/linked/private.json']) assert.equal((await rawRequest(h.resources.url, pathname)).status, 404, pathname);
  assert.equal((await rawRequest(h.site.url, '/assets/leak.js')).status, 404);
  assert.equal((await rawRequest(h.site.url, '/linked/private.json')).status, 404);
  // A previously indexed regular file must not become a filesystem escape later.
  await fs.rm(path.join(h.retail, 'ra2.mix')); await fs.symlink(path.join(h.base, 'private.json'), path.join(h.retail, 'ra2.mix'));
  assert.equal((await rawRequest(h.resources.url, '/retail/ra2.mix')).status, 404);
  assert.equal(await fs.readFile(path.join(h.base, 'private.json'), 'utf8'), '{"private":"do-not-serve"}');
  assert.equal(await fs.readFile(path.join(h.project, 'web/src/main.ts'), 'utf8'), 'export const title="王二火大";');
  assert.equal(await fs.readFile(path.join(h.project, 'dist/index.html'), 'utf8'), h.html);
});

test('resource integrity cannot silently change after indexing and served roots stay inside the owned project', async t => {
  const h = await harness(t);
  await fs.writeFile(path.join(h.retail, 'ra2.mix'), 'changed after initial SHA');
  assert.equal((await rawRequest(h.resources.url, '/retail/ra2.mix')).status, 409);
  await assert.rejects(createSiteServer({ root: h.project, distDir: h.retail, port: 0 }), /inside this project/);
  await fs.symlink(h.retail, path.join(h.project, 'foreign-public'));
  await assert.rejects(createResourceServer({ root: h.project, publicDir: 'foreign-public', assetRoot: h.retail, port: 0 }), /inside this project/);
  await assert.rejects(createResourceServer({ root: h.project, assetRoot: h.retail, port: 0, allowedOrigins: ['*'] }));
  await assert.rejects(createResourceServer({ root: h.project, assetRoot: h.retail, port: 0, publicUrl: 'file:///private' }), /Invalid resource public URL/);
});

test('development site serves Vite entrypoints and frontend modules without opening source or resource roots', async t => {
  const site = await createSiteServer({ root, production: false, port: 0 });
  t.after(() => site.close());
  for (const pathname of ['/', '/@vite/client', '/@vite/env', '/web/src/main.ts', '/web/src/engine/worker.ts', '/app-icon.png']) {
    const response = await rawRequest(site.url, pathname);
    assert.equal(response.status, 200, `${pathname}: ${response.body.toString().slice(0, 200)}`);
  }
  for (const pathname of ['/tools/dev-server.mjs', '/vendor/vera20k/src/core_lib.rs', '/@fs/etc/passwd', '/retail/ra2.mix', '/generated/catalog.json', '/wasm/vera_web_core.wasm']) {
    assert.equal((await rawRequest(site.url, pathname)).status, 404, pathname);
  }
});
