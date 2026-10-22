import test from 'node:test';
import assert from 'node:assert/strict';
import {createWebHost} from '../web-native/host.js';

test('regular web deployment uses its own service origin while assets follow the module', () => {
  const host = createWebHost({origin: '', pageUrl: 'http://127.0.0.1:5280/', moduleUrl: 'http://127.0.0.1:5280/host.js'});
  assert.equal(host.serviceUrl('/api/native/resources'), 'http://127.0.0.1:5280/api/native/resources');
  assert.equal(host.serviceUrl('/ws/native'), 'http://127.0.0.1:5280/ws/native');
  assert.equal(host.assetUrl('fonts/ui.ttf'), 'http://127.0.0.1:5280/fonts/ui.ttf');
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
  assert.equal(await (await host.fetchContent(catalogFile.url, {signal, credentials: 'include'})).text(), 'original gzip bytes');
  assert.deepEqual(calls, [['https://wan.youlidefuchou.com/content/objects/123', {signal, credentials: 'omit'}]]);
  assert.deepEqual(catalogFile, {url: '/content/objects/123', sha256: 'unchanged'});
});

test('host configuration rejects non-HTTP and credential-bearing service URLs', () => {
  for (const origin of ['file:///tmp/game', 'javascript:alert(1)', 'https://name:password@game.test/'])
    assert.throws(() => createWebHost({origin}), /服务地址/);
});
