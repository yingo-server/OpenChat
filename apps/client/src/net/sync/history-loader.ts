/**
 * 历史加载编排（sepc §1.2 三段式 loader）—— 与传输/存储解耦、可单测。
 *
 * 职责：
 *  1. 本地优先：先查 IndexedDB（cache.listMessages）。本地够 → 不打网络。
 *  2. 不足则请求服务端：发 920 → await 921（超时 3000ms）→ 写 IndexedDB → 返回；
 *     超时/失败 → 返回本地已有的（不报错、不阻塞 UI）。
 *  3. singleflight：同一 (convId, beforeSeq) 并发只发一次。
 *
 * 另外维护：
 *  - exhausted：某个会话 hasMore=false 后永久停止请求（避免滚动请求风暴）。
 *  - pending 表：按 convId 唤醒等待者；无等待者的迟到 921 直接丢弃（stale）。
 *
 * 设计说明：本模块是 net 层的纯逻辑件，依赖以端口（HistoryCachePort /
 * HistorySendPort）注入；bootstrap 用真实 cache + client 装配，单测用 fake。
 */
import type { StoredMessage } from './types';
import type { MsgNewPayload } from '../proto/payload';

export interface HistoryCachePort {
  /** 按 seq 升序返回 seq < beforeSeq 的最近 limit 条（复用 SyncCache 语义）。 */
  listMessages(convId: number, limit: number, beforeSeq?: number): Promise<StoredMessage[]>;
  putMessages(messages: StoredMessage[]): Promise<void>;
}

export interface HistorySendPort {
  /** 发送 920；返回 true 表示已交给传输层（离线返回 false）。 */
  requestHistory(convId: number, beforeSeq: number, limit: number): boolean;
}

export interface HistoryResult {
  convId: number;
  messages: MsgNewPayload[];
  fromCold: boolean;
  hasMore: boolean;
}

export type LoadSource = 'local' | 'network' | 'timeout';

export interface LoadOutcome {
  messages: StoredMessage[];
  source: LoadSource;
  /** 服务端是否还有更早的（本地命中时为 true——不代表已到底）。 */
  hasMore: boolean;
  /** hasMore=false 后为 true，之后该会话不再请求。 */
  exhausted: boolean;
}

export interface HistoryLoaderOptions {
  cache?: HistoryCachePort;
  send?: HistorySendPort;
  timeoutMs?: number;
}

/** MsgNewPayload → StoredMessage（与 msg-new handler 的映射保持一致）。 */
export function payloadToStored(convId: number, payload: MsgNewPayload): StoredMessage {
  const { content } = payload;
  const type = content.media.length > 0 ? content.media[0].type : content.text ? 'text' : 'system';
  return {
    convId: convId || payload.convId || 0,
    seq: payload.seq,
    msgId: payload.msgId,
    senderId: payload.senderId,
    sentAt: payload.sentAt,
    type,
    payload: {
      text: content.text,
      media: content.media,
      replyTo: content.replyTo,
      mentions: content.mentions,
    },
    status: 'sent',
    clientMsgId: content.clientMsgId || undefined,
    // 撤回消息在历史里必须立即以墓碑落地（否则重装后显示原文）。
    deleted: payload.recalled ? true : undefined,
  };
}

/** 合并本地与远端结果：按 seq 去重、升序（远端版本覆盖本地同 seq）。 */
function mergeUnique(local: StoredMessage[], fetched: StoredMessage[]): StoredMessage[] {
  const bySeq = new Map<number, StoredMessage>();
  for (const m of local) bySeq.set(m.seq, m);
  for (const m of fetched) bySeq.set(m.seq, m);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

interface PendingEntry {
  resolve: (result: HistoryResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class HistoryLoader {
  private cache: HistoryCachePort | null = null;
  private send: HistorySendPort | null = null;
  private timeoutMs: number;

  /** 按 convId 的等待者；无等待者时收到的 921 属迟到响应 → 丢弃。 */
  private readonly pending = new Map<number, PendingEntry>();
  /** 同一 (convId, beforeSeq) 的并发请求合并为一个 Promise。 */
  private readonly inflight = new Map<string, Promise<LoadOutcome>>();
  /** hasMore=false 的会话，之后不再发起网络请求。 */
  private readonly exhaustedConvs = new Set<number>();

  constructor(options: HistoryLoaderOptions = {}) {
    this.cache = options.cache ?? null;
    this.send = options.send ?? null;
    this.timeoutMs = options.timeoutMs ?? 3000;
  }

  configure(options: HistoryLoaderOptions): void {
    if (options.cache) this.cache = options.cache;
    if (options.send) this.send = options.send;
    if (options.timeoutMs !== undefined) this.timeoutMs = options.timeoutMs;
  }

  isExhausted(convId: number): boolean {
    return this.exhaustedConvs.has(convId);
  }

  /** 重置某会话的"到底"状态（如收到新消息后仍可继续往前翻）。 */
  resetExhausted(convId: number): void {
    this.exhaustedConvs.delete(convId);
  }

  /**
   * 921 到达入口（由 main.tsx 的 handler 调用）。返回是否被某个等待者消费；
   * false = 无等待者（超时后迟到 / 已切走会话）→ 丢弃，不写库。
   */
  handleResult(result: HistoryResult): boolean {
    const entry = this.pending.get(result.convId);
    if (!entry) return false; // stale: 迟到响应
    this.pending.delete(result.convId);
    clearTimeout(entry.timer);
    entry.resolve(result);
    return true;
  }

  /**
   * 三段式加载。返回给 message-store 的 StoredMessage[]（store 负责合并投影），
   * 同时携带 hasMore/exhausted 供 UI 判断"没有更多"。
   */
  async loadOlder(convId: number, beforeSeq: number, limit: number): Promise<LoadOutcome> {
    if (!this.cache || !this.send) {
      return { messages: [], source: 'local', hasMore: false, exhausted: true };
    }

    // —— 第 1 段：本地 ——
    const local = await this.cache.listMessages(convId, limit, beforeSeq);
    if (local.length >= limit) {
      return { messages: local, source: 'local', hasMore: true, exhausted: false };
    }

    // 已到底：不再请求，返回空（本地已有的早已在 store，避免无意义重复返回）。
    if (this.exhaustedConvs.has(convId)) {
      return { messages: [], source: 'local', hasMore: false, exhausted: true };
    }

    // —— 第 2/3 段：网络 + singleflight ——
    const key = `${convId}:${beforeSeq}`;
    const running = this.inflight.get(key);
    if (running) return running;

    const promise = this.fetch(convId, beforeSeq, limit, local).finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, promise);
    return promise;
  }

  private fetch(
    convId: number,
    beforeSeq: number,
    limit: number,
    local: StoredMessage[],
  ): Promise<LoadOutcome> {
    return new Promise<LoadOutcome>((resolve) => {
      let settled = false;
      const finish = (outcome: LoadOutcome): void => {
        if (settled) return;
        settled = true;
        resolve(outcome);
      };

      const timer = setTimeout(() => {
        this.pending.delete(convId);
        finish({ messages: local, source: 'timeout', hasMore: true, exhausted: false });
      }, this.timeoutMs);

      const resolveResult = async (result: HistoryResult): Promise<void> => {
        try {
          const fetched = result.messages.map((m) => payloadToStored(result.convId, m));
          if (fetched.length > 0) await this.cache!.putMessages(fetched);
          if (!result.hasMore) this.exhaustedConvs.add(convId);
          finish({
            messages: mergeUnique(local, fetched),
            source: 'network',
            hasMore: result.hasMore,
            exhausted: !result.hasMore,
          });
        } catch {
          // 写库失败不能阻塞 UI：退回本地已有。
          finish({ messages: local, source: 'timeout', hasMore: true, exhausted: false });
        }
      };

      this.pending.set(convId, { resolve: resolveResult, timer });

      const sent = this.send!.requestHistory(convId, beforeSeq, limit);
      if (!sent) {
        // 离线：立刻按超时处理，不等待。
        clearTimeout(timer);
        this.pending.delete(convId);
        finish({ messages: local, source: 'timeout', hasMore: true, exhausted: false });
      }
    });
  }
}

/** 进程内单例：bootstrap 注入依赖，main.tsx 的 921 handler 与 UI 共享。 */
export const historyLoader = new HistoryLoader();
