import { describe, expect, it } from 'vitest';
import {
  CodecError,
  base64ToBytes,
  bytesToBase64,
  createEnvelope,
  decodeEnvelope,
  decodeEnvelopeProto,
  encodeEnvelope,
  encodeEnvelopeProto,
  type Envelope,
} from './codec';

function sample(): Envelope {
  return createEnvelope({
    id: 42,
    ackId: 7,
    kind: 102,
    requestId: 'req-中文-1',
    flags: 3,
    sentAt: 1_700_000_000_123,
    convId: 9007199254740,
    payload: new Uint8Array([0, 1, 2, 250, 255]),
  });
}

describe('base64', () => {
  it('round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i += 1) bytes[i] = i;
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  it('handles empty and unpadded input', () => {
    expect(bytesToBase64(new Uint8Array(0))).toBe('');
    expect(base64ToBytes('')).toEqual(new Uint8Array(0));
    expect(base64ToBytes('AQID')).toEqual(new Uint8Array([1, 2, 3]));
  });
});

describe('JSON envelope codec', () => {
  it('round-trips every field including payload bytes', () => {
    const original = sample();
    const decoded = decodeEnvelope(encodeEnvelope(original));
    expect(decoded).toEqual(original);
    expect(decoded.payload).toBeInstanceOf(Uint8Array);
  });

  it('keeps target as a oneof (user_id variant)', () => {
    const original = createEnvelope({ kind: 12, userId: 2001, payload: new Uint8Array([9]) });
    const decoded = decodeEnvelope(encodeEnvelope(original));
    expect(decoded.userId).toBe(2001);
    expect(decoded.convId).toBeUndefined();
  });

  it('rejects malformed JSON and dual target', () => {
    expect(() => decodeEnvelope('{oops')).toThrow(CodecError);
    expect(() => decodeEnvelope('{"kind":102}')).not.toThrow();
    const dual = JSON.stringify({ kind: 102, conv_id: 1, user_id: 2, payload: '' });
    expect(() => decodeEnvelope(dual)).toThrow(CodecError);
  });

  it('rejects frames over 64KB', () => {
    const big = createEnvelope({ kind: 102, payload: new Uint8Array(70_000) });
    expect(() => encodeEnvelope(big)).toThrow(CodecError);
  });
});

describe('protobuf wire codec', () => {
  it('round-trips Envelope with proto field numbers', () => {
    const original = sample();
    const decoded = decodeEnvelopeProto(encodeEnvelopeProto(original));
    expect(decoded).toEqual(original);
  });

  it('round-trips empty optional fields', () => {
    const original = createEnvelope({ kind: 5 });
    const decoded = decodeEnvelopeProto(encodeEnvelopeProto(original));
    expect(decoded.kind).toBe(5);
    expect(decoded.convId).toBeUndefined();
    expect(decoded.payload).toEqual(new Uint8Array(0));
    expect(decoded.version).toBe(1);
  });

  it('skips unknown fields for forward compatibility', () => {
    const bytes = encodeEnvelopeProto(createEnvelope({ kind: 102, convId: 3 }));
    // 追加 unknown field 99 varint 1（tag = 99<<3 | 0 = 792 → varint 0x98 0x06）
    const extended = new Uint8Array(bytes.length + 3);
    extended.set(bytes);
    extended[bytes.length] = 0x98;
    extended[bytes.length + 1] = 0x06;
    extended[bytes.length + 2] = 0x01;
    const decoded = decodeEnvelopeProto(extended);
    expect(decoded.kind).toBe(102);
    expect(decoded.convId).toBe(3);
  });

  it('decodes an ArrayBuffer as well as Uint8Array', () => {
    const bytes = encodeEnvelopeProto(sample());
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    expect(decodeEnvelopeProto(buffer)).toEqual(sample());
  });
});
