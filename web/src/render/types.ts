/** Presentation-only view of the authoritative VERA WASM state. */
export interface VeraEntity {
  id: number;
  typeId: string;
  owner: number;
  rx: number;
  ry: number;
  subX?: number;
  subY?: number;
  z?: number;
  sx: number;
  sy: number;
  facing: number;
  hp: number;
  maxHp: number;
  category: 'infantry' | 'unit' | 'aircraft' | 'structure';
  limbo: boolean;
  alive?: boolean;
  visible?: boolean;
  moving?: boolean;
}
export interface VeraSnapshot {
  tick: number;
  entities: VeraEntity[];
  localOwner?: number;
  players?: { owner: number; color: number }[];
  fog?: { width: number; height: number; cells: number[] };
  [key: string]: unknown;
}
export interface SpriteFrame {
  x: number; y: number; width: number; height: number;
  offsetX: number; offsetY: number;
  facing: number; animation: number;
}
export interface SpriteAsset {
  image: string;
  remapImage?: string;
  cameo?: string;
  source: string;
  kind: string;
  width: number;
  height: number;
  frames: SpriteFrame[];
  foundation: [number, number];
}
export interface TerrainCell { rx: number; ry: number; z: number; }
export interface MapAsset {
  id: string;
  title: string;
  theater: string;
  image: string;
  minimap: string;
  width: number;
  height: number;
  originX: number;
  originY: number;
  localLeft: number;
  localTop: number;
  localWidth: number;
  localHeight: number;
  starts: { index: number; rx: number; ry: number }[];
  cells: TerrainCell[];
}
export interface AssetsManifest {
  schema: number;
  generator: string;
  maps: MapAsset[];
  sprites: Record<string, SpriteAsset>;
  warnings: string[];
  names?: Record<string, string>;
  colors?: { id: number; name: string; hex: string; rgb: number[]; ramp: number[][] }[];
}
export interface BuildingPlacement {
  typeId: string; rx: number; ry: number; valid: boolean;
}
