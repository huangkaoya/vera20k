// Binary content delivery is independent of the engine, lobby and installed
// game modes. Descriptors identify raw bytes; download describes the wire form.
const CACHE_NAME = 'werhd-native-content-v1';
// Read-only compatibility lookup for already-installed bytes. These legacy
// names are never used for new downloads or exposed resource URLs.
const LEGACY_CACHE_NAME = 'vera-native-content-v1';
const LEGACY_CACHE_PATH = '/.vera-content-cache/v1/';
const MAX_FILE_BYTES = 1024 ** 3;

export class ContentError extends Error {
  constructor(message, {retryable = false, cause} = {}) {
    super(message, {cause}); this.name = 'ContentError'; this.retryable = retryable;
  }
}
const aborted = signal => signal?.reason instanceof Error ? signal.reason : new DOMException('Content download cancelled', 'AbortError');
const check = context => { if (!context.active || context.signal?.aborted) throw aborted(context.signal); };
function activeAwait(value, context) {
  const pending = Promise.resolve(value);
  try { check(context); } catch (error) { void pending.catch(() => {}); return Promise.reject(error); }
  if (!context.signal) return pending;
  return new Promise((resolve, reject) => {
    const cancel = () => { cleanup(); reject(aborted(context.signal)); };
    const cleanup = () => context.signal.removeEventListener('abort', cancel);
    context.signal.addEventListener('abort', cancel, {once: true});
    pending.then(result => { cleanup(); try { check(context); resolve(result); } catch (error) { reject(error); } }, error => { cleanup(); reject(error); });
    if (context.signal.aborted) cancel();
  });
}
function retryWait(milliseconds, context) {
  check(context);
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); context.signal?.removeEventListener('abort', cancel); };
    const cancel = () => { cleanup(); reject(aborted(context.signal)); };
    const timer = setTimeout(() => { cleanup(); try { check(context); resolve(); } catch (error) { reject(error); } }, milliseconds);
    context.signal?.addEventListener('abort', cancel, {once: true});
    if (context.signal?.aborted) cancel();
  });
}
function describe(file, maxFileBytes) {
  const validSize = n => Number.isSafeInteger(n) && n >= 0 && n <= maxFileBytes;
  if (!file || typeof file.name !== 'string' || !file.name || typeof file.url !== 'string' || !file.url || !validSize(file.bytes) || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(file.sha256)) throw new ContentError('Invalid content descriptor');
  const raw = {id: file.id, name: file.name, bytes: file.bytes, sha256: file.sha256.toLowerCase(), url: file.url};
  const wire = file.download ?? {url: raw.url, bytes: raw.bytes, sha256: raw.sha256, encoding: 'identity'};
  if (typeof wire.url !== 'string' || !wire.url || !validSize(wire.bytes) || typeof wire.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(wire.sha256) || !['gzip', 'identity'].includes(wire.encoding)) throw new ContentError(`Invalid download descriptor for ${raw.name}`);
  if (wire.encoding === 'identity' && (wire.bytes !== raw.bytes || wire.sha256.toLowerCase() !== raw.sha256)) throw new ContentError(`Identity download differs from raw content for ${raw.name}`);
  return {...raw, download: {...wire, sha256: wire.sha256.toLowerCase()}};
}

export class ContentStore {
  constructor({cacheStorage = globalThis.caches, fetch = globalThis.fetch?.bind(globalThis), crypto = globalThis.crypto,
    cacheName = CACHE_NAME, baseUrl = globalThis.location?.href ?? 'https://werhd-content.invalid/', retries = 1,
    retryDelayMs = 250, maxFileBytes = MAX_FILE_BYTES, onCacheStatus} = {}) {
    if (typeof fetch !== 'function' || !crypto?.subtle) throw new ContentError('Fetch and Web Crypto are required');
    if (!Number.isSafeInteger(retries) || retries < 0 || retries > 3 || !Number.isFinite(retryDelayMs) || retryDelayMs < 0 || !Number.isSafeInteger(maxFileBytes) || maxFileBytes < 0 || maxFileBytes > MAX_FILE_BYTES) throw new ContentError('Invalid content store limits');
    Object.assign(this, {fetch, crypto, cacheStorage, cacheName, baseUrl, retries, retryDelayMs, maxFileBytes, onCacheStatus});
    this.cacheAvailable = undefined;
    this.statuses = new Map(); this.writers = new Map();
  }
  cacheStatus(file) { return this.statuses.get(typeof file === 'string' ? file.toLowerCase() : file.sha256?.toLowerCase()) ?? 'unknown'; }
  key(file) { return new URL(`/.werhd-content-cache/v1/${file.sha256}`, this.baseUrl).href; }
  async digest(bytes) { return Array.from(new Uint8Array(await this.crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join(''); }
  async cache() {
    if (!this.cachePromise) this.cachePromise = (async () => {
      try { if (!this.cacheStorage?.open) throw new Error('CacheStorage is unavailable'); const cache = await this.cacheStorage.open(this.cacheName); this.cacheAvailable = true; return cache; }
      catch { this.cacheAvailable = false; return null; }
    })();
    return this.cachePromise;
  }
  async legacyCache(context) {
    if (this.cacheName !== CACHE_NAME || typeof this.cacheStorage?.open !== 'function') return null;
    try {
      let exists = false;
      if (typeof this.cacheStorage.has === 'function')
        exists = await activeAwait(this.cacheStorage.has(LEGACY_CACHE_NAME), context);
      else if (typeof this.cacheStorage.keys === 'function')
        exists = (await activeAwait(this.cacheStorage.keys(), context)).includes(LEGACY_CACHE_NAME);
      // CacheStorage.open creates a cache. Never create the retired namespace
      // just to discover whether this browser has installed content in it.
      if (!exists) return null;
      const legacy = await activeAwait(this.cacheStorage.open(LEGACY_CACHE_NAME), context);
      return legacy;
    } catch (error) { check(context); return null; }
  }
  emit(context, stage, extra = {}) {
    check(context);
    context.onProgress?.({file: context.file, stage, loadedBytes: context.loadedBytes, totalBytes: context.file.bytes,
      wireBytes: context.wireBytes, wireTotalBytes: context.file.download.bytes, attemptWireBytes: context.attemptWireBytes,
      attempt: context.attempt, cacheStatus: context.cacheStatus, ...extra});
  }
  status(context, state, error) {
    check(context); context.cacheStatus = state; this.statuses.set(context.file.sha256, state);
    this.onCacheStatus?.({file: context.file, state, ...(error ? {error: String(error.message ?? error)} : {})});
    this.emit(context, 'cache');
  }
  async readBody(body, length, context, onChunk) {
    if (!body) { if (!length) return new Uint8Array(); throw new ContentError(`Empty response for ${context.file.name}`, {retryable: true}); }
    const reader = body.getReader(); let offset = 0;
    // The validated manifest is the allocation limit, including decompression.
    const bytes = new Uint8Array(length);
    try {
      for (;;) {
        const {done, value} = await activeAwait(reader.read(), context);
        if (done) break;
        if (!(value instanceof Uint8Array)) throw new ContentError(`Invalid response chunk for ${context.file.name}`, {retryable: true});
        onChunk?.(value, offset + value.length);
        if (value.length > length - offset) throw new ContentError(`Content length exceeds ${length} bytes for ${context.file.name}`, {retryable: true});
        bytes.set(value, offset); offset += value.length;
      }
      if (offset !== length) throw new ContentError(`Content length mismatch for ${context.file.name}: ${offset}/${length}`, {retryable: true});
      return bytes;
    } catch (error) {
      // cancel() need not settle promptly for a broken transport. Observe its
      // rejection without allowing a late read to complete this operation.
      void reader.cancel(error).catch(() => {}); throw error;
    } finally { reader.releaseLock(); }
  }
  async readCached(cache, context, key = this.key(context.file)) {
    let response;
    try { response = await activeAwait(cache.match(key), context); }
    catch (error) { check(context); this.status(context, 'unavailable', error); return null; }
    if (!response) { this.status(context, 'miss'); return null; }
    let bytes;
    try {
      bytes = await this.readBody(response.body, context.file.bytes, context);
      const hash = await activeAwait(this.digest(bytes), context);
      if (hash !== context.file.sha256) throw new ContentError('Cached content checksum mismatch');
    } catch (error) {
      check(context);
      // Delete exactly this content-addressed object, never the shared cache.
      try { await activeAwait(cache.delete(key), context); } catch (failure) { check(context); this.status(context, 'unavailable', failure); return null; }
      this.status(context, 'corrupt', error); return null;
    }
    context.loadedBytes = bytes.length; this.status(context, 'hit'); return bytes;
  }
  cacheResponse(bytes, context) {
    return new Response(bytes, {headers: {'Content-Type': 'application/octet-stream',
      'Content-Length': String(bytes.length), 'X-Werhd-Content-SHA256': context.file.sha256}});
  }
  async readLegacyCached(current, context) {
    const canCopy = current && context.cacheStatus !== 'unavailable';
    const legacy = await this.legacyCache(context);
    if (!legacy) return null;
    const oldKey = new URL(LEGACY_CACHE_PATH + context.file.sha256, this.baseUrl).href;
    const bytes = await this.readCached(legacy, context, oldKey);
    if (!bytes) {
      // A retired-cache read error does not disable an otherwise healthy new
      // cache for the verified replacement downloaded below.
      if (canCopy && context.cacheStatus === 'unavailable') this.status(context, 'miss');
      return null;
    }
    let copied = false;
    if (canCopy) copied = await this.writeCached(current, bytes, context, {preserveVerifiedCopy: true});
    if (copied && legacy !== current) {
      // Delete only after the new copy committed. Cache.delete is not
      // cancellable, so compensate a late deletion if this read was cancelled.
      const retired = Promise.resolve().then(() => { check(context); return legacy.delete(oldKey); }).then(async deleted => {
        if (deleted && (!context.active || context.signal?.aborted)) {
          try { await legacy.put(oldKey, this.cacheResponse(bytes, context)); } catch { /* The valid new copy still exists. */ }
        }
      });
      try { await activeAwait(retired, context); }
      catch (error) { check(context); /* Failed cleanup retains a usable copy. */ }
    }
    // Adapters that alias cache names may still supply a valid old-path hit.
    // Copy that one object, but never retire entries from the active Cache.
    // A failed migration is still a real, verified legacy cache hit. Returning
    // these bytes must never fall through to a redundant network download.
    if (!copied) this.status(context, 'hit');
    context.legacyCache = true; context.migratedCache = copied;
    return bytes;
  }
  async download(context) {
    const {file} = context, wire = file.download;
    if (wire.encoding === 'gzip' && typeof DecompressionStream !== 'function') throw new ContentError('This browser cannot decompress the selected resource pack');
    const pending = Promise.resolve().then(() => this.fetch(wire.url, {signal: context.signal}));
    // Some fetch adapters ignore abort; dispose their eventual body as well.
    pending.then(response => { if (!context.active || context.signal?.aborted) void response.body?.cancel().catch(() => {}); }, () => {});
    const response = await activeAwait(pending, context);
    if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new ContentError(`Resource ${file.name} returned HTTP ${response.status}`, {retryable: response.status >= 500 || response.status === 408 || response.status === 429}); }
    // Fetch may decode HTTP Content-Encoding automatically. The descriptor's
    // gzip is an explicit binary transport object, not an HTTP encoding header.
    let wireBytes = await this.readBody(response.body, wire.bytes, context, (_chunk, offset) => {
      context.wireBytes += offset - context.attemptWireBytes; context.attemptWireBytes = offset;
      if (wire.encoding === 'identity') context.loadedBytes = offset;
      this.emit(context, 'download');
    });
    this.emit(context, 'verify');
    const wireHash = await activeAwait(this.digest(wireBytes), context);
    if (wireHash !== wire.sha256) throw new ContentError(`Download checksum mismatch for ${file.name}`, {retryable: true});
    let bytes = wireBytes;
    if (wire.encoding === 'gzip') {
      const stream = new Blob([wireBytes]).stream().pipeThrough(new DecompressionStream('gzip'));
      wireBytes = null;
      try { bytes = await this.readBody(stream, file.bytes, context, (_chunk, offset) => { context.loadedBytes = offset; this.emit(context, 'verify'); }); }
      catch (error) { check(context); if (error instanceof ContentError) throw error; throw new ContentError(`Invalid gzip content for ${file.name}`, {cause: error, retryable: true}); }
      if (await activeAwait(this.digest(bytes), context) !== file.sha256) throw new ContentError(`Content checksum mismatch for ${file.name}`, {retryable: true});
    }
    check(context); context.loadedBytes = bytes.length; return bytes;
  }
  async writeCached(cache, bytes, context, {preserveVerifiedCopy = false} = {}) {
    const key = this.key(context.file), token = {};
    this.writers.set(key, token);
    try {
      check(context);
      const put = cache.put(key, this.cacheResponse(bytes, context));
      const settled = Promise.resolve(put).then(async () => {
        // A migrated copy was already validated and installed in the retired
        // namespace. Retaining a late completed copy cannot install new bytes;
        // it also protects another successful reader from losing its copy.
        if (!preserveVerifiedCopy && (!context.active || context.signal?.aborted) && this.writers.get(key) === token) {
          await cache.delete(key);
        }
      }).finally(() => { if (this.writers.get(key) === token) this.writers.delete(key); });
      await activeAwait(settled, context); this.status(context, 'stored'); return true;
    } catch (error) { check(context); this.status(context, 'write-failed', error); return false; }
    finally { if (context.active && !context.signal?.aborted && this.writers.get(key) === token) this.writers.delete(key); }
  }
  /** Return validated raw bytes. Cache failure is reported, not a play failure.
   * Abort the previous controller when replacing a download task. Progress
   * wireBytes includes retries; a cache hit transfers zero wire bytes. */
  async loadFile(file, {signal, onProgress} = {}) {
    file = describe(file, this.maxFileBytes);
    const context = {file, signal, onProgress, active: true, loadedBytes: 0, wireBytes: 0, attemptWireBytes: 0, attempt: 0, cacheStatus: 'unknown'};
    try {
      check(context); const cache = await activeAwait(this.cache(), context);
      if (!cache) this.status(context, 'unavailable');
      let cached = cache ? await this.readCached(cache, context) : null;
      if (!cached) cached = await this.readLegacyCached(cache, context);
      if (cached) {
        this.emit(context, 'complete', {fromCache: true, legacyCache: context.legacyCache === true,
          migratedCache: context.migratedCache === true});
        check(context); return cached;
      }
      let bytes;
      for (let attempt = 1; attempt <= this.retries + 1; attempt++) {
        context.attempt = attempt; context.attemptWireBytes = 0; context.loadedBytes = 0;
        try { bytes = await this.download(context); break; }
        catch (error) {
          check(context);
          const retryable = error instanceof ContentError ? error.retryable : error?.name !== 'AbortError';
          if (!retryable || attempt > this.retries) throw error;
          this.emit(context, 'retry');
          await retryWait(this.retryDelayMs * attempt, context);
        }
      }
      check(context);
      if (cache && context.cacheStatus !== 'unavailable') await this.writeCached(cache, bytes, context);
      this.emit(context, 'complete', {fromCache: false}); return bytes;
    } finally { context.active = false; }
  }
  /** Download/cache only, without mounting an engine or retaining byte arrays.
   * installed is false on unavailable/full storage, even if downloads succeed. */
  async prefetch(files, {signal, onProgress, concurrency = 2} = {}) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new ContentError('Prefetch concurrency must be 1–4');
    if (!Array.isArray(files)) throw new ContentError('Prefetch files must be an array');
    files = files.map(file => describe(file, this.maxFileBytes));
    const controller = new AbortController(), stop = () => controller.abort(signal?.reason), results = new Array(files.length), transferred = new Array(files.length).fill(0);
    if (signal?.aborted) throw aborted(signal);
    signal?.addEventListener('abort', stop, {once: true});
    let next = 0, completedFiles = 0, failure;
    const totalWireBytes = files.reduce((total, file) => total + file.download.bytes, 0);
    try {
      await Promise.all(Array.from({length: Math.min(concurrency, files.length)}, async () => {
        while (!controller.signal.aborted) {
          const index = next++; if (index >= files.length) return;
          try {
            const bytes = await this.loadFile(files[index], {signal: controller.signal, onProgress: progress => {
              transferred[index] = progress.wireBytes;
              if (progress.stage === 'complete') completedFiles++;
              onProgress?.({...progress, completedFiles, totalFiles: files.length, totalWireBytes, transferredWireBytes: transferred.reduce((total, count) => total + count, 0)});
            }});
            if (controller.signal.aborted) return;
            results[index] = {name: files[index].name, bytes: bytes.length, cacheStatus: this.cacheStatus(files[index])};
          } catch (error) { if (!failure) failure = error; controller.abort(error); return; }
        }
      }));
      if (failure) throw failure;
      if (controller.signal.aborted) throw aborted(controller.signal);
      return {files: results, cacheAvailable: this.cacheAvailable === true, installed: results.length > 0 && results.every(file => file.cacheStatus === 'stored' || file.cacheStatus === 'hit')};
    } finally { signal?.removeEventListener('abort', stop); }
  }
}
