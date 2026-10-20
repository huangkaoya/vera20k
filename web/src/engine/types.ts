import type { VeraEntity, VeraSnapshot as RenderSnapshot } from '../render/types';

export interface VeraPlayer { owner: number; slot: number; humanIndex: number | null; name: string; country: string; color: number; human: boolean; credits: number; power: number; drain: number; defeated: boolean; }
export interface VeraBuildOption { typeId: string; displayName: string; cost: number; category: string; enabled: boolean; reason: string | null; }
export interface VeraQueue { typeId: string; displayName: string; category: string; state: string; progress: number; total: number; }
export interface VeraReady { typeId: string; displayName: string; category: string; }
export interface Snapshot extends RenderSnapshot {
  tick: number; stateHash: string; tickMs: number; localOwner: number; viewPlayer: number;
  entities: VeraEntity[]; players: VeraPlayer[]; buildOptions: VeraBuildOption[]; queues: VeraQueue[]; ready: VeraReady[];
  map: { id: string; width: number; height: number; starts: Array<{index:number; rx:number; ry:number}>; [key:string]: unknown };
}
export interface VeraConfig {
  map: string; seed: number; localPlayer: number; viewPlayer: number;
  players: Array<{slot:number; name:string; country:string; color:number; start:number; team:number; human:boolean; difficulty:string}>;
  options: {credits:number; unitCount:number; gameSpeed:number; shortGame:boolean; superWeapons:boolean; crates:boolean; mcvRepacks:boolean; buildOffAlly:boolean; destroyableBridges:boolean};
}
export interface VeraCommand { kind: string; player?: number; [key:string]: unknown; }
export interface Placement {rx:number; ry:number; width:number; height:number; valid:boolean; inBuildArea:boolean; reason:string|null;}
export interface EngineResult {ok:boolean; snapshot?:Snapshot; placement?:Placement; error?:string; stack?:string;}
export interface ResourceFile {name:string; url:string; bytes:number; sha256:string;}
export interface ResourceManifest {files:ResourceFile[]; totalBytes:number; schema:number;}
