import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { authorized, cliOptions, installShutdown, json, listen, originAllowed, readJson, requireSecret, websocketUrl } from './common.mjs';
import { bindCommands, ensure, isStateHash } from './protocol.mjs';
const clone = value => JSON.parse(JSON.stringify(value));

/** Independent ticket-authenticated lockstep authority. Game simulation remains in each WASM client. */
export async function createBattleService({ port = 5283, host = '127.0.0.1', serviceSecret, publicUrl,
  allowedOrigins, loadingTimeoutMs = 120000, turnTimeoutMs = 30000,
} = {}) {
  const secret = requireSecret(serviceSecret), matches = new Map(), clients = new Set();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 65536 });
  let url = '', closed = false;
  function send(client, message) { if (client.ws.readyState === WebSocket.OPEN) client.ws.send(JSON.stringify(message)); }
  function broadcast(match, message) { for (const member of match.players) if (member.client) send(member.client, message); }
  function arm(match, timeout, reason) { clearTimeout(match.timeout); match.timeout = setTimeout(() => stop(match, reason), timeout); match.timeout.unref?.(); }
  function stop(match, reason) {
    if (match.stopped) return;
    match.stopped = true; matches.delete(match.id); clearTimeout(match.timeout);
    for (const member of match.players) if (member.client) {
      const client = member.client; client.match = null; send(client, { type: 'stopped', reason }); client.ws.close(1000, 'Match stopped');
    }
    match.tickets.clear(); match.frames.clear(); match.loaded.clear();
  }
  function createMatch(body) {
    ensure(body && /^[\w-]{1,32}$/.test(body.roomCode ?? ''), 'Invalid roomCode');
    ensure(body.config && typeof body.config === 'object' && Array.isArray(body.config.slots), 'Invalid match config');
    ensure(Array.isArray(body.members) && body.members.length >= 2 && body.members.length <= 8, 'Match requires 2 to 8 humans');
    const ordered = [...body.members].sort((a, b) => a.playerIndex - b.playerIndex), ids = new Set();
    ordered.forEach((member, index) => {
      ensure(member && typeof member.id === 'string' && member.id.length > 0 && member.id.length < 129 && !ids.has(member.id), 'Invalid member identity');
      ensure(member.playerIndex === index, 'Human indices must be compact and unique'); ids.add(member.id);
    });
    const match = { id: randomUUID(), roomCode: body.roomCode, config: clone(body.config), players: [], tickets: new Map(), frames: new Map(), loaded: new Map(), phase: 'loading', stopped: false, tick: 0 };
    const players = ordered.map(member => {
      const ticket = randomBytes(32).toString('base64url');
      const player = { id: member.id, playerIndex: member.playerIndex, name: String(member.name ?? '指挥官').slice(0, 24), ticket, client: null };
      match.players.push(player); match.tickets.set(ticket, player);
      return { id: member.id, playerIndex: member.playerIndex, ticket };
    });
    matches.set(match.id, match); arm(match, loadingTimeoutMs, '等待战场部署超时，对战已停止。');
    return { matchId: match.id, players, url: websocketUrl(publicUrl ?? url, '/ws/battle') };
  }
  const server = http.createServer(async (request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    try {
      if (pathname === '/api/health' || pathname === '/health') {
        const cors = originAllowed(request.headers.origin, allowedOrigins) && request.headers.origin ? { 'Access-Control-Allow-Origin': request.headers.origin, Vary: 'Origin' } : {};
        json(response, 200, { ok: true, service: 'battle', protocol: 1, matches: matches.size }, cors); return;
      }
      if (pathname.startsWith('/internal/')) {
        if (!authorized(request, secret)) { json(response, 401, { error: 'Unauthorized service request' }); return; }
        if (request.method === 'POST' && pathname === '/internal/matches') { json(response, 201, createMatch(await readJson(request))); return; }
        if (request.method === 'DELETE' && pathname.startsWith('/internal/matches/')) {
          const id = decodeURIComponent(pathname.slice('/internal/matches/'.length)), match = matches.get(id);
          if (match) stop(match, '大厅房间已关闭，对战已停止。');
          json(response, 200, { ok: true, cancelled: !!match }); return;
        }
      }
      json(response, 404, { error: 'Not found' });
    } catch (error) { json(response, error.status ?? 400, { error: error instanceof Error ? error.message : String(error) }); }
  });
  function upgrade(request, socket, head) {
    if (new URL(request.url ?? '/', 'http://localhost').pathname !== '/ws/battle' || !originAllowed(request.headers.origin, allowedOrigins)) { socket.destroy(); return; }
    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws));
  }
  server.on('upgrade', upgrade);
  wss.on('connection', ws => {
    const client = { ws, match: null, member: null, alive: true }; clients.add(client);
    send(client, { type: 'hello', protocol: 1, service: 'battle' });
    ws.on('message', bytes => {
      let message;
      try {
        message = JSON.parse(bytes.toString());
        if (message.type === 'join') {
          ensure(!client.match, 'Already joined a match');
          const match = matches.get(message.matchId); ensure(match && !match.stopped && match.phase === 'loading', 'Match unavailable');
          const member = match.tickets.get(message.ticket); ensure(member && !member.client, 'Invalid or already used battle ticket');
          match.tickets.delete(message.ticket); member.ticket = null; member.client = client; client.match = match; client.member = member;
          send(client, { type: 'joined', matchId: match.id, roomCode: match.roomCode, playerIndex: member.playerIndex, config: clone(match.config) });
        } else {
          const match = client.match; ensure(match && !match.stopped, 'Join a match first');
          if (message.type === 'loaded') {
            ensure(match.phase === 'loading', 'Match is already running');
            ensure(isStateHash(message.hash) && Number.isSafeInteger(message.tick) && message.tick >= 0, 'Invalid loaded state');
            ensure(!match.loaded.has(client.member.playerIndex), 'Duplicate loaded state');
            match.loaded.set(client.member.playerIndex, { hash: message.hash, tick: message.tick });
            if (match.loaded.size === match.players.length) {
              const values = [...match.loaded.values()];
              if (!values.every(value => value.hash === values[0].hash && value.tick === values[0].tick)) { stop(match, '初始战场状态校验不一致，对战已停止。'); return; }
              match.phase = 'running'; match.tick = values[0].tick + 1; broadcast(match, { type: 'ready', tick: match.tick });
              arm(match, turnTimeoutMs, '等待玩家指令超时，对战已停止。');
            }
          } else if (message.type === 'input') {
            ensure(match.phase === 'running', 'Wait for all players to load');
            ensure(Number.isSafeInteger(message.tick) && message.tick === match.tick, '作战帧顺序不正确');
            ensure(isStateHash(message.prevHash), '无效的状态校验'); ensure(!match.frames.has(client.member.playerIndex), '重复提交了当前作战帧');
            match.frames.set(client.member.playerIndex, { hash: message.prevHash, commands: bindCommands(message.commands, client.member.playerIndex) });
            if (match.frames.size === match.players.length) {
              const frames = match.players.map(player => match.frames.get(player.playerIndex));
              if (!frames.every(frame => frame.hash === frames[0].hash)) { stop(match, `第 ${match.tick} 帧状态校验不一致，对战已停止。`); return; }
              const commands = frames.flatMap(frame => frame.commands), tick = match.tick++;
              if (commands.length > 1024) { stop(match, '单帧作战指令过多，对战已停止。'); return; }
              match.frames.clear(); broadcast(match, { type: 'turn', tick, commands }); arm(match, turnTimeoutMs, '等待玩家指令超时，对战已停止。');
            }
          } else if (message.type === 'leave') stop(match, '有玩家离开，对战已停止。');
          else throw new Error('Unsupported battle message');
        }
      } catch (error) { send(client, { type: 'error', error: error instanceof Error ? error.message : String(error) }); }
    });
    ws.on('pong', () => { client.alive = true; }); ws.on('error', () => {});
    ws.on('close', () => { clients.delete(client); if (client.match) stop(client.match, '有玩家断开对战连接，对战已停止。'); });
  });
  const heartbeat = setInterval(() => { for (const client of clients) { if (!client.alive) client.ws.terminate(); else { client.alive = false; client.ws.ping(); } } }, 15000); heartbeat.unref();
  url = await listen(server, port, host);
  return { server, url, wsUrl: websocketUrl(publicUrl ?? url, '/ws/battle'), get matchCount() { return matches.size; },
    async close() { if (closed) return; closed = true; clearInterval(heartbeat); for (const match of [...matches.values()]) stop(match, '对战服务已停止。'); for (const client of clients) client.ws.terminate(); await new Promise(resolve => wss.close(resolve)); await new Promise(resolve => server.close(resolve)); },
  };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await createBattleService(cliOptions(5283)); console.log(`Battle service ${app.url}`); installShutdown(app);
}
