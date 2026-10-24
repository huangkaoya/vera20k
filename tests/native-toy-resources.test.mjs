import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {validateToyResourceSources} from '../tools/package-native-toy.mjs';
import {resourcePackUrls} from '../web-native/host-config.js';
import {reviewedToyResourceConfig, reviewedToyResourceSources} from '../web-native/toy-resource-sources.js';

const sha = value => createHash('sha256').update(value).digest('hex');
function fixture(mutate = () => {}) {
  const identity = sha('required'), catalogIdentity = sha('catalog'), wireSha256 = sha('object');
  const catalog = {schema: 2, identity, catalogIdentity, profiles: {}, packs: {}, files: [{
    download: {url: `/content/objects/${wireSha256}`, sha256: wireSha256, bytes: 19, encoding: 'gzip'},
  }]};
  const build = {contentCatalogIdentity: catalogIdentity, resourceManifestSha256: identity};
  const manifests = Array.from({length: 19}, (_, index) => ({schema: 1, kind: 'werhd-resource-shard',
    catalogIdentity, requiredResourceIdentity: identity, packId: `pack-${index + 1}`, parts: [{
      wireSha256, wireBytes: 19, offset: index, bytes: 1, sha256: sha(`part-${index}`),
      path: `parts/${sha(`part-${index}`)}.bin`,
    }]}));
  mutate(manifests);
  const routes = new Map(), calls = [];
  const sources = manifests.map((manifest, index) => {
    const url = `https://www.bilibilitoy.com/toy/test-${index + 1}/v2/manifest.json`;
    const bytes = JSON.stringify(manifest); routes.set(url, bytes);
    return {url, sha256: sha(bytes)};
  });
  const config = {catalogIdentity, requiredResourceIdentity: identity, sources};
  const fetch = async (url, options) => {
    calls.push({url, options});
    assert.ok(routes.has(url), 'packaging must only read public manifests');
    return new Response(routes.get(url));
  };
  return {build, catalog, config, routes, calls, fetch};
}

test('Toy source configuration contains the complete frozen public set while local hosting keeps its origin', () => {
  assert.equal(reviewedToyResourceSources.length, 19);
  assert.equal(reviewedToyResourceConfig.sources, reviewedToyResourceSources);
  assert.ok(Object.isFrozen(reviewedToyResourceConfig) && Object.isFrozen(reviewedToyResourceSources));
  assert.match(reviewedToyResourceConfig.catalogIdentity, /^[a-f0-9]{64}$/);
  assert.match(reviewedToyResourceConfig.requiredResourceIdentity, /^[a-f0-9]{64}$/);
  const urls = new Set();
  for (const [index, source] of reviewedToyResourceSources.entries()) {
    assert.ok(Object.isFrozen(source));
    assert.equal(source.url, `https://www.bilibilitoy.com/toy/werhd-yuri-res-b621aaa6-${String(index + 1).padStart(2, '0')}/v2/manifest.json`);
    assert.match(source.sha256, /^[a-f0-9]{64}$/); urls.add(source.url);
  }
  assert.equal(urls.size, 19);
  assert.deepEqual(resourcePackUrls, [], 'Toy CDN CORS does not authorize the local/Cloudflare browser origin');
});

test('Toy packaging checks all 19 pinned manifests with the production coverage validator', async () => {
  const f = fixture();
  assert.equal(await validateToyResourceSources(f), f.config.sources);
  assert.equal(f.calls.length, 19);
  for (const call of f.calls) {
    assert.equal(call.options.credentials, 'omit');
    assert.equal(call.options.redirect, 'error');
    assert.equal(call.options.cache, 'no-store');
  }
});

test('a changed build or resource catalog fails before any network request', async t => {
  for (const field of ['build catalog', 'build resources', 'catalog', 'required resources']) await t.test(field, async () => {
    const f = fixture();
    if (field === 'build catalog') f.build.contentCatalogIdentity = sha('changed');
    if (field === 'build resources') f.build.resourceManifestSha256 = sha('changed');
    if (field === 'catalog') f.catalog.catalogIdentity = sha('changed');
    if (field === 'required resources') f.catalog.identity = sha('changed');
    await assert.rejects(validateToyResourceSources(f), /differ from the current build\/catalog/);
    assert.equal(f.calls.length, 0);
  });
});

test('incomplete, duplicate or preview sources cannot be exported', async t => {
  const cases = {
    missing: f => f.config.sources.pop(),
    duplicate: f => { f.config.sources[1] = f.config.sources[0]; },
    preview: f => { f.config.sources[0].url = 'https://www.bilibilitoy.com/toy/preview/author_test/v2/manifest.json'; },
    unpinned: f => { delete f.config.sources[0].sha256; },
  };
  for (const [name, change] of Object.entries(cases)) await t.test(name, async () => {
    const f = fixture(); change(f);
    await assert.rejects(validateToyResourceSources(f), /all 19|unique pinned/);
    assert.equal(f.calls.length, 0);
  });
});

test('modified public bytes and a validly pinned coverage gap both stop packaging', async t => {
  await t.test('manifest SHA mismatch', async () => {
    const f = fixture(); f.routes.set(f.config.sources[0].url, '{}');
    await assert.rejects(validateToyResourceSources(f), /资源分包目录校验失败/);
  });
  await t.test('gap despite valid manifest pins', async () => {
    const f = fixture(manifests => { manifests[0].parts[0].offset = 1; });
    await assert.rejects(validateToyResourceSources(f), /重叠或缺口/);
    assert.equal(f.calls.length, 19);
  });
});
