export type SlotKind = 'human' | 'ai' | 'closed';
export type AiDifficulty = 'easy' | 'normal' | 'hard';
export interface LobbySlot {
  id: number;
  kind: SlotKind;
  name?: string;
  country: string;
  color: number;
  /** Zero based spawn index; -2 selects a seeded random position. */
  start: number;
  /** -2 means no alliance. */
  team: number;
  difficulty: AiDifficulty;
}
export interface SkirmishConfig {
  mapId: string;
  seed: number;
  localHouse: number;
  playerName: string;
  slots: LobbySlot[];
  credits: number;
  unitCount: number;
  gameSpeed: number;
  shortGame: boolean;
  superWeapons: boolean;
  mcvRepacks: boolean;
  cratesAppear: boolean;
  buildOffAlly: boolean;
}
export interface LobbyMap {
  id: string;
  name: string;
  maxPlayers: number;
  previewUrl?: string;
  description?: string;
  size?: string;
  starts?: Array<{ x: number; y: number }>;
}
export interface LobbyCountry { id: string; name: string; faction?: 'allied' | 'soviet' | 'yuri'; }
export interface LobbyColor { id: number; name: string; hex: string; }
export interface LobbyCatalog {
  maps: LobbyMap[];
  countries: LobbyCountry[];
  colors: LobbyColor[];
}
export type ProductionCategory = 'building' | 'defense' | 'infantry' | 'vehicle';
export interface ProductionItem {
  typeId: string;
  name: string;
  cost: number;
  category: ProductionCategory;
  cameo?: string;
  available?: boolean;
  reason?: string;
}
export interface ProductionQueue {
  typeId: string;
  progress: number;
  count?: number;
  ready?: boolean;
  paused?: boolean;
}
export interface SelectionInfo {
  ids: number[];
  name: string;
  typeId?: string;
  cameo?: string;
  ownerName?: string;
  hp?: number;
  maxHp?: number;
  canDeploy?: boolean;
  canSell?: boolean;
}
export interface BattleHudState {
  tick: number;
  elapsedSeconds?: number;
  credits: number;
  power?: { output: number; drain: number };
  selected?: SelectionInfo | null;
  production?: ProductionItem[];
  queues?: ProductionQueue[];
  faction?: 'allied' | 'soviet' | 'yuri';
  paused?: boolean;
  message?: string;
}
export type UiCommand =
  | { type: 'produce'; typeId: string; count: number }
  | { type: 'cancelProduction'; typeId: string }
  | { type: 'place'; typeId: string }
  | { type: 'deploy' | 'stop' | 'guard' | 'sell' | 'repair' | 'attackMove' | 'scatter'; ids: number[] }
  | { type: 'pause'; paused: boolean };
export interface RoomMember { id: string; name: string; ready: boolean; host?: boolean; }
export interface RoomState {
  code: string;
  members: RoomMember[];
  isHost: boolean;
  localMemberId?: string;
  canStart?: boolean;
  status?: string;
  config?: SkirmishConfig;
}
export interface GameUICallbacks {
  onStart(config: SkirmishConfig): void | Promise<void>;
  onCommand(command: UiCommand): void;
  onLeaveBattle(): void;
  onCreateRoom?(config: SkirmishConfig): void | Promise<void>;
  onJoinRoom?(code: string): void | Promise<void>;
  onLeaveRoom?(): void;
  onRoomConfigChange?(config: SkirmishConfig): void;
  onToggleReady?(): void;
  onStartRoom?(): void;
}
