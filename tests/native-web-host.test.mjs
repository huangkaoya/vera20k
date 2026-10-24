import test from 'node:test';
import assert from 'node:assert/strict';
import {createWebHost} from '../web-native/host.js';
import {staticRelease} from '../web-native/host-config.js';

const engineObject = `/content/objects/${'a'.repeat(64)}`;
const releaseConfig = () => ({build: 'native/build.json', catalog: 'native/catalog.json',
  module: 'native/werhd.js', content: {[engineObject]: 'native/engine.bin'}});

test('regular web deployment uses its own service origin while assets follow the module', () => {
  const host = createWebHost({origin: '', pageUrl: 'http://127.0.0.1:5280/', moduleUrl: 'http://127.0.0.1:5280/host.js'});
  assert.equal(host.serviceUrl('/api/native/resources'), 'http://127.0.0.1:5280/api/native/resources');
  assert.equal(host.serviceUrl('/ws/native'), 'http://127.0.0.1:5280/ws/native');
  assert.equal(host.assetUrl('fonts/ui.ttf'), 'http://127.0.0.1:5280/fonts/ui.ttf');
  assert.equal(host.buildUrl(), 'http://127.0.0.1:5280/native/build.json');
  assert.equal(host.catalogUrl(), 'http://127.0.0.1:5280/api/native/resources');
  assert.equal(host.engineModuleUrl('123'), 'http://127.0.0.1:5280/native/werhd.js?sha256=123');
  assert.equal(staticRelease, null, 'Toy bundling must not change local/Cloudflare defaults');
});

test('Toy child paths keep local assets and route original catalog URLs to Cloudflare', async () => {
  const calls = [], signal = new AbortController().signal;
  const host = createWebHost({origin: 'https://wan.youlidefuchou.com',
    pageUrl: 'https://www.bilibilitoy.com/toy/preview/example/index.html',
    moduleUrl: 'https://www.bilibilitoy.com/toy/preview/example/host.js',
    fetch: async (...args) => {calls.push(args); return new Response('original gzip bytes');}});
  const catalogFile = {url: '/content/objects/123', sha256: 'unchanged'};
  assert.equal(host.assetUrl('fonts/ui.ttf'), 'https://www.bilibilitoy.com/toy/preview/example/fonts/ui.ttf');
  assert.equal(host.serviceUrl('/native/werhd.js?sha256=123'), 'https://wan.youlidefuchou.com/native/werhd.js?sha256=123');
  assert.equal(host.serviceUrl('/ws/native'), 'https://wan.youlidefuchou.com/ws/native');
  assert.equal(host.buildUrl(), 'https://wan.youlidefuchou.com/native/build.json');
  assert.equal(host.catalogUrl(), 'https://wan.youlidefuchou.com/api/native/resources');
  assert.equal(host.engineModuleUrl('123'), 'https://wan.youlidefuchou.com/native/werhd.js?sha256=123');
  assert.equal(await (await host.fetchContent(catalogFile.url, {signal, credentials: 'include'})).text(), 'original gzip bytes');
  assert.deepEqual(calls, [['https://wan.youlidefuchou.com/content/objects/123', {signal, credentials: 'omit'}]]);
  assert.deepEqual(catalogFile, {url: '/content/objects/123', sha256: 'unchanged'});
});

test('Toy static releases keep all startup HTTP requests inside their module directory', async t => {
  for (const directory of ['/toy/werhd/', '/toy/preview/author_example/', '/toy/werhd/v2/'])
    await t.test(directory, async () => {
      const calls = [], signal = new AbortController().signal;
      const base = `https://www.bilibilitoy.com${directory}`;
      const host = createWebHost({origin: 'https://wan.youlidefuchou.com',
        pageUrl: 'https://www.bilibili.com/toy/werhd/index.html',
        moduleUrl: `${base}host.js?version=123`, staticRelease: releaseConfig(),
        fetch: async (...args) => { calls.push(args); return new Response('pinned engine gzip'); }});
      assert.equal(host.buildUrl(), `${base}native/build.json`);
      assert.equal(host.catalogUrl(), `${base}native/catalog.json`);
      assert.equal(host.engineModuleUrl('123'), `${base}native/werhd.js`);
      assert.equal(host.assetUrl('fonts/ui.ttf'), `${base}fonts/ui.ttf`);
      assert.equal(host.serviceUrl('/ws/native'), 'https://wan.youlidefuchou.com/ws/native');
      assert.equal(await (await host.fetchContent(engineObject, {signal, credentials: 'include'})).text(), 'pinned engine gzip');
      assert.deepEqual(calls, [[`${base}native/engine.bin`, {signal, credentials: 'omit'}]]);
      assert.ok([host.buildUrl(), host.catalogUrl(), host.engineModuleUrl(), calls[0][0]]
        .every(url => new URL(url).origin === 'https://www.bilibilitoy.com'));
    });
});

test('static fallback rejects every unbundled object and never contacts Cloudflare', async () => {
  const calls = [], config = releaseConfig();
  const host = createWebHost({origin: 'https://wan.youlidefuchou.com',
    moduleUrl: 'https://www.bilibilitoy.com/toy/werhd/host.js', staticRelease: config,
    fetch: async (...args) => { calls.push(args); return new Response(); }});
  // Mutating the supplied map after construction cannot add an unchecked route.
  config.content['/content/objects/' + 'b'.repeat(64)] = 'https://wan.youlidefuchou.com/file';
  for (const url of ['/content/objects/' + 'b'.repeat(64), '/native/werhd_bg.wasm',
    engineObject + '?changed=1', 'https://wan.youlidefuchou.com' + engineObject,
    'https://other.example' + engineObject])
    await assert.rejects(host.fetchContent(url), /未包含/);
  assert.deepEqual(calls, []);
});

test('static release config rejects invalid shapes, escaped paths and cross-origin files', async t => {
  const options = {origin: 'https://wan.youlidefuchou.com', moduleUrl: 'https://www.bilibilitoy.com/toy/werhd/host.js'};
  for (const config of [false, [], {}, {...releaseConfig(), content: {}}, {...releaseConfig(), typo: true},
    {...releaseConfig(), content: {'/native/werhd_bg.wasm': 'native/engine.bin'}}])
    assert.throws(() => createWebHost({...options, staticRelease: config}), /静态游戏/);
  for (const relative of ['https://other.example/file', '//other.example/file', '/native/file', '../file',
    'native/../file', 'native/%2e%2e/file', 'native\\file', 'native/file?x=1', 'native/file#hash', '.', 'native//file'])
    await t.test(relative, () => {
      for (const field of ['build', 'catalog', 'module', 'content']) {
        const config = releaseConfig();
        if (field === 'content') config.content[engineObject] = relative; else config[field] = relative;
        assert.throws(() => createWebHost({...options, staticRelease: config}), /静态游戏文件/);
      }
    });
  for (const moduleUrl of ['file:///tmp/host.js', 'data:text/javascript,', 'https://user:password@game.example/host.js'])
    assert.throws(() => createWebHost({...options, moduleUrl, staticRelease: releaseConfig()}), /静态游戏文件地址/);
  const config = releaseConfig(); config.build = './native/build.json';
  assert.equal(createWebHost({...options, staticRelease: config}).buildUrl(), 'https://www.bilibilitoy.com/toy/werhd/native/build.json');
});

test('host configuration rejects non-HTTP and credential-bearing service URLs', () => {
  for (const origin of ['file:///tmp/game', 'javascript:alert(1)', 'https://name:password@game.test/'])
    assert.throws(() => createWebHost({origin}), /服务地址/);
});
