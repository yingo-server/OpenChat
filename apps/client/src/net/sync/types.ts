/**
 * 同步域数据契约（net/sync 与 core/message-store 共享）。
 * 这些结构同时是 IndexedDB 的持久化结构 —— 字段变更需迁移版本。
 */
import type { Media } from '../proto/payload';

export type MessageStatus = 'sending' | 'sent' | 'delivered' | 'read' | 'failed';

/** 已落库的消息（IndexedDB messages store 的一条记录）。 */
export interface StoredMessage {
  convId: number;
  /** 会话内连续 seq；本地乐观消息不落库，故恒 > 0 */
  seq: number;
  msgId: number;
  senderId: number;
  sentAt: number;
  /** 渲染器类型：text / image / audio / video / file / system */
  type: string;
  /** kind 体解码后的展示字段（text/media/replyTo/mentions…） */
  payload: MessagePayloadView;
  status: MessageStatus;
  clientMsgId?: string;
  deleted?: boolean;
  /** MSG_EDIT 后的版本号（可选） */
  editedAt?: number;
}

export interface MessagePayloadView {
  text?: string;
  media?: Media[];
  replyTo?: number;
  mentions?: number[];
  [key: string]: unknown;
}

export interface ConvMemberView {
  userId: number;
  role: number;
  joinedAt: number;
  mutedUntil: number;
  name?: string;
  avatar?: string;
}

/** IndexedDB convs store 的一条记录（会话元数据 + 同步游标）。 */
export interface ConvRecord {
  convId: number;
  title: string;
  convType: number;
  createdAt: number;
  members: ConvMemberView[];
  version: number;
  /** 该会话已连续收到的最新 seq（RESUME 的起点） */
  lastSeq: number;
  unread: number;
  avatar?: string;
  updatedAt: number;
  lastMessageAt?: number;
  /** 文本摘要（媒体消息为空，由 lastMessageType 决定展示 [图片]/[语音]） */
  lastPreview?: string;
  lastMessageType?: string;
  lastSenderId?: number;
  pinned?: boolean;
  muted?: boolean;
}

export interface HydratedCache {
  convs: ConvRecord[];
  /** 每个会话最近 N 条，升序 */
  messages: StoredMessage[];
}

export interface SyncStateView {
  lastSeq: number;
  status: 'idle' | 'syncing' | 'gapped' | 'error';
  /** 服务端上报的当前 seq（RESUME_RESULT.server_seq） */
  serverSeq?: number;
}

export interface GapRange {
  from: number;
  to: number;
}

export interface IngestOutcome {
  accepted: number;
  buffered: number;
  duplicate: number;
  gap?: GapRange;
  lastSeq: number;
}
