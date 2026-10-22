import test from 'node:test';
import assert from 'node:assert/strict';
import {createVeraRuntime} from '../web-native/runtime-adapter.js';

test('content is frozen before gameplay while the replaceable network port remains available', async () => {
  const mounted = [], received = [], events = [], shell = [], movies = [];
  let diagnosticsReads = 0, pointerAllowed = true, menuActive = true;
  const module = {
    default: async ({module_or_path}) => { assert.deepEqual([...module_or_path], [0, 97, 115, 109]); },
    configure_content: text => events.push(JSON.parse(text)),
    mount_resource: (name, bytes) => mounted.push([name, [...bytes]]),
    start_browser: canvas => events.push(canvas),
    source_revision: () => 'pinned',
    browser_diagnostics: () => { ++diagnosticsReads; return {stage: 'ready'}; },
    browser_pointer_capture_allowed: () => pointerAllowed,
    browser_menu_active: () => menuActive,
    network_start: config => received.push(config), network_leave() {},
    network_receive() {}, network_drain_outbox: () => '[]',
    network_status: () => ({phase: 'running'}),
    browser_shell_update: text => shell.push(JSON.parse(text)),
    install_menu_animation: bytes => movies.push([...bytes]),
  };
  const runtime = await createVeraRuntime({moduleUrl: '/native/engine.js', engineBytes: new Uint8Array([0, 97, 115, 109]),
    importModule: async url => { assert.equal(url, '/native/engine.js'); return module; }});
  assert.throws(() => runtime.start('canvas'), /资源能力/);
  assert.equal(runtime.pointerCaptureAllowed(), false);
  assert.equal(runtime.menuActive(), false);
  assert.throws(() => runtime.installMenuAnimation(new Uint8Array([1])), /初始化/);
  runtime.configureContent({campaign: false, movies: false, music: false, menuAnimation: false});
  runtime.mountResource('core.mix', new Uint8Array([1, 2, 3]));
  runtime.start('canvas');
  assert.equal(runtime.pointerCaptureAllowed(), true);
  assert.equal(runtime.menuActive(), true);
  pointerAllowed = false; menuActive = false;
  assert.equal(runtime.pointerCaptureAllowed(), false);
  assert.equal(runtime.menuActive(), false);
  assert.equal(diagnosticsReads, 0, 'normal capability checks must not enable full diagnostics');
  assert.throws(() => runtime.configureContent({campaign: true}), /运行期间/);
  assert.throws(() => runtime.mountResource('optional.mix', new Uint8Array([4])), /运行期间/);
  assert.throws(() => runtime.start('canvas'), /运行期间/);
  assert.throws(() => runtime.installMenuAnimation('movie'), /二进制/);
  runtime.installMenuAnimation(new Uint8Array([4, 5]));
  assert.deepEqual(movies, [[4, 5]]);
  runtime.network.network_start('match');
  runtime.updateShell({schema: 1, lobby: {open: true, name: '指挥官'}});
  assert.deepEqual(shell, [{schema: 1, lobby: {open: true, name: '指挥官'}}]);
  assert.deepEqual(received, ['match']);
  assert.deepEqual(runtime.networkStatus(), {phase: 'running'});
  assert.deepEqual(mounted, [['core.mix', [1, 2, 3]]]);
  assert.equal(events[0].campaign, false);
  assert.equal(events[1], 'canvas');
});
