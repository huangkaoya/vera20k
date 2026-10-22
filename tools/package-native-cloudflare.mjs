import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {prepareNative} from '../deployment/prepare-native.mjs';
import {hashNativeFile} from './native-build-manifest.mjs';
import {serviceOrigin, resourcePackUrls} from '../web-native/host-config.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exec = promisify(execFile), sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceFiles = [
  'deployment/native-worker.mjs', 'deployment/native-origin.mjs', 'deployment/generated/release.json',
  'tools/services/native-room-coordinator.mjs', 'tools/services/native-room-routing.mjs',
  'tools/services/native-room-diagnostics.mjs',
];

async function rejectSymlink(file) {
  const relative = path.relative(root, file);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Package path escapes the owned project');
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('Package symlink rejected'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function readme(release) {
  return `# 王二火大 Cloudflare 部署包

这是可独立解压、安装 Node 依赖后部署的轻量源码包。
本次打包只生成文件，**没有执行上传或部署**。无需重新编译 Rust。

## 部署步骤

建议使用 Node.js 22 或更新版本。解压后在包含 package.json 的目录运行：

\`\`\`sh
npm ci
npm run login
npm run check
npm run deploy
\`\`\`

已有 youlidefuchou 登录配置时可跳过 login。脚本使用同一命名配置，
部署目标仍是现有账户、Worker 与 wan.youlidefuchou.com 路由。
只检查打包、不发布时运行 npm run check；也可以使用：

\`\`\`sh
npx wrangler --config deployment/wrangler.jsonc deploy --dry-run --outdir .build/check
\`\`\`

## 资源与绑定

- ASSETS：deployment/generated/assets，包含网页脚本、图标、字体和引擎 JS。
- NATIVE_DATA：现有 R2 桶 youlidefuchou-res，继续提供已上传的 WASM 和美术素材。
- NATIVE_ROOMS：NativeRooms Durable Object，保留原迁移、分片联机协议和路由。
- 完整资源清单与对象白名单保留在 deployment/generated/release.json。
- 保留 bilibilitoy.com 及合法子域的 HTTPS CORS 和两层 WebSocket 来源检查。
- resourcePackUrls 保持为空，尚未切换到 Toy 分包资源。

本包不含大素材、WASM 二进制、R2 上传计划、上传状态、登录凭证或本机配置。
现有 R2 桶必须保有清单对应的对象及 SHA 元数据。迁移到其他账户需要另外搬迁
资源与相关绑定；本包不是包含全部美术素材的离线安装包。
资源下载继续使用原清单、gzip 字节和 SHA 校验，不需要重新上传既有对象。

## 校验与版本

- 浏览器补丁：${release.build.patchSha256}
- 资源目录：${release.catalogIdentity}
- package-manifest.json 记录包内有效载荷每个文件的大小与 SHA256。
- SHA256SUMS 同时覆盖该清单；外部 ZIP 回执覆盖所有文件和 ZIP 本身。
- package.json / package-lock.json 的依赖精确沿用原 Cloudflare 部署版本。

真正的公网更新只有在 npm run deploy 成功后才发生；本 ZIP 的生成不代表已经部署。
`;
}

export async function packageNativeCloudflare() {
  if (serviceOrigin !== '' || !Array.isArray(resourcePackUrls) || resourcePackUrls.length)
    throw new Error('Cloudflare package requires same-origin hosting and disabled Toy resource sources');
  const release = await prepareNative();
  const output = path.join(root, 'dist/cloudflare'), stagingRoot = path.join(root, '.build');
  await rejectSymlink(output); await rejectSymlink(stagingRoot);
  await fs.mkdir(output, {recursive: true}); await fs.mkdir(stagingRoot, {recursive: true});
  const stage = await fs.mkdtemp(path.join(stagingRoot, 'cloudflare-package-'));
  const files = [];
  async function write(relative, bytes) {
    if (path.posix.isAbsolute(relative) || relative.split('/').includes('..')) throw new Error('Unsafe package filename');
    const target = path.join(stage, relative);
    await fs.mkdir(path.dirname(target), {recursive: true}); await fs.writeFile(target, bytes);
    files.push({path: relative, bytes: bytes.length, sha256: sha(bytes)});
  }
  async function copy(relative) {
    const file = path.join(root, relative); await rejectSymlink(file);
    const stat = await fs.lstat(file);
    if (!stat.isFile()) throw new Error('Package source must be an ordinary file');
    await write(relative, await fs.readFile(file));
  }
  try {
    // Explicit server-side source allowlist: no installer, credentials, upload
    // state, local paths, retail archives or unrelated project source.
    for (const relative of sourceFiles) await copy(relative);
    const assetRoot = path.join(root, 'deployment/generated/assets');
    async function copyAssets(directory, prefix = '') {
      await rejectSymlink(directory);
      for (const entry of (await fs.readdir(directory, {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
        const relative = path.posix.join(prefix, entry.name), file = path.join(directory, entry.name);
        if (entry.name.startsWith('.') || entry.isSymbolicLink()) throw new Error('Unexpected or symbolic public asset');
        if (entry.isDirectory()) await copyAssets(file, relative);
        else if (entry.isFile() && (/\.(?:html|js|css|json|svg|png|woff2?|ttf|ico)$/.test(entry.name)
          || relative === 'fonts/FiraSansCondensed-OFL')) {
          if ((await fs.lstat(file)).size > 25 * 1024 * 1024) throw new Error('Static asset exceeds the prepared size limit');
          await copy(path.posix.join('deployment/generated/assets', relative));
        } else throw new Error('Unexpected file in the prepared public asset tree');
      }
    }
    await copyAssets(assetRoot);
    const preparedHost = await fs.readFile(path.join(assetRoot, 'host-config.js'), 'utf8');
    if (!/export const resourcePackUrls\s*=\s*\[\s*\];/.test(preparedHost))
      throw new Error('Prepared browser assets must keep Toy resource URLs empty');
    const config = JSON.parse(await fs.readFile(path.join(root, 'deployment/wrangler.jsonc'), 'utf8'));
    config.$schema = '../node_modules/wrangler/config-schema.json';
    if (config.main !== 'native-worker.mjs' || config.assets?.directory !== './generated/assets')
      throw new Error('Unexpected relative Worker or asset entrypoint');
    await write('deployment/wrangler.jsonc', Buffer.from(JSON.stringify(config, null, 2) + '\n'));
    const sourcePackage = JSON.parse(await fs.readFile(path.join(root, 'deployment/package.json'), 'utf8'));
    const lock = JSON.parse(await fs.readFile(path.join(root, 'deployment/package-lock.json'), 'utf8'));
    const name = 'werhd-cloudflare-deployment';
    if (lock.lockfileVersion !== 3 || JSON.stringify(lock.packages?.['']?.devDependencies) !== JSON.stringify(sourcePackage.devDependencies)
      || Object.values(sourcePackage.devDependencies).some(version => !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)))
      throw new Error('Cloudflare dependency lock is not pinned to the exact deployment versions');
    const manifest = {name, private: true, type: 'module', scripts: {
      check: 'wrangler --config deployment/wrangler.jsonc deploy --dry-run --outdir .build/check',
      deploy: 'wrangler --profile=youlidefuchou --config deployment/wrangler.jsonc deploy',
      login: 'wrangler --profile=youlidefuchou login',
    }, devDependencies: sourcePackage.devDependencies};
    lock.name = name; lock.packages[''].name = name;
    await write('package.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
    await write('package-lock.json', Buffer.from(JSON.stringify(lock, null, 2) + '\n'));
    await write('README.md', Buffer.from(readme(release)));
    files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
    await write('package-manifest.json', Buffer.from(JSON.stringify({schema: 1,
      kind: 'werhd-cloudflare-source-package', deploymentPerformed: false, retailBundled: false,
      sourcePatchSha256: release.build.patchSha256, catalogIdentity: release.catalogIdentity,
      resourceManifestSha256: release.build.resourceManifestSha256, files: [...files]}, null, 2) + '\n'));
    files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
    await write('SHA256SUMS', Buffer.from(files.map(file => `${file.sha256}  ${file.path}`).join('\n') + '\n'));
    files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
    const contentsSha256 = sha(JSON.stringify(files));
    const basename = `werhd-cloudflare-${release.build.patchSha256.slice(0, 10)}-${contentsSha256.slice(0, 8)}`;
    const directory = path.join(output, basename), archive = path.join(output, basename + '.zip');
    await rejectSymlink(directory); await rejectSymlink(archive);
    const existing = await fs.lstat(directory).catch(error => {if (error.code === 'ENOENT') return null; throw error;});
    if (existing) {
      if (!existing.isDirectory()) throw new Error('Existing package output is not an ordinary folder');
      const found = [];
      async function inspect(current, prefix = '') {
        for (const entry of await fs.readdir(current, {withFileTypes: true})) {
          if (entry.isSymbolicLink()) throw new Error('Existing package symlink rejected');
          const relative = path.posix.join(prefix, entry.name);
          if (entry.isDirectory()) await inspect(path.join(current, entry.name), relative);
          else if (entry.isFile()) found.push(relative);
          else throw new Error('Existing package contains a non-regular entry');
        }
      }
      await inspect(directory);
      if (JSON.stringify(found.sort()) !== JSON.stringify(files.map(file => file.path).sort()))
        throw new Error('Existing package has missing or extra files; preserved for inspection');
      for (const file of files) {
        await rejectSymlink(path.join(directory, file.path));
        if (await hashNativeFile(path.join(directory, file.path)) !== file.sha256)
          throw new Error('Existing content-addressed package folder differs; preserved for inspection');
      }
      await fs.rm(stage, {recursive: true});
    } else await fs.rename(stage, directory);
    await exec(process.env.PYTHON || 'python3', ['-c', `
import hashlib, json, pathlib, sys, zipfile
source = pathlib.Path(sys.argv[1])
with zipfile.ZipFile(sys.argv[2], 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
    for entry in sorted(json.loads(sys.argv[3]), key=lambda item: item['path']):
        relative = pathlib.PurePosixPath(entry['path'])
        if relative.is_absolute() or '..' in relative.parts: raise RuntimeError('Unsafe package path')
        file = source.joinpath(*relative.parts)
        for parent in [file, *file.parents]:
            if parent == source.parent: break
            if parent.is_symlink(): raise RuntimeError('Package symlink rejected')
        data = file.read_bytes()
        if len(data) != entry['bytes'] or hashlib.sha256(data).hexdigest() != entry['sha256']:
            raise RuntimeError('Package content changed before ZIP creation')
        info = zipfile.ZipInfo(entry['path'], (1980,1,1,0,0,0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o100644 << 16
        archive.writestr(info, data, compresslevel=6)
`, directory, archive, JSON.stringify(files)]);
    const receipt = {schema: 1, kind: 'werhd-cloudflare-package-receipt', file: archive,
      directory, bytes: (await fs.stat(archive)).size, sha256: await hashNativeFile(archive), contentsSha256,
      sourcePatchSha256: release.build.patchSha256, catalogIdentity: release.catalogIdentity,
      resourceManifestSha256: release.build.resourceManifestSha256, deploymentPerformed: false, files};
    await fs.writeFile(archive + '.json', JSON.stringify(receipt, null, 2) + '\n');
    console.log(JSON.stringify(receipt, null, 2));
    return receipt;
  } finally { await fs.rm(stage, {recursive: true, force: true}); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  await packageNativeCloudflare();
