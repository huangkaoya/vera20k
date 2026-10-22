import test from 'node:test';
import assert from 'node:assert/strict';
import {createContentController} from '../web-native/content-controller.js';

const hash = character => character.repeat(64);
const file = (name, character, bytes = 10) => ({name, sha256: hash(character), bytes, url: `/content/objects/${hash(character)}`});
function fixture(options = {}) {
  const core = file('langmd.mix', 'a'), fullCore = file('langmd.mix', 'b'), movie = file('movmd03.mix', 'c'), campaign = file('mapsmd03.mix', 'd'), music = file('thememd.mix', 'e');
  const identity = hash('f'), catalog = {schema: 2, identity, catalogIdentity: hash('0'),
    profiles: {skirmish: {files: [core], requiredResourceIdentity: identity},
      full: {files: [fullCore, movie, campaign, music], requiredResourceIdentity: identity,
        capabilities: {campaign: true, movies: true, music: true}}},
    packs: {campaign: {files: [campaign], dependsOn: ['cinematics'], capabilities: {campaign: true}},
      cinematics: {files: [movie], capabilities: {movies: true}}, music: {files: [music], capabilities: {music: true}}}};
  let enabled = options.enabled ?? true, timerId = 0;
  const timers = new Map(), snapshots = [], activations = [], downloads = [], statuses = new Map();
  const store = {cacheStatus: item => statuses.get(item.sha256) ?? 'unknown',
    prefetch: async (files, control) => {
      downloads.push(files);
      control.onProgress({file: files[0], completedFiles: 0, totalFiles: files.length, wireBytes: 2, wireTotalBytes: 10, stage: 'download'});
      for (const item of files) statuses.set(item.sha256, 'stored');
      return {installed: true, files: []};
    }, ...options.store};
  const controller = createContentController({catalog, store,
    initialSelection: options.initialSelection,
    onState: value => snapshots.push(value), onActivate: value => activations.push(value),
    isActivationAllowed: () => enabled,
    setInterval: callback => { const id = ++timerId; timers.set(id, callback); return id; },
    clearInterval: id => timers.delete(id)});
  return {controller, snapshots, activations, downloads, statuses, timers, core, fullCore,
    setAllowed(value) { enabled = value; }, tick() { for (const callback of timers.values()) callback(); }};
}

test('native content controller publishes semantic data without a DOM and preserves package dependencies', () => {
  const f = fixture();
  f.controller.dispatch({action: 'open', pack: 'campaign'});
  const selected = f.controller.snapshot();
  assert.deepEqual(selected.addons, ['cinematics', 'campaign']);
  assert.equal(selected.selection.files, 3);
  assert.equal(selected.packs.find(item => item.id === 'cinematics').checked, true);
  assert.equal(typeof selected.packs[0].bytes, 'number');
  f.controller.dispatch({action: 'selectPack', id: 'cinematics', checked: false});
  assert.deepEqual(f.controller.snapshot().addons, []);
  f.controller.dispose(); assert.equal(f.timers.size, 0);
});

test('full content replaces the mounting view and never unions two versions of core resources', async () => {
  const f = fixture({initialSelection: {profile: 'skirmish', addons: ['music']}});
  assert.equal(f.controller.snapshot().packs.find(item => item.id === 'music').checked, true);
  f.controller.dispatch({action: 'selectProfile', profile: 'full'});
  await f.controller.dispatch({action: 'download', id: 'selection'});
  assert.equal(f.downloads[0].filter(item => item.name === 'langmd.mix').length, 1);
  assert.equal(f.downloads[0][0].sha256, f.fullCore.sha256);
  assert.equal(f.controller.snapshot().packs.find(item => item.id === 'campaign').included, true);
  f.controller.dispose();
});

test('verified downloads publish progress and activate only the selected profile and addons', async () => {
  const f = fixture(); f.controller.dispatch({action: 'selectPack', id: 'music', checked: true});
  assert.equal(f.controller.snapshot().canActivate, false);
  await f.controller.dispatch({action: 'download', id: 'selection'});
  assert.equal(f.snapshots.some(value => value.job?.file === 'langmd.mix' && value.job.wireBytes === 2), true);
  assert.equal(f.controller.snapshot().canActivate, true);
  await f.controller.dispatch({action: 'activate'});
  assert.deepEqual(f.activations, [{profile: 'skirmish', addons: ['music']}]);
  f.controller.dispose();
});

test('open native page follows a delayed admission gate, but an unchanged gate produces no updates', async () => {
  const f = fixture({enabled: false, store: {cacheStatus: () => 'hit'}});
  f.controller.dispatch({action: 'open'}); const count = f.snapshots.length, old = [...f.timers.values()][0];
  f.tick(); f.tick(); assert.equal(f.snapshots.length, count);
  f.setAllowed(true); f.tick(); assert.equal(f.controller.snapshot().canActivate, true);
  f.setAllowed(false); await f.controller.dispatch({action: 'activate'});
  assert.deepEqual(f.activations, []);
  f.setAllowed(true); f.tick(); assert.equal(f.snapshots.at(-1).canActivate, true);
  f.controller.dispatch({action: 'close'}); const closedCount = f.snapshots.length;
  old(); assert.equal(f.snapshots.length, closedCount); assert.equal(f.timers.size, 0);
  f.controller.dispose();
});

test('cancel and dispose fence late downloads from claiming verification or sending snapshots', async () => {
  let resolve, progress;
  const f = fixture({store: {prefetch: (_files, control) => { progress = control.onProgress; return new Promise(done => { resolve = done; }); }}});
  const download = f.controller.dispatch({action: 'download', id: 'selection'});
  f.controller.dispatch({action: 'cancel'}); resolve({installed: true}); await download;
  assert.equal(f.controller.snapshot().canActivate, false);
  const late = f.controller.dispatch({action: 'download', id: 'selection'});
  f.controller.dispose(); const count = f.snapshots.length;
  progress({file: f.core, completedFiles: 1, totalFiles: 1}); resolve({installed: true}); await late;
  assert.equal(f.snapshots.length, count);
});

test('quota failure is visible and cache installation never activates a game capability by itself', async () => {
  const f = fixture({store: {prefetch: async () => ({installed: false}), cacheStatus: () => 'write-failed'}});
  await f.controller.dispatch({action: 'download', id: 'campaign'});
  assert.equal(f.controller.snapshot().profile, 'skirmish');
  assert.deepEqual(f.controller.snapshot().addons, []);
  assert.match(f.controller.snapshot().message, /缓存不可用/);
  assert.deepEqual(f.activations, []);
  f.controller.dispose();
});
