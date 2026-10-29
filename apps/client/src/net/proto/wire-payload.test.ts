/**
 * payload wire 契约测试（P1-3 单态收敛）：
 *  - data 层 wire JSON 为准 —— camelCase 单态（权威清单：
 *    server/internal/data/pipe/wire/wire.go 的 json tag）；
 *  - snake_case 输入一律按缺失字段处理（无 pick() 双收）；
 *  - 例外：MSG_NEW(102) 与 content/media 保持 snake_case（flusher.go:137
 *    buildMsgNewPayload 有意输出 protojson 同名的 snake_case）。
 */
import { describe, expect, it } from 'vitest';
import {
  decodeConvCreate,
  decodeConvPayload,
  decodeDataResult,
  decodeError,
  decodeMsgAck,
  encodeConvCreate,
  encodeConvPayload,
  encodeDataResult,
  encodeMsgAck,
} from './payload';

const enc = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

describe('wire 单态（camelCase 为准，snake 拒收）', () => {
  it('decodeMsgAck 只认 camelCase（wire.MsgAck）', () => {
    const ack = decodeMsgAck(enc({ msgId: 7, seq: 3, clientMsgId: 'c-1', status: 0 }));
    expect(ack).toEqual({ msgId: 7, seq: 3, clientMsgId: 'c-1', status: 0 });

    // snake 输入：字段缺失 → 零值，不兜底
    const snake = decodeMsgAck(enc({ msg_id: 7, seq: 3, client_msg_id: 'c-1', status: 0 }));
    expect(snake.msgId).toBe(0);
    expect(snake.clientMsgId).toBe('');
  });

  it('encodeMsgAck 输出 camelCase', () => {
    const raw = JSON.parse(
      new TextDecoder().decode(encodeMsgAck({ msgId: 7, seq: 3, clientMsgId: 'c-1', status: 0 })),
    ) as Record<string, unknown>;
    expect(raw).toEqual({ msgId: 7, seq: 3, clientMsgId: 'c-1', status: 0 });
  });

  it('decodeDataResult 只认 camelCase（wire.DataResult），snake requestId 丢失', () => {
    const body = enc({ convId: 1, title: 't', convType: 1, createdAt: 0, members: [], version: 1 });
    const res = decodeDataResult(
      encodeDataResult({ op: 1, ok: true, body, requestId: 'req-1' }),
    );
    expect(res.requestId).toBe('req-1');
    expect(res.body).toBeDefined();

    const snake = decodeDataResult(enc({ op: 1, ok: true, request_id: 'req-2' }));
    expect(snake.requestId).toBe('');
  });

  it('decodeError 只认 camelCase（wire.Error retryAfterMs）', () => {
    const err = decodeError(enc({ code: 400, reason: 'bad', retryAfterMs: 500 }));
    expect(err.retryAfterMs).toBe(500);
    const snake = decodeError(enc({ code: 400, reason: 'bad', retry_after_ms: 500 }));
    expect(snake.retryAfterMs).toBe(0);
  });

  it('decodeConvPayload 只认 camelCase（wire.ConvPayload/Member）且秒级时间戳升毫秒', () => {
    const conv = decodeConvPayload(
      enc({
        convId: 9,
        title: '群',
        convType: 2,
        createdAt: 1_700_000_000, // 秒（conv.go nowSec）
        members: [{ userId: 1, role: 2, joinedAt: 1_700_000_000, mutedUntil: 0 }],
        version: 1,
      }),
    );
    expect(conv.convId).toBe(9);
    expect(conv.convType).toBe(2);
    expect(conv.createdAt).toBe(1_700_000_000_000);
    expect(conv.members[0]).toMatchObject({ userId: 1, role: 2, joinedAt: 1_700_000_000_000 });

    // snake 输入：不兜底
    const snake = decodeConvPayload(enc({ conv_id: 9, conv_type: 2, members: [] }));
    expect(snake.convId).toBe(0);
    expect(snake.convType).toBe(0);
  });

  it('encode/decodeConvPayload 往返为 camelCase', () => {
    const payload = {
      convId: 5,
      title: 't',
      convType: 1,
      createdAt: 1_700_000_000_000,
      members: [{ userId: 2, role: 0, joinedAt: 1_700_000_000_000, mutedUntil: 0 }],
      version: 1,
    };
    const raw = JSON.parse(new TextDecoder().decode(encodeConvPayload(payload))) as Record<
      string,
      unknown
    >;
    expect(Object.keys(raw)).toEqual(
      expect.arrayContaining(['convId', 'convType', 'createdAt', 'members', 'version']),
    );
    expect(decodeConvPayload(encodeConvPayload(payload)).convId).toBe(5);
  });

  it('encode/decodeConvCreate 为 camelCase（convKindToPipe 接收 camel 分支）', () => {
    const bytes = encodeConvCreate({ title: '', convType: 1, memberIds: [2001] });
    const raw = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    expect(raw).toEqual({ title: '', convType: 1, memberIds: [2001] });

    const snake = decodeConvCreate(enc({ conv_type: 2, member_ids: [3] }));
    expect(snake.convType).toBe(0);
    expect(snake.memberIds).toEqual([]);
  });
});

describe('MSG_NEW 例外：protojson 同名 snake_case（flusher.go 权威）', () => {
  it('decodeMsgNew 收 snake_case（msg_id/seq/sender_id/content.client_msg_id）', async () => {
    const { decodeMsgNew } = await import('./payload');
    const bytes = enc({
      msg_id: 1,
      seq: 2,
      sender_id: 1001,
      sent_at: 1_700_000_000_000,
      conv_id: 3,
      content: { client_msg_id: 'c-9', text: 'hi', media: [], mentions: [] },
    });
    const msg = decodeMsgNew(bytes);
    expect(msg.msgId).toBe(1);
    expect(msg.content.clientMsgId).toBe('c-9');
  });
});
