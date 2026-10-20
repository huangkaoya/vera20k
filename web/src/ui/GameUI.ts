import { defaultConfig, loadConfig, sanitizeConfig, saveConfig, validateConfig, RANDOM } from '../lobby/model';
import type {
  BattleHudState, GameUICallbacks, LobbyCatalog, LobbyMap, LobbySlot, ProductionCategory,
  ProductionItem, ProductionQueue, RoomState, SkirmishConfig, UiCommand,
} from './types';
export type * from './types';

const categoryNames: Record<ProductionCategory, string> = { building: '建筑', defense: '防御', infantry: '步兵', vehicle: '载具' };
const iconPaths: Record<string, string> = {
  building: 'M4 20V9l8-5 8 5v11H4Zm5 0v-7h6v7M4 10h16M8 8V4h3',
  defense: 'M12 3 3 7v6c0 4 9 8 9 8s9-4 9-8V7l-9-4Zm0 5v8m-4-4h8',
  infantry: 'M8 6a4 4 0 1 0 8 0M6 21v-7l6-3 6 3v7M3 15l3 2m12 0 3-2M9 21v-5m6 5v-5',
  vehicle: 'M3 14h18v5H3v-5Zm3 5v2m12-2v2M7 14V9h9l3 5M12 9V6h9',
  stop: 'M6 6h12v12H6Z', guard: 'M12 3 4 7v6c0 4 8 8 8 8s8-4 8-8V7l-8-4Zm0 5v7m-3-3h6',
  deploy: 'M12 3v12m-5-5 5 5 5-5M4 15v6h16v-6',
  sell: 'M16 6h-6a4 4 0 0 0 0 8h4a3 3 0 0 1 0 6H7M12 3v20',
  repair: 'M21 3a6 6 0 0 1-8 8L5 20a2 2 0 0 1-3-3l9-8a6 6 0 0 1 8-8l-4 4 4 2 2-4Z',
  attackMove: 'M12 2v5m0 10v5M2 12h5m10 0h5M12 6a6 6 0 1 0 0 12 6 6 0 0 0 0-12Zm0 3v6m-3-3h6',
  scatter: 'm4 4 6 6m4 4 6 6M4 9V4h5m11 11v5h-5M4 20l6-6m4-4 6-6M4 15v5h5m11-11V4h-5',
  home: 'm3 11 9-8 9 8M6 9v12h12V9M10 21v-7h4v7',
  pause: 'M8 4v16M16 4v16', play: 'm7 3 14 9-14 9V3Z',
};
function icon(name: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute('d', iconPaths[name] ?? iconPaths.building); path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor'); path.setAttribute('stroke-width', '1.8');
  path.setAttribute('stroke-linecap', 'round'); path.setAttribute('stroke-linejoin', 'round');
  svg.append(path); return svg;
}
function node<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag); result.className = className;
  if (text !== undefined) result.textContent = text; return result;
}
function button(label: string, click: () => void, className = ''): HTMLButtonElement {
  const result = node('button', className, label); result.type = 'button'; result.addEventListener('click', click); return result;
}
function select(items: Array<{ value: string; label: string; disabled?: boolean }>, value: string, change: (value: string) => void, label: string): HTMLSelectElement {
  const result = node('select'); result.setAttribute('aria-label', label);
  for (const item of items) { const option = node('option', '', item.label); option.value = item.value; option.disabled = !!item.disabled; result.append(option); }
  result.value = value; result.addEventListener('change', () => change(result.value)); return result;
}
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)); }
function money(value: number): string { return Math.floor(value).toLocaleString('zh-CN'); }

/** Presentation owns DOM and remembered lobby choices; simulation lives entirely in the Engine. */
export class GameUI {
  readonly canvas = node('canvas', 'battlefield');
  readonly minimap = node('canvas', 'minimap');
  private readonly lobby = node('section', 'lobby-view');
  private readonly battle = node('section', 'battle-view');
  private readonly loading = node('section', 'loading-view');
  private readonly toast = node('div', 'toast');
  private readonly mapList = node('div', 'map-list');
  private readonly mapPreview = node('div', 'map-preview');
  private readonly slotsElement = node('div', 'slot-rows');
  private readonly optionElement = node('div', 'game-options');
  private readonly roomPanel = node('div', 'room-panel');
  private readonly lobbyError = node('p', 'lobby-error');
  private readonly startButton: HTMLButtonElement;
  private readonly lobbyModeButtons: HTMLButtonElement[];
  private readonly mapName = node('h2');
  private readonly mapInfo = node('span', 'map-info');
  private readonly moneyElement = node('strong', '', '0');
  private readonly powerElement = node('span', 'power-value', '—');
  private readonly tickElement = node('span', 'battle-clock', '00:00');
  private readonly queueElement = node('div', 'queue-list');
  private readonly productionElement = node('div', 'production-grid');
  private readonly selectionElement = node('div', 'selection-info');
  private readonly battleMessage = node('div', 'battle-message');
  private readonly commandElement = node('div', 'command-buttons');
  private readonly categoryButtons = new Map<ProductionCategory, HTMLButtonElement>();
  private readonly loadingLabel = node('p', '', '正在准备战场');
  private readonly loadingBar = node('div', 'loading-bar-fill');
  private readonly confirm = node('div', 'confirm-overlay');
  private config = loadConfig();
  private catalog: LobbyCatalog = { maps: [], countries: [], colors: [] };
  private room: RoomState | null = null;
  private mode: 'single' | 'room' = 'single';
  private battleState: BattleHudState = { tick: 0, credits: 0 };
  private category: ProductionCategory = 'building';
  private currentProductionSignature = '';
  private toastTimer = 0;
  private readonly productionButtons = new Map<string, HTMLButtonElement>();

  constructor(private readonly mount: HTMLElement, private readonly callbacks: GameUICallbacks) {
    mount.classList.add('game-root');
    const header = node('header', 'brand-header');
    const brand = node('div', 'brand-lockup'); const brandIcon = node('img', 'brand-icon');
    brandIcon.src = '/app-icon.png'; brandIcon.alt = '';
    const name = node('div'); name.append(node('h1', '', '王二火大'), node('p', '', 'VERA 网页版 · 即时战略'));
    brand.append(brandIcon, name); header.append(brand, node('span', 'version-badge', 'V1.0 · 本地版'));
    const modeTabs = node('nav', 'lobby-tabs'); modeTabs.setAttribute('aria-label', '游戏模式');
    this.lobbyModeButtons = [
      button('单人遭遇战', () => this.setMode('single'), 'active'),
      button('本地联机', () => this.setMode('room')),
    ]; modeTabs.append(...this.lobbyModeButtons);
    const body = node('div', 'lobby-body');
    const maps = node('aside', 'map-panel metal-panel');
    const mapHeader = node('div', 'panel-heading'); mapHeader.append(node('h2', '', '作战地图'), node('span', '', 'MAPS'));
    maps.append(mapHeader, this.mapList);
    const center = node('main', 'setup-panel metal-panel');
    const heading = node('div', 'panel-heading'); heading.append(node('h2', '', '作战部署'), node('span', '', 'SKIRMISH'));
    const slotHeader = node('div', 'slot-row slot-header');
    for (const text of ['玩家 / 电脑', '国家', '颜色', '位置', '队伍']) slotHeader.append(node('span', '', text));
    center.append(heading, slotHeader, this.slotsElement, node('h3', 'section-label', '游戏设置'), this.optionElement, this.roomPanel);
    const right = node('aside', 'briefing-panel metal-panel');
    right.append(this.mapPreview, this.mapName, this.mapInfo, node('p', 'briefing-copy', '选择国家、部署位置和队友。展开基地，建设军队，击败你的对手。'));
    const hints = node('div', 'lobby-hints'); hints.append(node('strong', '', '指挥提示'), node('p', '', '左键选择 · 右键移动 / 攻击'), node('p', '', '双击基地车展开 · Shift 多选'), node('p', '', '方向键 / 拖动地图 · 滚轮缩放'));
    right.append(hints); body.append(maps, center, right);
    const footer = node('footer', 'lobby-footer');
    const footerInfo = node('div'); footerInfo.append(node('p', 'footer-name', '全平台即时战略 · 合家欢游戏'), node('span', 'footer-copy', '© 2026 王二火大制作组'));
    const actions = node('div', 'lobby-actions');
    const reset = button('恢复默认', () => { this.config = sanitizeConfig(defaultConfig(), this.catalog); this.changed(); });
    this.startButton = button('开始游戏', () => void this.start(), 'primary-button'); this.startButton.id = 'start-game';
    actions.append(reset, this.startButton); footer.append(footerInfo, this.lobbyError, actions);
    this.lobby.append(header, modeTabs, body, footer);
    this.createBattle();
    const loadingInner = node('div', 'loading-inner metal-panel');
    const loadingImage = node('img', 'loading-logo'); loadingImage.src = '/app-icon.png'; loadingImage.alt = '';
    const loadingTrack = node('div', 'loading-bar'); loadingTrack.append(this.loadingBar);
    loadingInner.append(loadingImage, node('h2', '', '战场部署中'), this.loadingLabel, loadingTrack);
    this.loading.append(loadingInner);
    this.toast.setAttribute('role', 'status'); this.toast.setAttribute('aria-live', 'polite');
    this.confirm.hidden = true;
    mount.replaceChildren(this.lobby, this.battle, this.loading, this.toast, this.confirm);
    this.showLobby();
  }
  setCatalog(catalog: LobbyCatalog): void {
    this.catalog = catalog; this.config = sanitizeConfig(this.config, catalog); this.renderLobby();
  }
  getConfig(): SkirmishConfig { return clone(this.config); }
  setConfig(config: SkirmishConfig): void { this.config = sanitizeConfig(config, this.catalog); this.renderLobby(); }
  showLobby(): void {
    this.lobby.hidden = false; this.battle.hidden = true; this.loading.hidden = true;
    this.confirm.hidden = true; this.renderLobby();
  }
  showLoading(message = '正在读取地图与游戏资源…', progress = 0): void {
    this.lobby.hidden = true; this.battle.hidden = true; this.loading.hidden = false;
    this.setLoadProgress(message, progress);
  }
  setLoadProgress(message: string, progress?: number): void {
    this.loadingLabel.textContent = message;
    if (progress !== undefined) this.loadingBar.style.width = `${Math.max(0, Math.min(1, progress)) * 100}%`;
  }
  showBattle(): { canvas: HTMLCanvasElement; minimap: HTMLCanvasElement } {
    this.lobby.hidden = true; this.loading.hidden = true; this.battle.hidden = false;
    this.confirm.hidden = true; return { canvas: this.canvas, minimap: this.minimap };
  }
  setRoom(room: RoomState | null): void {
    this.room = room;
    if (room) { this.mode = 'room'; if (room.config) this.config = sanitizeConfig(room.config, this.catalog); }
    else { for (const slot of this.config.slots) if (slot.id > 0 && slot.kind === 'human') slot.kind = 'ai'; }
    this.renderLobby();
  }
  notify(message: string, error = false): void {
    this.toast.textContent = message; this.toast.classList.toggle('error', error); this.toast.classList.add('visible');
    window.clearTimeout(this.toastTimer); this.toastTimer = window.setTimeout(() => this.toast.classList.remove('visible'), error ? 7000 : 4200);
  }
  private setMode(mode: 'single' | 'room'): void {
    if (this.room && mode === 'single') { this.notify('请先离开当前房间。'); return; }
    this.mode = mode; this.renderLobby();
  }
  private changed(): void {
    this.config = sanitizeConfig(this.config, this.catalog); saveConfig(this.config); this.lobbyError.textContent = '';
    if (this.room?.isHost) this.callbacks.onRoomConfigChange?.(this.getConfig());
    this.renderLobby();
  }
  private renderLobby(): void {
    this.lobbyModeButtons.forEach((b, i) => b.classList.toggle('active', (i === 0) === (this.mode === 'single')));
    this.mapList.replaceChildren();
    for (const map of this.catalog.maps) {
      const entry = button('', () => { this.config.mapId = map.id; this.changed(); }, 'map-choice');
      entry.classList.toggle('selected', map.id === this.config.mapId); entry.dataset.map = map.id;
      const label = node('div'); label.append(node('strong', '', map.name), node('span', '', `${map.maxPlayers} 人地图${map.size ? ` · ${map.size}` : ''}`));
      const count = node('span', 'map-player-count', `${map.maxPlayers}`); entry.append(count, label);
      entry.disabled = !!this.room && !this.room.isHost; this.mapList.append(entry);
    }
    if (!this.catalog.maps.length) this.mapList.append(node('p', 'empty-state', '正在读取地图…'));
    const map = this.catalog.maps.find(m => m.id === this.config.mapId);
    this.renderPreview(map); this.renderSlots(); this.renderOptions(); this.renderRoom();
    this.startButton.textContent = this.mode === 'single' ? '开始游戏' : this.room ? this.room.isHost ? '开始对战' : '准备 / 取消准备' : '创建房间';
    this.startButton.disabled = !map || (!!this.room && this.room.isHost && this.room.canStart === false);
    this.startButton.setAttribute('aria-label', this.startButton.textContent);
  }
  private renderPreview(map?: LobbyMap): void {
    this.mapName.textContent = map?.name ?? '选择作战地图'; this.mapInfo.textContent = map ? `${map.maxPlayers} 个部署位置${map.size ? `　/　${map.size}` : ''}` : '等待地图列表';
    this.mapPreview.replaceChildren();
    if (map?.previewUrl) {
      const image = node('img'); image.src = map.previewUrl; image.alt = `${map.name}地图预览`; this.mapPreview.append(image);
    } else { const empty = node('div', 'preview-placeholder'); empty.append(icon('attackMove'), node('span', '', map ? '战区侦察中' : '等待作战指令')); this.mapPreview.append(empty); }
    const label = node('span', 'preview-label', '战区概览'); this.mapPreview.append(label);
    if (map?.starts?.length) {
      const marks = node('div', 'preview-starts');
      map.starts.forEach((start, i) => { const mark = node('span', '', `${i + 1}`); mark.style.left = `${Math.max(4, Math.min(96, start.x * 100))}%`; mark.style.top = `${Math.max(4, Math.min(96, start.y * 100))}%`; marks.append(mark); });
      this.mapPreview.append(marks);
    }
  }
  private renderSlots(): void {
    this.slotsElement.replaceChildren(); const max = this.catalog.maps.find(m => m.id === this.config.mapId)?.maxPlayers ?? 2;
    const usedColors = this.config.slots.filter(s => s.kind !== 'closed').map(s => s.color);
    const usedStarts = this.config.slots.filter(s => s.kind !== 'closed').map(s => s.start);
    this.config.slots.slice(0, max).forEach((slot, index) => {
      const row = node('div', `slot-row${slot.kind === 'closed' ? ' closed' : ''}`); row.dataset.slot = `${index}`;
      const player = node('div', 'player-slot-name'); const marker = node('span', 'slot-number', `${index + 1}`); player.append(marker);
      if (index === 0) {
        const input = node('input', 'player-name'); input.value = this.config.playerName; input.maxLength = 24; input.setAttribute('aria-label', '玩家名称');
        input.addEventListener('change', () => { this.config.playerName = input.value.trim() || '指挥官'; this.changed(); }); player.append(input);
      } else {
        const kind = select([{ value: 'closed', label: '关闭' }, { value: 'easy', label: '简单电脑' }, { value: 'normal', label: '中等电脑' }, { value: 'hard', label: '困难电脑' }], slot.kind === 'closed' ? 'closed' : slot.difficulty,
          value => { slot.kind = value === 'closed' ? 'closed' : 'ai'; if (value !== 'closed') slot.difficulty = value as LobbySlot['difficulty']; this.changed(); }, `第 ${index + 1} 个玩家`);
        if (this.room && slot.kind === 'human') { kind.append(new Option(slot.name ?? '玩家', 'human')); kind.value = 'human'; kind.disabled = true; }
        player.append(kind);
      }
      const country = select(this.catalog.countries.map(c => ({ value: c.id, label: c.name })), slot.country, value => { slot.country = value; this.changed(); }, `第 ${index + 1} 位国家`);
      const color = select([{ value: `${RANDOM}`, label: '随机' }, ...this.catalog.colors.map(c => ({ value: `${c.id}`, label: c.name, disabled: c.id !== slot.color && usedColors.includes(c.id) }))], `${slot.color}`, value => { slot.color = Number(value); this.changed(); }, `第 ${index + 1} 位颜色`);
      color.className = 'color-select'; color.style.setProperty('--player-color', this.catalog.colors.find(c => c.id === slot.color)?.hex ?? '#bbc5ca');
      const start = select([{ value: `${RANDOM}`, label: '随机' }, ...Array.from({ length: max }, (_, i) => ({ value: `${i}`, label: `${i + 1}`, disabled: i !== slot.start && usedStarts.includes(i) }))], `${slot.start}`, value => { slot.start = Number(value); this.changed(); }, `第 ${index + 1} 位位置`);
      const team = select([{ value: `${RANDOM}`, label: '无' }, ...Array.from({ length: 4 }, (_, i) => ({ value: `${i}`, label: `${i + 1}` }))], `${slot.team}`, value => { slot.team = Number(value); this.changed(); }, `第 ${index + 1} 位队伍`);
      if (slot.kind === 'closed') for (const control of [country, color, start, team]) control.disabled = true;
      row.append(player, country, color, start, team);
      if (this.room && !this.room.isHost) row.querySelectorAll('input,select').forEach(control => (control as HTMLInputElement).disabled = true);
      this.slotsElement.append(row);
    });
  }
  private renderOptions(): void {
    this.optionElement.replaceChildren(); const values = node('div', 'option-values');
    const addValue = (label: string, key: 'credits' | 'unitCount' | 'gameSpeed', options: number[], suffix = '') => {
      const field = node('label', 'option-field'); field.append(node('span', '', label));
      const entries = [...new Set([...options, this.config[key]])].sort((a, b) => a - b);
      field.append(select(entries.map(v => ({ value: `${v}`, label: key === 'gameSpeed' ? ['最快', '很快', '较快', '正常', '较慢', '慢', '最慢'][v] : `${key === 'credits' ? money(v) : v}${suffix}` })), `${this.config[key]}`, value => { this.config[key] = Number(value); this.changed(); }, label)); values.append(field);
    };
    addValue('初始资金', 'credits', [5000, 10000, 20000, 50000]); addValue('初始部队', 'unitCount', [0, 1, 3, 5, 10]); addValue('游戏速度', 'gameSpeed', [0, 1, 2, 3, 4, 5, 6]);
    const checks = node('div', 'option-checks');
    const labels = { shortGame: '快速游戏', superWeapons: '超级武器', mcvRepacks: '基地车可重新部署', cratesAppear: '随机工具箱', buildOffAlly: '在盟友基地旁建造' } as const;
    for (const [key, label] of Object.entries(labels) as Array<[keyof typeof labels, string]>) {
      const field = node('label', 'check-field'); const input = node('input'); input.type = 'checkbox'; input.checked = this.config[key];
      input.addEventListener('change', () => { this.config[key] = input.checked; this.changed(); }); field.append(input, node('span', '', label)); checks.append(field);
    }
    const seedLabel = node('label', 'seed-field'); seedLabel.append(node('span', '', '战局种子'));
    const seed = node('input'); seed.type = 'number'; seed.min = '0'; seed.max = '4294967295'; seed.value = `${this.config.seed}`; seed.setAttribute('aria-label', '战局种子');
    seed.addEventListener('change', () => { this.config.seed = Number(seed.value); this.changed(); }); seedLabel.append(seed); this.optionElement.append(values, checks, seedLabel);
    if (this.room && !this.room.isHost) this.optionElement.querySelectorAll('input,select').forEach(control => (control as HTMLInputElement).disabled = true);
  }
  private renderRoom(): void {
    this.roomPanel.hidden = this.mode !== 'room'; this.roomPanel.replaceChildren();
    if (this.mode !== 'room') return;
    if (this.room) {
      const heading = node('div', 'room-heading'); heading.append(node('h3', '', `房间 ${this.room.code}`), button('离开房间', () => this.callbacks.onLeaveRoom?.(), 'quiet-button'));
      const members = node('div', 'room-members');
      this.room.members.forEach(member => { const row = node('div', 'room-member'); row.append(node('span', '', `${member.host ? '★ ' : ''}${member.name}`), node('span', member.ready ? 'ready' : '', member.host ? '房主' : member.ready ? '已准备' : '未准备')); members.append(row); });
      this.roomPanel.append(heading, members, node('p', 'room-note', this.room.status ?? '分享房间号，在另一浏览器窗口加入。所有玩家准备后由房主开始。'));
    } else {
      this.roomPanel.append(node('h3', '', '在本机的另一个浏览器窗口联机'));
      const join = node('div', 'room-join'); const input = node('input'); input.placeholder = '输入房间号'; input.maxLength = 12; input.setAttribute('aria-label', '房间号');
      const submit = button('加入房间', () => { const code = input.value.trim(); if (!code) { input.focus(); return; } void this.callbacks.onJoinRoom?.(code); });
      input.addEventListener('keydown', event => { if (event.key === 'Enter') submit.click(); }); join.append(input, submit);
      this.roomPanel.append(join, node('p', 'room-note', '也可以选择地图与规则，再点击下方「创建房间」。'));
    }
  }
  private async start(): Promise<void> {
    const error = validateConfig(this.config, this.catalog);
    if (error) { this.lobbyError.textContent = error; return; }
    saveConfig(this.config);
    try {
      if (this.mode === 'single') await this.callbacks.onStart(this.getConfig());
      else if (!this.room) await this.callbacks.onCreateRoom?.(this.getConfig());
      else if (this.room.isHost) this.callbacks.onStartRoom?.();
      else this.callbacks.onToggleReady?.();
    } catch (error) { this.notify(error instanceof Error ? error.message : String(error), true); }
  }
  private createBattle(): void {
    const world = node('div', 'world-container'); this.canvas.id = 'battlefield'; this.canvas.tabIndex = 0; this.canvas.setAttribute('aria-label', '红警战场');
    this.canvas.addEventListener('contextmenu', event => event.preventDefault()); world.append(this.canvas, this.battleMessage);
    const top = node('div', 'battle-topbar'); const title = node('div', 'battle-title', '王二火大'); title.append(node('span', '', 'VERA'));
    const moneyPanel = node('div', 'resource-value'); moneyPanel.append(node('span', '', '$'), this.moneyElement);
    const power = node('div', 'power-meter'); power.append(node('span', '', '电力'), this.powerElement);
    const returnButton = button('返回大厅', () => this.confirmLeave(), 'battle-return'); returnButton.prepend(icon('home'));
    top.append(title, this.tickElement, moneyPanel, power, returnButton);
    const side = node('aside', 'battle-sidebar'); const radarFrame = node('div', 'radar-frame'); this.minimap.width = 252; this.minimap.height = 152; this.minimap.setAttribute('aria-label', '战场小地图'); radarFrame.append(this.minimap, node('span', 'radar-label', '战术雷达'));
    const tabs = node('nav', 'production-tabs'); tabs.setAttribute('aria-label', '生产类别');
    for (const category of Object.keys(categoryNames) as ProductionCategory[]) {
      const tab = button('', () => { this.category = category; this.currentProductionSignature = ''; this.updateProduction(); }, category === this.category ? 'active' : ''); tab.title = categoryNames[category]; tab.setAttribute('aria-label', categoryNames[category]); tab.append(icon(category), node('span', '', categoryNames[category]));
      tabs.append(tab); this.categoryButtons.set(category, tab);
    }
    const productionLabel = node('h3', 'production-label', '建造与生产');
    const queueWrap = node('div', 'queue-wrap'); queueWrap.append(node('h3', '', '生产队列'), this.queueElement);
    side.append(radarFrame, tabs, productionLabel, this.productionElement, queueWrap, this.selectionElement);
    const bottom = node('div', 'battle-commandbar');
    const hint = node('div', 'command-hint'); hint.append(node('strong', '', '作战指令'), node('span', '', '左键选择 · 右键移动 / 攻击'));
    for (const [command, label, shortcut] of [['attackMove', '攻击移动', 'A'], ['stop', '停止', 'S'], ['guard', '警戒', 'G'], ['deploy', '展开', 'D'], ['scatter', '散开', 'X'], ['repair', '维修', ''], ['sell', '出售', '']] as const) {
      const item = button('', () => this.emitSelectionCommand(command), 'command-button'); item.dataset.command = command; item.title = `${label}${shortcut ? ` (${shortcut})` : ''}`; item.setAttribute('aria-label', label); item.append(icon(command), node('span', '', label)); if (shortcut) item.append(node('kbd', '', shortcut)); this.commandElement.append(item);
    }
    bottom.append(hint, this.commandElement); this.battle.append(world, top, side, bottom);
  }
  private emitSelectionCommand(type: 'attackMove' | 'stop' | 'guard' | 'deploy' | 'scatter' | 'repair' | 'sell'): void {
    const ids = this.battleState.selected?.ids ?? [];
    if (!ids.length) { this.notify('请先选择一个单位或建筑。'); return; }
    this.callbacks.onCommand({ type, ids });
  }
  setBattleState(state: BattleHudState): void {
    this.battleState = state; this.battle.dataset.faction = state.faction ?? 'allied';
    this.moneyElement.textContent = money(state.credits);
    const output = state.power?.output, drain = state.power?.drain;
    this.powerElement.textContent = output === undefined ? '—' : `${output} / ${drain ?? 0}`;
    this.powerElement.classList.toggle('low-power', output !== undefined && drain !== undefined && output < drain);
    const elapsed = Math.floor(state.elapsedSeconds ?? state.tick * [16, 33, 50, 66, 83, 100, 125][this.config.gameSpeed] / 1000);
    this.tickElement.textContent = `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`;
    this.battleMessage.textContent = state.message ?? ''; this.battleMessage.hidden = !state.message;
    this.updateProduction(); this.updateSelection();
  }
  private updateProduction(): void {
    this.categoryButtons.forEach((button, category) => button.classList.toggle('active', category === this.category));
    const items = (this.battleState.production ?? []).filter(item => item.category === this.category);
    const signature = JSON.stringify(items);
    if (signature !== this.currentProductionSignature) {
      this.currentProductionSignature = signature; this.productionButtons.clear(); this.productionElement.replaceChildren();
      for (const item of items) {
        const card = button('', () => {
          const queue = this.battleState.queues?.find(q => q.typeId === item.typeId && q.ready);
          this.callbacks.onCommand(queue ? { type: 'place', typeId: item.typeId } : { type: 'produce', typeId: item.typeId, count: 1 });
        }, 'cameo-button');
        card.dataset.type = item.typeId; card.title = `${item.name} · $${money(item.cost)}${item.reason ? ` · ${item.reason}` : ''}`;
        if (item.cameo) { const image = node('img'); image.src = item.cameo; image.alt = ''; image.loading = 'lazy'; card.append(image); }
        else card.append(icon(item.category));
        card.append(node('span', 'cameo-name', item.name), node('span', 'cameo-cost', `$${money(item.cost)}`), node('div', 'cameo-progress'), node('span', 'cameo-state'));
        card.disabled = item.available === false;
        card.addEventListener('contextmenu', event => { event.preventDefault(); this.callbacks.onCommand({ type: 'cancelProduction', typeId: item.typeId }); });
        this.productionElement.append(card); this.productionButtons.set(item.typeId, card);
      }
      if (!items.length) this.productionElement.append(node('p', 'production-empty', '展开基地车，建立基地后解锁生产。'));
    }
    for (const [typeId, card] of this.productionButtons) {
      const queue = this.battleState.queues?.find(q => q.typeId === typeId);
      const item = this.battleState.production?.find(item => item.typeId === typeId);
      card.disabled = item?.available === false && !queue;
      const progress = card.querySelector<HTMLElement>('.cameo-progress')!;
      progress.style.height = queue ? `${Math.max(0, Math.min(1, 1 - queue.progress)) * 100}%` : '0%';
      const state = card.querySelector<HTMLElement>('.cameo-state')!;
      state.textContent = queue?.ready ? '就绪' : queue?.paused ? '暂停' : queue ? `${Math.round(queue.progress * 100)}%${(queue.count ?? 0) > 1 ? ` ×${queue.count}` : ''}` : '';
      card.classList.toggle('production-ready', !!queue?.ready);
    }
    this.queueElement.replaceChildren();
    for (const queue of this.battleState.queues ?? []) this.queueElement.append(this.queueRow(queue));
    if (!this.battleState.queues?.length) this.queueElement.append(node('p', 'empty-queue', '生产队列为空'));
  }
  private queueRow(queue: ProductionQueue): HTMLElement {
    const item = this.battleState.production?.find(item => item.typeId === queue.typeId);
    const row = node('div', 'queue-row'); const name = node('span', '', item?.name ?? queue.typeId);
    const progress = node('span', 'queue-progress'); progress.style.setProperty('--progress', `${Math.max(0, Math.min(1, queue.progress)) * 100}%`);
    progress.textContent = queue.ready ? '就绪' : queue.paused ? '暂停' : `${Math.round(queue.progress * 100)}%`;
    row.append(name, progress); return row;
  }
  private updateSelection(): void {
    this.selectionElement.replaceChildren(); const selected = this.battleState.selected;
    if (!selected?.ids.length) {
      this.selectionElement.append(node('p', 'no-selection', '选择单位以查看状态'));
    } else {
      if (selected.cameo) { const image = node('img', 'selection-cameo'); image.src = selected.cameo; image.alt = ''; this.selectionElement.append(image); }
      const text = node('div', 'selection-details'); text.append(node('strong', '', selected.name), node('span', '', selected.ids.length > 1 ? `已选择 ${selected.ids.length} 个单位` : selected.ownerName ?? ''));
      if (selected.hp !== undefined && selected.maxHp) {
        const hp = node('div', 'health-bar'); const fill = node('i'); fill.style.width = `${Math.max(0, Math.min(1, selected.hp / selected.maxHp)) * 100}%`; hp.append(fill); text.append(hp, node('span', 'hp-value', `${selected.hp} / ${selected.maxHp}`));
      }
      this.selectionElement.append(text);
    }
    this.commandElement.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = !selected?.ids.length; });
  }
  private confirmLeave(): void {
    this.confirm.replaceChildren(); const panel = node('div', 'confirm-panel metal-panel');
    panel.append(node('h2', '', '返回大厅'), node('p', '', '当前战局将结束。确定返回大厅？'));
    const controls = node('div'); controls.append(button('继续游戏', () => { this.confirm.hidden = true; }), button('结束并返回', () => { this.confirm.hidden = true; this.callbacks.onLeaveBattle(); }, 'primary-button'));
    panel.append(controls); this.confirm.append(panel); this.confirm.hidden = false;
  }
  dispose(): void { window.clearTimeout(this.toastTimer); this.mount.replaceChildren(); }
}
