import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {nativeContentCatalogIdentity} from './native-build-manifest.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');

/** Build one immutable module graph. The root entry is the only stable path;
 * every import, configuration file, font and engine lives below its content ID.
 */
export function createToyStaticRelease({sourceFiles, build, catalog, engineModule, engineGzip,
  resourcePackUrls, origin}) {
  if (!(sourceFiles instanceof Map) || !sourceFiles.has('index.html') || !sourceFiles.has('bootstrap.js'))
    throw new Error('Toy release requires its HTML entry and bootstrap module');
  if (catalog.catalogIdentity !== nativeContentCatalogIdentity(catalog)
    || build.contentCatalogIdentity !== catalog.catalogIdentity || build.resourceManifestSha256 !== catalog.identity)
    throw new Error('Toy bundled engine and catalog identities differ');
  const module = build.outputs?.['werhd.js'], engine = build.outputs?.['werhd_bg.wasm'], wire = engine?.download;
  if (!module || module.bytes !== engineModule.length || module.sha256 !== sha(engineModule)
    || wire?.encoding !== 'gzip' || wire.bytes !== engineGzip.length || wire.sha256 !== sha(engineGzip)
    || wire.url !== `/content/objects/${wire.sha256}`)
    throw new Error('Toy bundled engine bytes differ from the checked build');
  const raw = gunzipSync(engineGzip, {maxOutputLength: engine.bytes});
  if (raw.length !== engine.bytes || sha(raw) !== engine.sha256)
    throw new Error('Toy bundled gzip does not reproduce the checked WASM');
  if (!Array.isArray(resourcePackUrls) || resourcePackUrls.length !== 19)
    throw new Error('Toy bundled release requires all 19 reviewed art sources');
  const address = new URL(origin);
  if (address.origin !== origin || address.protocol !== 'https:' || address.username || address.password)
    throw new Error('Toy multiplayer origin must be a plain HTTPS origin');

  const payload = new Map();
  for (const [name, bytes] of sourceFiles) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name) || name.split('/').some(part => !part || part === '.' || part === '..'))
      throw new Error('Unsafe Toy payload path');
    if (name !== 'index.html') payload.set(name, Buffer.from(bytes));
  }
  const staticRelease = {build: 'native/build.json', catalog: 'native/catalog.json',
    module: 'native/werhd.js', content: {[wire.url]: 'native/engine.bin'}};
  payload.set('host-config.js', Buffer.from('// Toy: all startup resources are local; serviceOrigin is for multiplayer.\n'
    + `export const serviceOrigin = ${JSON.stringify(origin)};\n`
    + `export const staticRelease = ${JSON.stringify(staticRelease, null, 2)};\n`
    + `export const resourcePackUrls = ${JSON.stringify(resourcePackUrls, null, 2)};\n`));
  payload.set('native/build.json', json(build));
  payload.set('native/catalog.json', json(catalog));
  payload.set('native/werhd.js', Buffer.from(engineModule));
  payload.set('native/engine.bin', Buffer.from(engineGzip));
  const release = {schema: 2, name: '王二火大', serviceOrigin: origin, renderer: build.renderer,
    patchSha256: build.patchSha256, resourceManifestSha256: build.resourceManifestSha256,
    catalogIdentity: catalog.catalogIdentity, outputs: build.outputs, defaultProfile: 'skirmish',
    engineBundled: true, artTransport: 'toy-resource-shards', assetsBundled: false,
    loginRequired: false, staticRelease, resourcePackUrls};
  payload.set('werhd-release.json', json(release));
  for (const [name, bytes] of payload)
    if (name.endsWith('.js') && /vera20k/i.test(bytes.toString())) throw new Error(`Legacy engine name in public script: ${name}`);
  const identities = [...payload, ['index.html', Buffer.from(sourceFiles.get('index.html'))]]
    .map(([path, bytes]) => ({path, bytes: bytes.length, sha256: sha(bytes)}))
    .sort((a, b) => a.path.localeCompare(b.path, 'en'));
  const releaseId = sha(JSON.stringify(identities)).slice(0, 20), directory = `releases/${releaseId}`;
  const entry = Buffer.from(sourceFiles.get('index.html')).toString();
  if (!entry.includes('src="./bootstrap.js"')) throw new Error('Toy HTML entry does not reference the checked bootstrap');
  const html = entry.replace(/<html\b/, `<html data-werhd-release="${releaseId}"`)
    .replaceAll('src="./', `src="./${directory}/`).replaceAll('href="./', `href="./${directory}/`);
  const files = new Map([['index.html', Buffer.from(html)],
    ['werhd-release.json', json({...release, releaseDirectory: directory})],
    ...[...payload].map(([name, bytes]) => [`${directory}/${name}`, bytes])]);
  return {files, releaseId, releaseDirectory: directory, staticRelease};
}
