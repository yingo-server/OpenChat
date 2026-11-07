/**
 * mailbox 游标收敛状态机（docs/v3-bus-design.md §2/§4 P1 客户端先行部分）。
 *
 * 职责：
 *  - 记录本端已消费到的 mailbox_seq（lastConsumed / lastAcked 单调游标）；
 *  - ingest 成功收敛后上报 kind 15 MAILBOX_ACK（cursor 单调，绝不回退）；
 *  - 重连/启动时发 kind 17 MAILBOX_RESUME 续传（cursor = lastConsumed）；
 *  - 重复/乱序（seq <= 游标）的 mailbox 条目直接丢弃，不进 ingest。
 *
 * 铁律：
 *  - 本模块**绝不绕过 engine.ingest 写缓存**——只做游标与 ACK/RESUME 决策；
 *    数据帧一律经 dispatch → handleMsgNew → engine.ingest 落库（single-writer）。
 *  - 依赖注入（与 pull-scheduler/history-loader 同风格）：未 configure 前为 inert。
 *
 * mailbox_seq 与 conv seq 分离（§2.1）：mailbox_seq 是投递序号（user 维度），
 * conv seq 是存储序号（conv 维度）；二者只在 ingest outcome 的 lastSeq 上汇合。
 */
import { KINDS } from '../protocol/kinds';
import { createEnvelope } from '../proto/codec';
import { encodeMailboxAck, encodeMailboxResume } from '../proto/payload';
import type { NetClient } from '../transport/types';

/** 依赖端口（bootstrap / 单测注入）。 */
export interface MailboxSyncDeps {
  /** 发送帧；返回 false（离线/未连接）时本次动作放弃（不重试，靠下一条收敛/重连覆盖）。 */
  send: (kind: number, payload: Uint8Array) => boolean;
  /** 引擎游标快照：全 conv lastSeq 之和 + 已加载会话数（诊断观测用，不参与游标决策）。 */
  engineLastSeq?: (convId: number) => number;
  /** 时间源（ms，单测注入 fake 时钟）。 */
  now?: () => number;
}

export interface MailboxSyncStats {
  /** 收到并接受的 mailbox 条目数（seq > 游标） */
  ingested: number;
  /** 因重复/乱序被丢弃的条目数（seq <= 游标） */
  droppedStale: number;
  /** 已发出的 kind 15 ACK 数 */
  acksSent: number;
  /** 已发出的 kind 17 续传数 */
  resumesSent: number;
  /** 游标推进次数 */
  advanced: number;
}

/**
 * 状态机状态：
 *   idle    —— 未连接/未收到任何 mailbox 条目；
 *   running —— 已有游标，正常消费、ACK；
 *   resumed —— 重连后已发 kind 17，等待续传帧。
 */
export type MailboxSyncState = 'idle' | 'running' | 'resumed';

export class MailboxSync {
  private readonly deps: MailboxSyncDeps;
  private readonly now: () => number;

  /** 已消费到的最大 mailbox_seq（单调不回退；持久化是服务端 Resume 的职责） */
  private lastConsumed = 0;
  /** 已 ACK 的游标（<= lastConsumed；ACK 合并窗口用） */
  private lastAcked = 0;
  private _state: MailboxSyncState = 'idle';
  /** ACK 合并窗口：pending 差量达到该值才发 kind 15（避免逐条 ACK 风暴） */
  private readonly ackWindow: number;

  private _stats: MailboxSyncStats = {
    ingested: 0,
    droppedStale: 0,
    acksSent: 0,
    resumesSent: 0,
    advanced: 0,
  };

  constructor(deps: MailboxSyncDeps = { send: () => false }, options: { ackWindow?: number } = {}) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.ackWindow = options.ackWindow ?? 1;
  }

  get state(): MailboxSyncState {
    return this._state;
  }

  get cursor(): number {
    return this.lastConsumed;
  }

  get lastAckedCursor(): number {
    return this.lastAcked;
  }

  get stats(): Readonly<MailboxSyncStats> {
    return this._stats;
  }

  /**
   * mailbox 条目到达（kind 102/103 等数据帧携带 mailbox_seq 时由 handler 调用；
   * 也接受纯游标帧）。重复/乱序（seq <= 游标）直接丢弃。
   *
   * 注意：这里**不**写缓存——数据本体必须已经/即将经 engine.ingest 落库，
   * 本方法只负责游标推进与 ACK 决策。ingest 失败时调用方不应调用本方法。
   */
  ingest(seq: number): boolean {
    if (!Number.isFinite(seq) || seq <= 0) return false;
    if (seq <= this.lastConsumed) {
      // 重复/乱序：丢弃（服务端重投/重连重叠窗口），游标不动
      this._stats.droppedStale += 1;
      return false;
    }
    this.lastConsumed = seq;
    this._stats.ingested += 1;
    this._stats.advanced += 1;
    if (this._state === 'idle') this._state = 'running';
    this.maybeAck();
    return true;
  }

  /**
   * 显式上报（ingest 收敛后的批量 ACK 入口）：把 lastConsumed 全量上报为 kind 15。
   * cursor 单调：<= lastAcked 时跳过（幂等，服务端 max 语义，乱序无害）。
   */
  ack(cursor = this.lastConsumed): boolean {
    if (cursor <= this.lastAcked) return false;
    if (cursor > this.lastConsumed) return false; // 越过游标 = 逻辑错误，拒绝
    const sent = this.deps.send(KINDS.MAILBOX_ACK, encodeMailboxAck(cursor));
    if (sent) {
      this.lastAcked = cursor;
      this._stats.acksSent += 1;
    }
    return sent;
  }

  /** pending 差量达到窗口才发 ACK；窗口=1 时逐条收敛即报。 */
  private maybeAck(): void {
    if (this.lastConsumed - this.lastAcked >= this.ackWindow) this.ack();
  }

  /**
   * 重连/连接建立：发 kind 17 MAILBOX_RESUME {cursor: lastConsumed} 请求续传。
   * 游标为 0（首次连接）时跳过——服务端从 head 推送即可，无需续传帧。
   */
  resume(limit?: number): boolean {
    if (this.lastConsumed <= 0) return false;
    const sent = this.deps.send(KINDS.MAILBOX_RESUME, encodeMailboxResume(this.lastConsumed, limit));
    if (sent) {
      this._state = 'resumed';
      this._stats.resumesSent += 1;
    }
    return sent;
  }

  /** 连接状态回调：offline → idle（游标保留，内存态即重连续传依据）；online → 发 kind 17。 */
  onConnState(state: 'online' | 'offline'): void {
    if (state === 'offline') {
      this._state = 'idle';
      return;
    }
    if (this.lastConsumed > 0) this.resume();
  }

  /** 诊断/测试：当前游标快照。 */
  snapshot(): { state: MailboxSyncState; lastConsumed: number; lastAcked: number } {
    return { state: this._state, lastConsumed: this.lastConsumed, lastAcked: this.lastAcked };
  }

  /** 测试/登出：游标与统计清零（mailbox 游标属会话态，不落客户端持久层）。 */
  reset(): void {
    this.lastConsumed = 0;
    this.lastAcked = 0;
    this._state = 'idle';
    this._stats = { ingested: 0, droppedStale: 0, acksSent: 0, resumesSent: 0, advanced: 0 };
  }
}

function noopSend(): boolean {
  return false;
}

/** 进程内单例：bootstrap 注入依赖（configure），main.tsx 的 15/16/17 handler 与重连路径共享。 */
export const mailboxSync = new MailboxSync({ send: noopSend });

/**
 * configure —— bootstrap 用真实依赖注入单例（与 configurePullScheduler 同风格）。
 * 未注入前为 inert（不发送），保证误接线时静默安全。
 */
export function configureMailboxSync(deps: MailboxSyncDeps, options?: { ackWindow?: number }): void {
  const instance = mailboxSync as unknown as {
    deps: MailboxSyncDeps;
    ackWindow: number;
  };
  instance.deps = deps;
  if (options?.ackWindow !== undefined) instance.ackWindow = options.ackWindow;
}

/** 便捷入口：经 NetClient 发送 mailbox 控制帧（bootstrap 注入用）。 */
export function sendMailboxFrame(net: NetClient, kind: number, payload: Uint8Array): boolean {
  return net.send(createEnvelope({ kind, payload }));
}
