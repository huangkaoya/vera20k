import type { GameOptions } from '../../../../network/gameopt/Parser';
import { resolveRaceSettings, type RaceSettings } from '../../../../game/race/RaceSettings';

type PreferredHostGameOptions = Pick<
  GameOptions,
  | 'gameSpeed'
  | 'credits'
  | 'unitCount'
  | 'shortGame'
  | 'superWeapons'
  | 'buildOffAlly'
  | 'mcvRepacks'
  | 'cratesAppear'
  | 'destroyableBridges'
  | 'multiEngineer'
  | 'noDogEngiKills'
  | 'instantCapture'
  | 'delayedOils'
> & {
  hostTeams?: boolean;
  raceSettings?: RaceSettings;
};

type PreferredHostMpDialogSettings = {
  gameSpeed: number;
  money: number;
  unitCount: number;
  shortGame: boolean;
  mcvRedeploys: boolean;
  crates: boolean;
  superWeapons: boolean;
  bridgeDestruction: boolean;
  multiEngineer: boolean;
};

let __export_PreferredHostOpts: typeof i;
class i {
  gameSpeed: number;
  credits: number;
  unitCount: number;
  shortGame: boolean;
  superWeapons: boolean;
  buildOffAlly: boolean;
  mcvRepacks: boolean;
  cratesAppear: boolean;
  hostTeams: boolean;
  destroyableBridges: boolean;
  multiEngineer: boolean;
  noDogEngiKills: boolean;
  instantCapture: boolean;
  delayedOils: boolean;
  slotsClosed: Set<number>;
  raceSettings: RaceSettings = resolveRaceSettings();

  constructor() {
    ((this.gameSpeed = 6),
      (this.credits = 1e4),
      (this.unitCount = 10),
      (this.shortGame = !0),
      (this.superWeapons = !1),
      (this.buildOffAlly = !0),
      (this.mcvRepacks = !0),
      (this.cratesAppear = !1),
      (this.hostTeams = !1),
      (this.destroyableBridges = !0),
      (this.multiEngineer = !1),
      (this.noDogEngiKills = !1),
      (this.instantCapture = !0),
      (this.delayedOils = !1),
      (this.slotsClosed = new Set()));
  }
  serialize(): string {
    return [
      this.gameSpeed,
      this.credits,
      this.unitCount,
      Number(this.shortGame),
      Number(this.superWeapons),
      Number(this.buildOffAlly),
      Number(this.mcvRepacks),
      Number(this.cratesAppear),
      [...this.slotsClosed].join(','),
      Number(this.hostTeams),
      Number(this.destroyableBridges),
      Number(this.multiEngineer),
      Number(this.noDogEngiKills),
      Number(this.instantCapture),
      Number(this.delayedOils),
      `${this.raceSettings.laps}/${this.raceSettings.respawnSeconds}/${this.raceSettings.crateSeconds}`,
    ].join(';');
  }
  unserialize(e: string): this {
    const race = e.split(';')[15];
    if (race) {
      const [laps, respawnSeconds, crateSeconds] = race.split('/').map(Number);
      this.raceSettings = resolveRaceSettings({ laps, respawnSeconds, crateSeconds });
    }
    const [t, i, r, s, a, n, o, l, c, h, u = '1', d, g, p = '1', m = '0'] = e.split(';');
    return (
      (this.gameSpeed = Number(t)),
      (this.credits = Number(i)),
      (this.unitCount = Number(r)),
      (this.shortGame = Boolean(Number(s))),
      (this.superWeapons = Boolean(Number(a))),
      (this.buildOffAlly = Boolean(Number(n))),
      (this.mcvRepacks = Boolean(Number(o))),
      (this.cratesAppear = Boolean(Number(l))),
      (this.hostTeams = Boolean(Number(h))),
      (this.destroyableBridges = Boolean(Number(u))),
      (this.multiEngineer = Boolean(Number(d))),
      (this.noDogEngiKills = Boolean(Number(g))),
      (this.instantCapture = Boolean(Number(p))),
      (this.delayedOils = Boolean(Number(m))),
      (this.slotsClosed = new Set(c ? c.split(',').map((e) => Number(e)) : [])),
      this
    );
  }
  applyGameOpts(e: PreferredHostGameOptions): this {
    if (e.raceSettings) this.raceSettings = resolveRaceSettings(e.raceSettings);
    return (
      (this.gameSpeed = e.gameSpeed),
      (this.credits = e.credits),
      (this.unitCount = e.unitCount),
      (this.shortGame = e.shortGame),
      (this.superWeapons = e.superWeapons),
      (this.buildOffAlly = e.buildOffAlly),
      (this.mcvRepacks = e.mcvRepacks),
      (this.cratesAppear = e.cratesAppear),
      (this.hostTeams = !!e.hostTeams),
      (this.destroyableBridges = e.destroyableBridges),
      (this.multiEngineer = e.multiEngineer),
      (this.noDogEngiKills = e.noDogEngiKills),
      (this.instantCapture = e.instantCapture),
      (this.delayedOils = e.delayedOils),
      this
    );
  }
  applyMpDialogSettings(e: PreferredHostMpDialogSettings): this {
    return (
      (this.gameSpeed = 6 - e.gameSpeed!),
      (this.credits = e.money),
      (this.unitCount = e.unitCount),
      (this.shortGame = e.shortGame),
      (this.mcvRepacks = e.mcvRedeploys),
      (this.cratesAppear = e.crates),
      (this.superWeapons = e.superWeapons),
      (this.destroyableBridges = e.bridgeDestruction),
      (this.multiEngineer = e.multiEngineer),
      this
    );
  }
}
__export_PreferredHostOpts = i;
export { __export_PreferredHostOpts as PreferredHostOpts };
