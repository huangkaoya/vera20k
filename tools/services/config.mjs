import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const roles = ['web', 'resources', 'lobby', 'battle'];
function httpUrl(value, label) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${label} must be an absolute HTTP(S) URL`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} must be an HTTP(S) URL without credentials, query or fragment`);
  }
  return url.href.replace(/\/$/, '');
}
export function endpoint(base, pathname) {
  return new URL(pathname.replace(/^\//, ''), base.replace(/\/$/, '') + '/').href;
}
function publicAssetUrl(value, label) { return httpUrl(value, label); }
export function normalizeConfig(input, {root = projectRoot, assetRoot = process.env.VERA_ASSET_ROOT} = {}) {
  if (!input || input.schema !== 1) throw new Error('Service configuration schema must be 1');
  const result = {schema: 1};
  const listeners = new Set();
  for (const role of roles) {
    const item = input[role];
    if (!item || typeof item.host !== 'string' || !item.host || !Number.isInteger(item.port) || item.port < 1 || item.port > 65535) {
      throw new Error(`${role} requires a host and port (1-65535)`);
    }
    const host = ['localhost', '::1', '127.0.0.1'].includes(item.host) ? 'loopback' : item.host;
    const listener = `${host}:${item.port}`;
    if (listeners.has(listener)) throw new Error(`Duplicate service listener: ${listener}`);
    listeners.add(listener);
    result[role] = {host: item.host, port: item.port, publicUrl: httpUrl(item.publicUrl, `${role}.publicUrl`)};
  }
  result.battle.internalUrl = httpUrl(input.battle.internalUrl ?? result.battle.publicUrl, 'battle.internalUrl');
  if (new URL(result.battle.internalUrl).pathname !== '/') throw new Error('battle.internalUrl must be an HTTP(S) origin without a path');
  result.allowedOrigins = [...new Set([new URL(result.web.publicUrl).origin, ...(input.allowedOrigins ?? []).map(value => {
    const normalized = httpUrl(value, 'allowedOrigins');
    if (new URL(normalized).pathname !== '/') throw new Error('allowedOrigins entries must be origins');
    return new URL(normalized).origin;
  })])];
  const insideRoot = (value, label) => {
    const resolved = path.resolve(root, value);
    if (!resolved.startsWith(path.resolve(root) + path.sep)) throw new Error(`${label} must be inside werhd-vera`);
    return resolved;
  };
  result.publicDir = insideRoot(input.resources.publicDir ?? 'public', 'resources.publicDir');
  result.distDir = insideRoot(input.web.distDir ?? 'dist', 'web.distDir');
  result.assetRoot = path.resolve(assetRoot ?? input.resources.assetRoot ?? path.join(os.homedir(), 'Library/Application Support/VERA20k/retail-assets'));
  result.runtime = {
    schema: 1,
    assets: {
      manifestUrl: publicAssetUrl(input.assets?.manifestUrl ?? endpoint(result.resources.publicUrl, 'generated/catalog.json'), 'assets.manifestUrl'),
      wasmUrl: publicAssetUrl(input.assets?.wasmUrl ?? endpoint(result.resources.publicUrl, 'wasm/vera_web_core.wasm'), 'assets.wasmUrl'),
      resourceManifestUrl: publicAssetUrl(input.assets?.resourceManifestUrl ?? endpoint(result.resources.publicUrl, 'api/resources'), 'assets.resourceManifestUrl'),
    },
    network: {lobbyUrl: endpoint(result.lobby.publicUrl, 'ws/rooms').replace(/^http/, 'ws')},
  };
  if (new URL(result.web.publicUrl).protocol === 'https:') {
    const urls = [...Object.values(result.runtime.assets), result.runtime.network.lobbyUrl, result.battle.publicUrl];
    if (urls.some(value => ['http:', 'ws:'].includes(new URL(value).protocol))) throw new Error('HTTPS web requires HTTPS assets and WSS services');
  }
  return result;
}
export async function loadConfig(filename = 'config/sites.local.json', options = {}) {
  const root = options.root ?? projectRoot;
  return normalizeConfig(JSON.parse(await fs.readFile(path.resolve(root, filename), 'utf8')), {...options, root});
}
