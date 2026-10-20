import type { SkirmishConfig } from '../ui/types';
import type { VeraConfig } from './types';

/** Resolve presentation sentinels once, before every peer receives the same setup. */
export function engineConfig(config: SkirmishConfig, viewPlayer = 0): VeraConfig {
  const active = config.slots.filter(slot => slot.kind !== 'closed');
  const used = new Set(active.filter(s => s.color >= 0).map(s => s.color));
  const free = Array.from({length:8}, (_, i) => i).filter(i => !used.has(i));
  let state = config.seed >>> 0;
  const random = (n: number) => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % n; };
  return {
    map:config.mapId, seed:config.seed, localPlayer:0, viewPlayer,
    players:active.map(slot => ({
      slot:slot.id, name:slot.kind === 'human' ? (slot.id === 0 ? config.playerName : slot.name || `玩家 ${slot.id + 1}`) : `电脑 ${slot.id + 1}`,
      country:slot.country, color:slot.color >= 0 ? slot.color : free.splice(random(free.length), 1)[0],
      start:slot.start < 0 ? -1 : slot.start, team:slot.team < 0 ? 0 : slot.team + 1,
      human:slot.kind === 'human', difficulty:slot.difficulty,
    })),
    options:{credits:config.credits,unitCount:config.unitCount,gameSpeed:config.gameSpeed,
      shortGame:config.shortGame,superWeapons:config.superWeapons,crates:config.cratesAppear,
      mcvRepacks:config.mcvRepacks,buildOffAlly:config.buildOffAlly,destroyableBridges:true},
  };
}
