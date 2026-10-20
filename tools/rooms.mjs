import { randomBytes, randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
const COMMAND_KINDS = new Set(['select', 'move', 'attack', 'deploy', 'queue', 'produce', 'place', 'cancel', 'cancelProduction', 'stop', 'guard', 'sell', 'repair', 'scatter', 'attackMove', 'forceAttack']);
const clone = value => JSON.parse(JSON.stringify(value));
const cleanName = value => typeof value === 'string' && value.trim() ? value.trim().slice(0, 24) : '指挥官';
const isHash = value => typeof value === 'string' && /^[\da-z:_-]{1,128}$/i.test(value);
function ensure(condition, message) { if (!condition) throw new Error(message); }
function roomConfig(value, maxPlayers) {
  ensure(value && typeof value === 'object' && !Array.isArray(value), '无效的房间设置');
  ensure(typeof value.mapId === 'string' && value.mapId.length > 0 && value.mapId.length < 128, '请选择有效地图');
  ensure(Array.isArray(value.slots) && value.slots.length > 0 && value.slots.length <= 8, '无效的玩家槽位');
  const config = clone(value);
  config.playerName = cleanName(value.playerName);
  config.localHouse = 0;
  config.seed = Number(value.seed) >>> 0;
  config.slots = config.slots.map((slot, id) => {
    ensure(slot && typeof slot === 'object', '无效的玩家槽位');
    return { ...slot, id, kind: id >= maxPlayers ? 'closed' : slot.kind === 'ai' ? 'ai' : 'closed' };
  });
  return config;
}
/** Local-only experimental lockstep rooms. No WOL / production WERHD protocol is implemented. */
export function attachRooms(server, {
  path = '/ws/rooms', getMapLimit = () => 8,
  loadingTimeoutMs = 120000, turnTimeoutMs = 30000,
} = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const rooms = new Map(), clients = new Set();
  function send(client, message) {
    if (client.ws.readyState === WebSocket.OPEN) client.ws.send(JSON.stringify(message));
  }
  function broadcast(room, message) { for (const member of room.members) send(member, message); }
  function view(room, client) {
    return { code: room.code, isHost: room.host === client.id, localMemberId: client.id,
      members: room.members.map(member => ({ id: member.id, name: member.name, ready: member.ready, host: member.id === room.host, slot: member.slot })),
      canStart: room.phase === 'lobby' && room.members.length >= 2 && room.members.every(member => member.id === room.host || member.ready),
      config: clone(room.config), status: room.phase === 'lobby' ? '分享房间号，在本机的另一浏览器窗口加入。' : room.phase === 'loading' ? '等待所有指挥官完成战场部署…' : '对战进行中',
    };
  }
  function update(room) { for (const member of room.members) send(member, { type: 'room', room: view(room, member) }); }
  function normalizeHumans(room) {
    for (const slot of room.config.slots) if (slot.kind === 'human') slot.kind = 'closed';
    for (const member of room.members) {
      const slot = room.config.slots[member.slot];
      ensure(slot && member.slot < room.maxPlayers, '当前地图没有足够的玩家位置');
      slot.kind = 'human'; slot.name = member.name;
    }
    room.config.playerName = room.members.find(member => member.id === room.host)?.name ?? '指挥官';
  }
  function clearTimeouts(room) { if (room.timeout) clearTimeout(room.timeout); room.timeout = undefined; }
  function stop(room, reason) {
    clearTimeouts(room); rooms.delete(room.code);
    for (const member of room.members) { member.room = null; member.ready = false; send(member, { type: 'stopped', reason }); send(member, { type: 'room', room: null }); }
    room.phase = 'stopped'; room.members = []; room.frames.clear(); room.loaded.clear();
  }
  function arm(room, ms, reason) { clearTimeouts(room); room.timeout = setTimeout(() => stop(room, reason), ms); room.timeout.unref?.(); }
  function leave(client) {
    const room = client.room; if (!room) return;
    if (room.phase !== 'lobby') { stop(room, '有玩家离开，对战已停止。'); return; }
    if (room.host === client.id) { stop(room, '房主已离开房间。'); return; }
    client.room = null; room.members = room.members.filter(member => member !== client);
    room.config.slots[client.slot].kind = 'closed'; client.ready = false;
    for (const member of room.members) member.ready = false;
    update(room); send(client, { type: 'room', room: null });
  }
  function requireRoom(client, phase) {
    ensure(client.room, '尚未加入房间');
    if (phase) ensure(client.room.phase === phase, '当前房间状态不允许此操作');
    return client.room;
  }
  function humanOrder(room) { return [...room.members].sort((a, b) => a.slot - b.slot); }
  function safeCommands(value, player) {
    ensure(Array.isArray(value) && value.length <= 256, '每帧最多提交 256 条指令');
    return value.map(command => {
      ensure(command && typeof command === 'object' && !Array.isArray(command) && COMMAND_KINDS.has(command.kind), '不支持的作战指令');
      const data = clone(command); data.player = player; return data;
    });
  }
  async function message(client, data) {
    let request;
    try {
      request = JSON.parse(data.toString());
      ensure(request && typeof request.type === 'string', '无效的房间消息');
      const { type } = request;
      if (type === 'create') {
        ensure(!client.room, '请先离开当前房间');
        const maxPlayers = Math.max(2, Math.min(8, getMapLimit(request.config?.mapId) || 8));
        const config = roomConfig(request.config, maxPlayers);
        let code; do { code = randomBytes(3).toString('hex').toUpperCase(); } while (rooms.has(code));
        client.name = cleanName(config.playerName); client.slot = 0; client.ready = true;
        const room = { code, host: client.id, config, maxPlayers, members: [client], phase: 'lobby', frames: new Map(), loaded: new Map(), tick: 0 };
        rooms.set(code, room); client.room = room; normalizeHumans(room); update(room);
      } else if (type === 'join') {
        ensure(!client.room, '请先离开当前房间');
        const room = rooms.get(String(request.code ?? '').trim().toUpperCase());
        ensure(room && room.phase === 'lobby', '找不到可加入的房间');
        const taken = new Set(room.members.map(member => member.slot));
        const slot = room.config.slots.findIndex((_, index) => index < room.maxPlayers && !taken.has(index));
        ensure(slot >= 0, '房间已满');
        client.name = cleanName(request.name); client.slot = slot; client.ready = false; client.room = room;
        room.members.push(client); for (const member of room.members) if (member.id !== room.host) member.ready = false;
        normalizeHumans(room); update(room);
      } else if (type === 'config') {
        const room = requireRoom(client, 'lobby'); ensure(room.host === client.id, '只有房主可以修改规则');
        const maxPlayers = Math.max(2, Math.min(8, getMapLimit(request.config?.mapId) || 8));
        ensure(room.members.every(member => member.slot < maxPlayers), '新地图没有足够的玩家位置');
        room.config = roomConfig(request.config, maxPlayers); room.maxPlayers = maxPlayers; normalizeHumans(room);
        for (const member of room.members) if (member.id !== room.host) member.ready = false; update(room);
      } else if (type === 'ready') {
        const room = requireRoom(client, 'lobby'); ensure(room.host !== client.id, '房主无需切换准备状态'); client.ready = !client.ready; update(room);
      } else if (type === 'start') {
        const room = requireRoom(client, 'lobby'); ensure(room.host === client.id, '只有房主可以开始对战');
        ensure(room.members.length >= 2 && room.members.every(member => member.id === room.host || member.ready), '请等待所有玩家准备');
        normalizeHumans(room); room.phase = 'loading'; room.loaded.clear(); room.frames.clear();
        humanOrder(room).forEach((member, playerIndex) => send(member, { type: 'start', config: clone(room.config), playerIndex, roomCode: room.code }));
        arm(room, loadingTimeoutMs, '等待战场部署超时，对战已停止。'); update(room);
      } else if (type === 'loaded') {
        const room = requireRoom(client, 'loading');
        ensure(isHash(request.hash) && Number.isSafeInteger(request.tick) && request.tick >= 0, '无效的初始状态校验');
        ensure(!room.loaded.has(client.id), '重复的战场部署确认');
        room.loaded.set(client.id, { hash: request.hash, tick: request.tick });
        if (room.loaded.size === room.members.length) {
          const initial = [...room.loaded.values()];
          if (!initial.every(value => value.hash === initial[0].hash && value.tick === initial[0].tick)) { stop(room, '初始战场状态校验不一致，对战已停止。'); return; }
          room.phase = 'running'; room.tick = initial[0].tick + 1; clearTimeouts(room);
          broadcast(room, { type: 'ready', tick: room.tick }); arm(room, turnTimeoutMs, '等待玩家指令超时，对战已停止。');
        }
      } else if (type === 'input') {
        const room = requireRoom(client, 'running');
        ensure(request.tick === room.tick && Number.isSafeInteger(request.tick), '作战帧顺序不正确');
        ensure(isHash(request.prevHash), '无效的状态校验'); ensure(!room.frames.has(client.id), '重复提交了当前作战帧');
        const playerIndex = humanOrder(room).indexOf(client);
        room.frames.set(client.id, { commands: safeCommands(request.commands, playerIndex), hash: request.prevHash });
        if (room.frames.size === room.members.length) {
          const frames = humanOrder(room).map(member => room.frames.get(member.id));
          if (!frames.every(frame => frame.hash === frames[0].hash)) { stop(room, `第 ${room.tick} 帧状态校验不一致，对战已停止。`); return; }
          const commands = frames.flatMap(frame => frame.commands), tick = room.tick++;
          room.frames.clear(); broadcast(room, { type: 'turn', tick, commands });
          arm(room, turnTimeoutMs, '等待玩家指令超时，对战已停止。');
        }
      } else if (type === 'leave') { leave(client); }
      else if (type === 'ping') { send(client, { type: 'pong' }); }
      else throw new Error('不支持的房间消息');
      if (Number.isSafeInteger(request.id)) send(client, { type: 'response', id: request.id, ok: true });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (Number.isSafeInteger(request?.id)) send(client, { type: 'response', id: request.id, ok: false, error: errorMessage });
      else send(client, { type: 'error', error: errorMessage });
    }
  }
  function upgrade(request, socket, head) {
    const requestPath = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (requestPath !== path) return;
    if (request.headers.origin) {
      try {
        const origin = new URL(request.headers.origin);
        if (!['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)) { socket.destroy(); return; }
      } catch { socket.destroy(); return; }
    }
    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request));
  }
  server.on('upgrade', upgrade);
  wss.on('connection', ws => {
    const client = { id: randomUUID(), ws, room: null, ready: false, slot: 0, name: '指挥官', alive: true };
    clients.add(client); send(client, { type: 'hello', protocol: 1, clientId: client.id });
    ws.on('message', data => void message(client, data));
    ws.on('pong', () => { client.alive = true; });
    ws.on('error', () => {});
    ws.on('close', () => { leave(client); clients.delete(client); });
  });
  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (!client.alive) { client.ws.terminate(); continue; }
      client.alive = false; client.ws.ping();
    }
  }, 15000); heartbeat.unref();
  return {
    get roomCount() { return rooms.size; },
    async close() {
      clearInterval(heartbeat); server.off('upgrade', upgrade);
      for (const room of [...rooms.values()]) stop(room, '本地联调服务已停止。');
      for (const client of clients) client.ws.terminate();
      await new Promise(resolve => wss.close(resolve));
    },
  };
}
