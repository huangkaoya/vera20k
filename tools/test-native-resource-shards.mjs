import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import {Readable} from 'node:stream';
import {ContentStore} from '../web-native/content-store.js';
import {createResourcePackFetch} from '../web-native/resource-packs.js';
import {createNativeServer} from './native-server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const planFile = path.join(root, 'dist/toy-resources/plan.json');
const planBytes = await fs.readFile(planFile), plan = JSON.parse(planBytes);
const catalog = JSON.parse(await fs.readFile(path.join(root, 'public/native-content/catalog.json')));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(catalog.catalogIdentity, plan.catalogIdentity);
assert.equal(plan.enabled, false, 'Approval must precede source activation');
const files = new Map();
for (const group of [catalog, ...Object.values(catalog.profiles), ...Object.values(catalog.packs)])
  for (const file of group.files) files.set(file.download.sha256, file);
assert.equal(files.size, 35);

const admitted = new Map(), requests = [];
for (const pack of plan.packs) {
  const directory = path.resolve(root, pack.directory);
  for (const name of await fs.readdir(directory)) {
    if (/\.(?:html|js|css)$/.test(name)) admitted.set(`/packs/${pack.packId}/${name}`, path.join(directory, name));
  }
  admitted.set(`/packs/${pack.packId}/v2/manifest.json`, path.join(directory, 'v2/manifest.json'));
  for (const part of pack.parts)
    admitted.set(`/packs/${pack.packId}/v2/${part.path}`, path.join(directory, 'v2', part.path));
}
let native, origin, sources;
const server = http.createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (!['GET', 'HEAD'].includes(request.method)) {response.writeHead(405).end(); return;}
    if (admitted.has(pathname)) {
      const file = admitted.get(pathname), stat = await fs.lstat(file);
      assert.ok(stat.isFile() && !stat.isSymbolicLink());
      const type = pathname.endsWith('.json') ? 'application/json' : pathname.endsWith('.html') ? 'text/html; charset=utf-8'
        : pathname.endsWith('.js') ? 'text/javascript' : pathname.endsWith('.css') ? 'text/css' : 'application/octet-stream';
      requests.push(pathname);
      response.writeHead(200, {'Content-Type': type, 'Content-Length': stat.size, 'Cache-Control': 'no-store'});
      if (request.method === 'HEAD') response.end();
      else await pipeline(createReadStream(file), response);
      return;
    }
    if (pathname === '/game/host-config.js') {
      response.writeHead(200, {'Content-Type': 'text/javascript', 'Cache-Control': 'no-store'});
      response.end(`export const serviceOrigin=${JSON.stringify(origin)};\nexport const resourcePackUrls=${JSON.stringify(sources)};\n`);
      return;
    }
    if (!native) {response.writeHead(404).end(); return;}
    const mapped = pathname.startsWith('/game/') ? pathname.slice('/game'.length) : pathname;
    // Game art must use the multipart transport. Only the engine object may
    // fall through to the native content service in this integration fixture.
    if (mapped.startsWith('/content/objects/')) {
      const engine = JSON.parse(await fs.readFile(path.join(root, 'public/native/build.json'))).outputs['werhd_bg.wasm'];
      if (mapped !== engine.download.url) throw new Error('Art attempted a whole-object fallback');
    }
    const upstream = await fetch(native.url + mapped, {method: request.method});
    response.writeHead(upstream.status, Object.fromEntries(upstream.headers));
    if (upstream.body && request.method !== 'HEAD') await pipeline(Readable.fromWeb(upstream.body), response);
    else response.end();
  } catch (error) {
    if (!response.headersSent) response.writeHead(500, {'Content-Type': 'text/plain'});
    response.end(error.message);
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
origin = `http://127.0.0.1:${server.address().port}`;
sources = plan.packs.map(pack => ({url: `${origin}/packs/${pack.packId}/v2/manifest.json`, sha256: pack.manifestSha256}));
const close = async () => {await native?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));};
try {
  const transport = await createResourcePackFetch({sources, catalog, fetch: globalThis.fetch,
    fallbackFetch: async url => {throw new Error('Unexpected art fallback: ' + url);}});
  const store = new ContentStore({cacheStorage: null, fetch: transport, retries: 0});
  const results = [];
  for (const file of files.values()) {
    let bytes = await store.loadFile(file);
    assert.equal(bytes.length, file.bytes);
    results.push({name: file.name, wireSha256: file.download.sha256, rawSha256: file.sha256, rawBytes: bytes.length});
    console.log(JSON.stringify({verified: results.length, total: files.size, name: file.name}));
    bytes = null;
    globalThis.gc?.();
  }
  const receipt = {ok: true, catalogIdentity: catalog.catalogIdentity, planSha256: sha(planBytes),
    objects: results.length, packages: plan.packs.length,
    parts: requests.filter(url => url.endsWith('.bin')).length, allArtFromShards: true,
    exactOriginalGzipAndRawHashesVerified: true, sourceActivationEnabled: false,
    maxRssKiB: process.resourceUsage().maxRSS, results};
  await fs.writeFile(path.join(root, 'validation/toy-resource-http.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt));
  if (process.argv.includes('--serve')) {
    native = await createNativeServer({port: 0, sourceCheck: true, requireChecked: true});
    await fs.writeFile(path.join(root, 'validation/toy-resource-browser-fixture.json'), JSON.stringify({origin,
      gameUrl: origin + '/game/index.html', toolUrl: origin + '/packs/' + plan.packs[0].packId + '/index.html', sources}, null, 2) + '\n');
    console.log(JSON.stringify({serving: true, game: origin + '/game/index.html', tool: origin + '/packs/' + plan.packs[0].packId + '/index.html'}));
    await new Promise(resolve => {process.once('SIGINT', resolve); process.once('SIGTERM', resolve);});
  }
} finally {await close();}
