import type { LobbyCatalog, LobbySlot, SkirmishConfig } from '../ui/types';
export const RANDOM = -2;
const STORAGE_KEY = 'werhd-vera.lobby.v1';
export function defaultConfig(): SkirmishConfig {
  return {
    mapId: '', seed: 200021, localHouse: 0, playerName: '指挥官',
    slots: Array.from({ length: 8 }, (_, id): LobbySlot => ({
      id, kind: id === 0 ? 'human' : id === 1 ? 'ai' : 'closed',
      country: 'America', color: id < 2 ? id : RANDOM, start: RANDOM, team: RANDOM,
      difficulty: 'normal',
    })),
    credits: 10000, unitCount: 0, gameSpeed: 3,
    shortGame: true, superWeapons: true, mcvRepacks: true,
    cratesAppear: false, buildOffAlly: true,
  };
}
export function sanitizeConfig(input: SkirmishConfig, catalog: LobbyCatalog): SkirmishConfig {
  const defaults = defaultConfig();
  const map = catalog.maps.find(m => m.id === input.mapId) ?? catalog.maps[0];
  const countries = new Set(catalog.countries.map(c => c.id));
  const colors = new Set(catalog.colors.map(c => c.id));
  const usedColors = new Set<number>(), usedStarts = new Set<number>();
  const result: SkirmishConfig = {
    ...defaults, ...input,
    mapId: map?.id ?? '',
    playerName: String(input.playerName || defaults.playerName).trim().slice(0, 24),
    localHouse: 0,
    seed: Number.isFinite(input.seed) ? Number(input.seed) >>> 0 : defaults.seed,
    credits: clamp(input.credits, 0, 100000, defaults.credits),
    unitCount: clamp(input.unitCount, 0, 20, defaults.unitCount),
    gameSpeed: clamp(input.gameSpeed, 0, 6, defaults.gameSpeed),
    slots: [],
  };
  for (const key of ['shortGame', 'superWeapons', 'mcvRepacks', 'cratesAppear', 'buildOffAlly'] as const) {
    result[key] = typeof input[key] === 'boolean' ? input[key] : defaults[key];
  }
  result.slots = defaults.slots.map((fallback, id) => {
    const candidate = Array.isArray(input.slots) ? input.slots[id] : undefined;
    const slot: LobbySlot = {
      ...fallback, ...candidate, id,
      kind: id === 0 ? 'human' : candidate?.kind === 'ai' || candidate?.kind === 'human' ? candidate.kind : 'closed',
      country: countries.has(candidate?.country ?? '') ? candidate!.country : catalog.countries[0]?.id ?? fallback.country,
      difficulty: ['easy', 'normal', 'hard'].includes(candidate?.difficulty ?? '') ? candidate!.difficulty : 'normal',
      color: Number.isInteger(candidate?.color) ? candidate!.color : fallback.color,
      start: Number.isInteger(candidate?.start) ? candidate!.start : RANDOM,
      team: Number.isInteger(candidate?.team) && candidate!.team >= 0 && candidate!.team < 4 ? candidate!.team : RANDOM,
    };
    if (map && id >= map.maxPlayers) slot.kind = 'closed';
    if (!colors.has(slot.color) || usedColors.has(slot.color)) slot.color = RANDOM;
    if (slot.start < 0 || slot.start >= (map?.maxPlayers ?? 8) || usedStarts.has(slot.start)) slot.start = RANDOM;
    if (slot.kind !== 'closed') {
      if (slot.color !== RANDOM) usedColors.add(slot.color);
      if (slot.start !== RANDOM) usedStarts.add(slot.start);
    }
    return slot;
  });
  return result;
}
function clamp(value: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.round(value))) : fallback;
}
export function validateConfig(config: SkirmishConfig, catalog: LobbyCatalog): string | null {
  const map = catalog.maps.find(m => m.id === config.mapId);
  if (!map) return '请先选择一张地图。';
  const active = config.slots.filter(s => s.kind !== 'closed');
  if (active.length < 2) return '请至少加入一名电脑对手。';
  if (active.length > map.maxPlayers) return '当前地图没有足够的出生位置。';
  if (active.every(s => s.team >= 0 && s.team === active[0].team)) return '至少需要两个不同阵营，或把队伍设为「无」。';
  return null;
}
export function loadConfig(): SkirmishConfig {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    const config = parsed && typeof parsed === 'object' ? { ...defaultConfig(), ...parsed } : defaultConfig();
    // A persisted room is not an active connection after a reload. Restore
    // those slots as computer opponents instead of invisible absent humans.
    if (Array.isArray(config.slots)) config.slots = config.slots.map((slot, index) =>
      index > 0 && slot?.kind === 'human' ? {...slot,kind:'ai'} : slot);
    return config;
  } catch { return defaultConfig(); }
}
export function saveConfig(config: SkirmishConfig): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(config)); } catch { /* Private browsing may disable storage. */ }
}
