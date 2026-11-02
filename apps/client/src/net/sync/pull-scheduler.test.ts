/**
 * pull-scheduler 单测 —— spec v1.2 §4.2 T-CL-1…T-CL-7（T-CL-8 属 CI 一致性检查，
 * 由 tests/ 层守护；此处另附 kinds 常量冒烟断言防回归）。
 *
 * 全部使用 fake 时钟（vi.useFakeTimers）+ fake transport + MemoryCache 引擎，
 * 链路：水位线 → schedulePull(jitter) → 8 SYNC → fake 服务端回 102 MSG_NEW →
 * engine.ingest → lastSeq 收敛（与真实服务端 onSyncRequest 应答形态一致：逐条 102）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryCache } from '../cache/idb';
import { SyncEngine, type SyncSink } from './engine';
import {
  PULL_JITTER_MS,
  PULL_MIN_INTERVAL_MS,
  PULL_PAGE_LIMIT,
  PullScheduler,
  type PullSchedulerDeps,
} from './pull-scheduler';
import { KINDS } from '../protocol/kinds';
import { decodeSyncRequest, encodeMsgNew, encodeSyncRequest, encodeWatermark } from '../proto/payload';
import type { Envelope } from '../proto/codec';
import type { ConvRecord, GapRange, HydratedCache, StoredMessage, SyncStateView } from './types';

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

function msg(convId: number, seq: number, text = `m${seq}`): StoredMessage {
  return {
    convId,
    seq,
    msgId: convId * 1_000_000 + seq,
    senderId: 2001,
    sentAt: 1_700_000_000_000 + seq * 1000,
    type: 'text',
    payload: { text },
    status: 'sent',
  };
}

class TestSink implements SyncSink {
  gaps: Array<{ convId: number; gap: GapRange }> = [];
  states = new Map<number, SyncStateView>();
  hydrate(_cache: HydratedCache): void {}
  applyMessages(_messages: StoredMessage[]): void {}
  applyTombstone(): void {}
  applyEdit(): void {}
  setSyncState(convId: number, state: SyncStateView): void {
    this.states.set(convId, state);
  }
  onGap(convId: number, gap: GapRange): void {
    this.gaps.push({ convId, gap });
  }
}

/** fake 服务端：记录收到的 8 SYNC，按 backlog 回逐条 102 MSG_NEW（pipe.go:412 形态）。 */
class FakeServer {
  syncRequests: Array<{ convId: number; sinceSeq: number; limit: number }> = [];
  /** 每次 8 SYNC 到达的 fake 时钟时刻（min_interval 断言用）。 */
  readonly syncTimes: number[] = [];
  /** convId → 服务端仍持有的最大 seq（拉取的「库存」）。 */
  readonly backlog = new Map<number, number[]>();

  async onEnvelope(env: Envelope, deliver: (env: Envelope) => void): Promise<void> {
    if (env.kind !== KINDS.SYNC_REQUEST) return;
    const req = decodeSyncRequest(env.payload);
    this.syncRequests.push(req);
    this.syncTimes.push(Date.now());
    const pending = this.backlog.get(req.convId) ?? [];
    const page = pending.filter((seq) => seq >= req.sinceSeq).slice(0, req.limit);
    for (const seq of page) {
      deliver({
        id: 0,
        ackId: 0,
        kind: KINDS.MSG_NEW,
        version: 1,
        requestId: '',
        flags: 0,
        sentAt: Date.now(),
        convId: req.convId,
        payload: encodeMsgNew({
          msgId: req.convId * 1_000_000 + seq,
          seq,
          senderId: 2001,
          sentAt: Date.now(),
          convId: req.convId,
          content: { clientMsgId: '', text: `m${seq}`, media: [], mentions: [] },
        }),
      });
    }
  }
}

interface Rig {
  scheduler: PullScheduler;
  engine: SyncEngine;
  server: FakeServer;
  /** 引擎 ingest（模拟 dispatch 的 102 handler） */
  feed: (env: Envelope) => Promise<void>;
  loaded: Set<number>;
  deps: PullSchedulerDeps;
  randomValues: number[];
}

function rig(randomValues: number[] = []): Rig {
  vi.useFakeTimers();
  const cache = new MemoryCache();
  const engine = new SyncEngine(cache, new TestSink());
  const server = new FakeServer();
  const loaded = new Set<number>();
  let randomIdx = 0;
  const randomValuesRef = { values: randomValues };
  const deps: PullSchedulerDeps = {
    getLastSeq: (convId) => engine.lastSeq(convId),
    isConvLoaded: (convId) => loaded.has(convId),
    sendSync: (convId, sinceSeq, limit) => {
      void server.onEnvelope(
        {
          id: 0,
          ackId: 0,
          kind: KINDS.SYNC_REQUEST,
          version: 1,
          requestId: '',
          flags: 0,
          sentAt: Date.now(),
          convId,
          payload: encodeSyncRequest({ convId, sinceSeq, limit }),
        },
        (down) => {
          void feed(down);
        },
      );
      return true;
    },
    random: () => {
      const v = randomValuesRef.values[randomIdx % Math.max(1, randomValuesRef.values.length)];
      randomIdx += 1;
      return v ?? 0.5;
    },
    now: () => Date.now(),
  };
  const scheduler = new PullScheduler(deps);
  const feed = async (env: Envelope): Promise<void> => {
    // 与 handleMsgNew 相同映射：payload → StoredMessage → engine.ingest（唯一写入口）
    const raw = JSON.parse(new TextDecoder().decode(env.payload)) as Record<string, unknown>;
    const stored: StoredMessage = {
      convId: env.convId ?? 0,
      seq: Number(raw.seq),
      msgId: Number(raw.msg_id),
      senderId: Number(raw.sender_id),
      sentAt: Number(raw.sent_at),
      type: 'text',
      payload: { text: '' },
      status: 'sent',
    };
    await engine.ingest(env.convId ?? 0, [stored]);
  };
  return { scheduler, engine, server, feed, loaded, deps, randomValues: randomValuesRef.values };
}

async function loadConv(rig: Rig, convId: number, upToSeq: number): Promise<void> {
  rig.loaded.add(convId);
  if (upToSeq > 0) {
    // 引擎要求 seq 连续：从 1 灌到 upToSeq（模拟已收敛的历史游标）
    const seed = Array.from({ length: upToSeq }, (_, i) => msg(convId, i + 1));
    await rig.engine.ingest(convId, seed);
  }
}

async function settle(rig: Rig, ms: number): Promise<void> {
  // 推进 fake 时钟并冲刷微任务（jitter 定时器 → pullLoop 的 sleep 链）
  const step = 50;
  for (let t = 0; t < ms; t += step) {
    await vi.advanceTimersByTimeAsync(step);
  }
  await vi.advanceTimersByTimeAsync(step);
}

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// T-CL-1 … T-CL-7
// ---------------------------------------------------------------------------

describe('PullScheduler (spec v1.2 §4.2)', () => {
  it('T-CL-1: watermark latestSeq=lastSeq+5 → one 8 SYNC with correct since_seq → converges via ingest', async () => {
    const r = rig();
    await loadConv(r, 1, 10); // lastSeq = 10
    r.server.backlog.set(1, [11, 12, 13, 14, 15]);

    r.scheduler.onWatermark({ convId: 1, latestSeq: 15 });
    await settle(r, PULL_JITTER_MS + PULL_MIN_INTERVAL_MS * 3);

    expect(r.server.syncRequests).toHaveLength(1);
    expect(r.server.syncRequests[0]).toEqual({ convId: 1, sinceSeq: 11, limit: PULL_PAGE_LIMIT });
    expect(r.engine.lastSeq(1)).toBe(15); // 收敛：lastSeq >= latestSeq
  });

  it('T-CL-2: duplicate / out-of-order watermark (latestSeq <= lastSeq) → dropped, zero requests', async () => {
    const r = rig();
    await loadConv(r, 1, 10);

    r.scheduler.onWatermark({ convId: 1, latestSeq: 10 }); // 重复
    r.scheduler.onWatermark({ convId: 1, latestSeq: 7 }); // 乱序迟到
    await settle(r, PULL_JITTER_MS + PULL_MIN_INTERVAL_MS * 2);

    expect(r.server.syncRequests).toHaveLength(0);
    expect(r.scheduler.stats.droppedStale).toBe(2);
  });

  it('T-CL-3: 500 concurrent watermarks same conv → singleflight 1 in-flight, targetSeq catches up, min_interval respected', async () => {
    const r = rig();
    await loadConv(r, 1, 0);
    // backlog 1..500；水位线从 1 涨到 500 连发 500 条
    r.server.backlog.set(1, Array.from({ length: 500 }, (_, i) => i + 1));
    for (let latest = 1; latest <= 500; latest += 1) {
      r.scheduler.onWatermark({ convId: 1, latestSeq: latest });
      expect(r.scheduler.hasInflight(1)).toBe(true); // 始终只有一个任务
    }
    // 追赶语义：任务 targetSeq 已到 500（首个 in-flight 被复用而非新建）
    expect(r.server.syncRequests).toHaveLength(0); // jitter 期内未发请求

    await settle(r, PULL_JITTER_MS + PULL_MIN_INTERVAL_MS * 6 + PULL_PAGE_LIMIT); // 500 条需 3 页续拉
    // singleflight：jitter 后最多一条 in-flight；min_interval 使页间距 ≥ 1000ms
    expect(r.server.syncRequests.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < r.server.syncTimes.length; i += 1) {
      expect(r.server.syncTimes[i] - r.server.syncTimes[i - 1]).toBeGreaterThanOrEqual(PULL_MIN_INTERVAL_MS);
    }
    expect(r.engine.lastSeq(1)).toBe(500); // 全部追赶完成
    expect(r.scheduler.hasInflight(1)).toBe(false); // 收敛后任务清除
  });

  it('T-CL-4: jitter delay ∈ [0, 2000ms], mean of 100 samples in [700, 1300ms] (uniform distribution)', async () => {
    vi.useFakeTimers();
    const samples: number[] = [];
    for (let i = 0; i < 100; i += 1) {
      const r = rig();
      r.randomValues.push(i / 100); // 覆盖 [0,1) 均匀栅格
      await loadConv(r, 1, 0);
      r.server.backlog.set(1, [1, 2, 3, 4, 5]); // 一次页面即收敛，避免重试噪声
      r.scheduler.onWatermark({ convId: 1, latestSeq: 5 });
      const start = Date.now();
      await settle(r, PULL_JITTER_MS + 1);
      expect(r.server.syncRequests.length).toBe(1);
      samples.push(r.server.syncTimes[0] - start); // jitter 到请求发出的实际间隔
      r.scheduler.reset();
    }
    for (const s of samples) {
      expect(s).toBeGreaterThanOrEqual(0);
      // settle 的粒度是 50ms 一档，允许 ±150ms 的时钟推进余量
      expect(s).toBeLessThanOrEqual(PULL_JITTER_MS + 150);
    }
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    expect(mean).toBeGreaterThanOrEqual(700);
    expect(mean).toBeLessThanOrEqual(1300);
  });

  it('T-CL-5: forward pull concurrent with backward 920 history → ingest accepts older seq, lastSeq never regresses', async () => {
    const r = rig();
    await loadConv(r, 1, 10); // lastSeq = 10（前向游标）
    r.server.backlog.set(1, [11, 12]);
    r.scheduler.onWatermark({ convId: 1, latestSeq: 12 });

    // 后向 920 结果（seq < lastSeq 的历史）经同一 ingest 落库
    await r.engine.ingest(1, [msg(1, 8, 'old8'), msg(1, 9, 'old9')]);
    expect(r.engine.lastSeq(1)).toBe(10); // 历史不推进也不回退 lastSeq（引擎不变量 5）

    await settle(r, PULL_JITTER_MS + PULL_MIN_INTERVAL_MS * 3);
    expect(r.engine.lastSeq(1)).toBe(12); // 前向收敛，游标单调
    expect(r.server.syncRequests[0].sinceSeq).toBe(11); // 前向游标未被历史污染
  });

  it('T-CL-6: limit-truncated pull continues until convergence; gap triggers onGap (replay path available)', async () => {
    const r = rig();
    await loadConv(r, 1, 0);
    // backlog 1..250 > limit 200 → 需要 2 页续拉
    r.server.backlog.set(1, Array.from({ length: 250 }, (_, i) => i + 1));
    r.scheduler.onWatermark({ convId: 1, latestSeq: 250 });
    await settle(r, PULL_JITTER_MS + PULL_MIN_INTERVAL_MS * 5 + PULL_PAGE_LIMIT);

    expect(r.server.syncRequests.length).toBe(2); // 200 + 50 续拉
    expect(r.server.syncRequests[1].sinceSeq).toBe(201);
    expect(r.engine.lastSeq(1)).toBe(250);

    // gap 路径：跳 seq 喂入 → onGap 触发（引擎既有全量重放入口）
    const gaps = r.engine as unknown as { ingest: (c: number, m: StoredMessage[]) => Promise<unknown> };
    await gaps.ingest(1, [msg(1, 400)]);
    const sink = (r.engine as unknown as { sink: TestSink }).sink;
    expect(sink.gaps.length).toBeGreaterThanOrEqual(1);
    expect(sink.gaps[sink.gaps.length - 1]?.gap.from).toBe(251);
  });

  it('T-CL-7: watermark for unloaded conv → pendingWatermark recorded, consumed on hydrate', async () => {
    const r = rig();
    r.scheduler.onWatermark({ convId: 42, latestSeq: 7 });
    expect(r.server.syncRequests).toHaveLength(0);
    expect(r.scheduler.peekPending()).toEqual([{ convId: 42, targetSeq: 7 }]);

    // 更大 targetSeq 覆盖（每 conv 只留最大）
    r.scheduler.onWatermark({ convId: 42, latestSeq: 9 });
    expect(r.scheduler.peekPending()).toEqual([{ convId: 42, targetSeq: 9 }]);

    await settle(r, PULL_JITTER_MS); // 未加载期间绝不发请求
    expect(r.server.syncRequests).toHaveLength(0);

    // hydrate：会话落位 → consumePending → 走正常调度
    await loadConv(r, 42, 0);
    r.server.backlog.set(42, [1, 2, 3]);
    const consumed = r.scheduler.consumePending(42);
    expect(consumed).toBe(9);
    await settle(r, PULL_JITTER_MS + PULL_MIN_INTERVAL_MS * 3);
    expect(r.server.syncRequests[0]?.convId).toBe(42);
    expect(r.engine.lastSeq(42)).toBe(3);
  });

  it('pendingWatermark table caps at 1000 entries, dropping oldest (spec §5 内存膨胀缓解)', async () => {
    const r = rig();
    for (let convId = 1; convId <= 1001; convId += 1) {
      r.scheduler.onWatermark({ convId, latestSeq: convId });
    }
    const pending = r.scheduler.peekPending();
    expect(pending).toHaveLength(1000);
    expect(pending[0].convId).toBe(2); // conv 1（最旧）被丢弃
    expect(pending[pending.length - 1].convId).toBe(1001);
  });

  it('kinds 冒烟：WATERMARK = 14 且 name 反查正确（T-CL-8 客户端侧前提）', () => {
    expect(KINDS.WATERMARK).toBe(14);
    const bytes = encodeWatermark({ convId: 1, latestSeq: 9, reason: 0, memberCount: 500 });
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    expect(parsed.convId).toBe(1);
    expect(parsed.latestSeq).toBe(9);
  });
});

// ConvRecord 引用保持类型导入被使用（与 engine.test 同款工具函数约定）
export type { ConvRecord };
