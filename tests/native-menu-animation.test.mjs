import test from 'node:test';
import assert from 'node:assert/strict';
import {installMenuAnimationPrefetch} from '../web-native/menu-animation.js';
import {ContentStore} from '../web-native/content-store.js';

const bytes = new Uint8Array([0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0]);
const hash = async data => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), n => n.toString(16).padStart(2, '0')).join('');
async function fixture(options = {}) {
  const file = {name: 'werhd-menu.mp4', bytes: bytes.length, sha256: await hash(bytes), url: '/menu.mp4'};
  const requests = [], ready = [], states = [];
  const store = new ContentStore({cacheStorage: null, retries: 0,
    fetch: async url => { requests.push(String(url)); return new Response(options.bad ? new Uint8Array(bytes.length) : bytes); }});
  const catalog = {packs: {brandingAnimation: {files: [file], dependsOn: []},
    cinematics: {files: [{...file, name: 'movmd03.mix', url: '/campaign-movies.mix'}]}}};
  const controller = installMenuAnimationPrefetch({catalog, store, onReady: data => ready.push(data), onState: state => states.push(state)});
  return {controller, requests, ready, states, catalog, file};
}

test('only compressed branding media downloads after explicit game-ready start and SHA verification', async () => {
  const f = await fixture();
  assert.deepEqual(f.requests, []); assert.equal(f.controller.snapshot().state, 'idle');
  const first = f.controller.start(), duplicate = f.controller.start();
  assert.equal(first, duplicate); assert.equal(await first, true);
  assert.deepEqual(f.requests, ['/menu.mp4']);
  assert.equal(f.ready.length, 1); assert.deepEqual(f.ready[0], bytes);
  assert.equal(f.controller.snapshot().state, 'ready');
  assert.equal(f.catalog.packs.cinematics.files[0].url, '/campaign-movies.mix');
  f.controller.dispose();
});

test('an invalid hash keeps the existing poster and never installs media or rejects the game', async () => {
  const f = await fixture({bad: true});
  assert.equal(await f.controller.start(), false);
  assert.deepEqual(f.ready, []); assert.equal(f.controller.snapshot().state, 'unavailable');
  assert.match(f.controller.snapshot().error, /checksum|integrity|SHA|hash/i);
  f.controller.dispose();
});

test('dispose cancels its own pending job and fences a late result from media installation', async () => {
  let resolve, signal;
  const states = [], ready = [];
  const controller = installMenuAnimationPrefetch({catalog: {packs: {brandingAnimation: {
    files: [{name: 'werhd-menu.mp4', bytes: 16}], dependsOn: []}}},
    store: {loadFile: (_file, control) => { signal = control.signal; return new Promise(done => { resolve = done; }); }},
    onReady: value => ready.push(value), onState: value => states.push(value)});
  const pending = controller.start(); controller.dispose();
  assert.equal(signal.aborted, true); const count = states.length;
  resolve(bytes); assert.equal(await pending, false);
  assert.deepEqual(ready, []); assert.equal(states.length, count);
  assert.equal(await controller.start(), false);
});

test('missing or oversized branding pack cannot expand the download into campaign resources', async () => {
  for (const pack of [undefined, {files: [{name: 'movmd03.mix', bytes: 16}]},
    {files: [{name: 'werhd-menu.mp4', bytes: 9 * 1024 * 1024}]},
    {files: [{name: 'werhd-menu.mp4', bytes: 16}], dependsOn: ['cinematics']}]) {
    let calls = 0;
    const controller = installMenuAnimationPrefetch({catalog: {packs: {brandingAnimation: pack}},
      store: {loadFile: () => { calls++; }}, onReady: () => { throw new Error('unreachable'); }});
    assert.equal(await controller.start(), false); assert.equal(calls, 0);
    assert.equal(controller.snapshot().state, 'unavailable'); controller.dispose();
  }
});
