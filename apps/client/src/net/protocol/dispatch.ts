/**
 * dispatch —— 协议分发全部逻辑，<50 行，永不修改。
 * 查表调用；未知 kind 计数丢弃；handler 异常在此隔离。
 */
import type { Envelope } from '../proto/codec';
import { kindName } from './kinds';
import type { HandlerContext, HandlerRegistry } from './registry';

export interface DispatchStats {
  handled: number;
  unhandled: number;
  failed: number;
  lastUnhandledKind: number;
}
const stats: DispatchStats = { handled: 0, unhandled: 0, failed: 0, lastUnhandledKind: 0 };
const unhandledCounts = new Map<number, number>();
export function dispatch(env: Envelope, ctx: HandlerContext, registry: HandlerRegistry): boolean {
  const handler = registry.get(env.kind);
  if (!handler) {
    stats.unhandled += 1;
    stats.lastUnhandledKind = env.kind;
    unhandledCounts.set(env.kind, (unhandledCounts.get(env.kind) ?? 0) + 1);
    return false;
  }
  try {
    handler(env, ctx);
    stats.handled += 1;
    return true;
  } catch (error) {
    stats.failed += 1;
    console.error(`[dispatch] handler failed kind=${kindName(env.kind)}`, error);
    return false;
  }
}

export const dispatchStats = (): Readonly<DispatchStats> => stats;

export const unhandledCount = (kind: number): number => unhandledCounts.get(kind) ?? 0;

export const unhandledKinds = (): Array<{ kind: number; count: number }> =>
  [...unhandledCounts.entries()].map(([kind, count]) => ({ kind, count }));

export function resetDispatchStats(): void {
  stats.handled = 0;
  stats.unhandled = 0;
  stats.failed = 0;
  stats.lastUnhandledKind = 0;
  unhandledCounts.clear();
}
