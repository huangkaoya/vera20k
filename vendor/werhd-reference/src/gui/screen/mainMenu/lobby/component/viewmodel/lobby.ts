import type { AiDifficulty } from '../../../../../../game/gameopts/GameOpts';
import type { MainMenuStrings } from '../../../MainMenuScreenTypes';
import type { ChatDisplayMessage } from '../../../../../component/Chat';
import type { ChatInputProps } from '../../../../../component/ChatInput';
import type { ChatHistory } from '../../../../../chat/ChatHistory';
import type { RankIndicatorPlayer } from '../RankIndicator';

export enum LobbyType {
  Singleplayer = 0,
  MultiplayerHost = 1,
  MultiplayerGuest = 2,
}

export enum SlotType {
  Player = 1,
  Ai = 2,
  Observer = 3,
}

export enum SlotOccupation {
  Open = 1,
  Closed = 2,
  Occupied = 3,
}

export enum PlayerStatus {
  NotReady = 1,
  Ready = 2,
  Host = 3,
}

/**
 * Shared view model for a visible lobby row.  A row can represent a human,
 * an AI, an observer, or an open/closed slot; the optional fields therefore
 * describe the currently assigned occupant rather than every possible slot.
 */
export interface LobbyPlayerSlot {
  country: string;
  color: string;
  startPos: number;
  team: number;
  occupation?: SlotOccupation;
  status?: PlayerStatus;
  type?: SlotType;
  aiDifficulty?: AiDifficulty;
  name?: string;
  ping?: number;
  playerProfile?: RankIndicatorPlayer;
}

export interface LobbyMpDialogSettings {
  alliesAllowed: boolean;
  bridgeDestruction: boolean;
  crates: boolean;
  gameSpeed: number;
  maxMoney: number;
  maxUnitCount: number;
  mcvRedeploys: boolean;
  minMoney: number;
  minUnitCount: number;
  money: number;
  moneyIncrement: number;
  multiEngineer: boolean;
  mustAlly: boolean;
  shortGame: boolean;
  superWeapons: boolean;
  unitCount: number;
}

export interface LobbyFormProps {
  raceMode?: boolean;
  raceSettings?: import('../../../../../../game/race/RaceSettings').RaceSettings;
  onChangeRaceSettings?(value: import('../../../../../../game/race/RaceSettings').RaceSettings): void;
  strings: MainMenuStrings;
  countryUiNames: ReadonlyMap<string, string>;
  countryUiTooltips: ReadonlyMap<string, string>;
  availablePlayerCountries: string[];
  availablePlayerColors: string[];
  availableStartPositions: number[];
  maxTeams: number;
  availableAiNames: ReadonlyMap<AiDifficulty, string>;
  lobbyType: LobbyType;
  mpDialogSettings: LobbyMpDialogSettings;
  onCountrySelect(country: string, slotIndex: number): void;
  onColorSelect(color: string, slotIndex: number): void;
  onStartPosSelect(startPosition: number, slotIndex: number): void;
  onTeamSelect(teamId: number, slotIndex: number): void;
  onSlotChange(occupation: SlotOccupation, slotIndex: number, difficulty?: AiDifficulty): void;
  onToggleShortGame(enabled: boolean): void;
  onToggleMcvRepacks(enabled: boolean): void;
  onToggleCratesAppear(enabled: boolean): void;
  onToggleSuperWeapons(enabled: boolean): void;
  onToggleBuildOffAlly(enabled: boolean): void;
  onToggleDestroyableBridges(enabled: boolean): void;
  onToggleMultiEngineer(enabled: boolean): void;
  onToggleNoDogEngiKills(enabled: boolean): void;
  onToggleInstantCapture(enabled: boolean): void;
  onToggleDelayedOils(enabled: boolean): void;
  onChangeGameSpeed(value: number): void;
  onChangeCredits(value: number): void;
  onChangeUnitCount(value: number): void;
  activeSlotIndex: number;
  teamsAllowed: boolean;
  teamsRequired: boolean;
  playerSlots: Array<LobbyPlayerSlot | undefined>;
  shortGame: boolean;
  mcvRepacks: boolean;
  cratesAppear: boolean;
  superWeapons: boolean;
  buildOffAlly: boolean;
  destroyableBridges: boolean;
  multiEngineer: boolean;
  multiEngineerCount: number;
  noDogEngiKills: boolean;
  instantCapture: boolean;
  delayedOils: boolean;
  hostTeams?: boolean;
  gameSpeed: number;
  credits: number;
  unitCount: number;
  channels?: string[];
  chatHistory?: InstanceType<typeof ChatHistory>;
  localUsername?: string;
  messages?: ChatDisplayMessage[];
  onSendMessage?: ChatInputProps['onSubmit'];
  onToggleHostTeams?(enabled: boolean): void;
  selectedGameServer?: string;
  lockScenarioSlots?: boolean;
}
