import type { RoomState, SkirmishConfig } from '../ui/types';
import type { VeraCommand } from '../engine/types';
import { resolveSocketUrl } from '../config/runtime';

export interface BattleConnection { url: string; matchId: string; ticket: string; }
export interface RoomStart { config: SkirmishConfig; playerIndex: number; roomCode: string; battle?: BattleConnection; }
export interface RoomTurn { tick: number; commands: VeraCommand[]; }
export interface RoomClientCallbacks {
  onRoom(state: RoomState | null): void;
  onStart(start: RoomStart): void | Promise<void>;
  onReady(tick: number): void;
  onTurn(turn: RoomTurn): void | Promise<void>;
  onStop(reason: string): void;
  onError?(message: string): void;
}

/** Lobby membership and battle inputs have separate transports. Legacy local servers remain supported. */
export class RoomClient {
  private socket: WebSocket | null = null;
  private battleSocket: WebSocket | null = null;
  private connecting: Promise<void> | null = null;
  private cancelConnect: ((error: Error) => void) | null = null;
  private cancelBattleJoin: ((error: Error) => void) | null = null;
  private sequence = 0;
  private connectionGeneration = 0;
  private matchGeneration = 0;
  private mode: 'legacy' | 'split' | null = null;
  private battleJoined = false;
  private matchActive = false;
  private pending = new Map<number, { resolve: () => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> }>();
  private intentionalClose = false;
  private readonly url: string;
  private readonly pageUrl: string;
  room: RoomState | null = null;
  playerIndex = 0;

  constructor(private readonly callbacks: RoomClientCallbacks, url: string) {
    this.pageUrl = typeof location === 'undefined' ? url : location.href;
    this.url = resolveSocketUrl(url, this.pageUrl, this.pageUrl, '大厅 URL');
  }
  get connected(): boolean { return this.socket?.readyState === WebSocket.OPEN; }
  get battleConnected(): boolean { return this.battleJoined && this.battleSocket?.readyState === WebSocket.OPEN; }

  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.connecting) return this.connecting;
    this.intentionalClose = false;
    this.connectionGeneration++;
    const attempt = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.url); this.socket = socket;
      const timeout = setTimeout(() => {
        if (this.socket !== socket) return;
        this.socket = null; this.cancelConnect = null; socket.close(); reject(new Error('连接大厅服务超时'));
      }, 10000);
      const cancel = (error: Error) => { clearTimeout(timeout); reject(error); };
      this.cancelConnect = cancel;
      socket.onopen = () => {
        clearTimeout(timeout);
        if (this.socket !== socket || this.intentionalClose) { socket.close(); reject(new Error('房间连接已关闭')); return; }
        if (this.cancelConnect === cancel) this.cancelConnect = null;
        resolve();
      };
      socket.onerror = () => {
        if (this.socket !== socket || this.intentionalClose) return;
        clearTimeout(timeout); reject(new Error('无法连接大厅服务'));
        socket.close();
      };
      socket.onmessage = event => {
        if (this.socket === socket && !this.intentionalClose) this.receiveLobby(event.data, socket);
      };
      socket.onclose = () => {
        clearTimeout(timeout); reject(new Error('大厅连接已断开'));
        if (this.socket !== socket || this.intentionalClose) return;
        const wasInRoom = !!this.room || this.matchActive;
        this.socket = null; this.room = null; this.cancelConnect = null;
        this.invalidateBattle(); this.rejectAll(new Error('大厅连接已断开')); this.callbacks.onRoom(null);
        if (wasInRoom) this.callbacks.onStop('大厅连接已断开，对战已停止。');
      };
    });
    const tracked = attempt.finally(() => { if (this.connecting === tracked) this.connecting = null; });
    this.connecting = tracked;
    return tracked;
  }

  async create(config: SkirmishConfig): Promise<void> { await this.request('create', { config }); }
  async join(code: string, name = '指挥官'): Promise<void> { await this.request('join', { code, name }); }
  async setConfig(config: SkirmishConfig): Promise<void> { await this.request('config', { config }); }
  async toggleReady(): Promise<void> { await this.request('ready'); }
  async start(): Promise<void> { await this.request('start'); }
  loaded(hash: string, tick = 0): void { this.sendBattle({ type: 'loaded', hash, tick }); }
  submit(tick: number, commands: VeraCommand[], prevHash: string): void { this.sendBattle({ type: 'input', tick, commands, prevHash }); }
  async leave(): Promise<void> {
    this.invalidateBattle();
    if (this.connected) await this.request('leave');
  }
  close(): void {
    this.intentionalClose = true; this.room = null;
    this.connectionGeneration++;
    this.invalidateBattle();
    this.cancelConnect?.(new Error('房间连接已关闭')); this.cancelConnect = null;
    const socket = this.socket; this.socket = null; this.connecting = null; socket?.close();
    this.rejectAll(new Error('房间连接已关闭'));
  }

  private async request(type: string, data: Record<string, unknown> = {}): Promise<void> {
    const connected = this.connect(), generation = this.connectionGeneration;
    await connected;
    if (generation !== this.connectionGeneration || this.intentionalClose) throw new Error('房间连接已关闭');
    return new Promise<void>((resolve, reject) => {
      const id = ++this.sequence;
      const timeout = setTimeout(() => { this.pending.delete(id); reject(new Error('房间请求超时')); }, 10000);
      this.pending.set(id, { resolve, reject, timeout });
      try { this.sendLobby({ type, id, ...data }); }
      catch (error) { clearTimeout(timeout); this.pending.delete(id); reject(asError(error)); }
    });
  }
  private sendLobby(message: Record<string, unknown>): void {
    if (!this.connected) throw new Error('大厅尚未连接'); this.socket!.send(JSON.stringify(message));
  }
  private sendBattle(message: Record<string, unknown>): void {
    if (this.mode === 'split') {
      if (!this.battleConnected) throw new Error('战局尚未连接');
      this.battleSocket!.send(JSON.stringify(message));
    } else if (this.mode === 'legacy') this.sendLobby(message);
    else throw new Error('战局尚未连接');
  }
  private invalidateBattle(): void {
    this.matchGeneration++; this.matchActive = false; this.battleJoined = false; this.mode = null;
    this.cancelBattleJoin?.(new Error('战局连接已关闭')); this.cancelBattleJoin = null;
    const socket = this.battleSocket; this.battleSocket = null; socket?.close();
  }
  private callbackError(error: unknown, current: () => boolean): void {
    if (current()) this.callbacks.onError?.(asError(error).message);
  }
  private stopBattle(reason: string): void {
    if (!this.matchActive) return;
    this.invalidateBattle();
    this.callbacks.onStop(reason);
  }

  private receiveLobby(data: string, source: WebSocket): void {
    const generation = this.matchGeneration;
    const current = () => this.socket === source && !this.intentionalClose && generation === this.matchGeneration;
    try {
      const message = JSON.parse(data);
      if (message.type === 'response') {
        const request = this.pending.get(message.id); if (!request) return;
        clearTimeout(request.timeout); this.pending.delete(message.id);
        if (message.ok) request.resolve(); else request.reject(new Error(message.error ?? '房间操作失败'));
      } else if (message.type === 'room') {
        this.room = message.room; this.callbacks.onRoom(this.room);
      } else if (message.type === 'start') {
        this.invalidateBattle(); this.matchActive = true;
        const token = this.matchGeneration;
        const stillCurrent = () => this.socket === source && !this.intentionalClose && token === this.matchGeneration;
        if (message.battle) {
          this.mode = 'split';
          void this.joinBattle(message, source, token).catch(error => {
            if (!stillCurrent()) return;
            this.callbacks.onError?.(asError(error).message); this.stopBattle(asError(error).message);
          });
        } else {
          this.mode = 'legacy'; this.playerIndex = message.playerIndex;
          try { void Promise.resolve(this.callbacks.onStart(message)).catch(error => this.callbackError(error, stillCurrent)); }
          catch (error) { this.callbackError(error, stillCurrent); }
        }
      } else if (message.type === 'ready' && this.mode !== 'split') {
        this.callbacks.onReady(message.tick);
      } else if (message.type === 'turn' && this.mode !== 'split') {
        void Promise.resolve(this.callbacks.onTurn(message)).catch(error => this.callbackError(error, current));
      } else if (message.type === 'stopped') {
        if (this.matchActive) this.stopBattle(message.reason);
      } else if (message.type === 'error') this.callbacks.onError?.(message.error);
    } catch (error) { this.callbackError(error, current); }
  }

  private async joinBattle(start: RoomStart, lobby: WebSocket, token: number): Promise<void> {
    const connection = start.battle!;
    if (typeof connection.matchId !== 'string' || !connection.matchId || typeof connection.ticket !== 'string' || !connection.ticket) throw new Error('战局连接凭据无效');
    const url = resolveSocketUrl(connection.url, this.url, this.pageUrl, '战局 URL');
    const socket = new WebSocket(url); this.battleSocket = socket;
    const current = () => this.socket === lobby && this.battleSocket === socket && !this.intentionalClose && token === this.matchGeneration;
    const joined = await new Promise<RoomStart>((resolve, reject) => {
      const timeout = setTimeout(() => { if (current()) reject(new Error('连接战局服务超时')); }, 10000);
      const cancel = (error: Error) => { clearTimeout(timeout); reject(error); };
      this.cancelBattleJoin = cancel;
      const fail = (reason: string) => {
        if (!current()) return;
        clearTimeout(timeout);
        if (!this.battleJoined) reject(new Error(reason));
        else this.stopBattle(reason);
      };
      socket.onopen = () => {
        if (!current()) { socket.close(); return; }
        socket.send(JSON.stringify({ type: 'join', matchId: connection.matchId, ticket: connection.ticket }));
      };
      socket.onerror = () => fail('无法连接战局服务');
      socket.onclose = () => fail('战局连接已断开，对战已停止。');
      socket.onmessage = event => {
        if (!current()) return;
        try {
          const message = JSON.parse(event.data);
          if (message.type === 'joined' && !this.battleJoined) {
            if (message.matchId !== connection.matchId || !Number.isInteger(message.playerIndex) || message.playerIndex < 0 || !message.config || typeof message.config !== 'object') throw new Error('战局加入确认无效');
            clearTimeout(timeout); this.cancelBattleJoin = null; this.battleJoined = true; this.playerIndex = message.playerIndex;
            resolve({ config: message.config, playerIndex: message.playerIndex, roomCode: message.roomCode, battle: { ...connection, url } });
          } else if (message.type === 'ready' && this.battleJoined) this.callbacks.onReady(message.tick);
          else if (message.type === 'turn' && this.battleJoined) {
            void Promise.resolve(this.callbacks.onTurn(message)).catch(error => {
              if (!current()) return;
              this.callbacks.onError?.(asError(error).message); this.stopBattle(asError(error).message);
            });
          } else if (message.type === 'stopped') fail(message.reason ?? '战局已停止');
          else if (message.type === 'error') fail(message.error ?? '战局服务错误');
        } catch (error) { fail(asError(error).message); }
      };
    });
    if (!current()) return;
    await this.callbacks.onStart(joined);
  }

  private rejectAll(error: Error): void {
    for (const request of this.pending.values()) { clearTimeout(request.timeout); request.reject(error); }
    this.pending.clear();
  }
}

function asError(error: unknown): Error { return error instanceof Error ? error : new Error(String(error)); }
