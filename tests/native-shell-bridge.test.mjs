import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeShellBridge} from '../web-native/shell-bridge.js';

function event(detail) { const value = new Event('vera-shell-action'); value.detail = detail; return value; }
test('hidden shell bridge queues detached snapshots before the native runtime and routes semantic actions', () => {
  const target = new EventTarget(), updates = [], commands = [], failures = [];
  const bridge = createNativeShellBridge({eventTarget: target, onError: error => failures.push(error)});
  const snapshot = {schema: 1, open: false, profiles: [{id: 'skirmish', checked: true}]};
  bridge.publish('content', snapshot); snapshot.profiles[0].checked = false;
  bridge.attach('content', {dispatch: action => commands.push(action)});
  bridge.setRuntime({updateShell: value => updates.push(value)});
  assert.equal(updates[0].content.profiles[0].checked, true);
  target.dispatchEvent(event({surface: 'content', action: 'open', pack: 'campaign'}));
  target.dispatchEvent(event({surface: 'simulation', action: 'move'}));
  assert.deepEqual(commands, [{surface: 'content', action: 'open', pack: 'campaign'}]);
  bridge.publish('lobby', {schema: 1, open: true, phase: 'entry'});
  assert.deepEqual(updates[1], {schema: 1, lobby: {schema: 1, open: true, phase: 'entry'}});
  assert.deepEqual(failures, []); bridge.dispose();
});
test('bridge disposal removes the listener and controllers; late actions and snapshots are inert', async () => {
  const target = new EventTarget(), updates = [], failures = []; let disposed = 0;
  const bridge = createNativeShellBridge({eventTarget: target, onError: error => failures.push(error.message)});
  bridge.attach('lobby', {dispatch: () => Promise.reject(new Error('service unavailable')), dispose: () => disposed++});
  bridge.setRuntime({updateShell: value => updates.push(value)});
  target.dispatchEvent(event({surface: 'lobby', action: 'create'})); await Promise.resolve();
  assert.deepEqual(failures, ['service unavailable']);
  bridge.dispose(); bridge.dispose();
  target.dispatchEvent(event({surface: 'lobby', action: 'create'})); bridge.publish('lobby', {open: true});
  assert.equal(disposed, 1); assert.deepEqual(updates, []);
});
