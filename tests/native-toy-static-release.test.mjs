import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {gzipSync, gunzipSync} from 'node:zlib';
import {createToyStaticRelease} from '../tools/toy-static-release.mjs';
import {createWebHost} from '../web-native/host.js';

const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
function catalogIdentity(catalog) {
  const {catalogIdentity, ...body} = catalog;
  return sha(JSON.stringify(canonical(body)));
}
function fixture() {
  const raw = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
  const engineGzip = gzipSync(raw), engineModule = Buffer.from('export default async function init() {}\n');
  const catalog = {schema: 2, identity: sha('required resources'), defaultProfile: 'skirmish',
    files: [], profiles: {skirmish: {files: []}, full: {files: []}}, packs: {}};
  catalog.catalogIdentity = catalogIdentity(catalog);
  const build = {schema: 2, renderer: 'WERHD wgpu/WebGPU', patchSha256: sha('patch'),
    contentCatalogIdentity: catalog.catalogIdentity, resourceManifestSha256: catalog.identity,
    outputs: {'werhd.js': {bytes: engineModule.length, sha256: sha(engineModule)},
      'werhd_bg.wasm': {bytes: raw.length, sha256: sha(raw), download: {
        url: `/content/objects/${sha(engineGzip)}`, bytes: engineGzip.length,
        sha256: sha(engineGzip), encoding: 'gzip'}}}};
  const sourceFiles = new Map([
    ['index.html', Buffer.from('<!doctype html><html><title>王二火大</title><link rel="icon" href="./branding/icon.png"><link rel="stylesheet" href="./game.css"><script type="module" src="./bootstrap.js"></script></html>')],
    ['bootstrap.js', Buffer.from("import './host.js';\n")],
    ['host.js', Buffer.from("import './host-config.js';\n")],
    ['host-config.js', Buffer.from('export const staticRelease = null;\n')],
    ['game.css', Buffer.from('body{background:#000}')],
    ['branding/icon.png', Buffer.from('test icon')],
    ['fonts/FiraSansCondensed-Medium.ttf', Buffer.from('test font')],
    ['fonts/FiraSansCondensed-OFL', Buffer.from('test font license')],
  ]);
  const resourcePackUrls = Array.from({length: 19}, (_, index) => ({
    url: `https://www.bilibilitoy.com/toy/test-${index + 1}/v2/manifest.json`, sha256: sha(`manifest ${index}`),
  }));
  return {sourceFiles, build, catalog, engineModule, engineGzip, resourcePackUrls,
    origin: 'https://wan.youlidefuchou.com'};
}
const exportedConfig = result => import('data:text/javascript;base64,'
  + result.files.get(`${result.releaseDirectory}/host-config.js`).toString('base64'));

test('Toy release bundles the complete startup graph in one immutable directory', async () => {
  const input = fixture(), result = createToyStaticRelease(input), directory = result.releaseDirectory;
  assert.match(result.releaseId, /^[a-f0-9]{20}$/);
  assert.equal(directory, `releases/${result.releaseId}`);
  assert.deepEqual([...result.files.keys()].filter(name => !name.startsWith(directory + '/')).sort(),
    ['index.html', 'werhd-release.json']);
  for (const name of input.sourceFiles.keys()) if (name !== 'index.html')
    assert.ok(result.files.has(`${directory}/${name}`), `missing versioned source: ${name}`);
  assert.deepEqual(JSON.parse(result.files.get(`${directory}/native/build.json`)), input.build);
  assert.deepEqual(JSON.parse(result.files.get(`${directory}/native/catalog.json`)), input.catalog);
  assert.deepEqual(result.files.get(`${directory}/native/werhd.js`), input.engineModule);
  assert.deepEqual(result.files.get(`${directory}/native/engine.bin`), input.engineGzip);
  assert.equal(sha(gunzipSync(result.files.get(`${directory}/native/engine.bin`))), input.build.outputs['werhd_bg.wasm'].sha256);
  const rootHtml = result.files.get('index.html').toString();
  assert.match(rootHtml, new RegExp(`data-werhd-release="${result.releaseId}"`));
  const references = [...rootHtml.matchAll(/(?:src|href)="([^"]+)"/g)].map(match => match[1]);
  assert.equal(references.length, 3);
  assert.ok(references.every(reference => reference.startsWith(`./${directory}/`)));
  assert.ok(references.includes(`./${directory}/bootstrap.js`));
  const config = await exportedConfig(result);
  assert.equal(config.serviceOrigin, input.origin);
  assert.deepEqual(config.resourcePackUrls, input.resourcePackUrls);
  assert.deepEqual(config.staticRelease, result.staticRelease);
  const release = JSON.parse(result.files.get('werhd-release.json'));
  assert.equal(release.releaseDirectory, directory);
  assert.equal(release.engineBundled, true);
  assert.equal(release.artTransport, 'toy-resource-shards');
});

test('identical Toy release inputs and reordered source maps produce identical bytes and directory', () => {
  const input = fixture(), first = createToyStaticRelease(input), second = createToyStaticRelease(fixture());
  assert.equal(second.releaseDirectory, first.releaseDirectory);
  assert.deepEqual(second.files, first.files);
  const reordered = createToyStaticRelease({...input, sourceFiles: new Map([...input.sourceFiles].reverse())});
  assert.equal(reordered.releaseDirectory, first.releaseDirectory);
  assert.deepEqual([...reordered.files].sort(), [...first.files].sort());
});

test('changes to each exported source or generated configuration create a new version directory', async t => {
  const original = createToyStaticRelease(fixture()).releaseDirectory;
  for (const name of fixture().sourceFiles.keys()) {
    // This placeholder is replaced by the generated, reviewed configuration.
    if (name === 'host-config.js') continue;
    await t.test(name, () => {
      const input = fixture(); input.sourceFiles.set(name, Buffer.concat([input.sourceFiles.get(name), Buffer.from('\nchanged')]));
      assert.notEqual(createToyStaticRelease(input).releaseDirectory, original);
    });
  }
  for (const [name, change] of Object.entries({
    origin: input => { input.origin = 'https://multiplayer.example'; },
    pin: input => { input.resourcePackUrls[0].sha256 = sha('changed pin'); },
    source: input => { input.resourcePackUrls[0].url = 'https://www.bilibilitoy.com/toy/changed/v2/manifest.json'; },
    build: input => { input.build.patchSha256 = sha('changed patch'); },
    catalog: input => {
      input.catalog.description = 'changed catalog';
      input.catalog.catalogIdentity = catalogIdentity(input.catalog);
      input.build.contentCatalogIdentity = input.catalog.catalogIdentity;
    },
  })) await t.test(name, () => {
    const input = fixture(); change(input);
    assert.notEqual(createToyStaticRelease(input).releaseDirectory, original);
  });
});

test('engine module, transfer object and decompressed WASM must match the pinned build', async t => {
  const changes = {
    'module bytes': input => { input.engineModule = Buffer.from('changed module'); },
    'module size': input => { input.build.outputs['werhd.js'].bytes++; },
    'module hash': input => { input.build.outputs['werhd.js'].sha256 = sha('different module'); },
    'gzip bytes': input => { input.engineGzip = gzipSync(Buffer.from('changed raw')); },
    'wire size': input => { input.build.outputs['werhd_bg.wasm'].download.bytes++; },
    'wire hash': input => { input.build.outputs['werhd_bg.wasm'].download.sha256 = sha('different gzip'); },
    'wire URL': input => { input.build.outputs['werhd_bg.wasm'].download.url = '/somewhere/engine.bin'; },
    'wire encoding': input => { input.build.outputs['werhd_bg.wasm'].download.encoding = 'identity'; },
    'raw hash': input => { input.build.outputs['werhd_bg.wasm'].sha256 = sha('different WASM'); },
    'raw size': input => { input.build.outputs['werhd_bg.wasm'].bytes++; },
  };
  for (const [name, change] of Object.entries(changes)) await t.test(name, () => {
    const input = fixture(); change(input);
    assert.throws(() => createToyStaticRelease(input), /bundled engine bytes|checked WASM/);
  });
});

test('catalog identities and all 19 reviewed sources are required', async t => {
  for (const [name, change] of Object.entries({
    'catalog bytes': input => { input.catalog.changed = true; },
    'catalog identity': input => { input.catalog.catalogIdentity = sha('incorrect catalog'); },
    'build catalog identity': input => { input.build.contentCatalogIdentity = sha('different catalog'); },
    'required identity': input => { input.build.resourceManifestSha256 = sha('different resources'); },
  })) await t.test(name, () => {
    const input = fixture(); change(input);
    assert.throws(() => createToyStaticRelease(input), /catalog identities differ/);
  });
  for (const sources of [undefined, [], fixture().resourcePackUrls.slice(0, 18), [...fixture().resourcePackUrls, {}]]) {
    const input = fixture(); input.resourcePackUrls = sources;
    assert.throws(() => createToyStaticRelease(input), /all 19 reviewed art sources/);
  }
});

test('the generated static config resolves all startup HTTP under Toy while retaining the multiplayer service', async t => {
  const input = fixture(), result = createToyStaticRelease(input), config = await exportedConfig(result);
  for (const base of ['https://www.bilibilitoy.com/toy/werhd/', 'https://www.bilibilitoy.com/toy/preview/author_example/'])
    await t.test(base, async () => {
      const directory = `${base}${result.releaseDirectory}/`, calls = [];
      const fetch = async (url, options) => {
        calls.push({url, options});
        assert.equal(new URL(url).origin, 'https://www.bilibilitoy.com');
        assert.ok(url.startsWith(directory));
        const relative = url.slice(base.length);
        assert.ok(result.files.has(relative), `missing real bundled file: ${relative}`);
        return new Response(result.files.get(relative));
      };
      const host = createWebHost({origin: config.serviceOrigin, staticRelease: config.staticRelease,
        moduleUrl: `${directory}host.js`, pageUrl: 'https://www.bilibili.com/toy/werhd/index.html', fetch});
      assert.deepEqual(await (await fetch(host.buildUrl())).json(), input.build);
      assert.deepEqual(await (await fetch(host.catalogUrl())).json(), input.catalog);
      assert.deepEqual(Buffer.from(await (await fetch(host.engineModuleUrl(input.build.outputs['werhd.js'].sha256))).arrayBuffer()), input.engineModule);
      const signal = new AbortController().signal;
      const response = await host.fetchContent(input.build.outputs['werhd_bg.wasm'].download.url,
        {signal, credentials: 'include'});
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), input.engineGzip);
      assert.deepEqual(calls[3].options, {signal, credentials: 'omit'});
      assert.equal(host.serviceUrl('/ws/native'), 'https://wan.youlidefuchou.com/ws/native');
      assert.equal(calls.length, 4);
    });
});
