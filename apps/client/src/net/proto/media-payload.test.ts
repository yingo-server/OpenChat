/**
 * 媒体 payload 编解码测试：客户端 wire 字段名与服务端 pipe/wire + proto 语义
 * 对齐 —— Media: media_id / mtype(1 image,2 audio,4 file) / name / size /
 * mime / width / height / duration_ms / thumb_inline / waveform / status /
 * url；MessageContent: client_msg_id / text / media / reply_to / mentions。
 */
import { describe, expect, it } from 'vitest';
import {
  decodeMessageSend,
  decodeMsgNew,
  encodeMedia,
  encodeMessageSend,
  mapMedia,
  type Media,
} from './payload';

describe('media payload 编解码（wire 字段名对齐）', () => {
  const media: Media = {
    mediaId: 'Ab3_-xYZ0123456789abcd',
    type: 'image',
    name: '截图.png',
    size: 123_456,
    width: 800,
    height: 600,
    mime: 'image/png',
    thumb: 'aGVsbG8=',
    status: 'ready',
  };

  it('encodeMedia 输出 snake_case wire 字段', () => {
    const raw = encodeMedia(media) as Record<string, unknown>;
    expect(raw).toEqual({
      media_id: 'Ab3_-xYZ0123456789abcd',
      mtype: 'image',
      name: '截图.png',
      size: 123_456,
      width: 800,
      height: 600,
      duration_ms: undefined,
      mime: 'image/png',
      thumb_inline: 'aGVsbG8=',
      waveform: undefined,
      status: 'ready',
      url: undefined,
    });
  });

  it('encodeMessageSend → JSON 携带 media 数组（MSG_SEND 101 契约）', () => {
    const bytes = encodeMessageSend({
      clientMsgId: 'c-1',
      text: '',
      media: [media],
      mentions: [],
    });
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(
      expect.arrayContaining(['client_msg_id', 'text', 'media', 'mentions']),
    );
    const wire = (parsed.media as Record<string, unknown>[])[0];
    expect(wire.media_id).toBe('Ab3_-xYZ0123456789abcd');
    expect(wire.mtype).toBe('image');
    expect(wire.width).toBe(800);
    expect(wire.mime).toBe('image/png');
  });

  it('decodeMessageSend 往返还原 Media（camelCase 领域对象）', () => {
    const bytes = encodeMessageSend({ clientMsgId: 'c-2', text: '', media: [media], mentions: [] });
    const content = decodeMessageSend(bytes);
    expect(content.clientMsgId).toBe('c-2');
    expect(content.media[0]).toMatchObject({
      mediaId: 'Ab3_-xYZ0123456789abcd',
      type: 'image',
      name: '截图.png',
      size: 123_456,
      width: 800,
      height: 600,
      mime: 'image/png',
      status: 'ready',
    });
  });

  it('mtype 数字（mediasvc REST 返回 1/2/4）由 mtypeToMediaType 映射', async () => {
    // 注：MSG_SEND wire 里 mtype 是字符串；REST 应答里的数字 1/2/4
    // 由 net/media.mtypeToMediaType 归一（mapMedia 的数字分支是遗留演示行为）。
    const { mtypeToMediaType } = await import('../media');
    expect(mtypeToMediaType(1)).toBe('image');
    expect(mtypeToMediaType(2)).toBe('audio');
    expect(mtypeToMediaType(4)).toBe('file');
  });

  it('MSG_NEW 下行 content.media 也能解码（回显链路）', () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        msg_id: 42,
        seq: 7,
        sender_id: 1001,
        sent_at: 1_700_000_000_000,
        conv_id: 1,
        content: {
          client_msg_id: 'c-3',
          text: '',
          media: [
            {
              media_id: 'm_audio_1',
              mtype: 'audio',
              name: 'voice.ogg',
              size: 4096,
              duration_ms: 3200,
              mime: 'audio/ogg',
              status: 'ready',
            },
          ],
          mentions: [],
        },
      }),
    );
    const msg = decodeMsgNew(bytes);
    expect(msg.content.media.length).toBe(1);
    const m = msg.content.media[0];
    expect(m.mediaId).toBe('m_audio_1');
    expect(m.type).toBe('audio');
    expect(m.durationMs).toBe(3200);
  });
});
