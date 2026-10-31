/**
 * kind → handler 注册表。等价于 shell 的 execvp 查表：
 * 注册发生在 main.tsx，dispatch 只查表调用，永不 switch(kind)。
 *
 * 新增一个 kind = 新增 handler 文件 + main.tsx 一行 register —— dispatch.ts 不改。
 */
import type { Envelope } from '../proto/codec';

export type Handler = (env: Envelope, ctx: HandlerContext) => void;

export class HandlerRegistry {
  private readonly handlers = new Map<number, Handler>();

  register(kind: number, handler: Handler): () => void {
    if (this.handlers.has(kind)) {
      // 覆盖注册是配置错误，但不应让应用崩溃；保留后者并告警。
      console.warn(`[protocol] handler for kind ${kind} overridden`);
    }
    this.handlers.set(kind, handler);
    return () => {
      if (this.handlers.get(kind) === handler) this.handlers.delete(kind);
    };
  }

  get(kind: number): Handler | undefined {
    return this.handlers.get(kind);
  }

  has(kind: number): boolean {
    return this.handlers.has(kind);
  }

  get size(): number {
    return this.handlers.size;
  }

  kinds(): number[] {
    return [...this.handlers.keys()];
  }
}

export function createRegistry(): HandlerRegistry {
  return new HandlerRegistry();
}

/**
 * handler 可用的依赖（端口）。由 main.tsx 注入，全部是接口而非具体 store，
 * 保证 net 层不 import core/ui，依赖方向 ui → core → net 不逆转。
 */
import type { SyncEngine } from '../sync/engine';
import type { Outbox } from '../sync/outbox';
import type { NetClient } from '../transport/types';
import type { ConvPayload, PresencePayload } from '../proto/payload';

export interface SessionPort {
  readonly userId: number;
  setFlags(flags: Record<string, string>, version: number): void;
  kicked(reason: string, bannedUntil: number): void;
  rateLimited(scope: string, retryAfterMs: number): void;
  toast(key: string, params?: Record<string, string | number>): void;
  /** 读取单个 feature flag（缺省返回 undefined）。 */
  flag(key: string): string | undefined;
}

export interface ConvPort {
  upsertFromWire(payload: ConvPayload): void;
  setActive(convId: number): void;
}

export interface PresencePort {
  setStatus(payload: PresencePayload): void;
  setTyping(convId: number, userId: number, typing: boolean, at?: number): void;
}

export interface MessagePort {
  applyReceipt(convId: number, msgId: number, type: 'read' | 'delivered', userId: number, at: number): void;
}

export interface HandlerContext {
  client: NetClient;
  sync: SyncEngine;
  outbox: Outbox;
  session: SessionPort;
  convs: ConvPort;
  presence: PresencePort;
  messages: MessagePort;
  navigate: (route: string) => void;
  toast: (key: string, params?: Record<string, string | number>) => void;
}
