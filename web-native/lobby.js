function globalStorage(name) { try { return globalThis[name]; } catch { return undefined; } }
function stored(storage, key, fallback, legacyKey) {
  try {
    const current = storage.getItem(key);
    if (current) return current;
    const old = legacyKey && storage.getItem(legacyKey);
    if (!old) return fallback;
    try { storage.setItem(key, old); storage.removeItem(legacyKey); } catch {}
    return old;
  } catch { return fallback; }
}
function save(storage, key, value) { try { storage.setItem(key, value); } catch {} }
/** DOM-free native-v3 transport. The caller owns all visible UI and forwards
 * semantic snapshots to its shell; no element, stylesheet or renderer is made. */
export function installNativeLobby({native, canvas, socketUrl, onState = () => {}} = {}) {
  if (!native || !canvas) throw new Error('联机大厅缺少游戏入口');
  const generatedId = globalThis.crypto?.randomUUID?.() ?? `player-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const playerId = stored(globalStorage('sessionStorage'), 'werhd.native.playerId', generatedId, 'vera.native.playerId');
  save(globalStorage('sessionStorage'), 'werhd.native.playerId', playerId);
  const state = {name: stored(globalStorage('localStorage'), 'werhd.native.playerName', '指挥官', 'vera.native.playerName'), code: '', room: null,
    open: false, connected: false, busy: false, status: '', error: '', matchId: null,
    nativeStarted: false, starting: false, stopped: false, inbound: []};
  let socket = null, socketEpoch = 0, connecting = null, cancelConnect = null, disposed = false, timer, draining = false;
  let completion = null, transportFailure = null, published = null, socketShard = null, creating = null;
  let nextHeartbeatAt = 0;

  function retryCreate() {
    if (!creating || creating.attempt >= 7 || state.room || state.matchId || disposed) return false;
    creating.attempt++;
    const message = creating.message;
    closeSocket();
    void request(message, true);
    return true;
  }

  function currentCompletion() {
    return completion?.matchId === state.matchId && completion.epoch === socketEpoch;
  }
  function completed(status = native.network_status()) {
    if (!currentCompletion()) return false;
    if (status?.matchId === state.matchId && status.phase === 'finished'
      && status.finishedTick === completion.tick && status.hash === completion.checksum) completion.confirmed = true;
    return completion.confirmed;
  }
  function transportFailed(reason) {
    if (completed()) return;
    // network_receive admits the ACK to Rust's mailbox. Its next app pass
    // validates the result; a close between those two steps must wait for it.
    if (currentCompletion()) { transportFailure = reason; return; }
    stopMatch(reason);
  }

  function report(error) {
    state.error = error instanceof Error ? error.message : String(error);
    state.busy = false; state.starting = false; render();
  }
  function setOpen(open) { state.open = open; render(); canvas.focus?.(); }
  function sendNow(message) {
    if (socket?.readyState !== WebSocket.OPEN) throw new Error('大厅连接已断开，请重新进入');
    socket.send(JSON.stringify(message));
  }
  async function connect(shard = socketShard) {
    if (socket && socketShard !== shard) closeSocket();
    if (socket?.readyState === WebSocket.OPEN) return;
    if (connecting) return connecting;
    const epoch = ++socketEpoch;
    const address = socketUrl ? new URL(socketUrl, location.href) : new URL('/ws/native', location.href);
    if (shard === null) address.searchParams.delete('shard');
    else address.searchParams.set('shard', String(shard));
    address.protocol = address.protocol === 'https:' ? 'wss:' : address.protocol === 'http:' ? 'ws:' : address.protocol;
    const current = new WebSocket(address); socket = current; socketShard = shard;
    connecting = new Promise((resolve, reject) => {
      let settled = false;
      cancelConnect = () => { if (!settled) { settled = true; reject(new Error('已离开大厅')); } };
      current.addEventListener('open', () => {
        if (epoch !== socketEpoch || socket !== current || disposed) return;
        state.connected = true;
        current.send(JSON.stringify({type: 'hello', protocol: 3, playerId}));
        nextHeartbeatAt = Date.now() + 15000;
        settled = true; resolve(); render();
      });
      current.addEventListener('message', event => {
        if (epoch !== socketEpoch || socket !== current || disposed) return;
        try { receive(JSON.parse(event.data)); } catch (error) { receiveError(error); }
      });
      current.addEventListener('error', () => {
        if (epoch !== socketEpoch || socket !== current || disposed) return;
        if (!settled) { settled = true; reject(new Error('无法连接联机服务')); }
        else if (state.matchId) transportFailed('联机连接发生错误，对局已停止。');
      });
      current.addEventListener('close', event => {
        if (epoch !== socketEpoch || socket !== current || disposed) return;
        // Preserve the transport outcome without logging player identity or
        // command payloads. A normal protocol stop and a broken link need
        // different evidence when diagnosing a public match.
        console.info('[WERHD transport] WebSocket closed', JSON.stringify({
          code: event.code ?? null, wasClean: event.wasClean ?? null,
          matchActive: Boolean(state.matchId), completed: completed(),
        }));
        socket = null; connecting = null; state.connected = false; state.busy = false;
        if (!settled) { settled = true; reject(new Error('联机服务连接已关闭')); }
        // Capacity rejection is known to precede room creation. Other broken
        // connections must not replay create: its outcome could be unknown.
        if (event.code === 1013 && retryCreate()) return;
        creating = null;
        if (state.matchId) transportFailed('联机连接已中断，对局已停止。');
        else if (state.open) { state.room = null; state.error = '大厅连接已关闭，请重新创建或加入。'; render(); }
      });
    }).finally(() => { if (epoch === socketEpoch) { connecting = null; cancelConnect = null; } });
    return connecting;
  }
  async function request(message, retry = false) {
    if (message.type === 'create' && !retry) creating = {message, first: Math.floor(Math.random() * 8), attempt: 0};
    else if (message.type !== 'create') creating = null;
    state.busy = true; state.error = ''; render();
    const joinedShard = message.type === 'join' && /^S[0-7][0-9A-F]{5}$/.test(message.code) ? Number(message.code[1]) : null;
    const shard = message.type === 'create' ? (creating.first + creating.attempt) % 8
      : message.type === 'join' ? joinedShard : socketShard;
    const connection = connect(shard); const epoch = socketEpoch;
    try { await connection; if (epoch !== socketEpoch || disposed) return false; sendNow(message); return true; }
    catch (error) { if (epoch === socketEpoch && !disposed) { creating = null; report(error); } return false; }
  }
  function closeSocket() {
    ++socketEpoch; cancelConnect?.(); cancelConnect = null;
    const current = socket; socket = null; connecting = null;
    state.connected = false; current?.close();
  }
  function deliver(message) {
    if (!state.nativeStarted) {
      if (state.inbound.length >= 256) throw new Error('联机消息积压，对局已停止');
      state.inbound.push(message); return;
    }
    native.network_receive(JSON.stringify(message));
    if (message.type === 'finished') {
      completion = {matchId: state.matchId, epoch: socketEpoch, tick: message.tick,
        checksum: message.checksum, confirmed: false};
      completed();
    }
  }
  function stopMatch(reason) {
    if (!state.matchId || completed()) return;
    try { deliver({type: 'stopped', matchId: state.matchId, reason}); } catch (error) { console.warn(error); }
    state.stopped = true; state.starting = false; state.busy = false;
    state.error = reason; setOpen(true);
  }
  function receiveError(error) {
    if (!state.matchId) { report(error); return; }
    const reason = error instanceof Error ? error.message : String(error);
    if (completed()) return;
    transportFailed(reason);
    // A rejected command cannot complete the shared turn. Retire the room
    // now so the peer also stops, rather than waiting for a turn timeout.
    if (socket?.readyState === WebSocket.OPEN) sendNow({type: 'leave'});
  }
  function receive(message) {
    if (message.type === 'hello') {
      if (message.protocol !== 3) {
        closeSocket();
        throw new Error('联机协议版本不兼容，请刷新游戏后重试');
      }
      return;
    }
    if (message.type === 'room') {
      if (message.room) creating = null;
      state.room = message.room; state.status = message.room?.status ?? ''; state.busy = false;
      if (!state.stopped) state.error = ''; render(); return;
    }
    if (message.type === 'error') {
      if (message.code === 'ROOM_CAPACITY' && retryCreate()) return;
      creating = null;
      // A rejected join/create owns no room. Release its connection slot so
      // failed lookups cannot crowd out guests joining acknowledged rooms.
      if (!state.room && !state.matchId) closeSocket();
      receiveError(message.error ?? '大厅操作失败'); return;
    }
    if (message.type === 'start') {
      if (state.matchId === message.matchId) return;
      if (state.matchId) throw new Error('已有对局尚未退出');
      completion = null; transportFailure = null;
      state.matchId = message.matchId; state.nativeStarted = false; state.inbound = [];
      state.starting = true; state.stopped = false; state.busy = true; state.error = '';
      try {
        native.network_start(JSON.stringify({...message.config, matchId: message.matchId, localPlayer: message.playerIndex}));
      } catch (error) {
        state.matchId = null; state.room = null; state.inbound = [];
        if (socket?.readyState === WebSocket.OPEN) sendNow({type: 'leave'});
        throw error;
      }
      render(); return;
    }
    if (['progress', 'ready', 'turn', 'finished', 'stopped', 'chat', 'taunt'].includes(message.type)) {
      if (message.matchId !== state.matchId) return;
      if (message.type === 'stopped') stopMatch(message.reason ?? '对局已停止');
      else deliver(message);
    }
  }
  function leaveRoom() {
    if (state.matchId) { native.network_leave(state.matchId); return; }
    if (socket?.readyState === WebSocket.OPEN) sendNow({type: 'leave'});
    state.room = null; state.busy = false; state.error = ''; state.status = ''; render();
  }
  function back() {
    creating = null;
    if (state.matchId) { native.network_leave(state.matchId); return; }
    leaveRoom(); closeSocket(); setOpen(false);
  }
  function updateConfig(change) {
    if (!state.room?.isHost || state.matchId) return;
    const config = structuredClone(state.room.config); change(config);
    return request({type: 'config', config});
  }
  function render() {
    if (disposed) return;
    const phase = state.stopped ? 'stopped' : completion?.confirmed && currentCompletion() ? 'finished'
      : state.matchId ? state.nativeStarted ? 'battle' : 'loading' : state.room ? 'room' : 'entry';
    const status = state.starting ? '双方正在载入原生战场…' : state.busy ? '正在联络…' : state.status
      || (state.connected ? '联机服务已连接' : '创建或加入房间后连接联机服务');
    const snapshot = {schema: 1, open: state.open, name: state.name, code: state.code,
      connected: state.connected, busy: state.busy, status, error: state.error, matchId: state.matchId,
      nativeStarted: state.nativeStarted, starting: state.starting, stopped: state.stopped, phase,
      room: state.room ? structuredClone(state.room) : null};
    const serialized = JSON.stringify(snapshot);
    if (serialized === published) return;
    // A presentation failure must not reject a valid turn or interrupt the peer.
    try { onState(snapshot); published = serialized; } catch (error) { console.warn('Could not publish native lobby state', error); }
  }
  function setName(name) {
    if (typeof name !== 'string') throw new Error('指挥官名称无效');
    state.name = name.slice(0, 24); save(globalStorage('localStorage'), 'werhd.native.playerName', state.name);
  }
  function setCode(code) {
    if (typeof code !== 'string') throw new Error('房间代码无效');
    state.code = code.toUpperCase().replace(/\s/g, '').slice(0, 12);
  }
  async function dispatch(message = {}) {
    if (disposed) return false;
    const command = typeof message === 'string' ? {action: message} : message;
    try {
      switch (command?.action) {
        case 'open': open(); return true;
        case 'close': case 'returnMenu': back(); return true;
        case 'setName': setName(command.name); render(); return true;
        case 'setCode': setCode(command.code); render(); return true;
        case 'create': case 'join': {
          if (state.busy || state.room || state.matchId) return false;
          if (command.name !== undefined) setName(command.name);
          if (command.code !== undefined) setCode(command.code);
          if (command.action === 'join' && !state.code) throw new Error('请输入房间代码');
          const requestMessage = {type: command.action, name: state.name.trim()};
          if (command.action === 'join') requestMessage.code = state.code;
          else if (command.config !== undefined) requestMessage.config = command.config;
          return await request(requestMessage);
        }
        case 'leave': if (state.busy && !state.matchId) return false; leaveRoom(); return true;
        case 'ready':
          if (!state.room || state.room.isHost || state.busy || state.matchId) return false;
          return await request({type: 'ready'});
        case 'start':
          if (!state.room?.isHost || !state.room.canStart || state.busy || state.matchId) return false;
          return await request({type: 'start'});
        case 'updateSettings': {
          if (!state.room?.isHost || state.busy || state.matchId) return false;
          if (!command.settings || typeof command.settings !== 'object' || Array.isArray(command.settings)) throw new Error('作战选项无效');
          const numeric = ['credits', 'unitCount', 'gameSpeed'];
          const booleans = ['shortGame', 'superWeapons', 'crates', 'mcvRepacks', 'buildOffAlly', 'destroyableBridges'];
          for (const [key, value] of Object.entries(command.settings)) {
            if (!numeric.includes(key) && !booleans.includes(key) || numeric.includes(key) && !Number.isSafeInteger(value) || booleans.includes(key) && typeof value !== 'boolean') throw new Error('作战选项无效');
          }
          return await updateConfig(config => Object.assign(config.options, command.settings));
        }
        case 'updatePlayer': {
          if (!state.room?.isHost || state.busy || state.matchId) return false;
          if (!Number.isInteger(command.slot) || !command.player || typeof command.player !== 'object' || Array.isArray(command.player)) throw new Error('玩家设置无效');
          for (const [key, value] of Object.entries(command.player)) {
            if (!['country', 'color', 'start', 'team'].includes(key) || key === 'country' && typeof value !== 'string' || key !== 'country' && !Number.isSafeInteger(value)) throw new Error('玩家设置无效');
          }
          if (!state.room.config.players.some(player => player.slot === command.slot)) throw new Error('玩家位置无效');
          return await updateConfig(config => Object.assign(config.players.find(player => player.slot === command.slot), command.player));
        }
        default: throw new Error('不支持的大厅操作');
      }
    } catch (error) { if (!disposed) report(error); return false; }
  }

  const open = () => { if (!state.stopped) state.error = ''; setOpen(true); };
  const started = () => {
    if (disposed || !state.matchId) return;
    state.nativeStarted = true; state.starting = false; state.busy = false;
    try { for (const message of state.inbound.splice(0)) deliver(message); }
    catch (error) { stopMatch(String(error)); return; }
    setOpen(state.stopped);
  };
  const returned = () => {
    creating = null;
    if (disposed) return;
    if (socket?.readyState === WebSocket.OPEN) sendNow({type: 'leave'});
    completion = null; transportFailure = null;
    state.matchId = null; state.nativeStarted = false; state.inbound = []; state.room = null;
    state.starting = false; state.stopped = false; state.busy = false; state.error = ''; state.status = '';
    closeSocket(); setOpen(false);
  };
  const failed = () => {
    creating = null;
    if (disposed) return;
    if (socket?.readyState === WebSocket.OPEN) sendNow({type: 'leave'});
    completion = null; transportFailure = null;
    state.matchId = null; state.nativeStarted = false; state.inbound = []; state.room = null;
    report(canvas.dataset?.werhdNetworkError || '无法启动网络对局'); setOpen(true);
  };
  window.addEventListener('werhd-native-network', open);
  window.addEventListener('werhd-native-network-started', started);
  window.addEventListener('werhd-native-network-return', returned);
  window.addEventListener('werhd-native-network-error', failed);
  function drain() {
    if (disposed || draining) return;
    draining = true;
    try {
      const messages = JSON.parse(native.network_drain_outbox());
      for (const message of messages) {
        if (message.matchId !== state.matchId) continue;
        if (socket?.readyState === WebSocket.OPEN) sendNow(message);
        else if (message.type !== 'leave') transportFailed('联机连接已中断，对局已停止。');
      }
      if (state.matchId && !state.stopped) {
        const status = native.network_status();
        if (completed(status)) { transportFailure = null; render(); }
        else if (status?.matchId === state.matchId && status.phase === 'stopped') {
          completion = null; transportFailure = null;
          stopMatch(status.error || '对局已停止');
        } else if (transportFailure && !currentCompletion()) stopMatch(transportFailure);
      }
    } catch (error) { if (state.matchId && !state.stopped) stopMatch(String(error)); }
    draining = false;
  }
  function timerDrain() {
    clearTimeout(timer);
    if (disposed) return;
    if (socket?.readyState === WebSocket.OPEN && Date.now() >= nextHeartbeatAt) {
      try { sendNow({type: 'ping'}); nextHeartbeatAt = Date.now() + 15000; }
      catch (error) { transportFailed('联机连接发生错误，对局已停止。'); }
    }
    drain();
    timer = setTimeout(timerDrain, document.hidden ? 100 : 25);
  }
  // The native online worker-timer pass also notifies here; background output
  // never depends on RAF or on the browser's throttled ordinary timeout alone.
  window.addEventListener('werhd-native-network-service', drain);
  document.addEventListener('visibilitychange', timerDrain);
  timerDrain(); render();
  return {dispatch, dispose() {
    if (disposed) return;
    disposed = true; creating = null; clearTimeout(timer); closeSocket();
    window.removeEventListener('werhd-native-network-service', drain);
    document.removeEventListener('visibilitychange', timerDrain);
    window.removeEventListener('werhd-native-network', open);
    window.removeEventListener('werhd-native-network-started', started);
    window.removeEventListener('werhd-native-network-return', returned);
    window.removeEventListener('werhd-native-network-error', failed);
  }};
}
