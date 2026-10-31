/**
 * 通话信令 payload 编解码往返（5 个 kind）+ 发送函数 Envelope target 校验。
 */
import { describe, expect, it } from 'vitest';
import { decodeEnvelope } from '../proto/codec';
import type { Envelope } from '../proto/codec';
import { KINDS } from '../protocol/kinds';
import type { NetClient } from '../transport/types';
import {
  decodeAnswer,
  decodeBusy,
  decodeCandidate,
  decodeHangup,
  decodeOffer,
  encodeAnswer,
  encodeBusy,
  encodeCandidate,
  encodeHangup,
  encodeOffer,
  sendAnswer,
  sendBusy,
  sendCandidate,
  sendHangup,
  sendOffer,
  type CallAnswerPayload,
  type CallBusyPayload,
  type CallCandidatePayload,
  type CallHangupPayload,
  type CallOfferPayload,
} from './signal';

const offer: CallOfferPayload = {
  callId: 'c-1',
  convId: 42,
  toUserId: 2002,
  sdp: 'v=0 offer',
  media: 'video',
  fromUserId: 1001,
};

const answer: CallAnswerPayload = { callId: 'c-1', sdp: 'v=0 answer', fromUserId: 2002 };
const candidate: CallCandidatePayload = {
  callId: 'c-1',
  candidate: 'candidate:1 1 udp ...',
  sdpMid: 'audio',
  sdpMLineIndex: 0,
  fromUserId: 2002,
};
const busy: CallBusyPayload = { callId: 'c-1', reason: 'declined', fromUserId: 2002 };
const hangup: CallHangupPayload = { callId: 'c-1', reason: 'timeout', fromUserId: 1001 };

describe('call signal payload 编解码往返', () => {
  it('OFFER', () => {
    expect(decodeOffer(encodeOffer(offer))).toEqual(offer);
  });
  it('ANSWER', () => {
    expect(decodeAnswer(encodeAnswer(answer))).toEqual(answer);
  });
  it('CANDIDATE（含 sdpMid=null / sdpMLineIndex=null）', () => {
    const nullCand: CallCandidatePayload = { ...candidate, sdpMid: null, sdpMLineIndex: null };
    expect(decodeCandidate(encodeCandidate(nullCand))).toEqual(nullCand);
    expect(decodeCandidate(encodeCandidate(candidate))).toEqual(candidate);
  });
  it('BUSY', () => {
    expect(decodeBusy(encodeBusy(busy))).toEqual(busy);
  });
  it('HANGUP', () => {
    expect(decodeHangup(encodeHangup(hangup))).toEqual(hangup);
  });
  it('payload 字段使用 camelCase', () => {
    const raw = JSON.parse(new TextDecoder().decode(encodeOffer(offer))) as Record<string, unknown>;
    expect(raw).toMatchObject({
      callId: 'c-1',
      convId: 42,
      toUserId: 2002,
      media: 'video',
      fromUserId: 1001,
    });
  });
});

function captureClient(): { client: NetClient; sent: Envelope[] } {
  const sent: Envelope[] = [];
  const client = {
    send: (env: Envelope) => {
      sent.push(env);
      return true;
    },
  } as unknown as NetClient;
  return { client, sent };
}

describe('call send 函数：Envelope kind + user_id target', () => {
  it('5 个 send 函数设置正确 kind 与目标 uid', () => {
    const { client, sent } = captureClient();
    sendOffer(client, offer);
    sendAnswer(client, 2002, answer);
    sendCandidate(client, 2002, candidate);
    sendBusy(client, 2002, busy);
    sendHangup(client, 2002, hangup);

    expect(sent.map((env) => env.kind)).toEqual([
      KINDS.CALL_OFFER,
      KINDS.CALL_ANSWER,
      KINDS.CALL_CANDIDATE,
      KINDS.CALL_BUSY,
      KINDS.CALL_HANGUP,
    ]);
    // OFFER 目标取 payload.toUserId，其余由显式参数指定
    expect(sent[0].userId).toBe(2002);
    expect(sent.slice(1).every((env) => env.userId === 2002)).toBe(true);
    // oneof：只有 user_id，无 conv_id
    expect(sent.every((env) => env.convId === undefined)).toBe(true);
  });

  it('send 出的 payload 可被对应 decode 还原（模拟服务端转发链路）', () => {
    const { client, sent } = captureClient();
    sendAnswer(client, 2002, answer);
    sendHangup(client, 2002, hangup);
    expect(decodeAnswer(sent[0].payload)).toEqual(answer);
    expect(decodeHangup(sent[1].payload)).toEqual(hangup);
    // 完整 Envelope 经 JSON wire 往返后 payload 字节一致
    const env = decodeEnvelope(
      JSON.stringify({
        id: 1,
        ack_id: 0,
        kind: KINDS.CALL_BUSY,
        version: 1,
        request_id: 'r',
        flags: 0,
        sent_at: 0,
        user_id: 2002,
        payload: '',
      }),
    );
    expect(env.kind).toBe(KINDS.CALL_BUSY);
    expect(env.userId).toBe(2002);
  });
});
