/**
 * P0 贯通断链回归测试：
 *  - P0-1：上行 encodeMedia 发数字 mtype（服务端 wire.go 用 int32 解析，
 *          字符串会导致 json.Unmarshal 整体失败 → 对端收到空消息）；
 *          下行 MSG_NEW 的 media.mtype 也是数字，decode 需按数字还原。
 *  - P0-2：decodePresence 兼容 {status} 与 {online:bool} 两种形态。
 *  - P1：decodeReceipt 返回数组（批量 receipts 不丢）；waveform 统一 0-100。
 */
import { describe, expect, it } from 'vitest';
import {
  decodeMsgNew,
  decodePresence,
  decodeReceipt,
  encodeMedia,
  encodeMessageSend,
  mapMedia,
  decodeFeatureFlags,
  mediaTypeToMtype,
  mtypeToMediaType,
  type Media,
} from './payload';

const enc = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

function decodeMsgSendMedia(bytes: Uint8Array): Record<string, unknown>[] {
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { media: Record<string, unknown>[] };
  return parsed.media;
}

describe('P0-1 media mtype 数字（image→1 audio→2 file→4）', () => {
  it('mediaTypeToMtype / mtypeToMediaType 双向映射', () => {
    expect(mediaTypeToMtype('image')).toBe(1);
    expect(mediaTypeToMtype('audio')).toBe(2);
    expect(mediaTypeToMtype('video')).toBe(3);
    expect(mediaTypeToMtype('file')).toBe(4);
    expect(mtypeToMediaType(1)).toBe('image');
    expect(mtypeToMediaType(2)).toBe('audio');
    expect(mtypeToMediaType(4)).toBe('file');
    expect(mtypeToMediaType(99)).toBe('file');
  });

  it('encodeMedia 对上行的 mtype 输出数字（不再是字符串）', () => {
    const cases: Array<[Media['type'], number]> = [
      ['image', 1],
      ['audio', 2],
      ['file', 4],
    ];
    for (const [type, mtype] of cases) {
      const raw = encodeMedia({ mediaId: `m_${type}`, type }) as Record<string, unknown>;
      expect(raw.mtype).toBe(mtype);
      expect(typeof raw.mtype).toBe('number');
    }
  });

  it('MSG_SEND 上行每个 media 的 mtype 都是数字（服务端 int32 可解析）', () => {
    const bytes = encodeMessageSend({
      clientMsgId: 'c-mtype',
      text: '',
      media: [
        { mediaId: 'm_img', type: 'image', size: 100 },
        { mediaId: 'm_aud', type: 'audio', durationMs: 3000 },
        { mediaId: 'm_file', type: 'file', name: 'a.pdf' },
      ],
    });
    const media = decodeMsgSendMedia(bytes);
    expect(media.map((m) => m.mtype)).toEqual([1, 2, 4]);
    for (const m of media) expect(typeof m.mtype).toBe('number');
  });

  it('MSG_NEW 下行 numeric mtype 正确还原成领域类型（不再恒 file）', () => {
    const bytes = enc({
      msg_id: 1,
      seq: 1,
      sender_id: 1001,
      sent_at: 1_700_000_000_000,
      conv_id: 1,
      content: {
        client_msg_id: 'c-1',
        text: '',
        media: [
          { media_id: 'a', mtype: 1, size: 10 },
          { media_id: 'b', mtype: 2, duration_ms: 3000 },
          { media_id: 'c', mtype: 4, name: 'f.pdf' },
        ],
        mentions: [],
      },
    });
    const msg = decodeMsgNew(bytes);
    expect(msg.content.media.map((m) => m.type)).toEqual(['image', 'audio', 'file']);
  });

  it('mapMedia 仍兼容旧字符串 mtype（演示/缓存回放）', () => {
    expect(mapMedia({ media_id: 'x', mtype: 'image' }).type).toBe('image');
    expect(mapMedia({ media_id: 'x', mtype: 'audio' }).type).toBe('audio');
    expect(mapMedia({ media_id: 'x', mtype: 'file' }).type).toBe('file');
  });
});

describe('P0-2 decodePresence 双形态兼容', () => {
  it('400 形态 {user_id, status:"online"} → online', () => {
    const p = decodePresence(enc({ user_id: 2001, status: 'online', at: 1000 }));
    expect(p).toEqual({ userId: 2001, status: 'online', at: 1000 });
  });

  it('400 形态 away 保留', () => {
    expect(decodePresence(enc({ user_id: 2001, status: 'away', at: 1 })).status).toBe('away');
  });

  it('401 形态 {user_id, online:true} → online（曾误判为离线）', () => {
    const p = decodePresence(enc({ user_id: 2001, online: true, at: 2000 }));
    expect(p).toEqual({ userId: 2001, status: 'online', at: 2000 });
  });

  it('402 形态 {user_id, online:false} → offline', () => {
    const p = decodePresence(enc({ user_id: 2001, online: false, at: 3000 }));
    expect(p.status).toBe('offline');
  });

  it('两形态都缺时降级 offline', () => {
    expect(decodePresence(enc({ user_id: 2001, at: 1 })).status).toBe('offline');
  });
});

describe('P1 receipts 数组 / waveform 0-100', () => {
  it('decodeReceipt 批量 receipts 返回全部（不只第一条）', () => {
    const list = decodeReceipt(
      enc({ receipts: [
        { msg_id: 10, user_id: 1, at: 100, rtype: 0 },
        { msg_id: 11, user_id: 2, at: 200, rtype: 1 },
        { msg_id: 12, user_id: 3, at: 300, rtype: 0 },
      ] }),
    );
    expect(list.map((r) => r.msgId)).toEqual([10, 11, 12]);
    expect(list.map((r) => r.type)).toEqual(['read', 'delivered', 'read']);
  });

  it('decodeReceipt 单条扁平形态返回单元素数组', () => {
    const list = decodeReceipt(enc({ msg_id: 7, user_id: 5, at: 50, rtype: 1 }));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ msgId: 7, userId: 5, type: 'delivered' });
  });

  it('decodeReceipt 无 msg_id 返回空数组', () => {
    expect(decodeReceipt(enc({ user_id: 5 }))).toEqual([]);
  });

  it('mapMedia 的 waveform 归一到 0-100 整数', () => {
    const media = mapMedia({ media_id: 'w', mtype: 2, waveform: [0, 50, 100, 250, -5] });
    expect(media.waveform).toEqual([0, 50, 100, 100, 0]);
  });
});

/** varint 编码（测试构造 protobuf FeatureFlags）。 */
function varint(value: number): number[] {
  const out: number[] = [];
  let v = value;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return out;
}

/** 构造 protobuf chatpb.FeatureFlags（version=1 varint，flags=2 map<string,string>）。 */
function protoFeatureFlags(version: number, flags: Record<string, string>): Uint8Array {
  const body: number[] = [0x08, ...varint(version)]; // field1 varint
  const encoder = new TextEncoder();
  for (const [k, v] of Object.entries(flags)) {
    const key = Array.from(encoder.encode(k));
    const val = Array.from(encoder.encode(v));
    const entry = [0x0a, ...varint(key.length), ...key, 0x12, ...varint(val.length), ...val];
    body.push(0x12, ...varint(entry.length), ...entry); // field2 length-delimited map entry
  }
  return new Uint8Array(body);
}

describe('decodeFeatureFlags（P0-4 双形态）', () => {
  it('JSON 形态（mockBridge）', () => {
    const p = decodeFeatureFlags(enc({ version: 3, flags: { call_enabled: 'false' } }));
    expect(p.version).toBe(3);
    expect(p.flags).toEqual({ call_enabled: 'false' });
  });

  it('protobuf 形态（真实 usergw router.go）', () => {
    const p = decodeFeatureFlags(
      protoFeatureFlags(5, { call_enabled: 'true', video_enabled: 'false' }),
    );
    expect(p.version).toBe(5);
    expect(p.flags).toEqual({ call_enabled: 'true', video_enabled: 'false' });
  });
});
