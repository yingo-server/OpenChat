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
 *
 * ---------------------------------------------------------------------------
 * wire 字段命名（单一形态，无 pick() 双收）：
 *  - data 层 wire JSON（server/internal/data/pipe/wire/wire.go 的 json tag）
 *    为准，lowerCamelCase：MsgAck{msgId,seq,clientMsgId,status}、
 *    Error{code,reason,retryAfterMs}、DataResult{op,ok,error,body,requestId}、
 *    ConvPayload{convId,title,convType,createdAt,members{userId,role,joinedAt,
 *    mutedUntil}}、ConvCreate{memberIds,convType}、ReadHistory{convId,sinceSeq,
 *    limit}。
 *  - 例外：MSG_NEW(102) 与其内嵌 content/media 保持 snake_case ——
 *    server/internal/data/pipe/flusher.go:137 buildMsgNewPayload 有意输出
 *    protojson 同名的 snake_case（client_msg_id/msg_id/seq/sender_id/sent_at/
 *    conv_id/media{media_id,mtype,thumb_inline,duration_ms}/reply_to/mentions），
 *    上行 MSG_SEND(101) 同形（服务端 payloadForPipe 对 snake/camel 均收，
 *    但落库归一为 snake_case）。
 *  - 服务端只有 protobuf 定义、无 JSON 生产者的 kind（TYPING/PRESENCE/PONG/
 *    RESUME/SYNC_REQUEST/RECEIPT/MSG_EDIT 等）：JSON 形态仅用于 mockBridge，
 *    字段名沿用 proto/chat.proto 的 snake_case（与 proto 字段同名便于对照）。
 */

import { base64ToBytes, bytesToBase64 } from './codec';

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
  /** 24 段波形采样 0..100 整数（与服务端 0-100 校验区间一致）；缺省时渲染器用时长 hash 生成 */
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

/**
 * 领域类型 → wire mtype 数字（与服务端 mediasvc 分类 + chatpb.Media 语义一致）：
 *   1 image / 2 audio / 3 video / 4 file。
 * 上行 MSG_SEND 与服务端下行 MSG_NEW 都必须用数字：服务端 wire.go 用
 * `MType int32` 解析，发字符串会导致 json.Unmarshal 整体失败、payload 原样
 * 透传、对端收到空消息（P0-1）。
 */
const MTYPE_OF_TYPE: Record<MediaType, number> = {
  image: 1,
  audio: 2,
  video: 3,
  file: 4,
};

const TYPE_OF_MTYPE: Record<number, MediaType> = {
  1: 'image',
  2: 'audio',
  3: 'video',
  4: 'file',
};

/** 领域媒体类型 → wire mtype 数字（image→1 / audio→2 / video→3 / file→4）。 */
export function mediaTypeToMtype(type: MediaType): number {
  return MTYPE_OF_TYPE[type] ?? 4;
}

/** wire mtype 数字 → 领域媒体类型；未知值回退为 file。 */
export function mtypeToMediaType(mtype: number): MediaType {
  return TYPE_OF_MTYPE[mtype] ?? 'file';
}

function mapMediaType(value: unknown): MediaType {
  // 服务端下行（buildMsgNewPayload / wire.Media）是数字 mtype。
  if (typeof value === 'number' && Number.isFinite(value)) return mtypeToMediaType(value);
  // 兼容旧/演示数据里的字符串形态（'image'|'audio'|'video'|'file'）。
  if (typeof value === 'string') {
    if ((MEDIA_TYPES as string[]).includes(value)) return value as MediaType;
    const asNum = Number(value);
    if (Number.isFinite(asNum)) return mtypeToMediaType(asNum);
  }
  return 'file';
}

/** 波形采样统一到 0-100 整数（服务端 validateThumbWaveform 校验区间）。 */
function decodeWaveform(value: unknown): number[] | undefined {
  if (Array.isArray(value)) {
    return value.slice(0, 24).map((v) => Math.round(Math.max(0, Math.min(100, Number(v) || 0))));
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
    mtype: mediaTypeToMtype(media.type),
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
  // wire.MsgAck (wire.go:39)：camelCase 单态。snake 输入不再兜底。
  const raw = decodeJsonPayload<Record<string, unknown>>(bytes);
  return {
    msgId: num(raw.msgId),
    seq: num(raw.seq),
    clientMsgId: str(raw.clientMsgId),
    status: num(raw.status),
  };
}

export function encodeMsgAck(payload: MsgAckPayload): Uint8Array {
  return encodeJsonPayload({
    msgId: payload.msgId,
    seq: payload.seq,
    clientMsgId: payload.clientMsgId,
    status: payload.status,
  });
}

/**
 * MSG_READ(104) / MSG_DELIVERED(105) payload → 回执数组。
 * proto 复用 MessagePayload.receipts：可能是 {"receipts":[...]} 批量形态，
 * 也可能是单条扁平形态。返回数组，由 handler 逐条应用（P1：不丢批次内后续回执）。
 */
export function decodeReceipt(bytes: Uint8Array): ReceiptPayload[] {
  const raw = decodeJsonPayload<Record<string, unknown>>(bytes);
  const mapRow = (row: Record<string, unknown>): ReceiptPayload => ({
    msgId: num(row.msg_id),
    userId: num(row.user_id),
    at: num(row.at, Date.now()),
    type: num(row.rtype) === 1 ? 'delivered' : 'read',
  });
  if (Array.isArray(raw.receipts)) {
    return (raw.receipts as Array<Record<string, unknown>>)
      .map(mapRow)
      .filter((receipt) => receipt.msgId > 0);
  }
  if (!raw.msg_id) return [];
  return [mapRow(raw)];
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
  // wire.Error (wire.go:47)：camelCase 单态。
  const raw = decodeJsonPayload<Record<string, unknown>>(bytes);
  return {
    code: num(raw.code),
    reason: str(raw.reason),
    retryAfterMs: num(raw.retryAfterMs),
  };
}

// ---------------------------------------------------------------------------
// 会话 / presence
// ---------------------------------------------------------------------------

/**
 * 数据层 wire JSON 统一 camelCase（wire.go json tag）。
 * 旧 pick(snake, camel) 双收已删除 —— 单态契约，snake 输入一律按缺失处理。
 */
/** 秒级时间戳（服务端 conv.go nowSec()）自动升级为毫秒（前端展示统一用 ms）。 */
function millis(value: unknown, fallback = 0): number {
  const v = num(value, fallback);
  return v > 0 && v < 1e12 ? v * 1000 : v;
}

/**
 * wire.ConvPayload (wire.go:128) + data 层时间戳语义（conv.go nowSec()：秒）：
 * camelCase 单态，秒级时间戳升毫秒。snake_case 输入不再兜底（P1-3 收敛，
 * 权威清单 server/internal/data/pipe/wire/wire.go json tag）。
 */
export function decodeConvPayload(bytes: Uint8Array): ConvPayload {
  const raw = decodeJsonPayload<Record<string, unknown>>(bytes);
  const memberRows = Array.isArray(raw.members) ? (raw.members as Array<Record<string, unknown>>) : [];
  return {
    convId: num(raw.convId),
    title: str(raw.title),
    convType: num(raw.convType),
    createdAt: millis(raw.createdAt, Date.now()),
    members: memberRows.map((m) => ({
      userId: num(m.userId),
      role: num(m.role),
      joinedAt: millis(m.joinedAt),
      mutedUntil: millis(m.mutedUntil),
      name: typeof m.name === 'string' ? m.name : undefined,
      avatar: typeof m.avatar === 'string' ? m.avatar : undefined,
    })),
    version: num(raw.version),
    lastSeq: raw.lastSeq === undefined ? undefined : num(raw.lastSeq),
    unread: raw.unread === undefined ? undefined : num(raw.unread),
    avatar: str(raw.avatar) || undefined,
  };
}

export function encodeConvPayload(payload: ConvPayload): Uint8Array {
  return encodeJsonPayload({
    convId: payload.convId,
    title: payload.title,
    convType: payload.convType,
    createdAt: payload.createdAt,
    members: payload.members.map((m) => ({
      userId: m.userId,
      role: m.role,
      joinedAt: m.joinedAt,
      mutedUntil: m.mutedUntil,
      name: m.name,
      avatar: m.avatar,
    })),
    version: payload.version,
    lastSeq: payload.lastSeq,
    unread: payload.unread,
    avatar: payload.avatar,
  });
}

// ---------------------------------------------------------------------------
// 会话创建 / 930-931 数据结果
// ---------------------------------------------------------------------------

export interface ConvCreateInput {
  title?: string;
  /** proto 语义：1 单聊 / 2 群聊 */
  convType: number;
  memberIds: number[];
}

export function encodeConvCreate(input: ConvCreateInput): Uint8Array {
  // 服务端 convKindToPipe (cmd/chatd/wire.go:176) 接收 camelCase JSON 分支。
  return encodeJsonPayload({
    title: input.title ?? '',
    convType: input.convType,
    memberIds: input.memberIds,
  });
}

export function decodeConvCreate(bytes: Uint8Array): ConvCreateInput {
  const raw = decodeJsonPayload<Record<string, unknown>>(bytes);
  const ids = raw.memberIds;
  return {
    title: str(raw.title),
    convType: num(raw.convType),
    memberIds: Array.isArray(ids) ? ids.map((v) => num(v)) : [],
  };
}

export interface DataResultPayload {
  op: number;
  ok: boolean;
  error?: string;
  body?: Uint8Array;
  requestId?: string;
}

export function decodeDataResult(bytes: Uint8Array): DataResultPayload {
  // wire.DataResult (wire.go:81)：camelCase 单态。body 是 base64 的 JSON bytes。
  const raw = decodeJsonPayload<Record<string, unknown>>(bytes);
  let body: Uint8Array | undefined;
  if (typeof raw.body === 'string' && raw.body.length > 0) {
    body = base64ToBytes(raw.body);
  } else if (raw.body instanceof Uint8Array) {
    body = raw.body;
  }
  return {
    op: num(raw.op),
    ok: bool(raw.ok),
    error: str(raw.error),
    body,
    requestId: str(raw.requestId),
  };
}

export function encodeDataResult(input: DataResultPayload): Uint8Array {
  return encodeJsonPayload({
    op: input.op,
    ok: input.ok,
    error: input.error ?? '',
    body: input.body ? bytesToBase64(input.body) : '',
    requestId: input.requestId ?? '',
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

/**
 * PRESENCE_UPDATE(400) / PRESENCE_SUBSCRIBE(401) / PRESENCE_UNSUBSCRIBE(402) payload。
 *
 * 服务端有两种形态（wire.PresenceSignal，见 data/pipe/wire/wire.go:201）：
 *  - 400 上行广播：{user_id, status:'online'|'away'|'offline', at}
 *  - 401/402 连接/断开：{user_id, online:bool, at}
 * 只读 status 会把 online:true 解析成 offline（P0-2），故同时兼容布尔 online。
 */
export function decodePresence(bytes: Uint8Array): PresencePayload {
  const raw = decodeJsonPayload<Record<string, unknown>>(bytes);
  let status: PresencePayload['status'] = 'offline';
  if (typeof raw.online === 'boolean') {
    // 401/402 形态：布尔 online（true→online, false→offline）。
    status = raw.online ? 'online' : 'offline';
  } else {
    const value = str(raw.status, 'offline');
    status = value === 'online' || value === 'away' ? value : 'offline';
  }
  return {
    userId: num(raw.user_id),
    status,
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
    convId: input.convId,
    sinceSeq: input.sinceSeq,
    limit: input.limit ?? 100,
  });
}

export function decodeSyncRequest(bytes: Uint8Array): { convId: number; sinceSeq: number; limit: number } {
  const raw = decodeJsonPayload<Record<string, unknown>>(bytes);
  return {
    convId: num(raw.convId, num(raw.conv_id)),
    sinceSeq: num(raw.sinceSeq, num(raw.since_seq)),
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
