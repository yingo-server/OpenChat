/**
 * WS 连接状态机（与纯传输 ws-connection 分离）：
 *
 *    start() ──► connecting ──open──► online
 *                    │                  │
 *                    │ close            │ close / 心跳超时 / 浏览器 offline
 *                    ▼                  ▼
 *                 (退避重试) ◄──── reconnecting ──(多次失败/离线)──► offline
 *
 * 职责边界：
 *  - 断线指数退避（backoff.ts，500ms→8s）
 *  - 重连成功后逐会话发送 RESUME(last_seq)，交给 sync 引擎补 gap
 *  - 25s 心跳 PING，心跳失败只静默重建连接，**不打断输入/UI**
 *  - 所有下行帧解码后原样交给 onFrame（由 dispatch 查表），本层不解释业务 kind
 */
import { backoffDelay, type BackoffOptions } from './backoff';
import { WsConnection, type SocketFactory } from './ws-connection';
import {
  createEnvelope,
  decodeEnvelope,
  decodeEnvelopeProto,
  encodeEnvelope,
  encodeEnvelopeProto,
  type Envelope,
} from '../proto/codec';
import { decodePong, encodePing } from '../proto/payload';
import { KINDS } from '../protocol/kinds';
import type { ConnState, ConnStateMeta, NetClient, ResumeTicket, StateListener } from './types';

export interface WsClientOptions {
  url: string;
  /** WS 升级前鉴权：拼到 query（usergw acceptor 读取） */
  token?: () => string | null;
  deviceId?: () => string;
  sessionId?: () => string;
  resumeTickets?: () => ResumeTicket[];
  onFrame: (env: Envelope) => void;
  onState?: (state: ConnState, meta: ConnStateMeta) => void;
  format?: 'json' | 'protobuf';
  heartbeatMs?: number;
  socketFactory?: SocketFactory;
  backoff?: BackoffOptions;
  now?: () => number;
}

export class WsClient implements NetClient {
  private conn: WsConnection | null = null;
  private readonly options: WsClientOptions;
  private readonly format: 'json' | 'protobuf';
  private readonly heartbeatMs: number;

  private _state: ConnState = 'offline';
  private _latencyMs = 0;
  private attempt = 0;
  private frameId = 0;
  private started = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastPongAt = 0;
  private resumeProvider: (() => ResumeTicket[]) | null = null;

  private frameListeners = new Set<(env: Envelope) => void>();
  private stateListeners = new Set<StateListener>();
  private browserOffline = typeof navigator !== 'undefined' && navigator.onLine === false;

  constructor(options: WsClientOptions) {
    this.options = options;
    this.format = options.format ?? 'json';
    this.heartbeatMs = options.heartbeatMs ?? 25_000;
    if (options.resumeTickets) this.resumeProvider = options.resumeTickets;
  }

  get state(): ConnState {
    return this._state;
  }

  get latencyMs(): number {
    return this._latencyMs;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.attempt = 0;
    this.bindBrowserEvents();
    this.setState('connecting');
    this.open();
  }

  stop(): void {
    this.started = false;
    this.clearTimers();
    this.unbindBrowserEvents();
    const conn = this.conn;
    this.conn = null;
    conn?.close(1000, 'client stop');
    this.setState('offline', 'client stop');
  }

  send(env: Envelope): boolean {
    if (!this.conn || this._state !== 'online') return false;
    const frame: Envelope = { ...env, id: env.id || ++this.frameId };
    const data = this.format === 'protobuf' ? encodeEnvelopeProto(frame) : encodeEnvelope(frame);
    return this.conn.send(data);
  }

  onFrame(listener: (env: Envelope) => void): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  onState(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  setResumeProvider(provider: () => ResumeTicket[]): void {
    this.resumeProvider = provider;
  }

  // -------------------------------------------------------------------------
  // 内部：连接 / 重连 / 心跳
  // -------------------------------------------------------------------------

  private open(): void {
    const conn = new WsConnection(this.buildUrl(), {
      factory: this.options.socketFactory,
      binaryType: 'arraybuffer',
    });
    this.conn = conn;

    conn.onOpen(() => {
      this.attempt = 0;
      this.lastPongAt = this.now();
      this.setState('online');
      this.sendResumeFrames();
      this.startHeartbeat();
    });

    conn.onMessage((data) => {
      let env: Envelope;
      try {
        env = this.format === 'protobuf' ? decodeEnvelopeProto(data as ArrayBuffer) : decodeEnvelope(data as string);
      } catch {
        return; // 畸形帧丢弃：codec 是边界，不让脏数据进入 dispatch
      }
      if (env.kind === KINDS.PONG) {
        try {
          const pong = decodePong(env.payload);
          if (pong.clientMs > 0) this._latencyMs = Math.max(0, this.now() - pong.clientMs);
        } catch {
          /* payload 畸形不影响 pong 本身 */
        }
        this.lastPongAt = this.now();
        this.emitState();
      }
      this.frameListeners.forEach((fn) => fn(env));
    });

    conn.onClose((info) => {
      this.stopHeartbeat();
      if (!this.started) return;
      this.scheduleReconnect(info.reason || `close ${info.code}`);
    });

    conn.onError(() => {
      /* onerror 之后浏览器必定派发 close，统一在 onClose 处理避免双重重连 */
    });

    conn.connect();
  }

  private scheduleReconnect(reason: string): void {
    if (!this.started || this.reconnectTimer) return;
    if (this.browserOffline) {
      this.setState('offline', 'browser offline');
      return;
    }
    this.attempt += 1;
    this.setState('reconnecting', reason);
    const delay = backoffDelay(this.attempt - 1, this.options.backoff);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.started) return;
      if (this.browserOffline) {
        this.setState('offline', 'browser offline');
        return;
      }
      this.open();
    }, delay);
  }

  private sendResumeFrames(): void {
    const tickets = this.resumeProvider ? this.resumeProvider() : [];
    const sessionId = this.options.sessionId?.() ?? '';
    for (const ticket of tickets) {
      const env = createEnvelope({
        kind: KINDS.RESUME,
        convId: ticket.convId,
        requestId: `resume-${ticket.convId}-${ticket.lastSeq}`,
        payload: new TextEncoder().encode(
          JSON.stringify({ session_id: sessionId, conv_id: ticket.convId, last_seq: ticket.lastSeq }),
        ),
      });
      this.send(env);
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this._state !== 'online') return;
      if (this.now() - this.lastPongAt > this.heartbeatMs * 2.2) {
        // 静默重建：UI 无感（NetworkBar 由 close 后的 reconnecting 驱动）
        this.conn?.close(4000, 'heartbeat timeout');
        this.conn = null;
        this.stopHeartbeat();
        if (this.started) this.scheduleReconnect('heartbeat timeout');
        return;
      }
      const ping = createEnvelope({ kind: KINDS.PING, payload: encodePing(this.now()) });
      this.send(ping);
    }, this.heartbeatMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private clearTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
  }

  private buildUrl(): string {
    const token = this.options.token?.();
    const deviceId = this.options.deviceId?.();
    try {
      const base = typeof location !== 'undefined' ? location.href : 'http://localhost/';
      const url = new URL(this.options.url, base);
      if (token) url.searchParams.set('token', token);
      if (deviceId) url.searchParams.set('device_id', deviceId);
      return url.toString();
    } catch {
      return this.options.url;
    }
  }

  private bindBrowserEvents(): void {
    if (typeof window === 'undefined') return;
    window.addEventListener('offline', this.onBrowserOffline);
    window.addEventListener('online', this.onBrowserOnline);
  }

  private unbindBrowserEvents(): void {
    if (typeof window === 'undefined') return;
    window.removeEventListener('offline', this.onBrowserOffline);
    window.removeEventListener('online', this.onBrowserOnline);
  }

  private onBrowserOffline = (): void => {
    this.browserOffline = true;
    this.conn?.close(4001, 'browser offline');
    this.conn = null;
    this.clearTimers();
    this.setState('offline', 'browser offline');
  };

  private onBrowserOnline = (): void => {
    this.browserOffline = false;
    if (!this.started || this._state === 'online') return;
    this.clearTimers();
    this.attempt = 0;
    this.setState('connecting');
    this.open();
  };

  private setState(state: ConnState, reason?: string): void {
    const changed = this._state !== state;
    this._state = state;
    if (changed || reason) this.emitState(reason);
  }

  private emitState(reason?: string): void {
    const meta: ConnStateMeta = {
      attempt: this.attempt,
      reason,
      latencyMs: this._latencyMs,
      at: this.now(),
    };
    this.options.onState?.(this._state, meta);
    this.stateListeners.forEach((fn) => fn(this._state, meta));
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }
}
