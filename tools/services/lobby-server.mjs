import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachRooms } from '../rooms.mjs';
import { cliOptions, installShutdown, json, listen, originAllowed, requireSecret, websocketUrl } from './common.mjs';

/** Room coordination only. Ticks and per-match credentials belong to the battle service. */
export async function createLobbyService({ port = 5282, host = '127.0.0.1', serviceSecret, battleUrl, publicUrl,
  allowedOrigins, getMapLimit, mapLimits, loadingTimeoutMs = 120000, turnTimeoutMs = 30000,
} = {}) {
  const secret = requireSecret(serviceSecret);
  if (typeof battleUrl !== 'string' || !/^https?:\/\//.test(battleUrl)) throw new Error('battleUrl must name the internal battle HTTP origin');
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    const cors = originAllowed(request.headers.origin, allowedOrigins) && request.headers.origin ? { 'Access-Control-Allow-Origin': request.headers.origin, Vary: 'Origin' } : {};
    if (pathname === '/api/health' || pathname === '/health') { json(response, 200, { ok: true, service: 'lobby', protocol: 1, rooms: rooms.roomCount }, cors); return; }
    json(response, 404, { error: 'Not found' });
  });
  async function callBattle(pathname, method, body) {
    const response = await fetch(new URL(pathname, battleUrl), { method, headers: { Authorization: `Bearer ${secret}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`Battle service request failed (${response.status})`);
    return response.json();
  }
  const rooms = attachRooms(server, { allowedOrigins, loadingTimeoutMs, turnTimeoutMs,
    getMapLimit: getMapLimit ?? (mapId => mapLimits instanceof Map ? mapLimits.get(mapId) ?? 8 : mapLimits?.[mapId] ?? 8),
    createMatch: body => callBattle('/internal/matches', 'POST', body),
    cancelMatch: matchId => callBattle(`/internal/matches/${encodeURIComponent(matchId)}`, 'DELETE'),
  });
  let url, closed = false;
  try { url = await listen(server, port, host); } catch (error) { await rooms.close(); throw error; }
  return { server, rooms, url, wsUrl: websocketUrl(publicUrl ?? url, '/ws/rooms'),
    async close() { if (closed) return; closed = true; await rooms.close(); await new Promise(resolve => server.close(resolve)); },
  };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await createLobbyService({ ...cliOptions(5282), battleUrl: process.env.BATTLE_SERVICE_URL });
  console.log(`Lobby service ${app.url}`); installShutdown(app);
}
