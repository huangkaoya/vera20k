import type { ResourceManifest } from '../engine/types';

export interface RuntimeAssets {
  manifestUrl: string;
  wasmUrl: string;
  resourceManifestUrl: string;
}
export interface RuntimeConfig {
  schema: 1;
  assets: RuntimeAssets;
  network: { lobbyUrl: string };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 必须是对象`);
  return value as Record<string, unknown>;
}
function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} 缺少有效 URL`);
  return value;
}
function checkUrl(url: URL, protocols: string[], pageUrl: string, label: string): string {
  if (!protocols.includes(url.protocol)) throw new Error(`${label} 不支持 ${url.protocol} 协议`);
  if (url.username || url.password) throw new Error(`${label} 不能包含用户名或密码`);
  if (new URL(pageUrl).protocol === 'https:' && (url.protocol === 'http:' || url.protocol === 'ws:')) {
    throw new Error(`${label} 会产生混合内容，HTTPS 页面必须使用 HTTPS/WSS`);
  }
  return url.href;
}

/** Resolve against the document that owns the URL, never against the game page by accident. */
export function resolveHttpUrl(value: unknown, baseUrl: string, pageUrl = baseUrl, label = '资源 URL'): string {
  const text = string(value, label);
  let url: URL;
  try { url = new URL(text, baseUrl); } catch { throw new Error(`${label} 无效`); }
  return checkUrl(url, ['http:', 'https:'], pageUrl, label);
}
export function resolveSocketUrl(value: unknown, baseUrl: string, pageUrl = baseUrl, label = '联机 URL'): string {
  const text = string(value, label);
  let url: URL;
  try { url = new URL(text, baseUrl); } catch { throw new Error(`${label} 无效`); }
  // A relative /ws/... address inherits the page's security; an explicit URL must be WS(S).
  if (!/^[a-z][a-z\d+.-]*:/i.test(text)) {
    if (url.protocol === 'https:') url.protocol = 'wss:';
    else if (url.protocol === 'http:') url.protocol = 'ws:';
  }
  return checkUrl(url, ['ws:', 'wss:'], pageUrl, label);
}

export function parseRuntimeConfig(value: unknown, configUrl: string, pageUrl = configUrl): RuntimeConfig {
  const input = record(value, '运行配置');
  if (input.schema !== 1) throw new Error('运行配置版本无效');
  const assets = record(input.assets, 'assets'), network = record(input.network, 'network');
  return {
    schema: 1,
    assets: {
      manifestUrl: resolveHttpUrl(assets.manifestUrl, configUrl, pageUrl, '美术清单 URL'),
      wasmUrl: resolveHttpUrl(assets.wasmUrl, configUrl, pageUrl, 'WASM URL'),
      resourceManifestUrl: resolveHttpUrl(assets.resourceManifestUrl, configUrl, pageUrl, '游戏资源清单 URL'),
    },
    network: { lobbyUrl: resolveSocketUrl(network.lobbyUrl, configUrl, pageUrl, '大厅 URL') },
  };
}

export async function loadRuntimeConfig(pageUrl = location.href, fetcher: typeof fetch = fetch): Promise<RuntimeConfig> {
  const configUrl = resolveHttpUrl('/api/config', pageUrl);
  const response = await fetcher(configUrl);
  if (!response.ok) throw new Error(`无法读取运行配置：${response.status}`);
  const baseUrl = resolveHttpUrl(response.url || configUrl, configUrl, pageUrl, '运行配置 URL');
  return parseRuntimeConfig(await response.json(), baseUrl, pageUrl);
}

/** Resource paths belong to the resource service, including after an HTTP redirect. */
export function resolveResourceManifest(value: unknown, manifestUrl: string, pageUrl = manifestUrl): ResourceManifest {
  const input = record(value, '游戏资源清单');
  if (input.schema !== 1 || !Array.isArray(input.files) || !input.files.length) throw new Error('游戏资源清单版本或文件列表无效');
  const names = new Set<string>();
  const files = input.files.map((value, index) => {
    const file = record(value, `资源 ${index}`), name = file.name;
    if (typeof name !== 'string' || !name || names.has(name.toLowerCase())) throw new Error(`资源 ${index} 名称无效或重复`);
    names.add(name.toLowerCase());
    if (typeof file.bytes !== 'number' || !Number.isSafeInteger(file.bytes) || file.bytes < 0) throw new Error(`资源 ${name} 大小无效`);
    if (typeof file.sha256 !== 'string' || !/^[\da-f]{64}$/i.test(file.sha256)) throw new Error(`资源 ${name} SHA-256 无效`);
    return { name, bytes: file.bytes, sha256: file.sha256.toLowerCase(), url: resolveHttpUrl(file.url, manifestUrl, pageUrl, `资源 ${name} URL`) };
  });
  const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  if (!Number.isSafeInteger(totalBytes) || input.totalBytes !== totalBytes) throw new Error('游戏资源清单总大小不一致');
  return { schema: 1, files, totalBytes };
}
