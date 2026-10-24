import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {verifyNativeBuild, hashNativeFile, readNativeContentIndex} from './native-build-manifest.mjs';
import {reviewedToyResourceConfig} from '../web-native/toy-resource-sources.js';
import {createResourcePackFetch} from '../web-native/resource-packs.js';
import {createToyStaticRelease} from './toy-static-release.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exec = promisify(execFile), sha = bytes => createHash('sha256').update(bytes).digest('hex');

/** Verify the complete public mirror before exporting a Toy-only configuration.
 * The checked-in pins replace mutable/local upload journals as the build input.
 */
export async function validateToyResourceSources({build, catalog, config = reviewedToyResourceConfig,
  fetch = globalThis.fetch?.bind(globalThis)} = {}) {
  if (config.catalogIdentity !== build?.contentCatalogIdentity
    || config.catalogIdentity !== catalog?.catalogIdentity
    || config.requiredResourceIdentity !== build?.resourceManifestSha256
    || config.requiredResourceIdentity !== catalog?.identity)
    throw new Error('Reviewed Toy resource sources differ from the current build/catalog');
  if (!Array.isArray(config.sources) || config.sources.length !== 19)
    throw new Error('Toy export requires all 19 reviewed resource sources');
  const urls = new Set();
  for (const source of config.sources) {
    let url;
    try { url = new URL(source?.url); } catch { throw new Error('Reviewed Toy resource URL is invalid'); }
    if (url.origin !== 'https://www.bilibilitoy.com' || url.username || url.password || url.search || url.hash
      || !/^\/toy\/[a-z0-9][a-z0-9_-]*\/v2\/manifest\.json$/.test(url.pathname)
      || !/^[a-f0-9]{64}$/.test(source.sha256) || urls.has(url.href))
      throw new Error('Reviewed Toy resource URLs must be unique pinned public manifests');
    urls.add(url.href);
  }
  // Reuse the production loader's SHA, catalog membership and gap/overlap checks.
  // This reads only the small manifests; large art downloads are tested separately.
  await createResourcePackFetch({sources: config.sources, catalog, fetch,
    signal: AbortSignal.timeout(120000),
    fallbackFetch: () => { throw new Error('Resource mirror validation cannot use a fallback'); }});
  return config.sources;
}

/** Export a checked self-contained engine and the reviewed art transport.
 * Only the multiplayer service remains external. Source maps, server source,
 * credentials and retail art archives do not enter the main ZIP.
 */
export async function packageNativeToy({origin = 'https://wan.youlidefuchou.com'} = {}) {
  const address = new URL(origin);
  if (address.protocol !== 'https:' || address.username || address.password || address.origin !== origin)
    throw new Error('Toy service origin must be a plain HTTPS origin');
  const build = await verifyNativeBuild({root, sourceCheck: true, requireChecked: true});
  const {manifest: catalog} = await readNativeContentIndex({root});
  const resourcePackUrls = await validateToyResourceSources({build, catalog});

  const output = path.join(root, 'dist/toy'), web = path.join(output, 'web');
  await fs.mkdir(output, {recursive: true});
  await fs.rm(web, {recursive: true, force: true});
  await fs.mkdir(web);
  const files = [], sourceFiles = new Map();
  async function write(relative, bytes) {
    if (relative.endsWith('.js') && /vera20k/i.test(bytes.toString()))
      throw new Error(`Legacy engine name in public script: ${relative}`);
    const target = path.join(web, relative);
    await fs.mkdir(path.dirname(target), {recursive: true});
    await fs.writeFile(target, bytes);
    files.push({path: relative, bytes: bytes.length, sha256: sha(bytes)});
  }
  async function collect(file, relative) {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Export requires ordinary files');
    sourceFiles.set(relative, await fs.readFile(file));
  }
  for (const name of (await fs.readdir(path.join(root, 'web-native'))).sort()) {
    if (!/\.(?:html|js|css)$/.test(name)) continue;
    if (name !== 'toy-resource-sources.js') await collect(path.join(root, 'web-native', name), name);
  }
  await collect(path.join(root, 'native-client/art/branding/wannafire-app-icon.png'), 'branding/icon.png');
  for (const name of ['FiraSansCondensed-Medium.ttf', 'FiraSansCondensed-OFL'])
    await collect(path.join(root, 'native-client/art/fonts', name), 'fonts/' + name);
  const bundled = createToyStaticRelease({sourceFiles, build, catalog, resourcePackUrls, origin,
    engineModule: await fs.readFile(path.join(root, 'public/native/werhd.js')),
    engineGzip: await fs.readFile(path.join(root, '.build/native-content/objects', build.outputs['werhd_bg.wasm'].download.sha256))});
  for (const [relative, bytes] of bundled.files) await write(relative, bytes);
  files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  const contentsSha256 = sha(JSON.stringify(files));
  const filename = `werhd-toy-${build.patchSha256.slice(0, 10)}-${contentsSha256.slice(0, 8)}.zip`;
  const archive = path.join(output, filename);
  // A stable archive contains only the page root, without an enclosing folder.
  await exec(process.env.PYTHON || 'python3', ['-c', `
import pathlib, sys, zipfile
root = pathlib.Path(sys.argv[1])
with zipfile.ZipFile(sys.argv[2], 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
    for file in sorted(root.rglob('*')):
        if file.is_symlink(): raise RuntimeError('ZIP symlink rejected')
        if not file.is_file(): continue
        info = zipfile.ZipInfo(file.relative_to(root).as_posix(), (1980,1,1,0,0,0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o100644 << 16
        archive.writestr(info, file.read_bytes(), compresslevel=6)
`, web, archive]);
  const receipt = {schema: 1, file: archive, bytes: (await fs.stat(archive)).size,
    sha256: await hashNativeFile(archive), contentsSha256, serviceOrigin: origin,
    patchSha256: build.patchSha256, catalogIdentity: catalog.catalogIdentity,
    engineBundled: true, artSourceCount: resourcePackUrls.length, releaseDirectory: bundled.releaseDirectory, files};
  if (receipt.bytes >= 50_000_000) throw new Error('Toy main ZIP must stay below 50,000,000 bytes');
  await fs.writeFile(path.join(output, filename + '.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt, null, 2));
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  await packageNativeToy();
