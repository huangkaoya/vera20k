import path from 'node:path';
import { constants, promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';

export const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.wasm': 'application/wasm',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
});

export function httpError(status, message) { return Object.assign(new Error(message), { status }); }
export function inside(root, candidate) { return candidate === root || candidate.startsWith(root + path.sep); }

/** Decode exactly once, before URL normalization can hide dot segments. */
export function requestPath(request) {
  const raw = (request.url ?? '/').split('?')[0];
  if (!raw.startsWith('/') || raw.startsWith('//')) throw httpError(400, 'Invalid path');
  let decoded;
  try { decoded = decodeURIComponent(raw); } catch { throw httpError(400, 'Invalid path encoding'); }
  if (decoded.includes('\0') || decoded.includes('\\')
      || decoded.split('/').some(part => part === '.' || part === '..' || part.startsWith('.'))) {
    throw httpError(400, 'Invalid path');
  }
  return decoded;
}

export async function ownedDirectory(root, directory) {
  const owner = await fs.realpath(path.resolve(root));
  const candidate = path.resolve(root, directory);
  if (!inside(path.resolve(root), candidate)) throw new Error('Served directory must be inside this project');
  const real = await fs.realpath(candidate);
  if (!inside(owner, real) || !(await fs.stat(real)).isDirectory()) throw new Error('Served directory must be inside this project');
  return real;
}

/** Reject every requested symlink component, including links to other project sources. */
export async function openRegularFile(root, relative) {
  const parts = relative.split('/');
  if (!relative || parts.some(part => !part || part.startsWith('.') || part.includes('\\') || part.includes('\0'))) {
    throw httpError(404, 'File not exposed');
  }
  let candidate = root;
  try {
    for (let index = 0; index < parts.length; index++) {
      candidate = path.join(candidate, parts[index]);
      const info = await fs.lstat(candidate);
      if (info.isSymbolicLink() || (index < parts.length - 1 ? !info.isDirectory() : !info.isFile())) {
        throw Object.assign(httpError(404, 'File not exposed'), { noFallback: true });
      }
    }
    const real = await fs.realpath(candidate);
    if (!inside(root, real)) throw httpError(404, 'File not exposed');
    const handle = await fs.open(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile()) { await handle.close(); throw httpError(404, 'File not exposed'); }
    return { handle, stat, filePath: real };
  } catch (error) {
    if (error.status) throw error;
    if (['ENOENT', 'ENOTDIR', 'ELOOP', 'EACCES', 'EPERM'].includes(error.code)) throw httpError(404, 'File not exposed');
    throw error;
  }
}

export function fingerprint(stat) { return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`; }
export function matchesETag(header, etag) {
  return typeof header === 'string' && header.split(',').some(value => value.trim() === '*' || value.trim().replace(/^W\//, '') === etag);
}

export function sendJson(request, response, status, data, { etag = false, range = false, cacheControl = 'no-store' } = {}) {
  const bytes = Buffer.from(JSON.stringify(data));
  const headers = { 'Content-Type': MIME['.json'], 'Content-Length': String(bytes.length),
    'Cache-Control': cacheControl, 'X-Content-Type-Options': 'nosniff' };
  if (etag) {
    const digest = createHash('sha256').update(bytes).digest('hex');
    headers.ETag = `"${digest}"`; headers['X-Content-SHA256'] = digest;
    if (matchesETag(request.headers['if-none-match'], headers.ETag)) {
      delete headers['Content-Length']; response.writeHead(304, headers); response.end(); return;
    }
  }
  let body = bytes;
  if (range) {
    headers['Accept-Ranges'] = 'bytes';
    if (request.headers.range && (!request.headers['if-range'] || request.headers['if-range'] === headers.ETag)) {
      let start, end;
      try { ({ start, end } = byteRange(request.headers.range, bytes.length)); }
      catch (error) { response.writeHead(error.status, { ...headers, 'Content-Range': `bytes */${bytes.length}`, 'Content-Length': '0' }); response.end(); return; }
      body = bytes.subarray(start, end + 1); status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${bytes.length}`; headers['Content-Length'] = String(body.length);
    }
  }
  response.writeHead(status, headers); response.end(request.method === 'HEAD' ? undefined : body);
}

function byteRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]) || size === 0) throw httpError(416, 'Invalid byte range');
  let start, end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix < 1) throw httpError(416, 'Invalid byte range');
    start = Math.max(0, size - suffix); end = size - 1;
  } else {
    start = Number(match[1]); end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) throw httpError(416, 'Invalid byte range');
    end = Math.min(size - 1, end);
  }
  return { start, end };
}

/** Hash and stream the same open file descriptor; paths are never used again after admission. */
export async function sendFile(request, response, opened, { mime, cache, digest, expectedFingerprint } = {}) {
  const { handle, stat, filePath } = opened;
  try {
    const identity = fingerprint(stat);
    if (expectedFingerprint && identity !== expectedFingerprint) throw httpError(409, 'Resource changed; restart resource service');
    if (!digest) {
      const cached = cache?.get(filePath);
      if (cached?.identity === identity) digest = cached.digest;
      else {
        const hash = createHash('sha256');
        for await (const chunk of handle.createReadStream({ autoClose: false, start: 0 })) hash.update(chunk);
        digest = hash.digest('hex'); cache?.set(filePath, { identity, digest });
      }
    }
    const etag = `"${digest}"`;
    const headers = { 'Content-Type': mime ?? MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', ETag: etag,
      'X-Content-SHA256': digest, 'Accept-Ranges': 'bytes' };
    if (matchesETag(request.headers['if-none-match'], etag)) { response.writeHead(304, headers); response.end(); return; }
    let start = 0, end = stat.size - 1, status = 200;
    if (request.headers.range && (!request.headers['if-range'] || request.headers['if-range'] === etag)) {
      try { ({ start, end } = byteRange(request.headers.range, stat.size)); }
      catch (error) {
        response.writeHead(error.status, { ...headers, 'Content-Range': `bytes */${stat.size}`, 'Content-Length': '0' }); response.end(); return;
      }
      status = 206; headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
    }
    headers['Content-Length'] = String(Math.max(0, end - start + 1));
    response.writeHead(status, headers);
    if (request.method === 'HEAD' || stat.size === 0) { response.end(); return; }
    await pipeline(handle.createReadStream({ start, end, autoClose: false }), response);
  } finally { await handle.close(); }
}

export function methods(request, response) {
  if (request.method === 'GET' || request.method === 'HEAD') return true;
  response.writeHead(405, { Allow: 'GET, HEAD', 'Content-Length': '0' }); response.end(); return false;
}

export function failRequest(request, response, error) {
  if (response.headersSent) { response.destroy(); return; }
  sendJson(request, response, error.status ?? 500, { error: error.status ? error.message : 'Request failed' });
}

export async function listen(server, port, host) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Service port must be a TCP port number');
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(); });
  });
  const address = host.includes(':') ? `[${host}]` : host;
  return `http://${address}:${server.address().port}`;
}

export async function closeServer(server) {
  await new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections?.(); });
}
