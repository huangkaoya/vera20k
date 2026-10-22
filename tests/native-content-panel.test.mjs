import test from 'node:test';
import assert from 'node:assert/strict';
import {installContentPanel} from '../web-native/content-panel.js';

// Minimal DOM/timer port around the real panel. No browser, engine or network
// is replaced inside the module under test.
class Node extends EventTarget {
  children = []; parent = null; dataset = {}; hidden = false; disabled = false; text = ''; renders = 0;
  constructor(tag) { super(); this.tag = tag; this.classList = {add: name => { this.className += ` ${name}`; }}; }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return this.text + this.children.map(node => node.textContent).join(''); }
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  replaceChildren(...nodes) { this.renders++; this.children = []; this.text = ''; this.append(...nodes); }
  setAttribute(name, value) { this[name] = value; }
  querySelectorAll(selector) {
    const result = [], selectors = selector.split(',');
    const visit = node => { if (selectors.some(part => part === '[data-content-id]' ? node.dataset.contentId !== undefined : node.tag === part)) result.push(node); node.children.forEach(visit); };
    this.children.forEach(visit); return result;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0]; }
  focus() { document.activeElement = this; }
  scrollIntoView() {}
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); }
  click() { if (!this.disabled) this.dispatchEvent(new Event('click')); }
}
function fixture(t, initial = false) {
  const saved = new Map(), timers = new Map(), retired = []; let id = 0, enabled = initial, checks = 0;
  const replace = (name, value) => { saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, {configurable: true, writable: true, value}); };
  const document = {head: new Node('head'), body: new Node('body'), createElement: tag => new Node(tag)};
  replace('document', document);
  replace('setInterval', (callback, milliseconds) => { const key = ++id; timers.set(key, {callback, milliseconds}); return key; });
  replace('clearInterval', key => { const timer = timers.get(key); if (timer) retired.push(timer); timers.delete(key); });
  const hash = character => character.repeat(64), file = {name: 'langmd.mix', bytes: 1, sha256: hash('a'), url: '/content/core'};
  const catalog = {schema: 2, identity: hash('b'), catalogIdentity: hash('c'), packs: {}, profiles: {
    skirmish: {files: [file], requiredResourceIdentity: hash('b')}, full: {files: [file], requiredResourceIdentity: hash('b')},
  }};
  const activations = [], panel = installContentPanel({catalog, store: {cacheStatus: () => 'hit', prefetch: async () => ({installed: true, files: []})},
    onActivate: selection => activations.push(selection), isActivationAllowed: () => { checks++; return enabled; }});
  const shell = document.body.children.find(node => node.className === 'vera-content-panel');
  t.after(() => { panel.dispose(); for (const [name, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; } });
  return {panel, shell, timers, retired, activations, document,
    get checks() { return checks; }, setAllowed(value) { enabled = value; },
    button: text => shell.querySelectorAll('button').find(node => node.textContent === text),
    tick() { for (const timer of [...timers.values()]) timer.callback(); },
  };
}

test('an open panel follows delayed native admission, without redrawing an unchanged gate', async t => {
  const f = fixture(t); assert.equal(f.timers.size, 0); f.panel.open();
  assert.equal(f.timers.size, 1); assert.equal([...f.timers.values()][0].milliseconds, 250);
  assert.equal(f.button('启用并重新载入').disabled, true);
  const renders = f.shell.renders, checks = f.checks;
  f.tick(); f.tick(); assert.equal(f.shell.renders, renders); assert.equal(f.checks, checks + 2);
  f.setAllowed(true); f.tick();
  assert.equal(f.shell.renders, renders + 1); assert.equal(f.button('启用并重新载入').disabled, false);
  f.tick(); assert.equal(f.shell.renders, renders + 1);
  f.setAllowed(false); f.tick(); assert.equal(f.button('启用并重新载入').disabled, true);
  assert.equal(f.activations.length, 0, 'a changed gate must never activate automatically');
});

test('close, reopen and disposal clean the watcher and ignore already queued old callbacks', t => {
  const f = fixture(t, true); f.panel.open(); const old = [...f.timers.values()][0];
  f.button('关闭').click(); assert.equal(f.timers.size, 0); assert.equal(f.shell.hidden, true);
  const checks = f.checks; old.callback(); assert.equal(f.checks, checks);
  f.setAllowed(false); f.panel.open(); assert.equal(f.timers.size, 1); assert.equal(f.button('启用并重新载入').disabled, true);
  const reopenedChecks = f.checks; old.callback(); assert.equal(f.checks, reopenedChecks);
  const current = [...f.timers.values()][0]; f.panel.dispose(); assert.equal(f.timers.size, 0);
  current.callback(); assert.equal(f.checks, reopenedChecks); assert.equal(f.document.body.children.length, 0); assert.equal(f.document.head.children.length, 0);
});

test('activation checks the latest gate even before the next watcher tick', async t => {
  const f = fixture(t, true); f.panel.open(); assert.equal(f.button('启用并重新载入').disabled, false);
  f.setAllowed(false); f.button('启用并重新载入').click();
  await Promise.resolve(); assert.equal(f.activations.length, 0); assert.match(f.shell.textContent, /请先退出当前对局/);
  f.setAllowed(true); f.tick(); f.button('启用并重新载入').click(); await Promise.resolve();
  assert.deepEqual(f.activations, [{profile: 'skirmish', addons: []}]);
});
