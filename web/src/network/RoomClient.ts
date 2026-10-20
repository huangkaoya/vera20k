import type { RoomState, SkirmishConfig } from '../ui/types';
import type { VeraCommand } from '../engine/types';
export interface RoomStart { config: SkirmishConfig; playerIndex: number; roomCode: string; }
export interface RoomTurn { tick: number; commands: VeraCommand[]; }
export interface RoomClientCallbacks {
  onRoom(state: RoomState | null): void;
  onStart(start: RoomStart): void | Promise<void>;
  onReady(tick: number): void;
  onTurn(turn: RoomTurn): void | Promise<void>;
  onStop(reason: string): void;
  onError?(message: string): void;
}
/** A deliberately local protocol; all humans submit one input frame and preceding state hash. */
export class RoomClient {
  private socket: WebSocket | null = null;
  private connecting: Promise<void> | null = null;
  private sequence = 0;
  private pending = new Map<number, { resolve: () => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> }>();
  private intentionalClose = false;
  room: RoomState | null = null;
  playerIndex = 0;
  constructor(private readonly callbacks: RoomClientCallbacks, private readonly url = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/rooms`) {}
  get connected(): boolean { return this.socket?.readyState === WebSocket.OPEN; }
  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.connecting) return this.connecting;
    this.intentionalClose = false;
    this.connecting = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.url); this.socket = socket;
      const timeout = setTimeout(() => { socket.close(); reject(new Error('连接本地联调服务超时')); }, 10000);
      socket.onopen = () => {
        clearTimeout(timeout);
        if (this.socket !== socket || this.intentionalClose) { socket.close(); reject(new Error('房间连接已关闭')); return; }
        resolve();
      };
      socket.onerror = () => {
        clearTimeout(timeout);
        reject(new Error(this.socket !== socket || this.intentionalClose ? '房间连接已关闭' : '无法连接本地联调服务'));
      };
      socket.onmessage = event => {
        if (this.socket !== socket || this.intentionalClose) return;
        this.receive(event.data, socket);
      };
      socket.onclose = () => {
        clearTimeout(timeout); reject(new Error('本地房间连接已断开'));
        if (this.socket !== socket || this.intentionalClose) return;
        const wasInRoom = !!this.room; this.socket = null; this.room = null;
        this.rejectAll(new Error('本地房间连接已断开')); this.callbacks.onRoom(null);
        if (wasInRoom && !this.intentionalClose) this.callbacks.onStop('本地房间连接已断开，对战已停止。');
      };
    }).finally(() => { this.connecting = null; });
    return this.connecting;
  }
  async create(config: SkirmishConfig): Promise<void> { await this.request('create', { config }); }
  async join(code: string, name = '指挥官'): Promise<void> { await this.request('join', { code, name }); }
  async setConfig(config: SkirmishConfig): Promise<void> { await this.request('config', { config }); }
  async toggleReady(): Promise<void> { await this.request('ready'); }
  async start(): Promise<void> { await this.request('start'); }
  loaded(hash: string, tick = 0): void { this.send({ type: 'loaded', hash, tick }); }
  submit(tick: number, commands: VeraCommand[], prevHash: string): void { this.send({ type: 'input', tick, commands, prevHash }); }
  async leave(): Promise<void> { if (this.connected) await this.request('leave'); }
  close(): void {
    this.intentionalClose = true; this.room = null; this.socket?.close(); this.socket = null;
    this.rejectAll(new Error('房间连接已关闭'));
  }
  private async request(type: string, data: Record<string, unknown> = {}): Promise<void> {
    await this.connect();
    return new Promise<void>((resolve, reject) => {
      const id = ++this.sequence;
      const timeout = setTimeout(() => { this.pending.delete(id); reject(new Error('房间请求超时')); }, 10000);
      this.pending.set(id, { resolve, reject, timeout });
      try { this.send({ type, id, ...data }); }
      catch (error) { clearTimeout(timeout); this.pending.delete(id); reject(error instanceof Error ? error : new Error(String(error))); }
    });
  }
  private send(message: Record<string, unknown>): void {
    if (!this.connected) throw new Error('房间尚未连接'); this.socket!.send(JSON.stringify(message));
  }
  private receive(data: string, source: WebSocket): void {
    const callbackError = (error: unknown): void => {
      if (this.socket !== source || this.intentionalClose) return;
      this.callbacks.onError?.(error instanceof Error ? error.message : String(error));
    };
    try {
      const message = JSON.parse(data);
      if (message.type === 'response') {
        const request = this.pending.get(message.id); if (!request) return;
        clearTimeout(request.timeout); this.pending.delete(message.id);
        if (message.ok) request.resolve(); else request.reject(new Error(message.error ?? '房间操作失败'));
      } else if (message.type === 'room') { this.room = message.room; this.callbacks.onRoom(this.room); }
      else if (message.type === 'start') {
        this.playerIndex = message.playerIndex;
        void Promise.resolve(this.callbacks.onStart(message)).catch(callbackError);
      } else if (message.type === 'ready') { this.callbacks.onReady(message.tick); }
      else if (message.type === 'turn') {
        void Promise.resolve(this.callbacks.onTurn(message)).catch(callbackError);
      } else if (message.type === 'stopped') { this.room = null; this.callbacks.onStop(message.reason); }
      else if (message.type === 'error') { this.callbacks.onError?.(message.error); }
    } catch (error) { callbackError(error); }
  }
  private rejectAll(error: Error): void { for (const request of this.pending.values()) { clearTimeout(request.timeout); request.reject(error); } this.pending.clear(); }
}
