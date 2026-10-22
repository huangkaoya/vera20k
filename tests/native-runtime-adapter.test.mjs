import test from 'node:test';
import assert from 'node:assert/strict';
import {createVeraRuntime} from '../web-native/runtime-adapter.js';

test('content is frozen before gameplay while the replaceable network port remains available', async () => {
  const mounted = [], received = [], events = [];
  const module = {
    default: async ({module_or_path}) => { assert.deepEqual([...module_or_path], [0, 97, 115, 109]); },
    configure_content: text => events.push(JSON.parse(text)),
    mount_resource: (name, bytes) => mounted.push([name, [...bytes]]),
    start_browser: canvas => events.push(canvas),
    source_revision: () => 'pinned',
    browser_diagnostics: () => ({stage: 'ready'}),
    network_start: config => received.push(config), network_leave() {},
    network_receive() {}, network_drain_outbox: () => '[]',
    network_status: () => ({phase: 'running'}),
  };
  const runtime = await createVeraRuntime({moduleUrl: '/native/engine.js', engineBytes: new Uint8Array([0, 97, 115, 109]),
    importModule: async url => { assert.equal(url, '/native/engine.js'); return module; }});
  assert.throws(() => runtime.start('canvas'), /资源能力/);
  runtime.configureContent({campaign: false, movies: false, music: false, menuAnimation: false});
  runtime.mountResource('core.mix', new Uint8Array([1, 2, 3]));
  runtime.start('canvas');
  assert.throws(() => runtime.configureContent({campaign: true}), /运行期间/);
  assert.throws(() => runtime.mountResource('optional.mix', new Uint8Array([4])), /运行期间/);
  assert.throws(() => runtime.start('canvas'), /运行期间/);
  runtime.network.network_start('match');
  assert.deepEqual(received, ['match']);
  assert.deepEqual(runtime.networkStatus(), {phase: 'running'});
  assert.deepEqual(mounted, [['core.mix', [1, 2, 3]]]);
  assert.equal(events[0].campaign, false);
  assert.equal(events[1], 'canvas');
});
