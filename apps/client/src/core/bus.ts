/**
 * store 间轻量事件总线。
 *
 * 依赖铁律：core/stores/* 互不 import，跨域联动只通过本总线；
 * 总线不依赖 React / 具体传输，纯同步发布订阅。
 */
import type { ConnState } from '../net/transport/types';
import type { ChatMessage } from './types';

export interface BusEvents {
  /** 新消息进入投影（含本地乐观消息） */
  'message:upserted': { message: ChatMessage };
  /** 既有消息变更（ACK/回执/编辑/撤回） */
  'message:updated': { message: ChatMessage };
  'message:removed': { convId: number; id: string };
  'conv:activated': { convId: number | null };
  'conn:changed': { state: ConnState; previous: ConnState };
  'session:changed': { userId: number; status: string };
}

type Listener<K extends keyof BusEvents> = (payload: BusEvents[K]) => void;

class EventBus {
  private readonly handlers = new Map<keyof BusEvents, Set<(payload: unknown) => void>>();

  on<K extends keyof BusEvents>(event: K, listener: Listener<K>): () => void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(listener as (payload: unknown) => void);
    this.handlers.set(event, set);
    return () => {
      set.delete(listener as (payload: unknown) => void);
    };
  }

  emit<K extends keyof BusEvents>(event: K, payload: BusEvents[K]): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const handler of set) {
      try {
        handler(payload);
      } catch (error) {
        console.error(`[bus] listener failed for ${String(event)}`, error);
      }
    }
  }

  clear(): void {
    this.handlers.clear();
  }
}

export const bus = new EventBus();
