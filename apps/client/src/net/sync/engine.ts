/**
 * last_seq 收敛引擎（rsync 模型）。
 *
 * 不变量：
 *  1. single-writer —— 所有写路径经过同一条串行队列，IndexedDB 写入是唯一事实源；
 *  2. 先校验后落库 —— seq 连续才接收；跳跃进入 gap buffer，并向网络层请求补拉；
 *  3. 去重 —— 已见 msgId / seq <= lastSeq 一律丢弃；
 *  4. 落库顺序 —— cache.putMessages → sink.applyMessages（内存投影）→ saveLastSeq；
 *  5. tombstone 不推进 lastSeq —— 删除/撤回是既有 seq 的变更，不是新消息。
 *
 * 全量重建（分页重放）与增量共用 `ingest` 入口，没有第二套写入路径。
 */
import type { SyncCache } from '../cache/idb';
import type { ResumeTicket } from '../transport/types';
import type {
  ConvRecord,
  GapRange,
  HydratedCache,
  IngestOutcome,
  StoredMessage,
  SyncStateView,
} from './types';

export interface SyncSink {
  hydrate(cache: HydratedCache): void;
  applyMessages(messages: StoredMessage[]): void;
  applyTombstone(convId: number, msgId: number, seq: number, op: 'delete' | 'recall'): void;
  applyEdit(convId: number, msgId: number, text: string): void;
  setSyncState(convId: number, state: SyncStateView): void;
  onGap(convId: number, gap: GapRange): void;
  onError?(error: unknown, context: string): void;
}

export interface SyncEngineOptions {
  /** 每会话内存中去重 msgId 的上限（防长会话内存膨胀） */
  seenLimit?: number;
  /** gap buffer 上限；超过则放弃增量，等待全量重放 */
  gapBufferLimit?: number;
}

interface ConvState {
  lastSeq: number;
  seen: Set<number>;
  seenOrder: number[];
  buffer: Map<number, StoredMessage>;
  gap: GapRange | null;
  status: SyncStateView['status'];
  serverSeq?: number;
  loaded: boolean;
}

export interface SyncEngineStats {
  accepted: number;
  duplicates: number;
  buffered: number;
  gaps: number;
  tombstones: number;
  errors: number;
}

export class SyncEngine {
  private readonly cache: SyncCache;
  private readonly sink: SyncSink;
  private readonly seenLimit: number;
  private readonly gapBufferLimit: number;
  private readonly states = new Map<number, ConvState>();
  private queue: Promise<unknown> = Promise.resolve();
  private _stats: SyncEngineStats = {
    accepted: 0,
    duplicates: 0,
    buffered: 0,
    gaps: 0,
    tombstones: 0,
    errors: 0,
  };

  constructor(cache: SyncCache, sink: SyncSink, options: SyncEngineOptions = {}) {
    this.cache = cache;
    this.sink = sink;
    this.seenLimit = options.seenLimit ?? 4096;
    this.gapBufferLimit = options.gapBufferLimit ?? 500;
  }

  get stats(): Readonly<SyncEngineStats> {
    return this._stats;
  }

  /** 启动 hydrate：IndexedDB → 内存投影。必须在 NetClient.start() 之前 await。 */
  hydrate(limitPerConv = 60): Promise<void> {
    return this.enqueue(async () => {
      const cache = await this.cache.hydrate(limitPerConv);
      const maxSeq = new Map<number, number>();
      for (const message of cache.messages) {
        const state = this.ensureState(message.convId, 0);
        this.remember(state, message.msgId);
        maxSeq.set(message.convId, Math.max(maxSeq.get(message.convId) ?? 0, message.seq));
      }
      for (const conv of cache.convs) {
        const state = this.ensureState(conv.convId, conv.lastSeq);
        // crash 恢复：若 putMessages 成功但 saveLastSeq 未完成，以库内最大 seq 校正游标
        state.lastSeq = Math.max(state.lastSeq, conv.lastSeq, maxSeq.get(conv.convId) ?? 0);
        state.loaded = true;
      }
      this.sink.hydrate(cache);
      for (const conv of cache.convs) this.emitState(conv.convId);
    });
  }

  /** 由 CONV_PAYLOAD 调用：登记会话（lastSeq 缺省 0），使其进入 RESUME 列表。 */
  ensureConv(convId: number, lastSeq = 0): Promise<number> {
    return this.enqueue(async () => {
      const state = await this.loadState(convId);
      if (lastSeq > state.lastSeq) {
        state.lastSeq = lastSeq;
        await this.cache.saveLastSeq(convId, lastSeq);
        this.emitState(convId);
      }
      return state.lastSeq;
    });
  }

  lastSeq(convId: number): number {
    return this.states.get(convId)?.lastSeq ?? 0;
  }

  /** 退出登录/切换账号：丢弃全部内存游标（IndexedDB 由调用方清理）。 */
  reset(): void {
    this.states.clear();
    this._stats = {
      accepted: 0,
      duplicates: 0,
      buffered: 0,
      gaps: 0,
      tombstones: 0,
      errors: 0,
    };
  }

  syncState(convId: number): SyncStateView {
    const state = this.states.get(convId);
    return {
      lastSeq: state?.lastSeq ?? 0,
      status: state?.status ?? 'idle',
      serverSeq: state?.serverSeq,
    };
  }

  /** 重连时按会话返回 RESUME(last_seq)。 */
  resumeTickets(): ResumeTicket[] {
    return [...this.states.entries()]
      .filter(([, state]) => state.loaded)
      .map(([convId, state]) => ({ convId, lastSeq: state.lastSeq }));
  }

  ingestNew(convId: number, message: StoredMessage): Promise<IngestOutcome> {
    return this.ingest(convId, [message]);
  }

  /**
   * 唯一下行写入口：校验 seq 连续性 → 落库 → 内存投影。
   * 支持批量（RESUME 补拉的多帧按序喂入）。
   */
  ingest(convId: number, messages: StoredMessage[]): Promise<IngestOutcome> {
    return this.enqueue(async () => {
      const state = await this.loadState(convId);
      const outcome: IngestOutcome = {
        accepted: 0,
        buffered: 0,
        duplicate: 0,
        lastSeq: state.lastSeq,
      };
      const sorted = [...messages].sort((a, b) => a.seq - b.seq);
      for (const message of sorted) {
        const accepted = await this.acceptOne(convId, state, message, outcome);
        if (accepted.length > 0) outcome.accepted += accepted.length;
      }
      outcome.lastSeq = state.lastSeq;
      return outcome;
    });
  }

  /** 删除/撤回：不推进 lastSeq；落库后通知投影层打 tombstone。 */
  applyTombstone(convId: number, msgId: number, op: 'delete' | 'recall' = 'delete'): Promise<boolean> {
    return this.enqueue(async () => {
      const existing = await this.cache.getMessageByMsgId(convId, msgId);
      if (!existing) return false;
      const updated: StoredMessage = { ...existing, deleted: true };
      await this.cache.putMessages([updated]);
      this._stats.tombstones += 1;
      this.safeSink('applyTombstone', () => this.sink.applyTombstone(convId, msgId, existing.seq, op));
      return true;
    });
  }

  /** 编辑：更新 payload.text 与 editedAt，不推进 lastSeq。 */
  applyEdit(convId: number, msgId: number, text: string): Promise<boolean> {
    return this.enqueue(async () => {
      const existing = await this.cache.getMessageByMsgId(convId, msgId);
      if (!existing) return false;
      const updated: StoredMessage = {
        ...existing,
        payload: { ...existing.payload, text },
        editedAt: Date.now(),
      };
      await this.cache.putMessages([updated]);
      this.safeSink('applyEdit', () => this.sink.applyEdit(convId, msgId, text));
      return true;
    });
  }

  /** RESUME_RESULT：得知服务端当前水位；缺的区间继续按 gap 处理。 */
  onResumeResult(payload: {
    convId: number;
    fromSeq: number;
    complete: boolean;
    serverSeq: number;
  }): Promise<void> {
    return this.enqueue(async () => {
      const state = await this.loadState(payload.convId);
      state.serverSeq = payload.serverSeq;
      if (payload.serverSeq > state.lastSeq) {
        state.status = 'syncing';
        const gap: GapRange = { from: state.lastSeq + 1, to: payload.serverSeq };
        this.emitState(payload.convId);
        this.requestGap(payload.convId, state, gap);
      } else {
        state.status = 'idle';
        this.emitState(payload.convId);
      }
      if (payload.complete && state.lastSeq >= payload.serverSeq) {
        state.status = 'idle';
        this.emitState(payload.convId);
      }
    });
  }

  /** 诊断/测试：当前各会话水位。 */
  snapshot(): Record<number, { lastSeq: number; status: string; buffered: number; gap: GapRange | null }> {
    return Object.fromEntries(
      [...this.states.entries()].map(([convId, state]) => [
        convId,
        { lastSeq: state.lastSeq, status: state.status, buffered: state.buffer.size, gap: state.gap },
      ]),
    );
  }

  // -------------------------------------------------------------------------
  // 内部（全部在串行队列内执行）
  // -------------------------------------------------------------------------

  private async acceptOne(
    convId: number,
    state: ConvState,
    message: StoredMessage,
    outcome: IngestOutcome,
  ): Promise<StoredMessage[]> {
    if (!Number.isFinite(message.seq) || message.seq <= 0) {
      outcome.duplicate += 1;
      this._stats.duplicates += 1;
      return [];
    }
    if (state.seen.has(message.msgId) || message.seq <= state.lastSeq) {
      outcome.duplicate += 1;
      this._stats.duplicates += 1;
      return [];
    }
    this.remember(state, message.msgId);

    if (message.seq === state.lastSeq + 1) {
      const accepted: StoredMessage[] = [message];
      state.lastSeq = message.seq;
      this.drainBuffer(state, accepted);
      await this.persist(convId, state, accepted);
      if (state.buffer.size === 0) {
        // 洞已补平：清除 gap 标记（persist 已把 status 置 idle）
        state.gap = null;
      } else {
        const min = Math.min(...state.buffer.keys());
        this.requestGap(convId, state, { from: state.lastSeq + 1, to: min - 1 });
      }
      return accepted;
    }

    state.buffer.set(message.seq, message);
    this._stats.buffered += 1;
    outcome.buffered += 1;
    if (state.buffer.size > this.gapBufferLimit) {
      state.buffer.clear();
      state.status = 'error';
      this.emitState(convId);
      return [];
    }
    if (!state.gap) {
      const gap: GapRange = { from: state.lastSeq + 1, to: message.seq - 1 };
      state.status = 'gapped';
      this.requestGap(convId, state, gap);
    }
    return [];
  }

  private drainBuffer(state: ConvState, accepted: StoredMessage[]): void {
    for (;;) {
      const next = state.buffer.get(state.lastSeq + 1);
      if (!next) break;
      state.buffer.delete(next.seq);
      accepted.push(next);
      state.lastSeq = next.seq;
    }
  }

  private requestGap(convId: number, state: ConvState, gap: GapRange): void {
    if (state.gap && state.gap.from === gap.from && state.gap.to === gap.to) {
      this.emitState(convId);
      return;
    }
    state.gap = gap;
    this._stats.gaps += 1;
    this.emitState(convId);
    this.safeSink('onGap', () => this.sink.onGap(convId, gap));
  }

  private async persist(convId: number, state: ConvState, accepted: StoredMessage[]): Promise<void> {
    const previous = state.lastSeq;
    try {
      // 1) IndexedDB 是唯一事实源：先落库
      await this.cache.putMessages(accepted);
      // 2) 内存投影（渲染读这里）
      this.safeSink('applyMessages', () => this.sink.applyMessages(accepted));
      // 3) 游标落库（crash 后 RESUME 从正确位置继续）
      await this.cache.saveLastSeq(convId, state.lastSeq);
      this._stats.accepted += accepted.length;
      state.status = state.buffer.size > 0 ? 'gapped' : 'idle';
      this.emitState(convId);
    } catch (error) {
      // 回滚内存游标，保持「IndexedDB = 事实源」不被破坏
      state.lastSeq = previous;
      state.status = 'error';
      this._stats.errors += 1;
      this.emitState(convId);
      this.sink.onError?.(error, 'persist');
      throw error;
    }
  }

  private async loadState(convId: number): Promise<ConvState> {
    const existing = this.states.get(convId);
    if (existing?.loaded) return existing;
    const lastSeq = await this.cache.getLastSeq(convId);
    const state = this.ensureState(convId, lastSeq);
    state.lastSeq = Math.max(state.lastSeq, lastSeq);
    state.loaded = true;
    return state;
  }

  private ensureState(convId: number, lastSeq: number): ConvState {
    let state = this.states.get(convId);
    if (!state) {
      state = {
        lastSeq,
        seen: new Set<number>(),
        seenOrder: [],
        buffer: new Map<number, StoredMessage>(),
        gap: null,
        status: 'idle',
        loaded: false,
      };
      this.states.set(convId, state);
    }
    return state;
  }

  private remember(state: ConvState, msgId: number): void {
    if (state.seen.has(msgId)) return;
    state.seen.add(msgId);
    state.seenOrder.push(msgId);
    if (state.seenOrder.length > this.seenLimit) {
      const evicted = state.seenOrder.shift();
      if (evicted !== undefined) state.seen.delete(evicted);
    }
  }

  private emitState(convId: number): void {
    const state = this.states.get(convId);
    if (!state) return;
    this.safeSink('setSyncState', () =>
      this.sink.setSyncState(convId, {
        lastSeq: state.lastSeq,
        status: state.status,
        serverSeq: state.serverSeq,
      }),
    );
  }

  private safeSink(context: string, fn: () => void): void {
    try {
      fn();
    } catch (error) {
      this._stats.errors += 1;
      this.sink.onError?.(error, context);
    }
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

/** 供测试与启动期断言：会话记录的最小合法形态。 */
export function emptyConv(convId: number): ConvRecord {
  return {
    convId,
    title: '',
    convType: 0,
    createdAt: 0,
    members: [],
    version: 0,
    lastSeq: 0,
    unread: 0,
    updatedAt: 0,
  };
}
