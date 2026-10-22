// Alternate transport only. Original catalog descriptors, gzip/raw checksums,
// cache keys and the engine's required resource identity remain authoritative.
const HASH = /^[a-f0-9]{64}$/;
const MAX_PART_BYTES = 48_000_000, MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_SOURCES = 128, MAX_PARTS = 4096, MAX_WIRE_BYTES = 1024 ** 3;

export class ResourcePackError extends Error {
  constructor(message, options) { super(message, options); this.name = 'ResourcePackError'; }
}
const fail = message => { throw new ResourcePackError(message); };
const aborted = signal => signal?.reason instanceof Error ? signal.reason : new DOMException('资源分包下载已取消', 'AbortError');
const check = signal => { if (signal?.aborted) throw aborted(signal); };
function awaitSignal(value, signal) {
  const pending = Promise.resolve(value);
  if (!signal) return pending;
  if (signal.aborted) { void pending.catch(() => {}); return Promise.reject(aborted(signal)); }
  return new Promise((resolve, reject) => {
    const stop = () => { cleanup(); reject(aborted(signal)); };
    const cleanup = () => signal.removeEventListener('abort', stop);
    signal.addEventListener('abort', stop, {once: true});
    pending.then(result => { cleanup(); try { check(signal); resolve(result); } catch (error) { reject(error); } },
      error => { cleanup(); reject(error); });
    if (signal.aborted) stop();
  });
}
async function digest(bytes, crypto, signal) {
  const result = await awaitSignal(crypto.subtle.digest('SHA-256', bytes), signal);
  return Array.from(new Uint8Array(result), byte => byte.toString(16).padStart(2, '0')).join('');
}
function sourceUrl(value) {
  if (typeof value !== 'string') fail('资源分包地址无效');
  let url;
  try { url = new URL(value); } catch { fail('资源分包地址必须是完整 URL'); }
  const local = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !local) || url.username || url.password || url.hash)
    fail('资源分包地址必须使用 HTTPS');
  return url.pathname.endsWith('/') ? new URL('manifest.json', url) : url;
}
async function responseBytes(response, {limit, exact, signal}) {
  if (!response.body) fail('资源分包响应没有内容');
  const reader = response.body.getReader(), chunks = exact === undefined ? [] : null;
  const output = exact === undefined ? null : new Uint8Array(exact);
  let length = 0;
  try {
    for (;;) {
      const {done, value} = await awaitSignal(reader.read(), signal);
      if (done) break;
      check(signal);
      if (!(value instanceof Uint8Array) || value.length > limit - length) fail('资源分包内容超过声明大小');
      if (output) output.set(value, length); else chunks.push(value);
      length += value.length;
    }
    if (exact !== undefined && length !== exact) fail(`资源分包长度不符：${length}/${exact}`);
    if (output) return output;
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return bytes;
  } catch (error) {
    void reader.cancel(error).catch(() => {}); throw error;
  } finally { reader.releaseLock(); }
}
function catalogObjects(catalog) {
  if (catalog?.schema !== 2 || !HASH.test(catalog.catalogIdentity) || !HASH.test(catalog.identity))
    fail('资源分包缺少有效的游戏资源目录');
  const objects = new Map();
  for (const scope of [catalog, ...Object.values(catalog.profiles ?? {}), ...Object.values(catalog.packs ?? {})]) {
    if (!Array.isArray(scope.files)) fail('游戏资源目录文件列表无效');
    for (const file of scope.files) {
      const wire = file?.download;
      if (!wire || !HASH.test(wire.sha256) || wire.encoding !== 'gzip'
        || !Number.isSafeInteger(wire.bytes) || wire.bytes <= 0 || wire.bytes > MAX_WIRE_BYTES
        || wire.url !== `/content/objects/${wire.sha256}`) fail('游戏资源压缩对象无效');
      const previous = objects.get(wire.sha256);
      if (previous && previous.bytes !== wire.bytes) fail('游戏资源目录压缩对象冲突');
      objects.set(wire.sha256, {bytes: wire.bytes, parts: []});
    }
  }
  if (!objects.size) fail('游戏资源目录为空');
  return objects;
}

/** Fetch-compatible adapter for a complete set of reviewed resource shard
 * manifests. Empty configuration returns the original transport untouched.
 * Every source is validated before any game/art object can be downloaded.
 */
export async function createResourcePackFetch({sources = [], catalog, fetch = globalThis.fetch?.bind(globalThis),
  fallbackFetch, crypto = globalThis.crypto, signal} = {}) {
  if (!Array.isArray(sources) || sources.length > MAX_SOURCES) fail('资源分包地址列表无效');
  if (typeof fallbackFetch !== 'function') fail('缺少默认资源下载服务');
  if (!sources.length) return fallbackFetch;
  if (typeof fetch !== 'function' || !crypto?.subtle) fail('浏览器缺少资源分包校验能力');
  check(signal);
  const objects = catalogObjects(catalog), urls = new Set(), packIds = new Set();
  let totalParts = 0;
  // Manifests are small; sequential validation keeps network work bounded and
  // fails before any partial directory can be used for a game download.
  for (const source of sources) {
    const location = sourceUrl(typeof source === 'string' ? source : source?.url);
    const pin = typeof source === 'object' && source !== null ? source.sha256 : undefined;
    if (pin !== undefined && !HASH.test(pin)) fail('资源分包目录校验码无效');
    if (urls.has(location.href)) fail('资源分包目录地址重复');
    urls.add(location.href);
    const response = await awaitSignal(fetch(location.href, {signal, credentials: 'omit', redirect: 'error', cache: 'no-store'}), signal);
    if (!response.ok) { void response.body?.cancel().catch(() => {}); fail(`资源分包目录读取失败：HTTP ${response.status}`); }
    const bytes = await responseBytes(response, {limit: MAX_MANIFEST_BYTES, signal});
    if (pin && await digest(bytes, crypto, signal) !== pin) fail('资源分包目录校验失败');
    let manifest;
    try { manifest = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)); }
    catch { fail('资源分包目录不是有效 JSON'); }
    if (manifest.schema !== 1 || manifest.kind !== 'werhd-resource-shard'
      || manifest.catalogIdentity !== catalog.catalogIdentity || manifest.requiredResourceIdentity !== catalog.identity
      || typeof manifest.packId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(manifest.packId)
      || !Array.isArray(manifest.parts) || !manifest.parts.length) fail('资源分包目录与当前游戏版本不一致');
    if (packIds.has(manifest.packId)) fail('资源分包编号重复');
    packIds.add(manifest.packId);
    totalParts += manifest.parts.length;
    if (totalParts > MAX_PARTS) fail('资源分包片段数量超出限制');
    for (const part of manifest.parts) {
      const object = objects.get(part?.wireSha256);
      if (!object || part.wireBytes !== object.bytes || !HASH.test(part.sha256)
        || !Number.isSafeInteger(part.offset) || part.offset < 0
        || !Number.isSafeInteger(part.bytes) || part.bytes <= 0 || part.bytes > MAX_PART_BYTES
        || part.offset > part.wireBytes - part.bytes || part.path !== `parts/${part.sha256}.bin`)
        fail('资源分包片段描述无效或不属于当前资源目录');
      object.parts.push({...part, url: new URL(part.path, location).href, packId: manifest.packId});
    }
  }
  for (const object of objects.values()) {
    object.parts.sort((a, b) => a.offset - b.offset);
    let offset = 0;
    for (const part of object.parts) {
      if (part.offset !== offset) fail('资源分包片段存在重叠或缺口');
      offset += part.bytes;
    }
    if (offset !== object.bytes) fail('资源分包目录未完整覆盖游戏资源');
  }
  check(signal);

  return async function resourcePackFetch(input, options = {}) {
    const address = new URL(typeof input === 'string' || input instanceof URL ? input : input.url,
      globalThis.location?.href ?? 'https://werhd-resource.invalid/');
    const match = /^\/content\/objects\/([a-f0-9]{64})$/.exec(address.pathname);
    const object = match && objects.get(match[1]);
    // Engine WASM is deliberately outside the art catalog and stays on the
    // existing service. A mapped art object never silently falls back there.
    if (!object) return fallbackFetch(input, options);
    const method = options.method ?? (typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET');
    const requestSignal = options.signal ?? (typeof Request !== 'undefined' && input instanceof Request ? input.signal : undefined);
    check(requestSignal);
    if (!['GET', 'HEAD'].includes(method)) fail('资源分包仅支持读取');
    const headers = {'Content-Type': 'application/gzip', 'Content-Length': String(object.bytes)};
    if (method === 'HEAD') return new Response(null, {headers});
    const controller = new AbortController();
    let streamController, active = true, index = 0;
    const cleanup = () => requestSignal?.removeEventListener('abort', stop);
    const stop = () => {
      if (!active) return;
      active = false; controller.abort(requestSignal?.reason); cleanup();
      streamController?.error(aborted(requestSignal));
    };
    requestSignal?.addEventListener('abort', stop, {once: true});
    const stream = new ReadableStream({
      start(current) { streamController = current; if (requestSignal?.aborted) stop(); },
      async pull(current) {
        if (!active) return;
        const part = object.parts[index];
        try {
          check(controller.signal);
          const pending = Promise.resolve().then(() => fetch(part.url, {signal: controller.signal, credentials: 'omit', redirect: 'error'}));
          pending.then(response => { if (!active) void response.body?.cancel().catch(() => {}); }, () => {});
          const response = await awaitSignal(pending, controller.signal);
          if (!response.ok) { void response.body?.cancel().catch(() => {}); fail(`资源分包 ${part.packId} 下载失败：HTTP ${response.status}`); }
          const bytes = await responseBytes(response, {limit: part.bytes, exact: part.bytes, signal: controller.signal});
          if (await digest(bytes, crypto, controller.signal) !== part.sha256) fail(`资源分包 ${part.packId} 校验失败`);
          check(controller.signal);
          if (!active) return;
          current.enqueue(bytes); index++;
          if (index === object.parts.length) { active = false; cleanup(); current.close(); }
        } catch (error) {
          if (active) { active = false; cleanup(); controller.abort(error); current.error(error); }
        }
      },
      cancel(reason) { active = false; cleanup(); controller.abort(reason); },
    }, {highWaterMark: 0});
    return new Response(stream, {headers});
  };
}
