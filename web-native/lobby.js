const COUNTRIES = [
  ['America', '美国'], ['Korea', '韩国'], ['France', '法国'], ['Germany', '德国'],
  ['GreatBritain', '英国'], ['Libya', '利比亚'], ['Iraq', '伊拉克'],
  ['Cuba', '古巴'], ['Russia', '苏俄'], ['Yuri', '尤里'],
];
const COLORS = ['黄色', '红色', '蓝色', '绿色', '橙色', '青色', '紫色', '粉色'];
const COLOR_HEX = ['#e7cc43', '#e7594c', '#5c9de9', '#68b665', '#e99c44', '#65cbd5', '#a17bd7', '#d67da4'];
const MAP = 'XMP29U2.MAP';

function stored(storage, key, fallback) {
  try { return storage.getItem(key) || fallback; } catch { return fallback; }
}
function save(storage, key, value) { try { storage.setItem(key, value); } catch {} }
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function button(text, action, {primary = false, disabled = false} = {}) {
  const node = element('button', `nl-button${primary ? ' nl-primary' : ''}`, text);
  node.type = 'button'; node.disabled = disabled; node.addEventListener('click', action);
  return node;
}
function field(label, control) {
  const wrapper = element('label', 'nl-field');
  wrapper.append(element('span', '', label), control); return wrapper;
}
function select(items, value, onChange, disabled = false) {
  const node = element('select'); node.disabled = disabled;
  for (const [key, label] of items) {
    const option = element('option', '', label); option.value = String(key); node.append(option);
  }
  node.value = String(value);
  node.addEventListener('change', () => onChange(node.value)); return node;
}

/** The native client owns the whole battlefield; this module owns only rooms. */
export function installNativeLobby({native, canvas, socketUrl} = {}) {
  if (!native || !canvas) throw new Error('联机大厅缺少游戏入口');
  const stylesheet = document.createElement('link'); stylesheet.rel = 'stylesheet';
  stylesheet.href = new URL('./lobby.css', import.meta.url).href; document.head.append(stylesheet);
  const shell = element('section', 'native-lobby'); shell.hidden = true;
  shell.setAttribute('aria-label', '王二火大联机大厅'); document.body.append(shell);
  const generatedId = globalThis.crypto?.randomUUID?.() ?? `player-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const playerId = stored(sessionStorage, 'vera.native.playerId', generatedId);
  save(sessionStorage, 'vera.native.playerId', playerId);
  const state = {name: stored(localStorage, 'vera.native.playerName', '指挥官'), code: '', room: null,
    open: false, connected: false, busy: false, status: '', error: '', matchId: null,
    nativeStarted: false, starting: false, stopped: false, inbound: []};
  let socket = null, socketEpoch = 0, connecting = null, cancelConnect = null, disposed = false, timer, draining = false;
  let completion = null, transportFailure = null;

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
  function setOpen(open) {
    state.open = open; shell.hidden = !open;
    if (open) { render(); shell.querySelector('input,button')?.focus(); }
    else canvas.focus();
  }
  function sendNow(message) {
    if (socket?.readyState !== WebSocket.OPEN) throw new Error('大厅连接已断开，请重新进入');
    socket.send(JSON.stringify(message));
  }
  async function connect() {
    if (socket?.readyState === WebSocket.OPEN) return;
    if (connecting) return connecting;
    const epoch = ++socketEpoch;
    const address = socketUrl ? new URL(socketUrl, location.href) : new URL('/ws/native', location.href);
    address.protocol = address.protocol === 'https:' ? 'wss:' : address.protocol === 'http:' ? 'ws:' : address.protocol;
    const current = new WebSocket(address); socket = current;
    connecting = new Promise((resolve, reject) => {
      let settled = false;
      cancelConnect = () => { if (!settled) { settled = true; reject(new Error('已离开大厅')); } };
      current.addEventListener('open', () => {
        if (epoch !== socketEpoch || socket !== current || disposed) return;
        state.connected = true;
        current.send(JSON.stringify({type: 'hello', protocol: 2, playerId}));
        settled = true; resolve(); render();
      });
      current.addEventListener('message', event => {
        if (epoch !== socketEpoch || socket !== current || disposed) return;
        try { receive(JSON.parse(event.data)); } catch (error) { receiveError(error); }
      });
      current.addEventListener('error', () => {
        if (epoch !== socketEpoch || socket !== current || disposed) return;
        if (!settled) { settled = true; reject(new Error('无法连接本地联机服务')); }
        else if (state.matchId) transportFailed('联机连接发生错误，对局已停止。');
      });
      current.addEventListener('close', () => {
        if (epoch !== socketEpoch || socket !== current || disposed) return;
        socket = null; connecting = null; state.connected = false; state.busy = false;
        if (!settled) { settled = true; reject(new Error('联机服务连接已关闭')); }
        if (state.matchId) transportFailed('联机连接已中断，对局已停止。');
        else if (state.open) { state.room = null; state.error = '大厅连接已关闭，请重新创建或加入。'; render(); }
      });
    }).finally(() => { if (epoch === socketEpoch) { connecting = null; cancelConnect = null; } });
    return connecting;
  }
  async function request(message) {
    state.busy = true; state.error = ''; render();
    const connection = connect(); const epoch = socketEpoch;
    try { await connection; if (epoch === socketEpoch && !disposed) sendNow(message); }
    catch (error) { if (epoch === socketEpoch && !disposed) report(error); }
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
    if (message.type === 'hello') return;
    if (message.type === 'room') {
      state.room = message.room; state.status = message.room?.status ?? ''; state.busy = false;
      if (!state.stopped) state.error = ''; if (state.open) render(); return;
    }
    if (message.type === 'error') { receiveError(message.error ?? '大厅操作失败'); return; }
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
    if (state.matchId) { native.network_leave(state.matchId); return; }
    leaveRoom(); closeSocket(); setOpen(false);
  }
  function updateConfig(change) {
    if (!state.room?.isHost || state.matchId) return;
    const config = structuredClone(state.room.config); change(config);
    request({type: 'config', config});
  }
  function memberControl(member, player, key, choices, numeric = false) {
    return select(choices, player?.[key] ?? (numeric ? member.slot : 'America'), value => {
      updateConfig(config => {
        const target = config.players.find(player => player.slot === member.slot);
        if (target) target[key] = numeric ? Number(value) : value;
      });
    }, !state.room.isHost || !!state.matchId || state.busy);
  }
  function render() {
    shell.replaceChildren();
    const frame = element('div', 'nl-frame');
    const header = element('header', 'nl-header');
    const brand = element('div', 'nl-brand'); const icon = element('img');
    icon.src = '/branding/icon.png'; icon.alt = ''; brand.append(icon);
    const titles = element('div'); titles.append(element('strong', '', '王二火大'), element('span', '', '联机作战大厅'));
    brand.append(titles); header.append(brand, button('返回主菜单', back)); frame.append(header);
    const body = element('main', 'nl-body'); const map = element('aside', 'nl-map');
    const mapArt = element('div', 'nl-map-art');
    mapArt.innerHTML = '<svg viewBox="0 0 360 240" aria-hidden="true"><path d="M0 40h360M0 80h360M0 120h360M0 160h360M0 200h360M40 0v240M80 0v240M120 0v240M160 0v240M200 0v240M240 0v240M280 0v240M320 0v240"/><circle cx="180" cy="120" r="80"/><circle cx="180" cy="120" r="45"/><path class="nl-radar" d="M180 120L230 55A80 80 0 0 1 260 120Z"/><path class="nl-cross" d="M165 120h30M180 105v30"/></svg>';
    map.append(mapArt, element('span', 'nl-kicker', '双人对战'), element('h2', '', '火线冲突 (2)'),
      element('p', '', '选择阵营，准备部队。在同一片战场上交锋。'), element('div', 'nl-map-id', MAP));
    body.append(map); const panel = element('section', 'nl-panel');
    if (state.matchId && !state.room) {
      panel.append(element('h2', '', '对局已停止'),
        element('p', '', state.error || '请返回主菜单，再开始下一场作战。'));
      const actions = element('div', 'nl-actions');
      actions.append(button('返回主菜单', back, {primary: true})); panel.append(actions);
    } else if (!state.room) {
      panel.append(element('h2', '', '集结你的战友'));
      const name = element('input'); name.value = state.name; name.maxLength = 24; name.autocomplete = 'nickname';
      name.addEventListener('input', () => { state.name = name.value; save(localStorage, 'vera.native.playerName', state.name); });
      panel.append(field('指挥官名称', name));
      const create = element('div', 'nl-entry-card');
      create.append(element('h3', '', '建立作战房间'), element('p', '', '创建房间后，将房间代码告诉另一位指挥官。'),
        button('创建房间', () => request({type: 'create', name: state.name.trim()}), {primary: true, disabled: state.busy}));
      const join = element('div', 'nl-entry-card'); const code = element('input');
      code.value = state.code; code.placeholder = '输入房间代码'; code.maxLength = 12; code.autocapitalize = 'characters';
      code.setAttribute('aria-label', '房间代码');
      code.addEventListener('input', () => { state.code = code.value.toUpperCase().replace(/\s/g, ''); code.value = state.code; });
      code.addEventListener('keydown', event => { if (event.key === 'Enter' && state.code) request({type: 'join', code: state.code, name: state.name.trim()}); });
      join.append(element('h3', '', '加入战友'), code,
        button('加入房间', () => request({type: 'join', code: state.code, name: state.name.trim()}), {disabled: state.busy}));
      panel.append(create, join);
    } else {
      const room = state.room; const heading = element('div', 'nl-room-title');
      heading.append(element('h2', '', `房间 ${room.code}`), element('span', 'nl-chip', `${room.members.length} / 2`)); panel.append(heading);
      panel.append(element('p', 'nl-muted', room.isHost ? '你是房主。双方准备后即可开战。' : '选择已由房主统一设置。准备就绪后，等待房主开战。'));
      const table = element('div', 'nl-roster');
      const headings = element('div', 'nl-player nl-player-heading');
      for (const title of ['指挥官', '阵营', '颜色', '出生点', '队伍']) headings.append(element('span', '', title)); table.append(headings);
      for (const member of room.members) {
        const player = room.config.players.find(player => player.slot === member.slot);
        const row = element('div', 'nl-player'); const identity = element('div', 'nl-player-name');
        const color = element('i', 'nl-player-color'); color.style.backgroundColor = COLOR_HEX[player?.color ?? member.slot];
        identity.append(color, element('strong', '', member.name), element('small', '', `${member.host ? '房主 · ' : ''}${member.ready ? '已准备' : '未准备'}`));
        row.append(identity, memberControl(member, player, 'country', COUNTRIES),
          memberControl(member, player, 'color', COLORS.map((name, index) => [index, name]), true),
          memberControl(member, player, 'start', [[0, '1'], [1, '2']], true),
          memberControl(member, player, 'team', [[-1, '无'], [0, 'A'], [1, 'B'], [2, 'C'], [3, 'D']], true)); table.append(row);
      }
      if (room.members.length < 2) table.append(element('div', 'nl-waiting', '等待另一位指挥官加入…'));
      panel.append(table); const options = element('div', 'nl-options'); const settings = room.config.options;
      const configSelect = (key, choices) => select(choices, settings[key], value => updateConfig(config => { config.options[key] = Number(value); }), !room.isHost || !!state.matchId || state.busy);
      options.append(field('初始资金', configSelect('credits', [[5000, '5,000'], [10000, '10,000'], [20000, '20,000'], [30000, '30,000']])),
        field('初始部队', configSelect('unitCount', [[0, '无'], [5, '5'], [10, '10']])),
        field('游戏速度', configSelect('gameSpeed', [[0, '极速'], [1, '很快'], [2, '较快'], [3, '正常'], [4, '较慢'], [5, '慢速'], [6, '最慢']])));
      const checks = element('div', 'nl-checks');
      for (const [key, label] of [['shortGame', '快速游戏'], ['superWeapons', '超级武器'], ['crates', '随机工具箱'], ['mcvRepacks', '基地重新部署'], ['buildOffAlly', '盟友旁建造'], ['destroyableBridges', '可摧毁桥梁']]) {
        const input = element('input'); input.type = 'checkbox'; input.checked = !!settings[key];
        input.disabled = !room.isHost || !!state.matchId || state.busy;
        input.addEventListener('change', () => updateConfig(config => { config.options[key] = input.checked; }));
        const labelNode = element('label'); labelNode.append(input, document.createTextNode(label)); checks.append(labelNode);
      }
      panel.append(options, checks); const actions = element('div', 'nl-actions');
      if (state.matchId) actions.append(button('返回主菜单', back, {primary: true}));
      else {
        const me = room.members.find(member => member.id === room.localMemberId);
        actions.append(button('离开房间', leaveRoom, {disabled: state.busy}));
        if (!room.isHost) actions.append(button(me?.ready ? '取消准备' : '准备就绪', () => request({type: 'ready'}), {disabled: state.busy}));
        if (room.isHost) actions.append(button('开始作战', () => request({type: 'start'}), {primary: true, disabled: !room.canStart || state.busy}));
      }
      panel.append(actions);
    }
    const status = element('div', `nl-status${state.error ? ' nl-error' : ''}`,
      state.error || (state.starting ? '双方正在载入原生战场…' : state.busy ? '正在联络…' : state.status || (state.connected ? '联机服务已连接' : '创建或加入房间后连接联机服务')));
    status.setAttribute('role', state.error ? 'alert' : 'status'); panel.append(status); body.append(panel); frame.append(body);
    frame.append(element('footer', 'nl-footer', '王二火大 · 与战友一起，再战一局。')); shell.append(frame);
  }

  const open = () => { state.error = ''; setOpen(true); };
  const started = () => {
    state.nativeStarted = true; state.starting = false; state.busy = false;
    try { for (const message of state.inbound.splice(0)) deliver(message); }
    catch (error) { stopMatch(String(error)); return; }
    setOpen(state.stopped);
  };
  const returned = () => {
    if (socket?.readyState === WebSocket.OPEN) sendNow({type: 'leave'});
    completion = null; transportFailure = null;
    state.matchId = null; state.nativeStarted = false; state.inbound = []; state.room = null;
    state.starting = false; state.stopped = false; state.busy = false;
    closeSocket(); setOpen(false);
  };
  const failed = () => {
    if (socket?.readyState === WebSocket.OPEN) sendNow({type: 'leave'});
    completion = null; transportFailure = null;
    state.matchId = null; state.nativeStarted = false; state.inbound = []; state.room = null;
    report(canvas.dataset.veraNetworkError || '无法启动网络对局'); setOpen(true);
  };
  window.addEventListener('vera-native-network', open);
  window.addEventListener('vera-native-network-started', started);
  window.addEventListener('vera-native-network-return', returned);
  window.addEventListener('vera-native-network-error', failed);
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
        if (completed(status)) transportFailure = null;
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
    drain();
    timer = setTimeout(timerDrain, document.hidden ? 100 : 25);
  }
  // The native online worker-timer pass also notifies here; background output
  // never depends on RAF or on the browser's throttled ordinary timeout alone.
  window.addEventListener('vera-native-network-service', drain);
  document.addEventListener('visibilitychange', timerDrain);
  timerDrain();
  return {open, dispose() {
    disposed = true; clearTimeout(timer); closeSocket(); shell.remove(); stylesheet.remove();
    window.removeEventListener('vera-native-network-service', drain);
    document.removeEventListener('visibilitychange', timerDrain);
    window.removeEventListener('vera-native-network', open);
    window.removeEventListener('vera-native-network-started', started);
    window.removeEventListener('vera-native-network-return', returned);
    window.removeEventListener('vera-native-network-error', failed);
  }};
}
