import { timingSafeEqual } from 'node:crypto';
export function requireSecret(value) {
  if (typeof value !== 'string' || value.length < 16) throw new Error('serviceSecret must be supplied and contain at least 16 characters');
  return value;
}
export function authorized(request, secret) {
  const supplied = Buffer.from(request.headers.authorization ?? ''), expected = Buffer.from(`Bearer ${secret}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
export function json(response, status, body, headers = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  response.end(JSON.stringify(body));
}
export async function readJson(request, limit = 65536) {
  const chunks = []; let bytes = 0;
  for await (const chunk of request) { bytes += chunk.length; if (bytes > limit) throw Object.assign(new Error('Request body too large'), { status: 413 }); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('Invalid JSON body'); }
}
export function originAllowed(origin, allowedOrigins) {
  if (!origin) return true; // Non-browser service/tests have no Origin header.
  if (allowedOrigins) return allowedOrigins.includes(origin);
  try { return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname); } catch { return false; }
}
export function websocketUrl(url, pathname) {
  const value = new URL(pathname.replace(/^\//, ''), url.replace(/\/$/, '') + '/'); value.protocol = value.protocol === 'https:' ? 'wss:' : 'ws:'; return value.href;
}
export async function listen(server, port, host) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); resolve(); }); });
  const address = server.address(); return `http://${host === '::1' ? '[::1]' : host}:${address.port}`;
}
export function cliOptions(defaultPort) {
  return { port: Number(process.env.PORT ?? defaultPort), host: process.env.HOST ?? '127.0.0.1',
    serviceSecret: process.env.WERHD_SERVICE_SECRET, publicUrl: process.env.PUBLIC_URL,
    allowedOrigins: process.env.ALLOWED_ORIGINS?.split(',').map(value => value.trim()).filter(Boolean) };
}
export function installShutdown(app) {
  let closing = false;
  const close = async () => { if (closing) return; closing = true; await app.close(); process.exit(0); };
  process.on('SIGINT', close); process.on('SIGTERM', close);
}
