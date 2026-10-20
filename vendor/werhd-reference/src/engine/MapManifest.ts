import { IniFile } from '../data/IniFile';
import type { IniSection } from '../data/IniSection';
import { resolveMapDisplayTitle } from '../data/OfficialMapSimplifiedTitles';
import type { GameModeEntry } from '../game/ini/GameModes';

/** Every map is filtered by the authoritative multiplayer-mode entries. */
export type MapGameMode = GameModeEntry;
export type MapTitleLookup = StringLookup;
export type MapFileSource = { filename: string; readAsString(): string };

let __export_MapManifest: typeof i;
class i {
  fileName!: string;
  uiName!: string;
  maxSlots!: number;
  official!: boolean;
  gameModes!: MapGameMode[];
  fromIni(section: IniSection, gameModes: MapGameMode[]): this {
    return ((this.fileName = section.getString('File') || section.name.toLowerCase() + '.map'), (this.uiName = section.getString('Description')), (this.maxSlots = section.getNumber('MaxPlayers')), (this.official = !0), (this.gameModes = gameModes.filter((gameMode) => section.getArray('GameMode').includes(gameMode.mapFilter))), this);
  }
  getFullMapTitle(strings: MapTitleLookup): string {
    return resolveMapDisplayTitle(this.fileName, strings.get(this.uiName), this.maxSlots, this.uiName, this.official);
  }
  fromMapFile(file: MapFileSource, gameModes: MapGameMode[]): this {
    let text = file.readAsString();
    const fileName = file.filename;
    const basic = new IniFile(this.extractIniSection('Basic', text)).getSection('Basic');
    if (!basic) throw new Error(`Map "${fileName}" is missing the [Basic] section`);
    ((this.fileName = fileName), (this.uiName = 'NOSTR:' + (basic.getString('Name') || fileName.replace(/\.[^.]+$/, ''))));
    const waypointText = this.extractIniSection('Waypoints', text);
    const waypoints = waypointText ? new IniFile(waypointText).getSection('Waypoints') : void 0;
    ((this.maxSlots = [...(waypoints?.entries.keys() ?? [])].filter((waypoint) => Number(waypoint) < 8).length), (this.official = basic.getBool('Official')));
    const supportedModes = basic.getArray('GameMode', void 0, ['standard']);
    return ((this.gameModes = gameModes.filter((gameMode) => supportedModes.includes(gameMode.mapFilter))), this);
  }
  extractIniSection(sectionName: string, text: string): string | undefined {
    const start = text.indexOf(`[${sectionName}]`);
    if (-1 !== start) {
      let end = start + 1;
      for (; end < text.length && ('[' !== text[end] || '\n' !== text[end - 1]); end++);
      return text.slice(start, end);
    }
  }
}
__export_MapManifest = i;
export { __export_MapManifest as MapManifest };
