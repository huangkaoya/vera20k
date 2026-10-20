import * as DataStreamModule from '../../data/DataStream';
import { resolveMapDisplayTitle } from '../../data/OfficialMapSimplifiedTitles';
import { getSafeMapTitle } from '../../util/contentSafety';
import { registerDisplayNamesFromPayload } from '../../util/nicknameCodec';
import * as gameOpts from '../../game/gameopts/GameOpts';
import * as Base64Module from '../../util/Base64';
import * as stringUtil from '../../util/string';
import { FileNameEncoder } from './FileNameEncoder';
import { MapNameLegacyEncoder } from './MapNameLegacyEncoder';
import type { PingInfo } from './PingInfo';
import type { SlotInfo } from './SlotInfo';
import { SlotType } from './SlotInfo';
import type { WolGameTopic } from './WolGameTopic';
import type { PlayerActionPayload } from '../gamestate/PlayerActionPayload';
import type { CampaignDifficulty } from '../../game/campaign/CampaignMission';
import { resolveRaceSettings, type RaceSettings } from '../../game/race/RaceSettings';
import { isRaceGameModeId } from '../../game/race/RaceMode';

type DataStreamReader = {
  readUint8(): number;
  readUint16(endian?: number): number;
  readUint8Array(byteLength: number): Uint8Array;
};

const DataStream: {
  new (data?: Uint8Array): DataStreamReader;
} = DataStreamModule.DataStream;
const AiDifficulty: {
  Easy: number;
  Medium: number;
  MediumSea: number;
  Advanced: number;
  Brutal: number;
} = gameOpts.AiDifficulty;
const Base64: {
  decode(value: string): string;
  isBase64(value: string): boolean;
} = Base64Module.Base64;
const binaryStringToUtf16: (value: string) => string = stringUtil.binaryStringToUtf16;
const uint8ArrayToBinaryString: (value: Uint8Array) => string = stringUtil.uint8ArrayToBinaryString;

export interface PlayerOptions {
  name: string;
  countryId: number;
  colorId: number;
  startPos: number;
  teamId: number;
}

export interface AiPlayerOptions {
  difficulty: number;
  countryId: number;
  colorId: number;
  startPos: number;
  teamId: number;
}

export interface GameOptions {
  gameSpeed: number;
  credits: number;
  unitCount: number;
  shortGame: boolean;
  superWeapons: boolean;
  buildOffAlly: boolean;
  mcvRepacks: boolean;
  cratesAppear: boolean;
  gameMode: number;
  hostTeams: boolean;
  mapTitle: string;
  maxSlots: number;
  mapOfficial: boolean;
  mapSizeBytes: number;
  mapName: string;
  mapDigest: string;
  destroyableBridges: boolean;
  multiEngineer: boolean;
  noDogEngiKills: boolean;
  instantCapture: boolean;
  delayedOils: boolean;
  ranked?: boolean;
  raceSettings?: RaceSettings;
  campaignId?: string;
  campaignDifficulty?: CampaignDifficulty;
  unknown?: string;
  humanPlayers: PlayerOptions[];
  aiPlayers: Array<AiPlayerOptions | undefined>;
}

export class Parser {
  parseOptions(data: string): GameOptions {
    const options = {} as GameOptions;
    const [gameData, playerData, , aiData] = data.split(':');
    const parts = gameData.split(',');

    parts.shift();
    parts.shift();
    options.gameSpeed = 6 - Number(parts.shift());
    options.credits = Number(parts.shift());
    options.unitCount = Number(parts.shift());
    options.shortGame = Boolean(Number(parts.shift()));
    options.superWeapons = Boolean(Number(parts.shift()));
    options.buildOffAlly = Boolean(Number(parts.shift()));
    options.mcvRepacks = Boolean(Number(parts.shift()));
    options.cratesAppear = Boolean(Number(parts.shift()));
    options.gameMode = Number(parts.shift());
    options.hostTeams = Boolean(Number(parts.shift()));

    const encodedMapTitle = parts.shift() ?? '';
    const wireMapTitle = Base64.isBase64(encodedMapTitle)
      ? binaryStringToUtf16(Base64.decode(encodedMapTitle))
      : new MapNameLegacyEncoder().decode(encodedMapTitle);
    options.maxSlots = Number(parts.shift());
    options.mapOfficial = Boolean(Number(parts.shift()));
    options.mapSizeBytes = Number(parts.shift());
    options.mapName = new FileNameEncoder().decode(parts.shift() ?? '');
    options.mapDigest = parts.shift() ?? '';
    options.mapTitle = getSafeMapTitle(
      resolveMapDisplayTitle(options.mapName, wireMapTitle, options.maxSlots, undefined, options.mapOfficial),
      options.mapOfficial,
    );
    options.destroyableBridges = Boolean(Number(parts.shift() ?? '1'));
    options.multiEngineer = Boolean(Number(parts.shift() ?? '0'));
    options.noDogEngiKills = Boolean(Number(parts.shift() ?? '0'));
    options.instantCapture = Boolean(Number(parts.shift() ?? '1'));
    options.delayedOils = Boolean(Number(parts.shift() ?? '0'));
    options.ranked = parts.includes('RA2WEB_RANKED=1');
    const race = parts.find(part => part.startsWith('RA2WEB_RACE='));
    if (isRaceGameModeId(options.gameMode) && race) {
      const [laps, respawnSeconds, crateSeconds] = race.slice('RA2WEB_RACE='.length).split('/').map(Number);
      options.raceSettings = resolveRaceSettings({ laps, respawnSeconds, crateSeconds });
    }
    options.campaignId = parts.find((part) => part.startsWith('RA2WEB_CAMPAIGN='))?.slice('RA2WEB_CAMPAIGN='.length);
    const campaignDifficulty = parts
      .find((part) => part.startsWith('RA2WEB_CAMPAIGN_DIFFICULTY='))
      ?.slice('RA2WEB_CAMPAIGN_DIFFICULTY='.length);
    if (campaignDifficulty === 'easy' || campaignDifficulty === 'medium' || campaignDifficulty === 'hard') {
      options.campaignDifficulty = campaignDifficulty;
    }
    const displayNamesTag = parts.find((part) => part.startsWith('RA2WEB_DN='))?.slice('RA2WEB_DN='.length);
    if (displayNamesTag && Base64.isBase64(displayNamesTag)) {
      try {
        const parsedDn = JSON.parse(binaryStringToUtf16(Base64.decode(displayNamesTag))) as Record<string, string>;
        registerDisplayNamesFromPayload(parsedDn);
      } catch {}
    }
    const unknownParts = parts.filter((part) =>
      part !== 'RA2WEB_RANKED=1' &&
      !part.startsWith('RA2WEB_RACE=') &&
      !part.startsWith('RA2WEB_CAMPAIGN=') &&
      !part.startsWith('RA2WEB_CAMPAIGN_DIFFICULTY=') &&
      !part.startsWith('RA2WEB_DN='));
    options.unknown = unknownParts.length ? unknownParts.join(',') : undefined;
    options.humanPlayers = this.parsePlayerOpts(playerData);
    options.aiPlayers = this.parseAiOpts(aiData?.slice(0, -1));

    return options;
  }

  parsePlayerOpts(data: string): PlayerOptions[] {
    const parts = data.split(',');
    if (parts.length % 8 !== 0) throw new Error("Couldn't parse gameopt: unexpected players data length " + parts.length);

    const players: PlayerOptions[] = [];
    for (let index = 0, count = Math.floor(parts.length / 8); index < count; ++index) {
      players.push({
        name: parts[8 * index],
        countryId: Number(parts[8 * index + 1]),
        colorId: Number(parts[8 * index + 2]),
        startPos: Number(parts[8 * index + 3]),
        teamId: Number(parts[8 * index + 4]),
      });
    }
    return players;
  }

  parseAiOpts(data?: string): Array<AiPlayerOptions | undefined> {
    const players: Array<AiPlayerOptions | undefined> = [];
    if (!data) return players;

    const parts = data.split(',');
    if (parts.length % 5 !== 0) throw new Error("Couldn't parse gameopt: unexpected ai data length " + parts.length);

    for (let index = 0, count = Math.floor(parts.length / 5); index < count; ++index) {
      const player = {
        difficulty: Number(parts[5 * index]),
        countryId: Number(parts[5 * index + 1]),
        colorId: Number(parts[5 * index + 2]),
        startPos: Number(parts[5 * index + 3]),
        teamId: Number(parts[5 * index + 4]),
      };
      players.push(player.countryId !== -1 ? player : undefined);
    }
    return players;
  }

  parseTopic(data: string): WolGameTopic | undefined {
    const parts = data.split(',');
    if (parts.length < 6) return undefined;

    const flags = parts[0];
    return {
      description: parts[6] ? binaryStringToUtf16(Base64.decode(parts[6])) : '',
      modHash: Number(parts[1]),
      modName: parts[7] ? binaryStringToUtf16(Base64.decode(parts[7])) : undefined,
      aiPlayers: Number(parts[2]),
      maxPlayers: Number(flags[2]),
      observers: Number(parts[3]),
      observable: Boolean(Number(parts[4])),
      mapName: new FileNameEncoder().decode(parts[5]),
    };
  }

  parsePingData(data: string): PingInfo[] {
    const parts = data.split(',').slice(1);
    if (parts.length % 2) throw new Error("Couldn't parse gameopt: unexpected ping data length " + parts.length);

    const pings: PingInfo[] = [];
    for (let index = 0, count = Math.floor(parts.length / 2); index < count; ++index) {
      pings.push({
        playerName: parts[2 * index],
        ping: Number(parts[2 * index + 1]),
      });
    }
    return pings;
  }

  parseSlotData(data: string): SlotInfo[] {
    const slots: SlotInfo[] = [];
    for (const slotData of data.slice(1, -1).split(',')) {
      if (slotData === '@Closed@') slots.push({ type: SlotType.Closed });
      else if (slotData === '@Open@') slots.push({ type: SlotType.Open });
      else if (slotData === '@OpenObserver@') slots.push({ type: SlotType.OpenObserver });
      else if (['@EasyAI@', '@MediumAI@', '@HardAI@', '@MediumSeaAI@', '@AdvancedAI@'].includes(slotData)) {
        let difficulty: number;
        if (slotData === '@EasyAI@') difficulty = AiDifficulty.Easy;
        else if (slotData === '@MediumAI@') difficulty = AiDifficulty.Medium;
        else if (slotData === '@MediumSeaAI@') difficulty = AiDifficulty.MediumSea;
        else if (slotData === '@AdvancedAI@') difficulty = AiDifficulty.Advanced;
        else if (slotData === '@HardAI@') difficulty = AiDifficulty.Brutal;
        else throw new Error("Couldn't parse gameopt: unknown slot type " + slotData);
        slots.push({ type: SlotType.Ai, difficulty });
      } else {
        slots.push({ type: SlotType.Player, name: slotData });
      }
    }
    return slots;
  }

  parsePlayerActions(data: Uint8Array): PlayerActionPayload[] {
    const stream = new DataStream(data);
    const actionCount = stream.readUint8();
    const actions: PlayerActionPayload[] = [];

    for (let index = 0; index < actionCount; ++index) {
      const id = stream.readUint8();
      const payloadLength = stream.readUint16();
      actions.push({
        id,
        params: payloadLength > 0 ? stream.readUint8Array(payloadLength) : new Uint8Array(),
      });
    }
    return actions;
  }

  parseAllPlayerActions(stream: DataStreamReader): Map<number, PlayerActionPayload[]> {
    const playerCount = stream.readUint8();
    const actions = new Map<number, PlayerActionPayload[]>();

    for (let index = 0; index < playerCount; ++index) {
      const playerId = stream.readUint8();
      const payloadLength = stream.readUint16();
      const payload = payloadLength > 0 ? stream.readUint8Array(payloadLength) : new Uint8Array();
      actions.set(playerId, this.parsePlayerActions(payload));
    }
    return actions;
  }

  parseMapData(data: Uint8Array): string {
    return uint8ArrayToBinaryString(data);
  }
}
