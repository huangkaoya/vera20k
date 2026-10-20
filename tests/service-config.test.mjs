import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeConfig, endpoint, loadConfig} from '../tools/services/config.mjs';

const example = () => ({schema: 1,
  web: {host: '127.0.0.1', port: 5280, publicUrl: 'https://game.example.test'},
  resources: {host: '127.0.0.1', port: 5281, publicUrl: 'https://cdn.example.test/vera/'},
  lobby: {host: '127.0.0.1', port: 5282, publicUrl: 'https://lobby.example.test/network/'},
  battle: {host: '127.0.0.1', port: 5283, publicUrl: 'https://battle.example.test', internalUrl: 'http://127.0.0.1:5283'},
});
test('separate public and internal endpoints, preserve public path prefixes and exclude private configuration', () => {
  const config = normalizeConfig(example(), {assetRoot: '/private/retail'});
  assert.equal(config.runtime.assets.manifestUrl, 'https://cdn.example.test/vera/generated/catalog.json');
  assert.equal(config.runtime.network.lobbyUrl, 'wss://lobby.example.test/network/ws/rooms');
  assert.equal(config.battle.internalUrl, 'http://127.0.0.1:5283');
  assert.deepEqual(config.allowedOrigins, ['https://game.example.test']);
  assert.equal(config.assetRoot, '/private/retail');
  assert.doesNotMatch(JSON.stringify(config.runtime), /private|internalUrl|allowedOrigins|host|secret/i);
  assert.equal(endpoint('https://a.test/sub/', '/wasm/core.wasm'), 'https://a.test/sub/wasm/core.wasm');
});
test('configuration rejects broken service boundaries and mixed content', () => {
  for (const mutate of [
    c => c.web.port = 0,
    c => c.lobby.port = c.battle.port,
    c => c.resources.publicUrl = 'https://user:password@example.test',
    c => c.resources.publicUrl = 'http://cdn.example.test',
    c => c.allowedOrigins = ['https://game.example.test/path'],
    c => c.resources.publicDir = '../vera20k',
    c => c.web.distDir = '../ra2web-werhd',
    c => c.battle.internalUrl = 'file:///tmp/socket',
    c => c.battle.internalUrl = 'http://127.0.0.1:5283/prefix',
  ]) {
    const input = example(); mutate(input); assert.throws(() => normalizeConfig(input));
  }
});
test('committed loopback configuration exposes four distinct roles and runtime asset overrides', async () => {
  const config = await loadConfig();
  assert.equal(new Set(['web','resources','lobby','battle'].map(role => config[role].port)).size, 4);
  const input = example(); input.assets = {wasmUrl: 'https://wasm.example.test/engine.wasm'};
  assert.equal(normalizeConfig(input).runtime.assets.wasmUrl, input.assets.wasmUrl);
});
