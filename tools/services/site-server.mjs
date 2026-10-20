import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIME, requestPath, ownedDirectory, openRegularFile, sendFile, sendJson,
  methods, failRequest, listen, closeServer, httpError } from './http-files.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const defaultRuntimeConfig = {
  schema: 1,
  assets: { manifestUrl: 'http://127.0.0.1:5281/generated/catalog.json',
    wasmUrl: 'http://127.0.0.1:5281/wasm/vera_web_core.wasm', resourceManifestUrl: 'http://127.0.0.1:5281/api/resources' },
  network: { lobbyUrl: 'ws://127.0.0.1:5282/ws/rooms' },
};
const staticExtensions = new Set(['.html', '.js', '.mjs', '.css', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.svg', '.ico', '.woff', '.woff2']);
const reserved = pathname => /^\/(?:retail|generated|wasm|api|tools|vendor|tests|validation|src)(?:\/|$)/.test(pathname);

export async function createSiteServer({ root = projectRoot, port = 5280, host = '127.0.0.1',
  production = true, distDir = 'dist', runtimeConfig = defaultRuntimeConfig,
} = {}) {
  const runtime = JSON.parse(JSON.stringify(runtimeConfig));
  if (runtime?.schema !== 1) throw new Error('Runtime config schema must be 1');
  const staticRoot = production ? await ownedDirectory(root, distDir) : undefined;
  const cache = new Map();
  let vite;
  const server = http.createServer(async (request, response) => {
    try {
      const pathname = requestPath(request);
      if (!methods(request, response)) return;
      if (pathname === '/api/config') { sendJson(request, response, 200, runtime); return; }
      if (pathname === '/api/health') { sendJson(request, response, 200, { ok: true, service: 'site', protocol: 1, production }); return; }
      if (reserved(pathname) || pathname.startsWith('/@fs/')) throw httpError(404, 'Route not exposed');
      if (production) {
        const extension = path.extname(pathname).toLowerCase();
        if (extension && !staticExtensions.has(extension)) throw httpError(404, 'File not exposed');
        let file;
        try { file = await openRegularFile(staticRoot, pathname === '/' ? 'index.html' : pathname.slice(1)); }
        catch (error) {
          if (error.status !== 404 || error.noFallback || (extension && extension !== '.html')) throw error;
          file = await openRegularFile(staticRoot, 'index.html');
        }
        await sendFile(request, response, file, { cache }); return;
      }
      const allowedDev = pathname === '/' || pathname === '/index.html' || pathname === '/app-icon.png'
        || pathname === '/favicon.ico' || pathname.startsWith('/web/') || pathname.startsWith('/@vite/')
        || pathname.startsWith('/@id/') || pathname.startsWith('/node_modules/.vite/')
        || pathname === '/node_modules/vite/dist/client/env.mjs';
      if (!allowedDev) throw httpError(404, 'Route not exposed');
      vite.middlewares(request, response, () => { if (!response.headersSent) { response.writeHead(404); response.end(); } });
    } catch (error) { failRequest(request, response, error); }
  });
  if (!production) {
    const { createServer } = await import('vite');
    const owner = await ownedDirectory(root, '.');
    vite = await createServer({ root: owner, configFile: path.join(owner, 'vite.config.ts'),
      server: { middlewareMode: true, hmr: { server }, fs: { strict: true,
        allow: [path.join(owner, 'index.html'), path.join(owner, 'web'), path.join(owner, 'public'), path.join(owner, 'node_modules')] } }, appType: 'spa' });
  }
  let url;
  try { url = await listen(server, port, host); }
  catch (error) { await vite?.close(); throw error; }
  let closing;
  return { server, url, runtimeConfig: runtime,
    close() { return closing ??= (async () => { await vite?.close(); await closeServer(server); })(); },
  };
}
