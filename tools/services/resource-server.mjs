import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createResourceIndex, isPublicRetailFile } from '../dev-server.mjs';
import { MIME, requestPath, ownedDirectory, openRegularFile, fingerprint, sendFile, sendJson,
  methods, failRequest, listen, closeServer, httpError } from './http-files.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const graphicExtensions = new Set(['.json', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.svg']);
const allowedHeaders = new Set(['range', 'if-none-match', 'if-modified-since', 'if-range']);

function origins(values) {
  return new Set(values.map(value => {
    const origin = new URL(value);
    if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== value) throw new Error('CORS origins must be exact HTTP(S) origins');
    return value;
  }));
}

// The exporter also serves monolith builds, so its root-relative paths stay on
// disk. Relative catalog links keep a reverse proxy's public base path intact.
function relativeCatalog(data) {
  const rewrite = (record, fields) => {
    if (!record || typeof record !== 'object') return;
    for (const field of fields) if (typeof record[field] === 'string' && record[field].startsWith('/generated/')) record[field] = record[field].slice('/generated/'.length);
  };
  if (Array.isArray(data.maps)) for (const map of data.maps) rewrite(map, ['image', 'minimap', 'terrainImage', 'previewImage']);
  if (data.sprites && typeof data.sprites === 'object') for (const sprite of Object.values(data.sprites)) rewrite(sprite, ['image', 'remapImage', 'cameo']);
  return data;
}

export async function createResourceServer({ root = projectRoot,
  assetRoot = process.env.VERA_ASSET_ROOT ?? path.join(os.homedir(), 'Library/Application Support/VERA20k/retail-assets'),
  publicDir = 'public', port = 5281, host = '127.0.0.1', publicUrl,
  allowedOrigins = ['http://127.0.0.1:5280', 'http://localhost:5280'],
} = {}) {
  const publicRoot = await ownedDirectory(root, publicDir);
  const retailRoot = await fs.realpath(path.resolve(assetRoot));
  const index = await createResourceIndex(retailRoot);
  const admitted = new Map();
  for (const [name, file] of index.allowed) {
    const opened = await openRegularFile(retailRoot, file.name);
    admitted.set(name, { ...file, fingerprint: fingerprint(opened.stat) }); await opened.handle.close();
  }
  const corsOrigins = origins(allowedOrigins), cache = new Map();
  let serviceUrl, manifest;
  const server = http.createServer(async (request, response) => {
    response.setHeader('Vary', 'Origin');
    try {
      const pathname = requestPath(request);
      const route = pathname === '/api/resources' || pathname === '/api/health' || pathname.startsWith('/retail/')
        || pathname.startsWith('/generated/') || pathname.startsWith('/wasm/');
      if (!route) throw httpError(404, 'Route not exposed');
      const origin = request.headers.origin;
      if (origin && !corsOrigins.has(origin)) throw httpError(403, 'Origin not allowed');
      if (origin) {
        response.setHeader('Access-Control-Allow-Origin', origin);
        response.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges, ETag, X-Content-SHA256');
      }
      if (request.method === 'OPTIONS') {
        const method = request.headers['access-control-request-method'];
        const requestedHeaders = String(request.headers['access-control-request-headers'] ?? '').split(',').map(header => header.trim().toLowerCase()).filter(Boolean);
        if (!origin || !['GET', 'HEAD'].includes(method) || requestedHeaders.some(header => !allowedHeaders.has(header))) throw httpError(403, 'Preflight not allowed');
        response.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
          'Access-Control-Allow-Headers': 'Range, If-None-Match, If-Modified-Since, If-Range', 'Access-Control-Max-Age': '600' }); response.end(); return;
      }
      if (!methods(request, response)) return;
      if (pathname === '/api/health') {
        sendJson(request, response, 200, { ok: true, service: 'resources', protocol: 1,
          resources: { count: manifest.files.length, bytes: manifest.totalBytes } }); return;
      }
      if (pathname === '/api/resources') { sendJson(request, response, 200, manifest, { etag: true }); return; }
      if (pathname.startsWith('/retail/')) {
        const name = pathname.slice('/retail/'.length);
        const file = isPublicRetailFile(name) ? admitted.get(name.toLowerCase()) : undefined;
        if (!file) throw httpError(404, 'Resource not exposed');
        await sendFile(request, response, await openRegularFile(retailRoot, file.name), {
          mime: 'application/octet-stream', digest: file.sha256, expectedFingerprint: file.fingerprint,
        }); return;
      }
      const isWasm = pathname.startsWith('/wasm/');
      const extension = path.extname(pathname).toLowerCase();
      if (isWasm ? extension !== '.wasm' : !graphicExtensions.has(extension)) throw httpError(404, 'File not exposed');
      if (pathname === '/generated/catalog.json' || pathname === '/generated/manifest.json') {
        const opened = await openRegularFile(publicRoot, pathname.slice(1));
        let data;
        try { data = relativeCatalog(JSON.parse(await opened.handle.readFile('utf8'))); }
        finally { await opened.handle.close(); }
        sendJson(request, response, 200, data, { etag: true, range: true, cacheControl: 'no-cache' }); return;
      }
      await sendFile(request, response, await openRegularFile(publicRoot, pathname.slice(1)), { mime: MIME[extension], cache });
    } catch (error) { failRequest(request, response, error); }
  });
  serviceUrl = await listen(server, port, host);
  let published;
  try {
    published = new URL(publicUrl ?? serviceUrl);
    if (!['http:', 'https:'].includes(published.protocol) || published.username || published.password || published.search || published.hash) throw new Error('Invalid resource public URL');
  } catch (error) { await closeServer(server); throw error; }
  const baseUrl = published.href.replace(/\/$/, '') + '/';
  manifest = { ...index.manifest, files: index.manifest.files.map(file => ({ ...file, url: new URL(file.url.slice(1), baseUrl).href })) };
  let closing;
  return { server, url: serviceUrl, publicUrl: baseUrl.replace(/\/$/, ''), manifest,
    close() { return closing ??= closeServer(server); },
  };
}
