/**
 * core 领域视图类型（net 的持久化结构 + UI 需要的瞬时字段）。
 */
import type { StoredMessage } from '../net/sync/types';

export interface ChatMessage extends StoredMessage {
  /** `${convId}:${seq}`（服务端）或 `local:${clientMsgId}`（乐观） */
  id: string;
  /** 发送失败原因（仅本地乐观消息） */
  error?: string;
}

export { type ConvRecord, type SyncStateView, type MessageStatus } from '../net/sync/types';
