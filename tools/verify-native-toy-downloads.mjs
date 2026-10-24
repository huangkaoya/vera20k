#!/usr/bin/env node
// Real public-download verification through the production shard transport.
// Node cannot establish browser CORS acceptance or interactive game correctness.
import {createHash, webcrypto} from 'node:crypto';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Readable, Transform, Writable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createGunzip} from 'node:zlib';
import {createResourcePackFetch} from '../web-native/resource-packs.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const requireThat = (condition, message) => { if (!condition) throw new Error(message); };
const PUBLIC_ORIGIN = 'https://www.bilibilitoy.com';

export function prepareVerification({planBytes, publication, catalog}) {
  const plan = JSON.parse(planBytes);
  requireThat(publication.planSha256 === sha256(planBytes), 'Publication plan SHA mismatch');
  requireThat(plan.catalogIdentity === publication.catalogIdentity && plan.catalogIdentity === catalog.catalogIdentity,
    'Catalog identity mismatch');
  requireThat(plan.requiredResourceIdentity === catalog.identity, 'Required resource identity mismatch');
  requireThat(plan.packs.length === 19 && publication.packs.length === 19 && plan.objects.length === 35,
    'Expected 19 published packs and 35 unique objects');
  const allowed = new Map(), seenPacks = new Set();
  const sources = plan.packs.map(pack => {
    const item = publication.packs.find(entry => entry.packId === pack.packId);
    requireThat(item?.status === 'published' && item.metadataVerified === true, `Not verified published: ${pack.packId}`);
    requireThat(item.artifact?.manifestSha256 === pack.manifestSha256, `Manifest pin mismatch: ${pack.packId}`);
    requireThat(item.artifact?.catalogIdentity === catalog.catalogIdentity, `Pack catalog mismatch: ${pack.packId}`);
    requireThat(!seenPacks.has(pack.packId), 'Duplicate pack'); seenPacks.add(pack.packId);
    const location = new URL(item.manifestPath, item.baseUrl);
    requireThat(location.origin === PUBLIC_ORIGIN && location.pathname === `/toy/${item.slug}/v2/manifest.json`,
      `Unexpected public manifest URL: ${pack.packId}`);
    const source = {url: location.href, sha256: pack.manifestSha256};
    allowed.set(source.url, {kind: 'manifest', packId: pack.packId, sha256: pack.manifestSha256});
    for (const part of pack.parts) {
      const url = new URL(part.path, location).href;
      requireThat(!allowed.has(url), 'Duplicate public part URL');
      allowed.set(url, {kind: 'part', packId: pack.packId, sha256: part.sha256,
        bytes: part.bytes, offset: part.offset, wireSha256: part.wireSha256});
    }
    return source;
  });
  requireThat([...allowed.values()].filter(item => item.kind === 'part').length === 83, 'Expected 83 parts');
  requireThat(new Set(plan.objects.map(object => object.wireSha256)).size === plan.objects.length, 'Duplicate gzip object');
  return {plan, sources, allowed};
}

export async function verifyToyDownloads({planBytes, publication, catalog, concurrency = 2,
  transport = globalThis.fetch, progress = console.log, save = async () => {}}) {
  requireThat(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 2, 'Concurrency must be 1 or 2');
  const {plan, sources, allowed} = prepareVerification({planBytes, publication, catalog});
  const startedAt = new Date().toISOString(), start = performance.now();
  const requests = [], objectResults = [], requested = new Set(), stop = new AbortController();
  let fallbackRequests = 0, next = 0, firstError, saving = Promise.resolve();
  const report = {
    schema: 1, kind: 'werhd-toy-public-download-verification', ok: false, startedAt,
    catalogIdentity: catalog.catalogIdentity, requiredResourceIdentity: catalog.identity,
    planSha256: publication.planSha256, concurrency, transport: 'Node fetch; production createResourcePackFetch',
    policy: {credentials: 'omit', redirect: 'error', cache: 'no-store', origin: PUBLIC_ORIGIN,
      fallbackAllowed: false, persistentCacheUsed: false, retries: 0},
    scope: '19 pinned public manifests and every part; gzip and decompressed raw SHA/size checked. Browser CORS and gameplay require separate verification.',
    expected: {manifests: sources.length, objects: plan.objects.length, parts: 83,
      wireBytes: plan.objects.reduce((sum, item) => sum + item.wireBytes, 0),
      rawBytes: plan.objects.reduce((sum, item) => sum + item.rawBytes, 0)},
    sources, requests, objects: objectResults,
  };
  const snapshot = async () => {
    report.finishedAt = new Date().toISOString(); report.elapsedMs = Math.round(performance.now() - start);
    report.actual = {requests: requests.length, manifests: requests.filter(item => item.kind === 'manifest').length,
      uniqueParts: requests.filter(item => item.kind === 'part').length, fallbackRequests,
      downloadedPartBytes: requests.filter(item => item.kind === 'part').reduce((sum, item) => sum + item.receivedBytes, 0),
      downloadedManifestBytes: requests.filter(item => item.kind === 'manifest').reduce((sum, item) => sum + item.receivedBytes, 0),
      verifiedObjects: objectResults.filter(item => item.ok).length,
      verifiedRawBytes: objectResults.filter(item => item.ok).reduce((sum, item) => sum + item.rawBytes, 0)};
    saving = saving.then(() => save(report));
    await saving;
  };
  const observedFetch = async (input, options = {}) => {
    const url = String(input), expected = allowed.get(url);
    requireThat(expected, 'Production loader requested an unapproved URL');
    requireThat(!requested.has(url), 'Unexpected repeated network request');
    requireThat(options.credentials === 'omit' && options.redirect === 'error', 'Production loader weakened fetch policy');
    requested.add(url);
    const current = {url, ...expected, receivedBytes: 0, ok: false}; requests.push(current);
    const began = performance.now(), digest = createHash('sha256');
    try {
      const response = await transport(url, {...options, cache: 'no-store', credentials: 'omit', redirect: 'error',
        headers: {'Origin': PUBLIC_ORIGIN}, signal: AbortSignal.any([stop.signal, options.signal, AbortSignal.timeout(180_000)].filter(Boolean))});
      current.httpStatus = response.status; current.contentType = response.headers.get('content-type');
      current.accessControlAllowOrigin = response.headers.get('access-control-allow-origin');
      requireThat(response.ok && response.body, `Public download failed: HTTP ${response.status} ${expected.packId}`);
      return new Response(response.body.pipeThrough(new TransformStream({
        transform(chunk, controller) { current.receivedBytes += chunk.byteLength; digest.update(chunk); controller.enqueue(chunk); },
        flush() {
          current.receivedSha256 = digest.digest('hex'); current.elapsedMs = Math.round(performance.now() - began);
          current.ok = current.receivedSha256 === expected.sha256 && (expected.bytes === undefined || current.receivedBytes === expected.bytes);
          requireThat(current.ok, `Network response digest/length mismatch: ${expected.packId}`);
        },
      })), {status: response.status, headers: response.headers});
    } catch (error) { current.error = error.message; current.elapsedMs = Math.round(performance.now() - began); throw error; }
  };
  try {
    const fetchObject = await createResourcePackFetch({sources, catalog, fetch: observedFetch, crypto: webcrypto, signal: stop.signal,
      fallbackFetch: async () => { fallbackRequests++; throw new Error('Forbidden fallback fetch'); }});
    progress(`Verified ${sources.length} pinned public manifests; beginning ${plan.objects.length} complete gzip objects / 83 parts`);
    await snapshot();
    const worker = async () => {
      while (!stop.signal.aborted) {
        const index = next++; if (index >= plan.objects.length) return;
        const expected = plan.objects[index], began = performance.now();
        const current = {names: expected.names, wireSha256: expected.wireSha256, rawSha256: expected.rawSha256,
          wireBytes: 0, rawBytes: 0, parts: expected.parts.map(part => ({packId: part.packId, sha256: part.sha256,
            offset: part.offset, bytes: part.bytes})), ok: false};
        objectResults.push(current);
        try {
          const wireDigest = createHash('sha256'), rawDigest = createHash('sha256');
          const response = await fetchObject(`/content/objects/${expected.wireSha256}`, {signal: stop.signal});
          await pipeline(Readable.fromWeb(response.body), new Transform({
            transform(chunk, encoding, done) { current.wireBytes += chunk.length; wireDigest.update(chunk); done(null, chunk); },
          }), createGunzip(), new Writable({
            write(chunk, encoding, done) { current.rawBytes += chunk.length; rawDigest.update(chunk); done(); },
          }), {signal: stop.signal});
          current.receivedWireSha256 = wireDigest.digest('hex'); current.receivedRawSha256 = rawDigest.digest('hex');
          current.ok = current.wireBytes === expected.wireBytes && current.rawBytes === expected.rawBytes
            && current.receivedWireSha256 === expected.wireSha256 && current.receivedRawSha256 === expected.rawSha256;
          requireThat(current.ok, `Complete gzip/raw SHA or length mismatch: ${expected.names.join(', ')}`);
          current.elapsedMs = Math.round(performance.now() - began);
          progress(`Verified object ${objectResults.filter(item => item.ok).length}/${plan.objects.length}: ${expected.names.join(', ')} (${current.wireBytes} compressed, ${current.rawBytes} raw bytes)`);
          await snapshot();
        } catch (error) {
          current.error = error.message; current.elapsedMs = Math.round(performance.now() - began);
          if (!firstError) firstError = error;
          stop.abort(error); await snapshot(); return;
        }
      }
    };
    await Promise.all(Array.from({length: concurrency}, worker));
    if (firstError) throw firstError;
    requireThat(requests.length === 102 && requests.every(item => item.ok), 'Not every public manifest and part passed');
    requireThat(objectResults.length === 35 && objectResults.every(item => item.ok), 'Not every gzip/raw object passed');
    report.ok = true;
  } catch (error) {
    report.error = error.message;
  }
  objectResults.sort((a, b) => plan.objects.findIndex(item => item.wireSha256 === a.wireSha256)
    - plan.objects.findIndex(item => item.wireSha256 === b.wireSha256));
  await snapshot(); return report;
}

async function main() {
  const args = process.argv.slice(2);
  requireThat(args.every(arg => arg === '--preflight-only' || /^--concurrency=[12]$/.test(arg)), 'Usage: verify-native-toy-downloads.mjs [--preflight-only] [--concurrency=1|2]');
  const [planBytes, publicationBytes, catalogBytes] = await Promise.all([
    readFile(resolve(root, 'dist/toy-resources/plan.json')),
    readFile(resolve(root, 'dist/toy-resources/publication.json')),
    readFile(resolve(root, 'public/native-content/catalog.json')),
  ]);
  const publication = JSON.parse(publicationBytes), catalog = JSON.parse(catalogBytes);
  if (args.includes('--preflight-only')) {
    const input = prepareVerification({planBytes, publication, catalog});
    console.log(JSON.stringify({ok: true, manifests: input.sources.length, objects: input.plan.objects.length,
      parts: input.allowed.size - input.sources.length, networkRequests: 0})); return;
  }
  const date = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  const output = resolve(root, `validation/toy-resource-public-downloads-${date}.json`);
  await mkdir(dirname(output), {recursive: true});
  const report = await verifyToyDownloads({planBytes, publication, catalog,
    concurrency: Number(args.find(arg => arg.startsWith('--concurrency='))?.split('=')[1] ?? 2),
    save: async receipt => writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`)});
  console.log(JSON.stringify({ok: report.ok, actual: report.actual, elapsedMs: report.elapsedMs, error: report.error}));
  if (!report.ok) process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
