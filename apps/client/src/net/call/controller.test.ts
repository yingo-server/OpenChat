/**
 * 通话状态机测试（fake RTCPeerConnection，node 环境）。
 * 覆盖：完整状态迁移 / 来电与忙线 / 45s 无应答超时 / ICE 失败。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeBusy, decodeHangup } from './signal';
import type { Envelope } from '../proto/codec';
import type { NetClient } from '../transport/types';
import { KINDS } from '../protocol/kinds';
import { CallController, ICE_TIMEOUT_MS, OFFER_TIMEOUT_MS, type CallControllerDeps } from './controller';
import type { IceCandidateInfo, PeerHandlers, PeerLike } from './peer';

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

class FakePeer implements PeerLike {
  handlers: PeerHandlers;
  localStream: MediaStream | null;
  closed = false;
  lastCandidate: IceCandidateInfo | null = null;
  remoteSdp = '';

  constructor(handlers: PeerHandlers, localStream: MediaStream | null) {
    this.handlers = handlers;
    this.localStream = localStream;
  }
  async createOffer() {
    return { type: 'offer' as const, sdp: 'offer-sdp' };
  }
  async createAnswer(remoteSdp: string) {
    this.remoteSdp = remoteSdp;
    return { type: 'answer' as const, sdp: 'answer-sdp' };
  }
  async setRemoteSdp(sdp: string) {
    this.remoteSdp = sdp;
  }
  async addIceCandidate(candidate: IceCandidateInfo) {
    this.lastCandidate = candidate;
  }
  close() {
    this.closed = true;
  }
}

function fakeStream() {
  const track = { enabled: true, kind: 'audio', stop: vi.fn() };
  return {
    getTracks: () => [track],
    getAudioTracks: () => [track],
    _track: track,
  } as unknown as MediaStream & { _track: { enabled: boolean; stop: () => void } };
}

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

interface Harness {
  controller: CallController;
  lastPeer: () => FakePeer;
  sent: Envelope[];
  client: NetClient;
  toasts: string[];
}

function makeHarness(): Harness {
  let peer: FakePeer | null = null;
  const deps: CallControllerDeps = {
    createPeer: (handlers, localStream) => {
      peer = new FakePeer(handlers, localStream);
      return peer;
    },
    getUserMedia: async () => fakeStream(),
    now: () => 1_000,
    newCallId: () => 'call-1',
  };
  const controller = new CallController(deps);
  const { client, sent } = captureClient();
  const toasts: string[] = [];
  controller.onToast = (key) => toasts.push(key);
  return {
    controller,
    lastPeer: () => {
      if (!peer) throw new Error('peer not created');
      return peer;
    },
    sent,
    client,
    toasts,
  };
}

const offerPayload = {
  callId: 'call-1',
  convId: 7,
  toUserId: 1,
  sdp: 'remote-offer',
  media: 'video' as const,
  fromUserId: 2,
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe('CallController 状态机', () => {
  it('idle → outgoing → connecting → active → ended 完整迁移', async () => {
    const { controller, lastPeer, sent, client } = makeHarness();

    const started = await controller.startCall({
      convId: 7,
      peerUserId: 2,
      media: 'video',
      client,
      selfId: 1,
    });
    expect(started).toBe(true);
    expect(controller.getSnapshot().state).toBe('outgoing');
    expect(sent[0].kind).toBe(KINDS.CALL_OFFER);
    expect(controller.getSnapshot().localStream).not.toBeNull();

    controller.handleAnswer({ callId: 'call-1', sdp: 'remote-answer', fromUserId: 2 }, client, 1);
    expect(controller.getSnapshot().state).toBe('connecting');

    lastPeer().handlers.onConnectionState('connected');
    expect(controller.getSnapshot().state).toBe('active');

    controller.hangup();
    expect(controller.getSnapshot().state).toBe('ended');
    expect(sent.some((env) => env.kind === KINDS.CALL_HANGUP)).toBe(true);
    expect(lastPeer().closed).toBe(true);
  });

  it('收到 OFFER 且 idle → incoming', () => {
    const { controller, client } = makeHarness();
    const result = controller.handleOffer(offerPayload, client, 1);
    expect(result).toBe('incoming');
    const snap = controller.getSnapshot();
    expect(snap.state).toBe('incoming');
    expect(snap.info?.peerUserId).toBe(2);
    expect(snap.info?.media).toBe('video');
  });

  it('收到 OFFER 且非 idle → 自动回 BUSY', async () => {
    const { controller, sent, client } = makeHarness();
    // 先发起一通，使状态离开 idle
    await controller.startCall({ convId: 7, peerUserId: 3, media: 'audio', client, selfId: 1 });
    expect(controller.getSnapshot().state).toBe('outgoing');

    const result = controller.handleOffer(offerPayload, client, 1);
    expect(result).toBe('busy');
    const busyEnv = sent.find((env) => env.kind === KINDS.CALL_BUSY);
    expect(busyEnv).toBeDefined();
    expect(decodeBusy(busyEnv!.payload)).toMatchObject({ callId: 'call-1', reason: 'busy', fromUserId: 1 });
    // 当前通话状态不受来电影响
    expect(controller.getSnapshot().state).toBe('outgoing');
  });

  it('answer 接听 → connecting，并向对端发 ANSWER', async () => {
    const { controller, sent, client } = makeHarness();
    controller.handleOffer(offerPayload, client, 1);
    const ok = await controller.answer();
    expect(ok).toBe(true);
    expect(controller.getSnapshot().state).toBe('connecting');
    const answerEnv = sent.find((env) => env.kind === KINDS.CALL_ANSWER);
    expect(answerEnv?.userId).toBe(2);
  });

  it('reject 拒绝 → 发 BUSY(declined) 并 ended', () => {
    const { controller, sent, client } = makeHarness();
    controller.handleOffer(offerPayload, client, 1);
    controller.reject();
    const busyEnv = sent.find((env) => env.kind === KINDS.CALL_BUSY);
    expect(decodeBusy(busyEnv!.payload).reason).toBe('declined');
    expect(controller.getSnapshot().state).toBe('ended');
  });
});

describe('CallController 超时与失败', () => {
  it('45s 无 answer → 自动 HANGUP(timeout) 并 ended', async () => {
    const { controller, sent, client, toasts } = makeHarness();
    await controller.startCall({ convId: 7, peerUserId: 2, media: 'audio', client, selfId: 1 });
    expect(controller.getSnapshot().state).toBe('outgoing');

    vi.advanceTimersByTime(OFFER_TIMEOUT_MS);

    expect(controller.getSnapshot().state).toBe('ended');
    const hangupEnv = sent.find((env) => env.kind === KINDS.CALL_HANGUP);
    expect(hangupEnv).toBeDefined();
    expect(decodeHangup(hangupEnv!.payload).reason).toBe('timeout');
    expect(toasts).toContain('call.timeout');
  });

  it('ICE 失败（10s 未 connected）→ ended + 网络问题提示', async () => {
    const { controller, sent, client, toasts } = makeHarness();
    await controller.startCall({ convId: 7, peerUserId: 2, media: 'audio', client, selfId: 1 });
    controller.handleAnswer({ callId: 'call-1', sdp: 'r', fromUserId: 2 }, client, 1);
    expect(controller.getSnapshot().state).toBe('connecting');

    vi.advanceTimersByTime(ICE_TIMEOUT_MS);

    expect(controller.getSnapshot().state).toBe('ended');
    expect(toasts).toContain('call.networkIssue');
    expect(sent.some((env) => env.kind === KINDS.CALL_HANGUP)).toBe(true);
  });

  it('peer connectionState=failed → ended + 网络问题', async () => {
    const { controller, lastPeer, client, toasts } = makeHarness();
    await controller.startCall({ convId: 7, peerUserId: 2, media: 'audio', client, selfId: 1 });
    lastPeer().handlers.onConnectionState('failed');
    expect(controller.getSnapshot().state).toBe('ended');
    expect(toasts).toContain('call.networkIssue');
  });

  it('对端挂断 HANGUP → 按 reason 结束并提示', async () => {
    const { controller, lastPeer, client, toasts } = makeHarness();
    await controller.startCall({ convId: 7, peerUserId: 2, media: 'audio', client, selfId: 1 });
    // 进入 active 后再挂断
    controller.handleAnswer({ callId: 'call-1', sdp: 'r', fromUserId: 2 }, client, 1);
    lastPeer().handlers.onConnectionState('connected');
    expect(controller.getSnapshot().state).toBe('active');

    controller.handleHangup({ callId: 'call-1', reason: 'hangup', fromUserId: 2 });
    expect(controller.getSnapshot().state).toBe('ended');
    expect(toasts).toContain('call.ended');
  });

  it('handleBusy 忙线 → ended 且提示 call.busy', async () => {
    const { controller, client, toasts } = makeHarness();
    await controller.startCall({ convId: 7, peerUserId: 2, media: 'audio', client, selfId: 1 });
    controller.handleBusy({ callId: 'call-1', reason: 'busy', fromUserId: 2 });
    expect(controller.getSnapshot().state).toBe('ended');
    expect(toasts).toContain('call.busy');
  });

  it('toggleMute 切换本地音轨 enabled', async () => {
    const fake = fakeStream();
    let peer: FakePeer | null = null;
    const controller = new CallController({
      createPeer: (handlers, localStream) => {
        peer = new FakePeer(handlers, localStream);
        return peer;
      },
      getUserMedia: async () => fake,
      now: () => 1_000,
      newCallId: () => 'call-1',
    });
    const { client } = captureClient();
    await controller.startCall({ convId: 7, peerUserId: 2, media: 'audio', client, selfId: 1 });
    expect(fake._track.enabled).toBe(true);
    const muted = controller.toggleMute();
    expect(muted).toBe(true);
    expect(fake._track.enabled).toBe(false);
    expect(controller.toggleMute()).toBe(false);
    expect(fake._track.enabled).toBe(true);
    expect(peer).not.toBeNull();
  });
});
