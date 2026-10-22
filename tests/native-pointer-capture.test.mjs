import test from 'node:test';
import assert from 'node:assert/strict';
import {installPointerCapture} from '../web-native/pointer-capture.js';

class Target {
  listeners = new Map();
  addEventListener(type, callback) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(callback); }
  removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
  emit(type, data = {}) {
    const event = {pointerType: 'mouse', pointerId: 1, isTrusted: true, prevented: false, stopped: false,
      preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...data};
    for (const callback of this.listeners.get(type) ?? []) callback(event);
    return event;
  }
}
function fixture() {
  const canvas = new Target(), doc = new Target(), win = new Target();
  const state = {pointerCaptureAllowed: true};
  let requests = 0, exits = 0, timer, cleared = false;
  canvas.requestPointerLock = () => { ++requests; };
  doc.exitPointerLock = () => { ++exits; doc.pointerLockElement = null; };
  const controller = installPointerCapture({canvas, document: doc, window: win, getState: () => state,
    setInterval: callback => { timer = callback; return 7; }, clearInterval: id => { assert.equal(id, 7); cleared = true; }});
  return {canvas, doc, win, state, controller, tick: () => timer(), requests: () => requests, exits: () => exits, cleared: () => cleared};
}

test('mouse engagement acquires once and consumes the complete acquisition click', () => {
  const f = fixture();
  assert.equal(f.canvas.emit('pointerdown').stopped, true);
  assert.equal(f.requests(), 1);
  // A delayed browser response must not consume every subsequent game click.
  assert.equal(f.canvas.emit('pointerdown').stopped, false); assert.equal(f.requests(), 1);
  f.doc.pointerLockElement = f.canvas; f.doc.emit('pointerlockchange');
  assert.equal(f.canvas.emit('pointerup').stopped, true);
  assert.equal(f.canvas.emit('click').prevented, true);
  assert.equal(f.canvas.emit('pointerdown').stopped, false);
  assert.equal(f.requests(), 1);
  f.controller.dispose();
});

test('native gameplay admission fails closed while non-mouse and untrusted events never acquire', () => {
  const f = fixture();
  for (const pointerType of ['touch', 'pen']) assert.equal(f.canvas.emit('pointerdown', {pointerType}).stopped, false);
  f.canvas.emit('pointerdown', {isTrusted: false});
  // Menus, pauses, dialogs, results, touch and the cursor preference are
  // admitted by the native owner represented by this one read-only field.
  f.state.pointerCaptureAllowed = false; f.canvas.emit('pointerdown');
  delete f.state.pointerCaptureAllowed; f.canvas.emit('pointerdown');
  f.state.pointerCaptureAllowed = true; f.doc.hidden = true; f.canvas.emit('pointerdown');
  assert.equal(f.requests(), 0);
  f.controller.dispose();
});

test('Esc unlock does not auto-reacquire and next mouse gesture only reacquires', () => {
  const f = fixture();
  f.canvas.emit('pointerdown'); f.doc.pointerLockElement = f.canvas; f.doc.emit('pointerlockchange');
  f.canvas.emit('pointerup'); f.canvas.emit('click');
  f.doc.pointerLockElement = null; f.doc.emit('pointerlockchange'); f.tick();
  assert.equal(f.requests(), 1);
  assert.equal(f.canvas.emit('pointerdown').stopped, true);
  assert.equal(f.requests(), 2);
  f.controller.dispose();
});

test('native menu admission, hidden page and blur release only this canvas', () => {
  const f = fixture();
  for (const transition of [() => { f.state.pointerCaptureAllowed = false; },
    () => { delete f.state.pointerCaptureAllowed; }, () => { f.doc.hidden = true; }]) {
    f.state.pointerCaptureAllowed = true; f.doc.hidden = false;
    f.doc.pointerLockElement = f.canvas; transition(); f.tick();
  }
  assert.equal(f.exits(), 3);
  f.doc.pointerLockElement = f.canvas; f.win.emit('blur'); assert.equal(f.exits(), 4);
  f.doc.pointerLockElement = {}; f.tick(); assert.equal(f.exits(), 4);
  f.controller.dispose(); assert.equal(f.cleared(), true);
  assert.ok([...f.canvas.listeners.values(), ...f.doc.listeners.values(), ...f.win.listeners.values()].every(set => !set.size));
});

test('unsupported or rejected pointer lock leaves ordinary absolute input available', async () => {
  const f = fixture();
  delete f.canvas.requestPointerLock;
  assert.equal(f.canvas.emit('pointerdown').stopped, false);
  f.canvas.requestPointerLock = () => Promise.reject(new Error('not available'));
  f.canvas.emit('pointerdown'); await Promise.resolve();
  // The failed request consumed only its engagement gesture, not later input.
  assert.equal(f.canvas.emit('pointerdown').stopped, false);
  f.state.pointerCaptureAllowed = false; assert.equal(f.canvas.emit('pointerdown').stopped, false);
  f.controller.dispose();
});

test('read-only snapshot distinguishes browser capability, pending request and actual ownership', () => {
  const f = fixture();
  assert.deepEqual(f.controller.snapshot(), {supported: true, locked: false, pending: false, error: null});
  f.canvas.emit('pointerdown');
  assert.deepEqual(f.controller.snapshot(), {supported: true, locked: false, pending: true, error: null});
  f.doc.pointerLockElement = f.canvas; f.doc.emit('pointerlockchange');
  assert.deepEqual(f.controller.snapshot(), {supported: true, locked: true, pending: false, error: null});
  delete f.canvas.requestPointerLock;
  assert.equal(f.controller.snapshot().supported, false);
  assert.ok(Object.isFrozen(f.controller.snapshot()));
  f.controller.dispose();
});

test('rejection diagnostics retain bounded browser name/message and enable ordinary clicks', async () => {
  const f = fixture();
  const reason = Object.assign(new Error('Denied by embedding permissions policy'), {name: 'SecurityError'});
  f.canvas.requestPointerLock = () => Promise.reject(reason);
  f.canvas.emit('pointerdown'); await Promise.resolve();
  assert.deepEqual(f.controller.snapshot(), {supported: true, locked: false, pending: false,
    error: {name: 'SecurityError', message: 'Denied by embedding permissions policy'}});
  // Generic pointerlockerror must not replace the useful Promise rejection.
  f.doc.emit('pointerlockerror');
  assert.equal(f.controller.snapshot().error.name, 'SecurityError');
  assert.equal(f.canvas.emit('pointerdown').stopped, false);
  assert.ok(Object.isFrozen(f.controller.snapshot().error));
  // A deliberate lifecycle exit allows a later mouse gesture to retry.
  f.win.emit('blur');
  assert.equal(f.canvas.emit('pointerdown').stopped, false);
  f.win.emit('focus');
  assert.equal(f.canvas.emit('pointerdown').stopped, true);
  await Promise.resolve(); f.controller.dispose();
});

test('legacy pointerlockerror and synchronous errors are visible without a Promise', () => {
  const f = fixture();
  f.canvas.emit('pointerdown'); f.doc.emit('pointerlockerror');
  assert.equal(f.controller.snapshot().error.name, 'PointerLockError');
  assert.equal(f.controller.snapshot().pending, false);
  f.win.emit('blur'); f.win.emit('focus');
  f.canvas.requestPointerLock = () => { throw Object.assign(new Error('x'.repeat(500)), {name: 'NotSupportedError'}); };
  f.canvas.emit('pointerdown');
  assert.equal(f.controller.snapshot().error.name, 'NotSupportedError');
  assert.equal(f.controller.snapshot().error.message.length, 400);
  f.controller.dispose();
});

test('a grant after blur is revoked even when focus returns before it arrives', () => {
  const f = fixture();
  f.canvas.emit('pointerdown'); f.win.emit('blur'); f.win.emit('focus');
  f.doc.pointerLockElement = f.canvas; f.doc.emit('pointerlockchange');
  assert.equal(f.exits(), 1);
  assert.equal(f.controller.snapshot().locked, false);
  f.controller.dispose();
});

test('a delayed modern grant after disposal is released by Promise completion', async () => {
  const f = fixture(); let grant;
  f.canvas.requestPointerLock = () => new Promise(resolve => { grant = resolve; });
  f.canvas.emit('pointerdown'); f.controller.dispose();
  f.doc.pointerLockElement = f.canvas; grant(); await Promise.resolve();
  assert.equal(f.exits(), 1);
  assert.ok([...f.canvas.listeners.values(), ...f.doc.listeners.values(), ...f.win.listeners.values()].every(set => !set.size));
});

test('a delayed legacy grant after disposal has only a completion guard until resolved', () => {
  const f = fixture();
  f.canvas.emit('pointerdown'); f.controller.dispose();
  assert.ok([...f.canvas.listeners.values(), ...f.win.listeners.values()].every(set => !set.size));
  f.doc.pointerLockElement = f.canvas; f.doc.emit('pointerlockchange');
  assert.equal(f.exits(), 1);
  assert.ok([...f.doc.listeners.values()].every(set => !set.size));
});

test('the document focus check independently prevents capture when no blur arrived', () => {
  const f = fixture(); f.doc.hasFocus = () => false;
  assert.equal(f.canvas.emit('pointerdown').stopped, false);
  assert.equal(f.requests(), 0);
  f.controller.dispose();
});
