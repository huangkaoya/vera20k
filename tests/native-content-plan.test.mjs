import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveContentPlan} from '../web-native/content-plan.js';

const hash = character => character.repeat(64);
const file = (name, character, bytes = 10) => ({name, sha256: hash(character), bytes, url: `/content/objects/${hash(character)}`});
function fixture() {
  return {schema: 2, identity: hash('a'), catalogIdentity: hash('b'),
    profiles: {skirmish: {requiredResourceIdentity: hash('a'), files: [file('langmd.mix', 'c')], capabilities: {}},
      full: {requiredResourceIdentity: hash('a'), files: [file('langmd.mix', 'd'), file('movmd03.mix', 'e')],
        capabilities: {campaign: true, movies: true, music: true, menuAnimation: true}}},
    packs: {campaign: {files: [file('mapsmd03.mix', 'f')], dependsOn: ['cinematics'], capabilities: {campaign: true}},
      cinematics: {files: [file('movmd03.mix', 'e')], capabilities: {movies: true}},
      conflict: {files: [file('LANGMD.MIX', 'd')]}}};
}

test('optional campaign includes cinematics without changing required multiplayer identity', () => {
  const catalog = fixture(), base = resolveContentPlan(catalog), expanded = resolveContentPlan(catalog, {addons: ['campaign']});
  assert.equal(base.requiredResourceIdentity, expanded.requiredResourceIdentity);
  assert.deepEqual(expanded.addons, ['cinematics', 'campaign']);
  assert.equal(expanded.capabilities.campaign, true); assert.equal(expanded.capabilities.movies, true);
  assert.equal(base.capabilities.campaign, false); assert.equal(expanded.files.length, 3);
});
test('profiles replace the whole mounting view and optional files cannot override core', () => {
  const catalog = fixture();
  assert.throws(() => resolveContentPlan(catalog, {addons: ['conflict']}), /冲突/);
  const full = resolveContentPlan(catalog, {profile: 'full', addons: ['cinematics']});
  assert.equal(full.files.length, 2); assert.equal(full.files[0].sha256, hash('d'));
});
test('dependency cycles and foreign gameplay identities fail before download or mounting', () => {
  const catalog = fixture(); catalog.packs.cinematics.dependsOn = ['campaign'];
  assert.throws(() => resolveContentPlan(catalog, {addons: ['campaign']}), /依赖/);
  catalog.profiles.full.requiredResourceIdentity = hash('0');
  assert.throws(() => resolveContentPlan(catalog, {profile: 'full'}), /版本不一致/);
});
