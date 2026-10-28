/**
 * 传输层统一契约：真实 WS 与 mockBridge 实现同一接口。
 * 上层（main.tsx 接线、handlers、sync）只依赖 NetClient，不感知具体传输。
 */
import type { Envelope } from '../proto/codec';

export type ConnState = 'connecting' | 'online' | 'offline' | 'reconnecting';

export interface ResumeTicket {
  convId: number;
  lastSeq: number;
}

export interface ConnStateMeta {
  /** 连续失败次数（成功连接后归零） */
  attempt: number;
  /** 最近一次断开原因（close code / offline 事件 / heartbeat） */
  reason?: string;
  /** 心跳 RTT（ms） */
  latencyMs?: number;
  at: number;
}

export type FrameListener = (env: Envelope) => void;
export type StateListener = (state: ConnState, meta: ConnStateMeta) => void;

export interface NetClient {
  readonly state: ConnState;
  readonly latencyMs: number;
  start(): void;
  stop(): void;
  /** 编码并发送；未连接返回 false（不缓冲，缓冲由 outbox 负责） */
  send(env: Envelope): boolean;
  onFrame(listener: FrameListener): () => void;
  onState(listener: StateListener): () => void;
  /** 同步引擎把每个会话的 last_seq 提供给它，重连时逐会话 RESUME */
  setResumeProvider(provider: () => ResumeTicket[]): void;
}
