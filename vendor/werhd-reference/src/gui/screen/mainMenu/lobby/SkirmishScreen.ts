import { isRaceGameModeId } from '../../../../game/race/RaceMode';
import { Task } from '@puzzl/core/lib/async/Task';
import { OperationCanceledError, type CancellationToken } from '@puzzl/core/lib/async/cancellation';
import { ErrorHandler } from '../../../../ErrorHandler';
import { LocalPrefs, StorageKey } from '../../../../LocalPrefs';
import { MapFile } from '../../../../data/MapFile';
import { VirtualFile } from '../../../../data/vfs/VirtualFile';
import { MapDigest } from '../../../../engine/MapDigest';
import { MapManifest } from '../../../../engine/MapManifest';
import { DownloadError } from '../../../../engine/ResourceLoader';
import { MusicType } from '../../../../engine/sound/Music';
import { AiDifficulty } from '../../../../game/gameopts/GameOpts';
import * as GameOptionConstants from '../../../../game/gameopts/constants';
import type { GameModeEntry } from '../../../../game/ini/GameModes';
import { MessageBoxApi } from '../../../component/MessageBoxApi';
import type { HtmlReactElement } from '../../../HtmlReactElement';
import { HtmlViewComponent } from '../../../jsx/HtmlView';
import { jsx } from '../../../jsx/jsx';
import { RootController } from '../../RootController';
import { MainMenuRoute } from '../MainMenuRoute';
import { MainMenuScreen } from '../MainMenuScreen';
import type {
  MainMenuJsxRenderer,
  MainMenuScreenController,
  MainMenuSidebarButton,
  MainMenuStrings,
} from '../MainMenuScreenTypes';
import { ScreenType } from '../ScreenType';
import type { MapSelScreenParams, MapSelScreenResult } from '../mapSel/MapSelScreen';
import { findIndexReverse } from '../../../../util/array';
import { isNotNullOrUndefined } from '../../../../util/typeGuard';
import { CompositeDisposable } from '../../../../util/disposable/CompositeDisposable';
import { Parser, type AiPlayerOptions, type GameOptions } from '../../../../network/gameopt/Parser';
import { SlotType as GameSlotType, type MutableSlotInfo } from '../../../../network/gameopt/SlotInfo';
import { Serializer } from '../../../../network/gameopt/Serializer';
import { LobbyForm } from './component/LobbyForm';
import {
  LobbyType,
  PlayerStatus,
  SlotOccupation,
  SlotType as LobbySlotType,
  type LobbyFormProps,
  type LobbyMpDialogSettings,
  type LobbyPlayerSlot,
} from './component/viewmodel/lobby';
import { MapPreviewRenderer } from './MapPreviewRenderer';
import { PreferredHostOpts } from './PreferredHostOpts';
import { isSpecialMissionGameModeId } from '../../../../game/scenario/SpecialMission';
import { applySpecialMissionRoom } from './specialMissionRoom';
import { getSafeMapTitle } from '../../../../util/contentSafety';

type SkirmishMapManifest = InstanceType<typeof MapManifest>;
type SkirmishGameOptions = Omit<GameOptions, 'hostTeams'> & { hostTeams?: boolean };

interface SkirmishCountry {
  name: string;
  uiName: string;
  uiTooltip: string | undefined;
}

interface SkirmishColor {
  asHexString(): string;
}

type SkirmishMpDialogSettings = LobbyMpDialogSettings;

interface SkirmishRules {
  general: {
    engineerCaptureLevel: number;
    engineerDamage: number;
  };
  mpDialogSettings: SkirmishMpDialogSettings;
  getMultiplayerCountries(): SkirmishCountry[];
  getMultiplayerColors(): ReadonlyMap<string, SkirmishColor>;
}

interface SkirmishMapFileLoader {
  load(name: string, cancellation?: CancellationToken): Promise<VirtualFile>;
}

interface SkirmishMapList {
  getAll(): SkirmishMapManifest[];
  getByName(name: string): SkirmishMapManifest | undefined;
}

interface SkirmishGameModes {
  getById(id: number): GameModeEntry;
  hasId(id: number): boolean;
}

type SkirmishMapSelection = Omit<MapSelScreenResult, 'changedMapFile' | 'gameMode' | 'mapName'> & {
  changedMapFile: VirtualFile | undefined;
  gameMode: GameModeEntry;
  mapName: string;
};

export class SkirmishScreen extends MainMenuScreen<MainMenuScreenController> {
  title: string;
  musicType: unknown;
  private readonly playerName = 'Player 1';
  private readonly disposables = new CompositeDisposable();
  private currentMapFile: VirtualFile | undefined;
  private formModel: LobbyFormProps | undefined;
  private gameOpts: SkirmishGameOptions | undefined;
  private lobbyForm: HtmlReactElement<LobbyFormProps> | undefined;
  private mapTask: Task<void> | undefined;
  private slotsInfo: MutableSlotInfo[] | undefined;
  private specialMissionLock = false;
  private specialMissionBriefing: string | undefined;

  constructor(
    private readonly rootController: InstanceType<typeof RootController>,
    private readonly errorHandler: InstanceType<typeof ErrorHandler>,
    private readonly messageBoxApi: InstanceType<typeof MessageBoxApi>,
    private readonly strings: MainMenuStrings,
    private readonly rules: SkirmishRules,
    private readonly jsxRenderer: MainMenuJsxRenderer,
    private readonly mapFileLoader: SkirmishMapFileLoader,
    private readonly mapList: SkirmishMapList,
    private readonly gameModes: SkirmishGameModes,
    private readonly localPrefs: InstanceType<typeof LocalPrefs>,
  ) {
    super();
    this.title = this.strings.get('GUI:SkirmishGame');
    this.musicType = MusicType.Intro;
  }

  onEnter(): void {
    this.controller!.toggleMainVideo(false);
    this.lobbyForm = undefined;
    this.initFormModel();
    void this.createGame();
  }

  private async createGame(): Promise<void> {
    try {
      await this.initOptions();
    } catch (error) {
      this.handleError(
        error,
        error instanceof DownloadError
          ? this.strings.get('TXT_DOWNLOAD_FAILED')
          : this.strings.get('WOL:MatchErrorCreatingGame'),
      );
      return;
    }
    this.updateMapPreview();
    this.updateFormModel();
    this.controller!.toggleSidebarPreview(true);
    this.initView();
  }

  onViewportChange(): void {}

  onUnstack(result?: SkirmishMapSelection): void {
    if (result) {
      const gameOpts = this.gameOpts!;
      const slotsInfo = this.slotsInfo!;
      const gameModeChanged = result.gameMode.id !== gameOpts.gameMode;
      gameOpts.gameMode = result.gameMode.id;
      const map = this.mapList.getByName(result.mapName)!;
      const mapFile = result.changedMapFile ?? this.currentMapFile!;
      this.currentMapFile = mapFile;
      const lastUsedSlot = findIndexReverse(
        slotsInfo,
        (slot) => slot.type === GameSlotType.Ai || slot.type === GameSlotType.Player || slot.type === GameSlotType.Open,
      );
      const slotsToClose = Math.max(0, lastUsedSlot + 1 - map.maxSlots);
      for (let index = 0; index < slotsToClose; index++) {
        slotsInfo[lastUsedSlot - index].type = GameSlotType.Closed;
        gameOpts.aiPlayers[lastUsedSlot - index] = undefined;
      }
      const settings = this.getSettings(gameOpts.gameMode);
      for (const player of [...gameOpts.humanPlayers, ...gameOpts.aiPlayers]) {
        if (!player) continue;
        if (player.startPos > map.maxSlots - 1) player.startPos = GameOptionConstants.RANDOM_START_POS;
        if (gameModeChanged) player.teamId = settings.alliesAllowed && settings.mustAlly ? 0 : GameOptionConstants.NO_TEAM_ID;
      }
      this.syncSpecialMissionRoom();
      this.applyGameOption((options) => {
        options.mapName = map.fileName;
        options.mapDigest = MapDigest.compute(mapFile);
        options.mapSizeBytes = mapFile.getSize();
        options.mapTitle = getSafeMapTitle(map.getFullMapTitle(this.strings), map.official);
        options.maxSlots = this.specialMissionLock ? 1 : map.maxSlots;
        options.mapOfficial = map.official;
      });
      this.localPrefs.setItem(StorageKey.LastMap, map.fileName);
      this.localPrefs.setItem(StorageKey.LastMode, String(result.gameMode.id));
      this.saveBotSettings();
    }
    this.updateMapPreview();
    this.initView();
  }

  async onStack(): Promise<void> {
    await this.unrender();
  }

  private initView(): void {
    this.initLobbyForm();
    this.refreshSidebarButtons();
    this.refreshSidebarMpText();
    this.controller!.showSidebarButtons();
  }

  private async initOptions(): Promise<void> {
    const preferredOptions = this.localPrefs.getItem(StorageKey.PreferredGameOpts);
    const lastCountry = this.localPrefs.getItem(StorageKey.LastPlayerCountry);
    const lastColor = this.localPrefs.getItem(StorageKey.LastPlayerColor);
    const lastStartPosition = this.localPrefs.getItem(StorageKey.LastPlayerStartPos);
    const lastTeam = this.localPrefs.getItem(StorageKey.LastPlayerTeam);
    const lastMap = this.localPrefs.getItem(StorageKey.LastMap);
    const lastMode = this.localPrefs.getItem(StorageKey.LastMode);
    const lastBots = this.localPrefs.getItem(StorageKey.LastBots);
    const rememberedMap = lastMap ? this.mapList.getByName(lastMap) : undefined;
    let gameModeId = rememberedMap && lastMode && this.gameModes.hasId(Number(lastMode)) ? Number(lastMode) : 1;
    let gameMode = this.gameModes.getById(gameModeId);
    const map = rememberedMap?.gameModes.find((entry) => entry.mapFilter === gameMode.mapFilter)
      ? rememberedMap
      : (() => {
          gameModeId = 1;
          gameMode = this.gameModes.getById(gameModeId);
          return this.mapList.getAll().find((entry) => entry.gameModes.find((mode) => mode.mapFilter === gameMode.mapFilter))!;
        })();
    const mapFile = (this.currentMapFile = await this.mapFileLoader.load(map.fileName));
    const hostOptions = new PreferredHostOpts();
    if (preferredOptions) hostOptions.unserialize(preferredOptions);
    else hostOptions.applyMpDialogSettings(this.rules.mpDialogSettings);
    const settings = this.getSettings(gameModeId);
    const defaultDifficulty = AiDifficulty.Medium;
    const savedAiOptions = lastBots ? new Parser().parseAiOpts(lastBots) : undefined;
    if (savedAiOptions) this.sanitizeLastBotSettings(savedAiOptions, lastColor, lastStartPosition, map.maxSlots, settings);
    const aiPlayers: Array<AiPlayerOptions | undefined> = new Array(8).fill(undefined).map((_value, index) => {
      if (index && !(index > map.maxSlots - 1)) {
        const difficulty = 1 < index || savedAiOptions ? savedAiOptions?.[index]?.difficulty : defaultDifficulty;
        if (difficulty !== undefined) {
          return {
            countryId: savedAiOptions?.[index]?.countryId ?? GameOptionConstants.RANDOM_COUNTRY_ID,
            colorId: savedAiOptions?.[index]?.colorId ?? GameOptionConstants.RANDOM_COLOR_ID,
            startPos: savedAiOptions?.[index]?.startPos ?? GameOptionConstants.RANDOM_START_POS,
            teamId: savedAiOptions?.[index]?.teamId ?? (settings.mustAlly ? 3 : GameOptionConstants.NO_TEAM_ID),
            difficulty,
          };
        }
      }
      return undefined;
    });
    this.gameOpts = {
      gameMode: gameModeId,
      shortGame: hostOptions.shortGame,
      mcvRepacks: hostOptions.mcvRepacks,
      cratesAppear: hostOptions.cratesAppear,
      superWeapons: hostOptions.superWeapons,
      gameSpeed: hostOptions.gameSpeed,
      credits: hostOptions.credits,
      raceSettings: hostOptions.raceSettings,
      unitCount: hostOptions.unitCount,
      buildOffAlly: hostOptions.buildOffAlly,
      destroyableBridges: hostOptions.destroyableBridges,
      multiEngineer: hostOptions.multiEngineer,
      noDogEngiKills: hostOptions.noDogEngiKills,
      instantCapture: hostOptions.instantCapture,
      delayedOils: hostOptions.delayedOils,
      humanPlayers: [
        {
          name: this.playerName,
          countryId:
            lastCountry !== undefined && Number(lastCountry) < this.getAvailablePlayerCountries().length
              ? Number(lastCountry)
              : GameOptionConstants.RANDOM_COUNTRY_ID,
          colorId:
            lastColor !== undefined && Number(lastColor) < this.getAvailablePlayerColors().length
              ? Number(lastColor)
              : GameOptionConstants.RANDOM_COLOR_ID,
          startPos:
            lastStartPosition !== undefined && Number(lastStartPosition) < this.getAvailableStartPositions(map.maxSlots).length
              ? Number(lastStartPosition)
              : GameOptionConstants.RANDOM_START_POS,
          teamId:
            lastTeam !== undefined && settings.alliesAllowed && Number(lastTeam) < 4
              ? Number(lastTeam)
              : settings.mustAlly
                ? 0
                : GameOptionConstants.NO_TEAM_ID,
        },
      ],
      aiPlayers,
      mapName: map.fileName,
      mapDigest: MapDigest.compute(mapFile),
      mapSizeBytes: mapFile.getSize(),
      mapTitle: getSafeMapTitle(map.getFullMapTitle(this.strings), map.official),
      maxSlots: map.maxSlots,
      mapOfficial: map.official,
    };
    this.slotsInfo = [
      { type: GameSlotType.Player, name: this.playerName },
      ...aiPlayers.slice(1).map((player) =>
        player ? { type: GameSlotType.Ai, difficulty: player.difficulty } : { type: GameSlotType.Closed },
      ),
    ];
    this.syncSpecialMissionRoom();
  }

  private syncSpecialMissionRoom(): void {
    const gameOpts = this.gameOpts;
    const slotsInfo = this.slotsInfo;
    if (!gameOpts || !slotsInfo) {
      this.specialMissionLock = false;
      this.specialMissionBriefing = undefined;
      return;
    }
    let map: MapFile | undefined;
    if (isSpecialMissionGameModeId(gameOpts.gameMode) && this.currentMapFile) {
      try {
        map = new MapFile(this.currentMapFile);
      } catch {
        map = undefined;
      }
    }
    const result = applySpecialMissionRoom({
      gameOpts,
      slotsInfo,
      map,
      countryNames: this.getAvailablePlayerCountries(),
      colorNames: [...this.rules.getMultiplayerColors().keys()],
      strings: this.strings,
    });
    this.specialMissionLock = result.lockScenarioSlots;
    this.specialMissionBriefing = result.briefing;
  }

  private sanitizeLastBotSettings(
    bots: Array<AiPlayerOptions | undefined>,
    lastColor: string | undefined,
    lastStartPosition: string | undefined,
    maxSlots: number,
    settings: SkirmishMpDialogSettings,
  ): void {
    let botCount = 0;
    for (let index = 0; index < bots.length; index++) {
      if (bots[index]) {
        botCount++;
        if (botCount > maxSlots - 1) bots[index] = undefined;
      }
    }
    const usedColors = lastColor !== undefined ? [Number(lastColor)] : [];
    const usedStartPositions = lastStartPosition !== undefined ? [Number(lastStartPosition)] : [];
    for (const bot of bots) {
      if (!bot) continue;
      if (!GameOptionConstants.aiUiNames.has(bot.difficulty as AiDifficulty)) bot.difficulty = AiDifficulty.Easy;
      if (bot.countryId !== undefined && bot.countryId >= this.getAvailablePlayerCountries().length) {
        bot.countryId = GameOptionConstants.RANDOM_COUNTRY_ID;
      }
      if (bot.colorId !== undefined && bot.colorId !== GameOptionConstants.RANDOM_COUNTRY_ID) {
        if (bot.colorId >= this.getAvailablePlayerColors().length || usedColors.includes(bot.colorId)) {
          bot.colorId = GameOptionConstants.RANDOM_COLOR_ID;
        } else {
          usedColors.push(bot.colorId);
        }
      }
      if (bot.startPos !== undefined && bot.startPos !== GameOptionConstants.RANDOM_START_POS) {
        if (bot.startPos >= this.getAvailableStartPositions(maxSlots).length || usedStartPositions.includes(bot.startPos)) {
          bot.startPos = GameOptionConstants.RANDOM_START_POS;
        } else {
          usedStartPositions.push(bot.startPos);
        }
      }
      if (bot.teamId !== GameOptionConstants.NO_TEAM_ID) {
        if (4 <= bot.teamId || !settings.alliesAllowed) bot.teamId = settings.mustAlly ? 3 : GameOptionConstants.NO_TEAM_ID;
      } else if (settings.mustAlly) {
        bot.teamId = 3;
      }
    }
  }

  private handleError(error: unknown, message: string): void {
    this.errorHandler.handle(error, message, () => {
      this.controller?.goToScreen(ScreenType.SinglePlayer);
    });
  }

  private getSettings(gameModeId: number): SkirmishMpDialogSettings {
    return this.gameModes.getById(gameModeId).mpDialogSettings as SkirmishMpDialogSettings;
  }

  private getAvailablePlayerCountryRules(): SkirmishCountry[] {
    return this.rules.getMultiplayerCountries();
  }

  private getAvailablePlayerCountries(): string[] {
    return this.getAvailablePlayerCountryRules().map((country) => country.name);
  }

  private getAvailablePlayerColors(): string[] {
    return [...this.rules.getMultiplayerColors().values()].map((color) => color.asHexString());
  }

  private getAvailableStartPositions(maxSlots: number): number[] {
    return new Array(maxSlots).fill(0).map((_value, index) => index);
  }

  private getSelectablePlayerColors(playerSlots: ReadonlyArray<LobbyPlayerSlot | undefined>): string[] {
    const usedColors: string[] = [];
    playerSlots.forEach((slot) => {
      if (slot) usedColors.push(slot.color);
    });
    return [GameOptionConstants.RANDOM_COLOR_NAME].concat(
      this.getAvailablePlayerColors().filter((color) => color && !usedColors.includes(color)),
    );
  }

  private getSelectableStartPositions(
    playerSlots: ReadonlyArray<LobbyPlayerSlot | undefined>,
    maxSlots: number,
  ): number[] {
    const usedStartPositions: number[] = [];
    playerSlots.forEach((slot) => {
      if (slot) usedStartPositions.push(slot.startPos);
    });
    return [GameOptionConstants.RANDOM_START_POS].concat(
      this.getAvailableStartPositions(maxSlots).filter((position) => !usedStartPositions.includes(position)),
    );
  }

  private initFormModel(): void {
    const settings = this.rules.mpDialogSettings;
    const countries = this.getAvailablePlayerCountryRules();
    this.formModel = {
      strings: this.strings,
      countryUiNames: new Map<string, string>([
        [GameOptionConstants.RANDOM_COUNTRY_NAME, GameOptionConstants.RANDOM_COUNTRY_UI_NAME],
        [GameOptionConstants.OBS_COUNTRY_NAME, GameOptionConstants.OBS_COUNTRY_UI_NAME],
        ...countries.map((country) => [country.name, country.uiName] as const),
      ]),
      countryUiTooltips: new Map<string, string>([
        [GameOptionConstants.RANDOM_COUNTRY_NAME, GameOptionConstants.RANDOM_COUNTRY_UI_TOOLTIP],
        [GameOptionConstants.OBS_COUNTRY_NAME, GameOptionConstants.OBS_COUNTRY_UI_TOOLTIP],
        ...countries.flatMap((country) => (country.uiTooltip ? [[country.name, country.uiTooltip] as const] : [])),
      ]),
      availablePlayerCountries: [GameOptionConstants.RANDOM_COUNTRY_NAME].concat(this.getAvailablePlayerCountries()),
      availablePlayerColors: [],
      availableStartPositions: [],
      maxTeams: 4,
      availableAiNames: GameOptionConstants.aiUiNames,
      lobbyType: LobbyType.Singleplayer,
      mpDialogSettings: settings,
      onCountrySelect: (country, slotIndex) => {
        const slot = this.formModel!.playerSlots[slotIndex]!;
        this.updatePlayerInfo(this.getCountryIdByName(country), this.getColorIdByName(slot.color), slot.startPos, slot.team, slotIndex);
        this.updateFormModel();
      },
      onColorSelect: (color, slotIndex) => {
        const slot = this.formModel!.playerSlots[slotIndex]!;
        this.updatePlayerInfo(this.getCountryIdByName(slot.country), this.getColorIdByName(color), slot.startPos, slot.team, slotIndex);
        this.updateFormModel();
      },
      onStartPosSelect: (startPosition, slotIndex) => {
        const slot = this.formModel!.playerSlots[slotIndex]!;
        this.updatePlayerInfo(
          this.getCountryIdByName(slot.country),
          this.getColorIdByName(slot.color),
          startPosition,
          slot.team,
          slotIndex,
        );
      },
      onTeamSelect: (teamId, slotIndex) => {
        const slot = this.formModel!.playerSlots[slotIndex]!;
        this.updatePlayerInfo(
          this.getCountryIdByName(slot.country),
          this.getColorIdByName(slot.color),
          slot.startPos,
          teamId,
          slotIndex,
        );
      },
      onSlotChange: (occupation, slotIndex, difficulty) => {
        this.changeSlotType(occupation, slotIndex, difficulty);
        this.saveBotSettings();
      },
      onToggleShortGame: (enabled) => this.applyGameOption((options) => (options.shortGame = enabled)),
      onToggleMcvRepacks: (enabled) => this.applyGameOption((options) => (options.mcvRepacks = enabled)),
      onToggleCratesAppear: (enabled) => this.applyGameOption((options) => (options.cratesAppear = enabled)),
      onToggleSuperWeapons: (enabled) => this.applyGameOption((options) => (options.superWeapons = enabled)),
      onToggleBuildOffAlly: (enabled) => this.applyGameOption((options) => (options.buildOffAlly = enabled)),
      onToggleDestroyableBridges: (enabled) => this.applyGameOption((options) => (options.destroyableBridges = enabled)),
      onToggleMultiEngineer: (enabled) =>
        this.applyGameOption((options) => {
          options.multiEngineer = enabled;
          if (enabled) options.instantCapture = true;
        }),
      onToggleNoDogEngiKills: (enabled) => this.applyGameOption((options) => (options.noDogEngiKills = enabled)),
      onToggleInstantCapture: (enabled) => this.applyGameOption((options) => (options.instantCapture = enabled)),
      onToggleDelayedOils: (enabled) => this.applyGameOption((options) => (options.delayedOils = enabled)),
      onChangeGameSpeed: (value) => this.applyGameOption((options) => (options.gameSpeed = value)),
      onChangeRaceSettings: (value) => this.applyGameOption((options) => (options.raceSettings = value)),
      onChangeCredits: (value) => this.applyGameOption((options) => (options.credits = value)),
      onChangeUnitCount: (value) => this.applyGameOption((options) => (options.unitCount = value)),
      activeSlotIndex: 0,
      teamsAllowed: true,
      teamsRequired: false,
      playerSlots: [],
      shortGame: true,
      mcvRepacks: true,
      cratesAppear: true,
      superWeapons: true,
      buildOffAlly: true,
      destroyableBridges: true,
      multiEngineer: false,
      multiEngineerCount: Math.ceil((1 - this.rules.general.engineerCaptureLevel) / this.rules.general.engineerDamage) + 1,
      noDogEngiKills: false,
      instantCapture: true,
      delayedOils: false,
      gameSpeed: 6,
      credits: settings.money,
      unitCount: settings.unitCount,
      lockScenarioSlots: false,
    };
  }

  private applyGameOption(mutator: (options: SkirmishGameOptions) => void): void {
    const gameOpts = this.gameOpts!;
    mutator(gameOpts);
    this.updateFormModel();
    this.localPrefs.setItem(StorageKey.PreferredGameOpts, new PreferredHostOpts().applyGameOpts(gameOpts).serialize());
  }

  private changeSlotType(occupation: SlotOccupation, slotIndex: number, difficulty: AiDifficulty | undefined): void {
    const gameOpts = this.gameOpts!;
    if (slotIndex === 0) throw new Error('Change slot type of host');
    if (occupation === SlotOccupation.Occupied && difficulty !== undefined) {
      const settings = this.getSettings(gameOpts.gameMode);
      const slot = this.slotsInfo![slotIndex]!;
      slot.type = GameSlotType.Ai;
      slot.difficulty = difficulty;
      gameOpts.aiPlayers[slotIndex] ??= {
        difficulty,
        countryId: GameOptionConstants.RANDOM_COUNTRY_ID,
        colorId: GameOptionConstants.RANDOM_COLOR_ID,
        startPos: GameOptionConstants.RANDOM_START_POS,
        teamId: settings.mustAlly ? 3 : GameOptionConstants.NO_TEAM_ID,
      };
      gameOpts.aiPlayers[slotIndex]!.difficulty = difficulty;
    }
    if (occupation === SlotOccupation.Closed) {
      this.slotsInfo![slotIndex]!.type = GameSlotType.Closed;
      gameOpts.aiPlayers[slotIndex] = undefined;
    }
    this.updateFormModel();
  }

  private saveBotSettings(): void {
    this.localPrefs.setItem(StorageKey.LastBots, new Serializer().serializeAiOpts(this.gameOpts!.aiPlayers));
  }

  private getCountryNameById(countryId: number): string {
    if (countryId === GameOptionConstants.RANDOM_COUNTRY_ID) return GameOptionConstants.RANDOM_COUNTRY_NAME;
    if (countryId === GameOptionConstants.OBS_COUNTRY_ID) return GameOptionConstants.OBS_COUNTRY_NAME;
    return this.getAvailablePlayerCountries()[countryId];
  }

  private getCountryIdByName(country: string): number {
    if (country === GameOptionConstants.RANDOM_COUNTRY_NAME) return GameOptionConstants.RANDOM_COUNTRY_ID;
    if (country === GameOptionConstants.OBS_COUNTRY_NAME) return GameOptionConstants.OBS_COUNTRY_ID;
    return this.getAvailablePlayerCountries().indexOf(country);
  }

  private getColorNameById(colorId: number): string {
    return colorId === GameOptionConstants.RANDOM_COLOR_ID
      ? GameOptionConstants.RANDOM_COLOR_NAME
      : this.getAvailablePlayerColors()[colorId];
  }

  private getColorIdByName(color: string): number {
    if (color === GameOptionConstants.RANDOM_COLOR_NAME) return GameOptionConstants.RANDOM_COLOR_ID;
    const colorId = this.getAvailablePlayerColors().indexOf(color);
    if (colorId === -1) throw new Error(`Color ${color} not found in available player colors`);
    return colorId;
  }

  private updatePlayerInfo(countryId: number, colorId: number, startPos: number, teamId: number, slotIndex: number): void {
    const gameOpts = this.gameOpts!;
    const slot = this.slotsInfo![slotIndex]!;
    if (slot.type === GameSlotType.Ai) {
      const aiPlayer = gameOpts.aiPlayers[slotIndex];
      if (!aiPlayer) throw new Error('No AI found on slot ' + slotIndex);
      aiPlayer.countryId = countryId;
      aiPlayer.colorId = colorId;
      aiPlayer.startPos = startPos;
      aiPlayer.teamId = teamId;
      this.saveBotSettings();
    } else {
      if (slot.type !== GameSlotType.Player) throw new Error('Unexpected slot type ' + slot.type);
      const humanPlayer = gameOpts.humanPlayers.find((player) => player.name === slot.name);
      if (!humanPlayer) throw new Error('No player found on slot ' + slotIndex);
      humanPlayer.countryId = countryId;
      humanPlayer.colorId = colorId;
      humanPlayer.startPos = startPos;
      humanPlayer.teamId = teamId;
      if (countryId !== GameOptionConstants.RANDOM_COUNTRY_ID) {
        this.localPrefs.setItem(StorageKey.LastPlayerCountry, String(countryId));
      } else {
        this.localPrefs.removeItem(StorageKey.LastPlayerCountry);
      }
      if (colorId !== GameOptionConstants.RANDOM_COLOR_ID) {
        this.localPrefs.setItem(StorageKey.LastPlayerColor, String(colorId));
      } else {
        this.localPrefs.removeItem(StorageKey.LastPlayerColor);
      }
      if (startPos !== GameOptionConstants.RANDOM_START_POS) {
        this.localPrefs.setItem(StorageKey.LastPlayerStartPos, String(startPos));
      } else {
        this.localPrefs.removeItem(StorageKey.LastPlayerStartPos);
      }
      if (teamId !== GameOptionConstants.NO_TEAM_ID) {
        this.localPrefs.setItem(StorageKey.LastPlayerTeam, String(teamId));
      } else {
        this.localPrefs.removeItem(StorageKey.LastPlayerTeam);
      }
    }
    this.updateFormModel();
  }

  private updateFormModel(): void {
    const gameOpts = this.gameOpts!;
    const form = this.formModel!;
    const slotsInfo = this.slotsInfo!;
    form.gameSpeed = gameOpts.gameSpeed;
    form.credits = gameOpts.credits;
    form.raceSettings = gameOpts.raceSettings;
    form.unitCount = gameOpts.unitCount;
    form.shortGame = gameOpts.shortGame;
    form.superWeapons = gameOpts.superWeapons;
    form.buildOffAlly = gameOpts.buildOffAlly;
    form.mcvRepacks = gameOpts.mcvRepacks;
    form.cratesAppear = gameOpts.cratesAppear;
    form.destroyableBridges = gameOpts.destroyableBridges;
    form.multiEngineer = gameOpts.multiEngineer;
    form.noDogEngiKills = gameOpts.noDogEngiKills;
    form.instantCapture = gameOpts.instantCapture;
    form.delayedOils = gameOpts.delayedOils;
    let remainingSlots = gameOpts.maxSlots;
    slotsInfo.forEach((_slotInfo, index) => {
      if (remainingSlots) {
        remainingSlots--;
        form.playerSlots[index] = {
          country: GameOptionConstants.RANDOM_COUNTRY_NAME,
          color: GameOptionConstants.RANDOM_COLOR_NAME,
          startPos: GameOptionConstants.RANDOM_START_POS,
          team: GameOptionConstants.NO_TEAM_ID,
        };
      } else {
        form.playerSlots[index] = undefined;
      }
    });
    slotsInfo.forEach((slotInfo, index) => {
      const formSlot = form.playerSlots[index];
      if (!formSlot) return;
      formSlot.occupation =
        slotInfo.type === GameSlotType.Closed
          ? SlotOccupation.Closed
          : slotInfo.type === GameSlotType.Open || slotInfo.type === GameSlotType.OpenObserver
            ? SlotOccupation.Open
            : SlotOccupation.Occupied;
      if (slotInfo.type === GameSlotType.Ai) {
        formSlot.aiDifficulty = slotInfo.difficulty;
        formSlot.type = LobbySlotType.Ai;
      } else if (slotInfo.type === GameSlotType.Player) {
        formSlot.name = slotInfo.name;
        formSlot.type = LobbySlotType.Player;
      }
      formSlot.status = PlayerStatus.NotReady;
    });
    form.raceMode = isRaceGameModeId(gameOpts.gameMode);
    const humanPlayers = gameOpts.humanPlayers;
    const aiPlayers = gameOpts.aiPlayers;
    const settings = this.getSettings(gameOpts.gameMode);
    form.playerSlots.forEach((formSlot, index) => {
      if (!formSlot || !humanPlayers.length) return;
      if (formSlot.occupation === SlotOccupation.Occupied) {
        const humanPlayer = humanPlayers.find((player) => player.name === formSlot.name);
        if (humanPlayer) {
          formSlot.country = this.getCountryNameById(humanPlayer.countryId);
          formSlot.color = this.getColorNameById(humanPlayer.colorId);
          formSlot.startPos = humanPlayer.startPos;
          formSlot.team = humanPlayer.teamId;
        } else {
          const aiPlayer = aiPlayers[index];
          if (aiPlayer) {
            formSlot.country = this.getCountryNameById(aiPlayer.countryId);
            formSlot.color = this.getColorNameById(aiPlayer.colorId);
            formSlot.startPos = aiPlayer.startPos;
            formSlot.team = aiPlayer.teamId;
          }
        }
      } else {
        formSlot.country = GameOptionConstants.RANDOM_COUNTRY_NAME;
        formSlot.team = settings.mustAlly ? 3 : GameOptionConstants.NO_TEAM_ID;
      }
    });
    form.availablePlayerColors = this.getSelectablePlayerColors(form.playerSlots);
    form.availableStartPositions = this.getSelectableStartPositions(form.playerSlots, gameOpts.maxSlots);
    form.teamsAllowed = settings.alliesAllowed;
    form.teamsRequired = settings.mustAlly;
    form.lockScenarioSlots = this.specialMissionLock;
    if (this.lobbyForm && humanPlayers.length) this.lobbyForm.refresh();
  }

  private updateMapPreview(): void {
    this.mapTask?.cancel();
    this.mapTask = new Task<void>(async (cancellation) => {
      if (this.controller) {
        this.controller.setSidebarPreview();
        let map: MapFile;
        let file: VirtualFile;
        try {
          file = await this.mapFileLoader.load(this.gameOpts!.mapName, cancellation);
          map = new MapFile(file);
        } catch (error) {
          if (error instanceof DownloadError) {
            this.handleError(error, this.strings.get('TXT_DOWNLOAD_FAILED'));
            return;
          }
          throw error;
        }
        const preview = new MapPreviewRenderer(this.strings).render(
          map,
          LobbyType.Singleplayer,
          this.controller.getSidebarPreviewSize(),
          file.filename,
        );
        this.controller.setSidebarPreview(preview);
      }
    });
    this.mapTask.start().catch((error) => {
      if (!(error instanceof OperationCanceledError)) {
        console.error('Failed to render map preview');
        console.error(error);
      }
    });
    this.disposables.add(
      () => this.mapTask?.cancel(),
      () => (this.mapTask = undefined),
    );
  }

  private initLobbyForm(): void {
    const [element] = this.jsxRenderer.render(
      jsx(HtmlViewComponent, {
        innerRef: (form: HtmlReactElement<LobbyFormProps>) => (this.lobbyForm = form),
        component: LobbyForm,
        props: this.formModel!,
      }),
    );
    this.controller!.setMainComponent(element);
  }

  private refreshSidebarButtons(): void {
    const buttons: MainMenuSidebarButton[] = [
      {
        label: this.strings.get('GUI:StartGame'),
        tooltip: this.strings.get('STT:SkirmishButtonStartGame'),
        disabled: false,
        onClick: () => {
          const gameOpts = this.gameOpts!;
          if (!isSpecialMissionGameModeId(gameOpts.gameMode) && !isRaceGameModeId(gameOpts.gameMode) && gameOpts.aiPlayers.filter(isNotNullOrUndefined).length < 1) {
            this.messageBoxApi.show(this.strings.get('TXT_NEED_AT_LEAST_TWO_PLAYERS'), this.strings.get('GUI:Ok'));
          } else if (this.meetsMinimumTeams()) {
            this.rootController.createGame(
              '0',
              Date.now(),
              undefined,
              this.playerName,
              gameOpts as GameOptions,
              true,
              false,
              false,
              false,
              new MainMenuRoute(ScreenType.Skirmish),
            );
          } else {
            this.messageBoxApi.show(this.strings.get('TXT_CANNOT_ALLY'), this.strings.get('GUI:Ok'));
          }
        },
      },
      {
        label: this.strings.get('GUI:ChooseMap'),
        tooltip: this.strings.get('STT:SkirmishButtonChooseMap'),
        onClick: () => {
          const gameOpts = this.gameOpts!;
          const params: MapSelScreenParams = {
            lobbyType: LobbyType.Singleplayer,
            gameOpts,
            usedSlots: () =>
              1 +
              findIndexReverse(
                this.slotsInfo!,
                (slot) => slot.type === GameSlotType.Ai || slot.type === GameSlotType.Player,
              ),
          };
          this.controller?.pushScreen(ScreenType.MapSelection, params);
        },
      },
      {
        label: this.strings.get('GUI:Back'),
        tooltip: this.strings.get('STT:SkirmishButtonBack'),
        isBottom: true,
        onClick: () => this.controller?.goToScreen(ScreenType.SinglePlayer),
      },
    ];
    this.controller!.setSidebarButtons(buttons, true);
    this.refreshSidebarMpText();
  }

  private meetsMinimumTeams(): boolean {
    const players = [...this.gameOpts!.humanPlayers, ...this.gameOpts!.aiPlayers]
      .filter(isNotNullOrUndefined)
      .filter((player) => player.countryId !== GameOptionConstants.OBS_COUNTRY_ID);
    const firstTeam = players[0].teamId;
    return firstTeam === GameOptionConstants.NO_TEAM_ID || players.some((player) => player.teamId !== firstTeam);
  }

  private refreshSidebarMpText(): void {
    const gameOpts = this.gameOpts;
    this.controller?.setSidebarMpContent({
      text: gameOpts
        ? this.strings.get(this.gameModes.getById(gameOpts.gameMode).label) +
          '\n\n' +
          getSafeMapTitle(gameOpts.mapTitle, gameOpts.mapOfficial) +
          (this.specialMissionBriefing ? '\n\n' + this.specialMissionBriefing : '')
        : '',
    });
  }

  async onLeave(): Promise<void> {
    this.disposables.dispose();
    this.gameOpts = undefined;
    this.slotsInfo = undefined;
    this.currentMapFile = undefined;
    this.controller!.toggleSidebarPreview(false);
    await this.unrender();
  }

  private async unrender(): Promise<void> {
    await this.controller!.hideSidebarButtons();
    if (this.lobbyForm) this.lobbyForm = undefined;
  }
}
