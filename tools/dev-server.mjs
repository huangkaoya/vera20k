import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { attachRooms } from './rooms.mjs';
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const retailPolicy = JSON.parse(fs.readFileSync(new URL('./retail-policy.json', import.meta.url), 'utf8'));
const names = new Set(retailPolicy.names.map(name => name.toLowerCase()));
const excluded = new Set(retailPolicy.exclude.map(name => name.toLowerCase()));
export function isPublicRetailFile(name) {
  const lower = name.toLowerCase();
  return name === path.basename(name) && !name.includes('\\') && !excluded.has(lower)
    && (names.has(lower) || (lower.endsWith('.mix') && retailPolicy.mixPrefixes.some(prefix => lower.startsWith(prefix.toLowerCase())))
      || retailPolicy.extensions.some(extension => lower.endsWith(extension.toLowerCase())));
}
const json = (response, status, data) => {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(data));
};
async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
/** Only an explicit set of regular root files is exposed; personal configuration and media are excluded. */
export async function createResourceIndex(assetRoot, {isAllowed = isPublicRetailFile} = {}) {
  const root = path.resolve(assetRoot), allowed = new Map(), files = [];
  const entries = (await fsp.readdir(root, { withFileTypes: true }))
    .filter(entry => entry.isFile() && isAllowed(entry.name))
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase(), 'en'));
  for (const entry of entries) {
    const filePath = path.join(root, entry.name), stat = await fsp.stat(filePath);
    const file = { name: entry.name, url: `/retail/${encodeURIComponent(entry.name)}`, bytes: stat.size, sha256: await sha256(filePath) };
    files.push(file); allowed.set(entry.name.toLowerCase(), { filePath, ...file });
  }
  return { manifest: { schema: 1, files, totalBytes: files.reduce((sum, file) => sum + file.bytes, 0) }, allowed };
}
async function mapLimits(root) {
  try {
    const catalog = JSON.parse(await fsp.readFile(path.join(root, 'public/generated/catalog.json'), 'utf8'));
    return new Map(catalog.maps.map(map => [map.id, Math.max(2, map.starts?.length ?? map.maxPlayers ?? 2)]));
  } catch { return new Map(); }
}
export async function createDevServer({ port = Number(process.env.PORT ?? 5280), host = '127.0.0.1',
  assetRoot = process.env.VERA_ASSET_ROOT ?? path.join(os.homedir(), 'Library/Application Support/VERA20k/retail-assets'),
  root = projectRoot, production = false, distDir = 'dist',
} = {}) {
  if (host !== '127.0.0.1') throw new Error('Local integration server must bind 127.0.0.1');
  let resourceIndex, resourceError;
  try { resourceIndex = await createResourceIndex(assetRoot); }
  catch (error) { resourceError = error instanceof Error ? error.message : String(error); }
  let vite;
  const staticRoot = path.resolve(root, distDir);
  if (production && staticRoot !== path.resolve(root) && !staticRoot.startsWith(path.resolve(root) + path.sep)) throw new Error('Static output must be inside this project');
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
      if (url.pathname === '/api/health') {
        json(response, resourceIndex ? 200 : 503, { ok: !!resourceIndex, app: 'werhd-vera', protocol: 1,
          resources: resourceIndex ? { count: resourceIndex.manifest.files.length, bytes: resourceIndex.manifest.totalBytes } : null,
          error: resourceError ? '无法读取本地零售游戏资源，请设置 VERA_ASSET_ROOT。' : undefined }); return;
      }
      if (url.pathname === '/api/config') {
        const origin = `http://${host}:${server.address().port}`;
        json(response, 200, {schema: 1, assets: {manifestUrl: `${origin}/generated/catalog.json`,
          wasmUrl: `${origin}/wasm/vera_web_core.wasm`, resourceManifestUrl: `${origin}/api/resources`},
          network: {lobbyUrl: `${origin.replace('http:', 'ws:')}/ws/rooms`}}); return;
      }
      if (url.pathname === '/api/resources') {
        if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405, { Allow: 'GET, HEAD' }); response.end(); return; }
        if (!resourceIndex) { json(response, 503, { error: '本地游戏资源不可用。' }); return; }
        if (request.method === 'HEAD') { response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(); }
        else json(response, 200, resourceIndex.manifest); return;
      }
      if (url.pathname.startsWith('/retail/')) {
        if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405, { Allow: 'GET, HEAD' }); response.end(); return; }
        let name; try { name = decodeURIComponent(url.pathname.slice('/retail/'.length)); } catch { json(response, 400, { error: 'Invalid resource name' }); return; }
        const file = isPublicRetailFile(name) ? resourceIndex?.allowed.get(name.toLowerCase()) : undefined;
        if (!file) { json(response, 404, { error: 'Resource not exposed' }); return; }
        const headers = { 'Content-Type': 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=3600', ETag: `"${file.sha256}"`, 'Accept-Ranges': 'bytes' };
        if (request.headers['if-none-match'] === headers.ETag) { response.writeHead(304, headers); response.end(); return; }
        let start = 0, end = file.bytes - 1, status = 200;
        if (request.headers.range) {
          const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range);
          if (!match || Number(match[1]) >= file.bytes) { response.writeHead(416, { 'Content-Range': `bytes */${file.bytes}` }); response.end(); return; }
          start = Number(match[1]); end = match[2] ? Math.min(file.bytes - 1, Number(match[2])) : file.bytes - 1;
          if (end < start) { response.writeHead(416, { 'Content-Range': `bytes */${file.bytes}` }); response.end(); return; }
          status = 206; headers['Content-Range'] = `bytes ${start}-${end}/${file.bytes}`;
        }
        headers['Content-Length'] = String(Math.max(0, end - start + 1)); response.writeHead(status, headers);
        if (request.method === 'HEAD' || !file.bytes) { response.end(); return; }
        const stream = fs.createReadStream(file.filePath, { start, end }); stream.on('error', () => response.destroy()); stream.pipe(response); return;
      }
      if (production) {
        let pathname; try { pathname = decodeURIComponent(url.pathname); } catch { response.writeHead(400); response.end(); return; }
        let candidate = path.resolve(staticRoot, '.' + pathname);
        if (!candidate.startsWith(staticRoot + path.sep) && candidate !== staticRoot) { response.writeHead(404); response.end(); return; }
        let stat; try { stat = await fsp.stat(candidate); } catch { /* SPA navigation falls through to the index. */ }
        if (!stat?.isFile()) {
          if (path.extname(pathname) && !pathname.endsWith('.html')) { response.writeHead(404); response.end(); return; }
          candidate = path.join(staticRoot, 'index.html');
          try { stat = await fsp.stat(candidate); } catch { json(response, 503, { error: '请先运行 npm run build 生成网页版本。' }); return; }
        }
        const real = await fsp.realpath(candidate);
        if (!real.startsWith(staticRoot + path.sep)) { response.writeHead(404); response.end(); return; }
        const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.wasm': 'application/wasm', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
        response.writeHead(200, { 'Content-Type': mime[path.extname(candidate)] ?? 'application/octet-stream', 'Content-Length': stat.size, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' });
        if (request.method === 'HEAD') { response.end(); return; }
        const stream = fs.createReadStream(candidate); stream.on('error', () => response.destroy()); stream.pipe(response); return;
      }
      vite.middlewares(request, response, () => { response.writeHead(404); response.end('Not found'); });
    } catch { if (!response.headersSent) json(response, 500, { error: 'Local request failed' }); else response.destroy(); }
  });
  const limits = await mapLimits(root);
  const rooms = attachRooms(server, { getMapLimit: mapId => limits.get(mapId) ?? 8 });
  if (!production) vite = await createViteServer({ root, configFile: path.join(root, 'vite.config.ts'),
    server: { middlewareMode: true, hmr: { server }, fs: { allow: [root] } }, appType: 'spa' });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); resolve(); }); });
  const actualPort = server.address().port;
  return { server, rooms, manifest: resourceIndex?.manifest, url: `http://${host}:${actualPort}`,
    async close() { await rooms.close(); await vite?.close(); await new Promise(resolve => server.close(resolve)); },
  };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const productionIndex = process.argv.indexOf('--production');
  const app = await createDevServer({ production: productionIndex >= 0, distDir: productionIndex >= 0 && process.argv[productionIndex + 1] ? process.argv[productionIndex + 1] : 'dist' });
  console.log(`王二火大 · VERA 网页版 ${app.url}`);
  console.log(`仅本机联调：${app.manifest?.files.length ?? 0} 个游戏资源；本地房间使用 ${app.url.replace('http:', 'ws:')}/ws/rooms`);
  let closing = false;
  const close = async () => { if (closing) return; closing = true; await app.close(); process.exit(0); };
  process.on('SIGINT', close); process.on('SIGTERM', close);
}
