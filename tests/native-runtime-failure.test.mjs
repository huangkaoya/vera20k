import test from 'node:test';
import assert from 'node:assert/strict';
import {watchRuntimeFailure} from '../web-native/runtime-failure.js';

function fixture(dataset = {werhdStage: 'ready'}) {
  const observers = [], failures = [], canvas = {dataset: {...dataset}};
  class Observer {
    constructor(callback) { this.callback = callback; this.disconnects = 0; observers.push(this); }
    observe(target, options) { this.target = target; this.options = options; }
    disconnect() { ++this.disconnects; }
    // Queued mutation callbacks may still run after disconnection.
    notify() { this.callback([]); }
  }
  const watcher = watchRuntimeFailure({canvas, MutationObserver: Observer,
    onFailure: failure => {
      assert.equal(observers[0].disconnects, 1, 'disconnect before cleanup can generate another native error');
      failures.push(failure);
    }});
  return {canvas, observer: observers[0], failures, watcher};
}

test('ready and ordinary loading-stage updates keep the fatal monitor active without failing', () => {
  const {canvas, observer, failures, watcher} = fixture({werhdStage: 'starting'});
  canvas.dataset.werhdStage = 'ready'; observer.notify();
  canvas.dataset.werhdLoadStage = 'first-battle-frame'; observer.notify();
  canvas.dataset.werhdError = 'an old diagnostic without a fatal stage'; observer.notify();
  assert.deepEqual(failures, []);
  assert.equal(observer.disconnects, 0);
  assert.equal(observer.target, canvas);
  assert.ok(observer.options.attributeFilter.includes('data-werhd-stage'));
  watcher.dispose();
});

test('a runtime fatal reports its message and load stage once and disconnects before notifying', () => {
  const {canvas, observer, failures, watcher} = fixture();
  canvas.dataset.werhdLoadStage = 'first-battle-frame';
  canvas.dataset.werhdError = 'GPU validation failed';
  canvas.dataset.werhdStage = 'error'; observer.notify();
  assert.equal(observer.disconnects, 1);
  assert.deepEqual(failures, [{message: 'GPU validation failed', stage: 'first-battle-frame'}]);
  canvas.dataset.werhdError = 'secondary failure'; observer.notify(); watcher.dispose();
  assert.equal(observer.disconnects, 1);
  assert.deepEqual(failures, [{message: 'GPU validation failed', stage: 'first-battle-frame'}]);
});

test('an error already present when monitoring starts is reported immediately', () => {
  const {observer, failures} = fixture({werhdStage: 'error', werhdError: 'render panic', werhdLoadStage: 'install-world'});
  assert.deepEqual(failures, [{message: 'render panic', stage: 'install-world'}]);
  assert.equal(observer.disconnects, 1);
});

test('disposal makes later and queued fatal mutations inert', () => {
  const {canvas, observer, failures, watcher} = fixture();
  watcher.dispose(); watcher.dispose();
  canvas.dataset.werhdStage = 'error'; observer.notify();
  assert.deepEqual(failures, []);
  assert.equal(observer.disconnects, 1);
});

test('a fatal without detailed metadata still provides a visible failure message', () => {
  const {failures} = fixture({werhdStage: 'error'});
  assert.deepEqual(failures, [{message: '游戏运行失败', stage: null}]);
});
