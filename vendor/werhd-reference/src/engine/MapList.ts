import type { IniFile } from '../data/IniFile';
import { MapManifest, type MapFileSource, type MapGameMode } from './MapManifest';
import { mapFileNamesReferToSameMap } from './rewriteCustomMapRetiredDomain';

type MapManifestInstance = InstanceType<typeof MapManifest>;
type GameModes = { getAll(): MapGameMode[] };

let __export_MapList: typeof i;
class i {
  gameModes: GameModes;
  manifests: MapManifestInstance[];
  constructor(gameModes: GameModes) { ((this.gameModes = gameModes), (this.manifests = [])); }
  addFromIni(ini: IniFile): this {
    const multiMaps = ini.getSection('MultiMaps');
    if (!multiMaps) throw new Error('Invalid map list. Missing [MultiMaps] section.');
    return ((this.manifests = this.manifests.concat([...multiMaps.entries.values()].map((mapId) => {
      const section = ini.getSection(mapId as string);
      if (!section) throw new Error(`Invalid map list. Missing [${mapId}] section.`);
      return new MapManifest().fromIni(section, this.gameModes.getAll());
    }))), this.dedupeEntries(), this);
  }
  add(manifest: MapManifestInstance): void { this.manifests.push(manifest); }
  addFromMapFile(file: MapFileSource): void { this.add(new MapManifest().fromMapFile(file, this.gameModes.getAll())); }
  getAll(): MapManifestInstance[] { return this.manifests; }
  getByName(name: string): MapManifestInstance | undefined {
    return this.manifests.find(
      (manifest) =>
        manifest.fileName.toLowerCase() === name.toLowerCase() || mapFileNamesReferToSameMap(manifest.fileName, name),
    );
  }
  sortByName(): void { this.manifests.sort((first, second) => first.fileName.localeCompare(second.fileName)); }
  clone(): i { const clone = new i(this.gameModes); return ((clone.manifests = [...this.manifests]), clone); }
  mergeWith(mapList: i): this { return (this.manifests.push(...mapList.manifests), this.dedupeEntries(), this); }
  dedupeEntries(): void { this.manifests = [...new Map(this.manifests.map((manifest) => [manifest.fileName.toLowerCase(), manifest])).values()]; }
}
__export_MapList = i;
export { __export_MapList as MapList };
