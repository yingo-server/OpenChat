/**
 * 纯 WebSocket 封装 —— 只做四件事：connect / close / send / onClose 等事件订阅。
 * 不含任何状态机、重连、心跳、鉴权、编解码（这些在上层 ws-client / codec）。
 *
 * 通过结构化的 WsSocket 接口注入，浏览器用 WebSocket，单测用 fake socket。
 */

export interface WsCloseInfo {
  code: number;
  reason: string;
  wasClean: boolean;
}

export interface WsSocket {
  readonly readyState: number;
  binaryType?: string;
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: WsCloseInfo) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export type SocketFactory = (url: string, protocols?: string[]) => WsSocket;

export const WS_OPEN = 1;
export const WS_CLOSING = 2;

export interface WsConnectionOptions {
  /** 注入点：默认浏览器 WebSocket；测试传 fake */
  factory?: SocketFactory;
  protocols?: string[];
  binaryType?: 'arraybuffer' | 'blob';
}

type Unsubscribe = () => void;

export class WsConnection {
  private socket: WsSocket | null = null;
  private readonly url: string;
  private readonly options: WsConnectionOptions;

  private openHandlers = new Set<() => void>();
  private messageHandlers = new Set<(data: string | ArrayBuffer) => void>();
  private closeHandlers = new Set<(info: WsCloseInfo) => void>();
  private errorHandlers = new Set<(error: unknown) => void>();

  constructor(url: string, options: WsConnectionOptions = {}) {
    this.url = url;
    this.options = options;
  }

  get readyState(): number {
    return this.socket ? this.socket.readyState : 3;
  }

  get isOpen(): boolean {
    return this.socket !== null && this.socket.readyState === WS_OPEN;
  }

  /** 建立连接。重复调用（connecting/open）会被忽略，不抛错。 */
  connect(): void {
    if (this.socket && (this.socket.readyState === 0 || this.socket.readyState === WS_OPEN)) return;

    const factory = this.options.factory ?? defaultFactory();
    const socket = factory(this.url, this.options.protocols);
    this.socket = socket;
    if (this.options.binaryType && 'binaryType' in socket) {
      socket.binaryType = this.options.binaryType;
    }

    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.openHandlers.forEach((fn) => fn());
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      const data = event.data;
      if (typeof data === 'string' || data instanceof ArrayBuffer) {
        this.messageHandlers.forEach((fn) => fn(data));
      } else if (data instanceof Uint8Array) {
        this.messageHandlers.forEach((fn) => fn(data.buffer as ArrayBuffer));
      }
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.closeHandlers.forEach((fn) => fn(event));
    };
    socket.onerror = (error) => {
      if (this.socket !== socket) return;
      this.errorHandlers.forEach((fn) => fn(error));
    };
  }

  /** 发送已编码的帧；未连接返回 false（由 outbox 负责排队，这里不缓冲）。 */
  send(data: string | ArrayBuffer | Uint8Array): boolean {
    if (!this.isOpen || !this.socket) return false;
    try {
      this.socket.send(data);
      return true;
    } catch {
      return false;
    }
  }

  close(code = 1000, reason = 'client close'): void {
    const socket = this.socket;
    if (!socket) return;
    this.socket = null;
    try {
      socket.close(code, reason);
    } catch {
      /* 已关闭 */
    }
    this.closeHandlers.forEach((fn) => fn({ code, reason, wasClean: true }));
  }

  onOpen(fn: () => void): Unsubscribe {
    this.openHandlers.add(fn);
    return () => this.openHandlers.delete(fn);
  }

  onMessage(fn: (data: string | ArrayBuffer) => void): Unsubscribe {
    this.messageHandlers.add(fn);
    return () => this.messageHandlers.delete(fn);
  }

  onClose(fn: (info: WsCloseInfo) => void): Unsubscribe {
    this.closeHandlers.add(fn);
    return () => this.closeHandlers.delete(fn);
  }

  onError(fn: (error: unknown) => void): Unsubscribe {
    this.errorHandlers.add(fn);
    return () => this.errorHandlers.delete(fn);
  }
}

function defaultFactory(): SocketFactory {
  if (typeof WebSocket === 'undefined') {
    throw new Error('WebSocket is not available in this environment');
  }
  return (url, protocols) => new WebSocket(url, protocols) as unknown as WsSocket;
}
