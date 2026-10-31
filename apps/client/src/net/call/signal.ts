/**
 * 通话信令 payload 编解码 + 发送函数。
 *
 * 契约（前后端共用，逐字对齐）：服务端信令转发 payload 为 JSON camelCase：
 *   CALL_OFFER      {callId,convId,toUserId,sdp,media:"audio|video",fromUserId}
 *   CALL_ANSWER     {callId,sdp,fromUserId}
 *   CALL_CANDIDATE  {callId,candidate,sdpMid,sdpMLineIndex,fromUserId}
 *   CALL_BUSY       {callId,reason:"busy|declined|unsupported",fromUserId}
 *   CALL_HANGUP     {callId,reason:"hangup|timeout|error",fromUserId}
 *
 * 发送时 Envelope.user_id（target）设为对端 uid；服务端会回填真实 fromUserId，
 * 前端收到时以 payload.fromUserId 判断发起方 / 应答方。
 */
import { createEnvelope } from '../proto/codec';
import { decodeJsonPayload, encodeJsonPayload } from '../proto/payload';
import { KINDS } from '../protocol/kinds';
import type { NetClient } from '../transport/types';
import type { CallMedia } from './types';

export interface CallOfferPayload {
  callId: string;
  convId: number;
  toUserId: number;
  sdp: string;
  media: CallMedia;
  fromUserId: number;
}

export interface CallAnswerPayload {
  callId: string;
  sdp: string;
  fromUserId: number;
}

export interface CallCandidatePayload {
  callId: string;
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
  fromUserId: number;
}

export type CallBusyReason = 'busy' | 'declined' | 'unsupported';

export interface CallBusyPayload {
  callId: string;
  reason: CallBusyReason;
  fromUserId: number;
}

export type CallHangupReason = 'hangup' | 'timeout' | 'error';

export interface CallHangupPayload {
  callId: string;
  reason: CallHangupReason;
  fromUserId: number;
}

// ---------------------------------------------------------------------------
// 编解码
// ---------------------------------------------------------------------------

function num(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value !== '' && Number.isFinite(Number(value))) return Number(value);
  return fallback;
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function strOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function numOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function media(value: unknown): CallMedia {
  return value === 'video' ? 'video' : 'audio';
}

export function encodeOffer(p: CallOfferPayload): Uint8Array {
  return encodeJsonPayload({
    callId: p.callId,
    convId: p.convId,
    toUserId: p.toUserId,
    sdp: p.sdp,
    media: p.media,
    fromUserId: p.fromUserId,
  });
}

export function decodeOffer(bytes: Uint8Array): CallOfferPayload {
  const raw = decodeJsonPayload<Record<string, unknown>>(bytes);
  return {
    callId: str(raw.callId),
    convId: num(raw.convId),
    toUserId: num(raw.toUserId),
    sdp: str(raw.sdp),
    media: media(raw.media),
    fromUserId: num(raw.fromUserId),
  };
}

export function encodeAnswer(p: CallAnswerPayload): Uint8Array {
  return encodeJsonPayload({ callId: p.callId, sdp: p.sdp, fromUserId: p.fromUserId });
}

export function decodeAnswer(bytes: Uint8Array): CallAnswerPayload {
  const raw = decodeJsonPayload<Record<string, unknown>>(bytes);
  return { callId: str(raw.callId), sdp: str(raw.sdp), fromUserId: num(raw.fromUserId) };
}

export function encodeCandidate(p: CallCandidatePayload): Uint8Array {
  return encodeJsonPayload({
    callId: p.callId,
    candidate: p.candidate,
    sdpMid: p.sdpMid,
    sdpMLineIndex: p.sdpMLineIndex,
    fromUserId: p.fromUserId,
  });
}

export function decodeCandidate(bytes: Uint8Array): CallCandidatePayload {
  const raw = decodeJsonPayload<Record<string, unknown>>(bytes);
  return {
    callId: str(raw.callId),
    candidate: str(raw.candidate),
    sdpMid: strOrNull(raw.sdpMid),
    sdpMLineIndex: numOrNull(raw.sdpMLineIndex),
    fromUserId: num(raw.fromUserId),
  };
}

export function encodeBusy(p: CallBusyPayload): Uint8Array {
  return encodeJsonPayload({ callId: p.callId, reason: p.reason, fromUserId: p.fromUserId });
}

export function decodeBusy(bytes: Uint8Array): CallBusyPayload {
  const raw = decodeJsonPayload<Record<string, unknown>>(bytes);
  const reason = str(raw.reason);
  return {
    callId: str(raw.callId),
    reason: reason === 'declined' || reason === 'unsupported' ? reason : 'busy',
    fromUserId: num(raw.fromUserId),
  };
}

export function encodeHangup(p: CallHangupPayload): Uint8Array {
  return encodeJsonPayload({ callId: p.callId, reason: p.reason, fromUserId: p.fromUserId });
}

export function decodeHangup(bytes: Uint8Array): CallHangupPayload {
  const raw = decodeJsonPayload<Record<string, unknown>>(bytes);
  const reason = str(raw.reason);
  return {
    callId: str(raw.callId),
    reason: reason === 'timeout' || reason === 'error' ? reason : 'hangup',
    fromUserId: num(raw.fromUserId),
  };
}

// ---------------------------------------------------------------------------
// 发送（Envelope.user_id = 对端 uid）
// ---------------------------------------------------------------------------

function sendFrame(client: NetClient, kind: number, toUserId: number, payload: Uint8Array): boolean {
  return client.send(createEnvelope({ kind, userId: toUserId, payload }));
}

export function sendOffer(client: NetClient, p: CallOfferPayload): boolean {
  return sendFrame(client, KINDS.CALL_OFFER, p.toUserId, encodeOffer(p));
}

export function sendAnswer(client: NetClient, toUserId: number, p: CallAnswerPayload): boolean {
  return sendFrame(client, KINDS.CALL_ANSWER, toUserId, encodeAnswer(p));
}

export function sendCandidate(client: NetClient, toUserId: number, p: CallCandidatePayload): boolean {
  return sendFrame(client, KINDS.CALL_CANDIDATE, toUserId, encodeCandidate(p));
}

export function sendBusy(client: NetClient, toUserId: number, p: CallBusyPayload): boolean {
  return sendFrame(client, KINDS.CALL_BUSY, toUserId, encodeBusy(p));
}

export function sendHangup(client: NetClient, toUserId: number, p: CallHangupPayload): boolean {
  return sendFrame(client, KINDS.CALL_HANGUP, toUserId, encodeHangup(p));
}
