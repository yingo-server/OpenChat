/**
 * Envelope 编解码 —— 与后端 wire 兼容的最小实现。
 *
 * 后端 Envelope（proto/chat.proto）字段：
 *   id/ack_id(u64) kind/version(u32) request_id(string) flags(u32)
 *   sent_at(fixed64 ms) target oneof(conv_id=10 | user_id=11) payload(bytes=15)
 *
 * 两种格式，按设计文档「JSON+base64 payload」推荐实现：
 *  1) `encodeEnvelope` / `decodeEnvelope`：JSON 文本帧。字段名与 proto 完全同名
 *     (snake_case)，payload 走 base64。这是本前端与 mockBridge/本地开发的默认格式，
 *     浏览器无需 protobuf runtime 即可跑通完整链路。
 *  2) `encodeEnvelopeProto` / `decodeEnvelopeProto`：字节级 protobuf wire 编码，
 *     字段号与 proto/chat.proto 一致，可直接对接后端 usergw（无 protoc 依赖）。
 *
 * 两种格式共享同一个 Envelope 结构，切换只发生在 transport 层（NetClient 构造参数），
 * 业务 handler / sync 引擎不感知 wire 格式。
 *
 * 注意：JS number 精确表达 uint64 的上限是 2^53-1；帧 id / 会话 id 远小于该值。
 * 若未来出现 >2^53 的 id，需要把 Envelope 的 id 系字段升级为 bigint（协议层预留）。
 */

export const PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 64 * 1024; // usergw codec 的 64KB 上限

export interface Envelope {
  id: number;
  ackId: number;
  kind: number;
  version: number;
  requestId: string;
  flags: number;
  sentAt: number;
  /** oneof target：与 userId 互斥；undefined 表示无目标（广播/控制帧） */
  convId?: number;
  userId?: number;
  payload: Uint8Array;
}

export type EnvelopeInit = Partial<Omit<Envelope, 'payload'>> & {
  payload?: Uint8Array;
};

/** 构造帧：补齐协议默认值。id 由调用方（conn 层）递增分配。 */
export function createEnvelope(init: EnvelopeInit = {}): Envelope {
  return {
    id: init.id ?? 0,
    ackId: init.ackId ?? 0,
    kind: init.kind ?? 0,
    version: init.version ?? PROTOCOL_VERSION,
    requestId: init.requestId ?? '',
    flags: init.flags ?? 0,
    sentAt: init.sentAt ?? Date.now(),
    convId: init.convId,
    userId: init.userId,
    payload: init.payload ?? new Uint8Array(0),
  };
}

export class CodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodecError';
  }
}

// ---------------------------------------------------------------------------
// base64（浏览器 / node / vitest 通用，无 Buffer 依赖）
// ---------------------------------------------------------------------------

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP: Record<string, number> = {};
for (let i = 0; i < B64_ALPHABET.length; i += 1) B64_LOOKUP[B64_ALPHABET[i]] = i;

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const triplet = (b0 << 16) | (b1 << 8) | b2;
    out += B64_ALPHABET[(triplet >> 18) & 63];
    out += B64_ALPHABET[(triplet >> 12) & 63];
    out += i + 1 < bytes.length ? B64_ALPHABET[(triplet >> 6) & 63] : '=';
    out += i + 2 < bytes.length ? B64_ALPHABET[triplet & 63] : '=';
  }
  return out;
}

export function base64ToBytes(text: string): Uint8Array {
  const clean = text.replace(/[\r\n\s]/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = clean.endsWith('=') ? clean : clean + '='.repeat((4 - (clean.length % 4)) % 4);
  if (padded.length % 4 !== 0) throw new CodecError('invalid base64 length');
  let outLen = (padded.length / 4) * 3;
  if (padded.endsWith('==')) outLen -= 2;
  else if (padded.endsWith('=')) outLen -= 1;
  const out = new Uint8Array(outLen);
  let o = 0;
  for (let i = 0; i < padded.length; i += 4) {
    const c0 = B64_LOOKUP[padded[i]];
    const c1 = B64_LOOKUP[padded[i + 1]];
    const c2 = padded[i + 2] === '=' ? 0 : B64_LOOKUP[padded[i + 2]];
    const c3 = padded[i + 3] === '=' ? 0 : B64_LOOKUP[padded[i + 3]];
    if (c0 === undefined || c1 === undefined || c2 === undefined || c3 === undefined) {
      throw new CodecError('invalid base64 character');
    }
    const triplet = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
    if (o < outLen) out[o++] = (triplet >> 16) & 0xff;
    if (o < outLen) out[o++] = (triplet >> 8) & 0xff;
    if (o < outLen) out[o++] = triplet & 0xff;
  }
  return out;
}

// ---------------------------------------------------------------------------
// JSON + base64（默认格式）
// ---------------------------------------------------------------------------

interface EnvelopeJson {
  id: number;
  ack_id: number;
  kind: number;
  version: number;
  request_id: string;
  flags: number;
  sent_at: number;
  conv_id?: number;
  user_id?: number;
  payload: string;
}

export function envelopeToJson(env: Envelope): EnvelopeJson {
  const json: EnvelopeJson = {
    id: env.id,
    ack_id: env.ackId,
    kind: env.kind,
    version: env.version,
    request_id: env.requestId,
    flags: env.flags,
    sent_at: env.sentAt,
    payload: bytesToBase64(env.payload),
  };
  if (env.convId !== undefined) json.conv_id = env.convId;
  if (env.userId !== undefined) json.user_id = env.userId;
  return json;
}

export function envelopeFromJson(json: EnvelopeJson): Envelope {
  return createEnvelope({
    id: numberField(json.id),
    ackId: numberField(json.ack_id),
    kind: numberField(json.kind),
    version: json.version === undefined ? PROTOCOL_VERSION : numberField(json.version),
    requestId: typeof json.request_id === 'string' ? json.request_id : '',
    flags: json.flags === undefined ? 0 : numberField(json.flags),
    sentAt: numberField(json.sent_at),
    convId: json.conv_id === undefined || json.conv_id === null ? undefined : numberField(json.conv_id),
    userId: json.user_id === undefined || json.user_id === null ? undefined : numberField(json.user_id),
    payload: typeof json.payload === 'string' ? base64ToBytes(json.payload) : new Uint8Array(0),
  });
}

/** Envelope -> JSON 文本（WebSocket text frame）。 */
export function encodeEnvelope(env: Envelope): string {
  const text = JSON.stringify(envelopeToJson(env));
  assertFrameSize(text.length);
  return text;
}

/** JSON 文本 -> Envelope；畸形数据抛 CodecError（dispatch 层统一兜底）。 */
export function decodeEnvelope(text: string | ArrayBuffer | Uint8Array): Envelope {
  let raw: string;
  if (typeof text === 'string') raw = text;
  else {
    const bytes = text instanceof Uint8Array ? text : new Uint8Array(text);
    if (bytes.length > MAX_FRAME_BYTES) throw new CodecError('frame exceeds 64KB');
    raw = new TextDecoder().decode(bytes);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CodecError('invalid JSON envelope');
  }
  if (!parsed || typeof parsed !== 'object') throw new CodecError('envelope must be an object');
  const json = parsed as EnvelopeJson;
  if (typeof json.kind !== 'number') throw new CodecError('envelope.kind must be number');
  if (json.conv_id !== undefined && json.user_id !== undefined) {
    throw new CodecError('envelope target is oneof: conv_id xor user_id');
  }
  const env = envelopeFromJson(json);
  assertFrameSize(raw.length);
  return env;
}

// ---------------------------------------------------------------------------
// protobuf wire（与 proto/chat.proto 字段号一致）
// ---------------------------------------------------------------------------

const FIELD = {
  id: 1,
  ackId: 2,
  kind: 3,
  version: 4,
  requestId: 5,
  flags: 6,
  sentAt: 7,
  convId: 10,
  userId: 11,
  payload: 15,
} as const;

class ByteWriter {
  private buf = new Uint8Array(128);
  private len = 0;

  private ensure(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  u8(value: number): void {
    this.ensure(1);
    this.buf[this.len++] = value & 0xff;
  }

  varint(value: number): void {
    if (!Number.isFinite(value) || value < 0) throw new CodecError('varint must be non-negative');
    let n = Math.floor(value);
    while (n > 0x7f) {
      this.u8((n & 0x7f) | 0x80);
      n = Math.floor(n / 128);
    }
    this.u8(n);
  }

  tag(field: number, wire: number): void {
    this.varint((field << 3) | wire);
  }

  fixed64(field: number, value: number): void {
    this.tag(field, 1);
    this.ensure(8);
    const view = new DataView(this.buf.buffer, this.buf.byteOffset + this.len, 8);
    view.setBigUint64(0, BigInt(Math.trunc(value)), true);
    this.len += 8;
  }

  bytes(field: number, value: Uint8Array): void {
    this.tag(field, 2);
    this.varint(value.length);
    this.ensure(value.length);
    this.buf.set(value, this.len);
    this.len += value.length;
  }

  string(field: number, value: string): void {
    this.bytes(field, new TextEncoder().encode(value));
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

class ByteReader {
  private offset = 0;
  constructor(private readonly data: Uint8Array) {}

  get done(): boolean {
    return this.offset >= this.data.length;
  }

  u8(): number {
    if (this.offset >= this.data.length) throw new CodecError('unexpected end of frame');
    return this.data[this.offset++];
  }

  varint(): number {
    let result = 0;
    let shift = 0;
    for (;;) {
      const byte = this.u8();
      result += (byte & 0x7f) * Math.pow(2, shift);
      if ((byte & 0x80) === 0) return result;
      shift += 7;
      if (shift > 63) throw new CodecError('varint too long');
    }
  }

  tag(): { field: number; wire: number } {
    const key = this.varint();
    return { field: key >>> 3, wire: key & 7 };
  }

  fixed64(): number {
    if (this.offset + 8 > this.data.length) throw new CodecError('unexpected end of fixed64');
    const view = new DataView(this.data.buffer, this.data.byteOffset + this.offset, 8);
    this.offset += 8;
    return Number(view.getBigUint64(0, true));
  }

  bytes(): Uint8Array {
    const len = this.varint();
    if (this.offset + len > this.data.length) throw new CodecError('unexpected end of bytes');
    const out = this.data.subarray(this.offset, this.offset + len);
    this.offset += len;
    return out;
  }

  skip(wire: number): void {
    switch (wire) {
      case 0:
        this.varint();
        return;
      case 1:
        this.offset += 8;
        return;
      case 2: {
        const len = this.varint();
        this.offset += len;
        return;
      }
      case 5:
        this.offset += 4;
        return;
      default:
        throw new CodecError(`unsupported wire type ${wire}`);
    }
  }
}

/** Envelope -> protobuf 字节（可直接发送 Binary WebSocket frame）。 */
export function encodeEnvelopeProto(env: Envelope): Uint8Array {
  const w = new ByteWriter();
  if (env.id) {
    w.tag(FIELD.id, 0);
    w.varint(env.id);
  }
  if (env.ackId) {
    w.tag(FIELD.ackId, 0);
    w.varint(env.ackId);
  }
  if (env.kind) {
    w.tag(FIELD.kind, 0);
    w.varint(env.kind);
  }
  if (env.version) {
    w.tag(FIELD.version, 0);
    w.varint(env.version);
  }
  if (env.requestId) w.string(FIELD.requestId, env.requestId);
  if (env.flags) {
    w.tag(FIELD.flags, 0);
    w.varint(env.flags);
  }
  if (env.sentAt) w.fixed64(FIELD.sentAt, env.sentAt);
  if (env.convId !== undefined) {
    w.tag(FIELD.convId, 0);
    w.varint(env.convId);
  } else if (env.userId !== undefined) {
    w.tag(FIELD.userId, 0);
    w.varint(env.userId);
  }
  if (env.payload.length > 0) w.bytes(FIELD.payload, env.payload);
  const out = w.finish();
  assertFrameSize(out.length);
  return out;
}

/** protobuf 字节 -> Envelope。未知字段按 wire type 跳过（前向兼容）。 */
export function decodeEnvelopeProto(data: Uint8Array | ArrayBuffer): Envelope {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length > MAX_FRAME_BYTES) throw new CodecError('frame exceeds 64KB');
  const r = new ByteReader(bytes);
  const env: Envelope = createEnvelope();
  while (!r.done) {
    const { field, wire } = r.tag();
    switch (field) {
      case FIELD.id:
        env.id = r.varint();
        break;
      case FIELD.ackId:
        env.ackId = r.varint();
        break;
      case FIELD.kind:
        env.kind = r.varint();
        break;
      case FIELD.version:
        env.version = r.varint();
        break;
      case FIELD.requestId:
        env.requestId = new TextDecoder().decode(r.bytes());
        break;
      case FIELD.flags:
        env.flags = r.varint();
        break;
      case FIELD.sentAt:
        env.sentAt = r.fixed64();
        break;
      case FIELD.convId:
        env.convId = r.varint();
        break;
      case FIELD.userId:
        env.userId = r.varint();
        break;
      case FIELD.payload:
        env.payload = r.bytes().slice();
        break;
      default:
        r.skip(wire);
    }
  }
  return env;
}

function numberField(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value !== '' && Number.isFinite(Number(value))) return Number(value);
  return 0;
}

function assertFrameSize(size: number): void {
  if (size > MAX_FRAME_BYTES) throw new CodecError('frame exceeds 64KB');
}
