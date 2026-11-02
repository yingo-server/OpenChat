/**
 * 拉取模式调度器（spec v1.2 §2.1/§2.2 状态机）—— 纯逻辑件，依赖注入（与 history-loader 同风格）。
 *
 * 职责（只产生请求，绝不直接写 cache/sink——结构性防御「第二套写入路径」）：
 *  - onWatermark(w)：§2.1 三步状态机
 *      1) conv 未加载 → 记 pendingWatermark（hydrate 时消费）；
 *      2) latestSeq <= lastSeq → 丢弃（重复/乱序迟到，零请求）；
 *      3) 否则 schedulePull(convId, latestSeq)。
 *  - schedulePull：singleflight（每 conv ≤1 in-flight，重复水位线更新 targetSeq 追赶）
 *      + jitter random(0, 2000ms) + min_interval 1000ms。
 *  - 拉取 = 8 SYNC {conv_id, since_seq=lastSeq+1, limit=200}。服务端 onSyncRequest
 *    (pipe.go:412) 的应答不是包裹结果帧，而是把缺失消息逐条以 102 MSG_NEW 重发——
 *    由现有 dispatch → handleMsgNew → engine.ingest 路径落库收敛，本模块不感知帧。
 *  - 收尾：服务端 catchup 不回 has_more，因此续拉条件为 lastSeq < targetSeq
 *    （limit 截断时下一轮水位线/续拉覆盖）；lastSeq >= targetSeq 即收敛。
 *  - 与后向 920 的并发（§2.4）：singleflight 键分离（pull:<convId> vs hist:...）；
 *    游标分离（前向游标 = 引擎 lastSeq，后向游标 = UI 最旧已加载 seq）；
 *    引擎「seq <= lastSeq 不推进 lastSeq」不变量保证 920 历史落库不回退。
 *
 * 惊群防护（§2.2）：jitter 把 500 人同批水位线的拉取摊在 2s 内；
 * min_interval 合并高频会话的多条水位线为一次更大范围的拉取（追赶语义）。
 */
export const PULL_JITTER_MS = 2000;
export const PULL_MIN_INTERVAL_MS = 1000;
export const PULL_PAGE_LIMIT = 200;
export const PENDING_WATERMARK_LIMIT = 1000;

/** 依赖端口（bootstrap 注入真实实现，单测注入 fake）。 */
export interface PullSchedulerDeps {
  /** 引擎 lastSeq 快照读取（不直接依赖 store；竞态无害——拉多去重、拉少下轮覆盖）。 */
  getLastSeq: (convId: number) => number;
  /** 会话是否已加载（不在 conv-store 会话列表 = 未 hydrate）。 */
  isConvLoaded: (convId: number) => boolean;
  /** 发送 8 SYNC；返回 true 表示已交给传输层（离线返回 false，任务放弃待下轮水位线）。 */
  sendSync: (convId: number, sinceSeq: number, limit: number) => boolean;
  /** 随机源（单测注入固定序列做 jitter 分布断言）。 */
  random?: () => number;
  /** 时间源（ms，单测注入 fake 时钟时保持一致）。 */
  now?: () => number;
}

export interface Watermark {
  convId: number;
  latestSeq: number;
  /** reason 仅诊断/测试断言用，客户端逻辑不依赖（spec §1.1）。 */
  reason?: number;
  memberCount?: number;
}

interface PullTask {
  convId: number;
  targetSeq: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** jitter 已过、请求已发出（续拉循环在跑）。 */
  started: boolean;
  /** 上次实际发出 8 SYNC 的时刻（min_interval 判定）。 */
  lastSentAt: number;
}

export interface PullSchedulerStats {
  watermarksReceived: number;
  droppedStale: number;
  pendingRecorded: number;
  pullsSent: number;
  converged: number;
}

export class PullScheduler {
  private readonly deps: PullSchedulerDeps;

  private readonly random: () => number;
  private readonly now: () => number;

  /** 每 conv 至多一个任务（singleflight 键 pull:<convId>）。 */
  private readonly inflight = new Map<number, PullTask>();
  /** 未加载会话的水位线：convId → 最新 targetSeq（O(会话数) 常数）。 */
  private readonly pendingWatermarks = new Map<number, number>();
  /** pending 表插入顺序（上限 1000 丢弃最旧）。 */
  private readonly pendingOrder: number[] = [];

  private _stats: PullSchedulerStats = {
    watermarksReceived: 0,
    droppedStale: 0,
    pendingRecorded: 0,
    pullsSent: 0,
    converged: 0,
  };

  constructor(deps: PullSchedulerDeps) {
    this.deps = deps;
    this.random = deps.random ?? Math.random;
    this.now = deps.now ?? Date.now;
  }

  get stats(): Readonly<PullSchedulerStats> {
    return this._stats;
  }

  /** spec §2.1 状态机入口（由 kind 14 handler 调用）。 */
  onWatermark(w: Watermark): void {
    this._stats.watermarksReceived += 1;
    if (!this.deps.isConvLoaded(w.convId)) {
      this.recordPending(w.convId, w.latestSeq);
      return;
    }
    if (w.latestSeq <= this.deps.getLastSeq(w.convId)) {
      this._stats.droppedStale += 1; // 重复/乱序：零请求
      return;
    }
    this.schedulePull(w.convId, w.latestSeq);
  }

  /** 未加载会话记 pendingWatermark，返回是否为该 conv 首条。 */
  private recordPending(convId: number, latestSeq: number): void {
    const isNew = !this.pendingWatermarks.has(convId);
    const existing = this.pendingWatermarks.get(convId) ?? 0;
    // 每 conv 只留最大 targetSeq（O(会话数) 常数，防内存膨胀）
    this.pendingWatermarks.set(convId, Math.max(existing, latestSeq));
    if (isNew) {
      this.pendingOrder.push(convId);
      while (this.pendingOrder.length > PENDING_WATERMARK_LIMIT) {
        const oldest = this.pendingOrder.shift();
        if (oldest !== undefined && !this.inflight.has(oldest)) {
          // 丢弃最旧 conv 的 pending（靠重连 Resume 收敛）
          this.pendingWatermarks.delete(oldest);
        }
      }
    }
    this._stats.pendingRecorded += 1;
  }

  /** pending 表快照（hydrate 消费 / 测试观测）。 */
  peekPending(): Array<{ convId: number; targetSeq: number }> {
    return [...this.pendingWatermarks.entries()].map(([convId, targetSeq]) => ({ convId, targetSeq }));
  }

  /**
   * 会话 hydrate 时消费 pending 水位线（bootstrap 在 conv-store upsert 后调用）。
   * 返回被消费的 targetSeq；仍落后于引擎游标的自然被 onWatermark 第 2 步语义丢弃。
   */
  consumePending(convId: number): number | null {
    const targetSeq = this.pendingWatermarks.get(convId);
    if (targetSeq === undefined) return null;
    this.pendingWatermarks.delete(convId);
    const idx = this.pendingOrder.indexOf(convId);
    if (idx >= 0) this.pendingOrder.splice(idx, 1);
    this.onWatermark({ convId, latestSeq: targetSeq });
    return targetSeq;
  }

  /**
   * singleflight + jitter + min_interval 调度。
   * 已有 in-flight → 更新 targetSeq（追赶语义），返回。
   */
  schedulePull(convId: number, targetSeq: number): void {
    const existing = this.inflight.get(convId);
    if (existing) {
      if (targetSeq > existing.targetSeq) existing.targetSeq = targetSeq;
      return;
    }
    const task: PullTask = {
      convId,
      targetSeq,
      timer: null,
      started: false,
      lastSentAt: 0,
    };
    this.inflight.set(convId, task);
    // jitter random(0, 2000ms)：500 人同批水位线在 2s 内均匀摊开（§2.2）
    const delay = Math.floor(this.random() * PULL_JITTER_MS);
    task.timer = setTimeout(() => {
      task.timer = null;
      task.started = true;
      void this.pullLoop(task);
    }, delay);
  }

  /** 拉取循环：8 SYNC → 引擎 ingest（外部路径）→ 未达 target 续拉（受 min_interval）。 */
  private async pullLoop(task: PullTask): Promise<void> {
    for (;;) {
      const lastSeq = this.deps.getLastSeq(task.convId);
      if (lastSeq >= task.targetSeq) {
        // 收敛：水位线消费完成
        this.inflight.delete(task.convId);
        this._stats.converged += 1;
        return;
      }
      const sinceSeq = lastSeq + 1;
      // min_interval：同 conv 两次拉取间隔 ≥ 1000ms（首拉不受限）
      const wait = task.lastSentAt === 0 ? 0 : Math.max(0, PULL_MIN_INTERVAL_MS - (this.now() - task.lastSentAt));
      if (wait > 0) await sleep(wait);
      const sent = this.deps.sendSync(task.convId, sinceSeq, PULL_PAGE_LIMIT);
      if (!sent) {
        // 离线：放弃本轮（下一条水位线 / 兜底轮询 / Resume 收敛）
        this.inflight.delete(task.convId);
        return;
      }
      task.lastSentAt = this.now();
      this._stats.pullsSent += 1;
      // 服务端 catchup 把缺失帧逐条回为 102 MSG_NEW（pipe.go:412），
      // 经 dispatch → ingest 异步落库。等待一拍后重读游标判断是否需要续拉。
      await sleep(PULL_MIN_INTERVAL_MS);
    }
  }

  /** 测试/停机：清空全部任务与 pending（不发请求）。 */
  reset(): void {
    for (const task of this.inflight.values()) {
      if (task.timer !== null) clearTimeout(task.timer);
    }
    this.inflight.clear();
    this.pendingWatermarks.clear();
    this.pendingOrder.length = 0;
    this._stats = {
      watermarksReceived: 0,
      droppedStale: 0,
      pendingRecorded: 0,
      pullsSent: 0,
      converged: 0,
    };
  }

  /** 该 conv 是否有 in-flight 任务（§2.4 退让规则观测用）。 */
  hasInflight(convId: number): boolean {
    return this.inflight.has(convId);
  }

  /** bootstrap 注入真实依赖（单例用）。 */
  reconfigure(deps: PullSchedulerDeps): void {
    Object.assign(this.deps, deps);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 进程内单例：bootstrap 注入依赖（configure），main.tsx 的 14 handler 与 hydrate 路径共享。 */
export const pullScheduler = new PullScheduler({
  getLastSeq: () => 0,
  isConvLoaded: () => false,
  sendSync: () => false,
});

/**
 * configure —— bootstrap 用真实依赖注入单例（与 historyLoader.configure 同风格）。
 * 未注入前为 inert（不加载、不发送），保证误接线时静默安全。
 */
export function configurePullScheduler(deps: PullSchedulerDeps): void {
  (pullScheduler as unknown as { reconfigure: (d: PullSchedulerDeps) => void }).reconfigure(deps);
}
