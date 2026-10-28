/**
 * kind 级 payload 编解码。
 *
 * Envelope.payload 是 bytes；本实现用「JSON 编码的 kind 体」承载（UTF-8），
 * 字段名与 proto/chat.proto 完全同名，便于对照：
 *   MsgNew / MsgAck / Receipt / Resume / ResumeResult / FeatureFlags / Kicked /
 *   ConvPayload / Typing / PresenceUpdate。
 *
 * 生产对接真实后端时，只需把本文件替换为 protobuf-ts 生成物（保持导出的
 * decode 与 encode 签名），handler 与 sync 引擎无需改动 —— 这是唯一与 payload
 * schema 耦合的位置。
 */

export class PayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PayloadError';
  }
}

export type MediaType = 'image' | 'audio' | 'video' | 'file';
export type MediaStatus = 'pending' | 'uploading' | 'ready' | 'expired' | 'failed';

export interface Media {
  mediaId: string;
  type: MediaType;
  name?: string;
  size?: number;
  width?: number;
  height?: number;
  durationMs?: number;
  mime?: string;
  /** 内联缩略图（data URL 或 base64）；列表先用它做低清占位 */
  thumb?: string;
  /** 24 段波形采样 0..1；缺省时渲染器用时长 hash 生成，保证稳定 */
  waveform?: number[];
  /** 可直接播放/下载的地址（mock 演示用 data URL） */
  url?: string;
  status?: MediaStatus;
}

export interface MessageContent {
  clientMsgId: string;
  text: string;
  media: Media[];
  replyTo?: number;
  mentions: number[];
}

export interface MsgNewPayload {
  msgId: number;
  seq: number;
  senderId: number;
  sentAt: number;
  content: MessageContent;
  /** 会话 id：Envelope.target 已有，payload 冗余一份便于 mock/离线重放 */
  convId?: number;
}

export interface MsgAckPayload {
  msgId: number;
  seq: number;
  clientMsgId: string;
  status: number;
}

export interface ReceiptPayload {
  msgId: number;
  userId: number;
  at: number;
  type: 'read' | 'delivered';
}

export interface ResumeResultPayload {
  convId: number;
  fromSeq: number;
  complete: boolean;
  serverSeq: number;
}

export interface FeatureFlagsPayload {
  version: number;
  flags: Record<string, string>;
}

export interface KickedPayload {
  reason: string;
  bannedUntil: number;
}

export interface RateLimitedPayload {
  scope: string;
  limit: number;
  retryAfterMs: number;
}

export interface ErrorPayload {
  code: number;
  reason: string;
  retryAfterMs: number;
}

export interface ConvMember {
  userId: number;
  role: number;
  joinedAt: number;
  mutedUntil: number;
  /** 展示名（客户端扩展；服务端资料域可下发） */
  name?: string;
  avatar?: string;
}

export interface ConvPayload {
  convId: number;
  title: string;
  convType: number;
  createdAt: number;
  members: ConvMember[];
  version: number;
  /** 客户端扩展：服务端下发会话时的游标（缺失则从本地/0 开始） */
  lastSeq?: number;
  unread?: number;
  avatar?: string;
}

export interface TypingPayload {
  convId: number;
  userId: number;
  typing: boolean;
  at?: number;
}

export interface PresencePayload {
  userId: number;
  status: 'offline' | 'online' | 'away';
  at: number;
}

export interface PongPayload {
  clientMs: number;
  serverMs: number;
}

// ---------------------------------------------------------------------------
// JSON 编解码基础设施
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeJsonPayload(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

export function decodeJsonPayload<T>(bytes: Uint8Array): T {
  if (!bytes || bytes.length === 0) throw new PayloadError('empty payload');
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(bytes));
  } catch {
    throw new PayloadError('payload is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object') throw new PayloadError('payload must be an object');
  return parsed as T;
}

function num(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value !== '' && Number.isFinite(Number(value))) return Number(value);
  return fallback;
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

// ---------------------------------------------------------------------------
// 媒体
// ---------------------------------------------------------------------------

const MEDIA_TYPES: MediaType[] = ['image', 'audio', 'video', 'file'];

function mapMediaType(value: unknown): MediaType {
  if (typeof value === 'string' && (MEDIA_TYPES as string[]).includes(value)) {
    return value as MediaType;
  }
  return MEDIA_TYPES[num(value, 3)] ?? 'file';
}

function decodeWaveform(value: unknown): number[] | undefined {
  if (Array.isArray(value)) {
    return value.slice(0, 24).map((v) => Math.max(0, Math.min(1, Number(v) || 0)));
  }
  return undefined;
}

interface RawMedia {
  media_id?: unknown;
  mtype?: unknown;
  name?: unknown;
  size?: unknown;
  width?: unknown;
  height?: unknown;
  duration_ms?: unknown;
  mime?: unknown;
  thumb_inline?: unknown;
  waveform?: unknown;
  status?: unknown;
  url?: unknown;
}

export function mapMedia(raw: RawMedia): Media {
  return {
    mediaId: str(raw.media_id),
    type: mapMediaType(raw.mtype),
    name: str(raw.name) || undefined,
    size: num(raw.size, 0),
    width: num(raw.width, 0),
    height: num(raw.height, 0),
    durationMs: num(raw.duration_ms, 0),
    mime: str(raw.mime) || undefined,
    thumb: str(raw.thumb_inline) || undefined,
    waveform: decodeWaveform(raw.waveform),
    url: str(raw.url) || undefined,
    status: (str(raw.status) || 'ready') as MediaStatus,
  };
}

export function encodeMedia(media: Media): RawMedia {
  return {
    media_id: media.mediaId,
    mtype: media.type,
    name: media.name,
    size: media.size,
    width: media.width,
    height: media.height,
    duration_ms: media.durationMs,
    mime: media.mime,
    thumb_inline: media.thumb,
    waveform: media.waveform,
    status: media.status,
    url: media.url,
  };
}

// ---------------------------------------------------------------------------
// 消息
// ---------------------------------------------------------------------------

interface RawContent {
  client_msg_id?: unknown;
  text?: unknown;
  media?: RawMedia[];
  reply_to?: unknown;
  mentions?: unknown[];
}

export function mapContent(raw: RawContent | undefined): MessageContent {
  return {
    clientMsgId: str(raw?.client_msg_id),
    text: str(raw?.text),
    media: Array.isArray(raw?.media) ? raw!.media.map(mapMedia) : [],
    replyTo: raw?.reply_to ? num(raw.reply_to) : undefined,
    mentions: Array.isArray(raw?.mentions) ? raw!.mentions.map((v) => num(v)) : [],
  };
}

export function encodeContent(content: Partial<MessageContent>): RawContent {
  const raw: RawContent = {
    client_msg_id: content.clientMsgId ?? '',
    text: content.text ?? '',
    media: (content.media ?? []).map(encodeMedia),
    mentions: content.mentions ?? [],
  };
  if (content.replyTo) raw.reply_to = content.replyTo;
  return raw;
}

/**
 * 上行 MSG_SEND(101) payload。
 * 说明：MESSAGE payload 里的 client_msg_id 同时作为 dedupguard 幂等键。
 */
export function encodeMessageSend(input: {
  clientMsgId: string;
  text?: string;
  media?: Media[];
  replyTo?: number;
  mentions?: number[];
}): Uint8Array {
  return encodeJsonPayload(encodeContent(input));
}

/** 下行 MSG_NEW(102) payload -> 领域对象。 */
export function decodeMsgNew(bytes: Uint8Array): MsgNewPayload {
  const raw = decodeJsonPayload<{
    msg_id?: unknown;
    seq?: unknown;
    sender_id?: unknown;
    sent_at?: unknown;
    content?: RawContent;
    conv_id?: unknown;
  }>(bytes);
  const msgId = num(raw.msg_id);
  const seq = num(raw.seq);
  if (!msgId || !seq) throw new PayloadError('MSG_NEW requires msg_id and seq');
  return {
    msgId,
    seq,
    senderId: num(raw.sender_id),
    sentAt: num(raw.sent_at, Date.now()),
    content: mapContent(raw.content),
    convId: raw.conv_id ? num(raw.conv_id) : undefined,
  };
}

export function encodeMsgNew(input: MsgNewPayload): Uint8Array {
  return encodeJsonPayload({
    msg_id: input.msgId,
    seq: input.seq,
    sender_id: input.senderId,
    sent_at: input.sentAt,
    content: encodeContent(input.content),
    conv_id: input.convId,
  });
}

export function decodeMsgAck(bytes: Uint8Array): MsgAckPayload {
  const raw = decodeJsonPayload<Record<string, unknown>>(bytes);
  return {
    msgId: num(raw.msg_id),
    seq: num(raw.seq),
    clientMsgId: str(raw.client_msg_id),
    status: num(raw.status),
  };
}

export function encodeMsgAck(payload: MsgAckPayload): Uint8Array {
  return encodeJsonPayload({
    msg_id: payload.msgId,
    seq: payload.seq,
    client_msg_id: payload.clientMsgId,
    status: payload.status,
  });
}

export function decodeReceipt(bytes: Uint8Array): ReceiptPayload | null {
  const raw = decodeJsonPayload<Record<string, unknown>>(bytes);
  // proto 复用 MessagePayload.receipts：容忍 {"receipts":[...]} 形态。
  if (Array.isArray(raw.receipts) && raw.receipts.length > 0) {
    const first = raw.receipts[0] as Record<string, unknown>;
    return {
      msgId: num(first.msg_id),
      userId: num(first.user_id),
      at: num(first.at, Date.now()),
      type: num(first.rtype) === 0 ? 'read' : 'delivered',
    };
  }
  if (!raw.msg_id) return null;
  return {
    msgId: num(raw.msg_id),
    userId: num(raw.user_id),
    at: num(raw.at, Date.now()),
    type: num(raw.rtype) === 1 ? 'delivered' : 'read',
  };
}

export function encodeReceipt(payload: ReceiptPayload): Uint8Array {
  return encodeJsonPayload({
    msg_id: payload.msgId,
    user_id: payload.userId,
    at: payload.at,
    rtype: payload.type === 'read' ? 0 : 1,
  });
}

export function decodeMsgMutation(bytes: Uint8Array): { msgId: number; convId?: number; text?: string; forEveryone?: boolean } {
  const raw = decodeJsonPayload<Record<string, unknown>>(bytes);
  return {
    msgId: num(raw.msg_id),
    convId: raw.conv_id ? num(raw.conv_id) : undefined,
    text: typeof raw.text === 'string' ? raw.text : undefined,
    forEveryone: bool(raw.for_everyone),
  };
}

// ---------------------------------------------------------------------------
// 连接 / 同步
// ---------------------------------------------------------------------------

export function encodeResume(input: { sessionId: string; convId: number; lastSeq: number }): Uint8Array {
  return encodeJsonPayload({
    session_id: input.sessionId,
    conv_id: input.convId,
    last_seq: input.lastSeq,
  });
}

export function decodeResumeResult(bytes: Uint8Array): ResumeResultPayload {
  const raw = decodeJsonPayload<Record<string, unknown>>(bytes);
  return {
    convId: num(raw.conv_id),
    fromSeq: num(raw.from_seq),
    complete: bool(raw.complete),
    serverSeq: num(raw.server_seq),
  };
}

export function decodeFeatureFlags(bytes: Uint8Array): FeatureFlagsPayload {
  const raw = decodeJsonPayload<{ version?: unknown; flags?: Record<string, string> }>(bytes);
  return {
    version: num(raw.version),
    flags: raw.flags && typeof raw.flags === 'object' ? raw.flags : {},
  };
}

export function decodeKicked(bytes: Uint8Array): KickedPayload {
  const raw = decodeJsonPayload<Record<string, unknown>>(bytes);
  return {
    reason: str(raw.reason, 'KICKED'),
    bannedUntil: num(raw.banned_until),
  };
}

export function decodeRateLimited(bytes: Uint8Array): RateLimitedPayload {
  const raw = decodeJsonPayload<Record<string, unknown>>(bytes);
  return {
    scope: str(raw.scope),
    limit: num(raw.limit),
    retryAfterMs: num(raw.retry_after_ms, 1000),
  };
}

export function decodeError(bytes: Uint8Array): ErrorPayload {
  const raw = decodeJsonPayload<Record<string, unknown>>(bytes);
  return {
    code: num(raw.code),
    reason: str(raw.reason),
    retryAfterMs: num(raw.retry_after_ms),
  };
}

// ---------------------------------------------------------------------------
// 会话 / presence
// ---------------------------------------------------------------------------

export function decodeConvPayload(bytes: Uint8Array): ConvPayload {
  const raw = decodeJsonPayload<{
    conv_id?: unknown;
    title?: unknown;
    conv_type?: unknown;
    created_at?: unknown;
    members?: Array<Record<string, unknown>>;
    version?: unknown;
    last_seq?: unknown;
    unread?: unknown;
    avatar?: unknown;
  }>(bytes);
  return {
    convId: num(raw.conv_id),
    title: str(raw.title),
    convType: num(raw.conv_type),
    createdAt: num(raw.created_at, Date.now()),
    members: (raw.members ?? []).map((m) => ({
      userId: num(m.user_id),
      role: num(m.role),
      joinedAt: num(m.joined_at),
      mutedUntil: num(m.muted_until),
      name: typeof m.name === 'string' ? m.name : undefined,
      avatar: typeof m.avatar === 'string' ? m.avatar : undefined,
    })),
    version: num(raw.version),
    lastSeq: raw.last_seq === undefined ? undefined : num(raw.last_seq),
    unread: raw.unread === undefined ? undefined : num(raw.unread),
    avatar: str(raw.avatar) || undefined,
  };
}

export function encodeConvPayload(payload: ConvPayload): Uint8Array {
  return encodeJsonPayload({
    conv_id: payload.convId,
    title: payload.title,
    conv_type: payload.convType,
    created_at: payload.createdAt,
    members: payload.members.map((m) => ({
      user_id: m.userId,
      role: m.role,
      joined_at: m.joinedAt,
      muted_until: m.mutedUntil,
      name: m.name,
      avatar: m.avatar,
    })),
    version: payload.version,
    last_seq: payload.lastSeq,
    unread: payload.unread,
    avatar: payload.avatar,
  });
}

export function decodeTyping(bytes: Uint8Array): TypingPayload {
  const raw = decodeJsonPayload<Record<string, unknown>>(bytes);
  return {
    convId: num(raw.conv_id),
    userId: num(raw.user_id),
    typing: bool(raw.typing),
    at: num(raw.at, Date.now()),
  };
}

export function decodePresence(bytes: Uint8Array): PresencePayload {
  const raw = decodeJsonPayload<Record<string, unknown>>(bytes);
  const status = str(raw.status, 'offline');
  return {
    userId: num(raw.user_id),
    status: status === 'online' || status === 'away' ? status : 'offline',
    at: num(raw.at, Date.now()),
  };
}

export function decodePong(bytes: Uint8Array): PongPayload {
  const raw = decodeJsonPayload<Record<string, unknown>>(bytes);
  return { clientMs: num(raw.client_ms), serverMs: num(raw.server_ms) };
}

export function encodePing(clientMs: number): Uint8Array {
  return encodeJsonPayload({ client_ms: clientMs });
}

export function decodePing(bytes: Uint8Array): { clientMs: number } {
  const raw = decodeJsonPayload<Record<string, unknown>>(bytes);
  return { clientMs: num(raw.client_ms) };
}

/** 上行 MSG_SEND(101) payload -> 内容（mockBridge / 发送队列观测用）。 */
export function decodeMessageSend(bytes: Uint8Array): MessageContent {
  return mapContent(decodeJsonPayload<RawContent>(bytes));
}

export function decodeResumeRequest(bytes: Uint8Array): { sessionId: string; convId: number; lastSeq: number } {
  const raw = decodeJsonPayload<Record<string, unknown>>(bytes);
  return {
    sessionId: str(raw.session_id),
    convId: num(raw.conv_id),
    lastSeq: num(raw.last_seq),
  };
}

export function encodeSyncRequest(input: { convId: number; sinceSeq: number; limit?: number }): Uint8Array {
  return encodeJsonPayload({
    conv_id: input.convId,
    since_seq: input.sinceSeq,
    limit: input.limit ?? 100,
  });
}

export function decodeSyncRequest(bytes: Uint8Array): { convId: number; sinceSeq: number; limit: number } {
  const raw = decodeJsonPayload<Record<string, unknown>>(bytes);
  return {
    convId: num(raw.conv_id),
    sinceSeq: num(raw.since_seq),
    limit: num(raw.limit, 100),
  };
}

export function encodeFeatureFlags(flags: Record<string, string>, version: number): Uint8Array {
  return encodeJsonPayload({ version, flags });
}

export function encodeTyping(convId: number, userId: number, typing: boolean): Uint8Array {
  return encodeJsonPayload({ conv_id: convId, user_id: userId, typing, at: Date.now() });
}

export function encodePresence(userId: number, status: 'online' | 'away' | 'offline'): Uint8Array {
  return encodeJsonPayload({ user_id: userId, status, at: Date.now() });
}

export function encodeResumeResult(payload: ResumeResultPayload): Uint8Array {
  return encodeJsonPayload({
    conv_id: payload.convId,
    from_seq: payload.fromSeq,
    complete: payload.complete,
    server_seq: payload.serverSeq,
  });
}

export function encodePong(clientMs: number, serverMs: number): Uint8Array {
  return encodeJsonPayload({ client_ms: clientMs, server_ms: serverMs });
}
