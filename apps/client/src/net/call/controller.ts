/**
 * 通话状态机（§ A.4）与对外单例。
 *
 *    idle → outgoing → connecting → active → ended →(1.5s)→ idle
 *    idle → incoming →(answer)→ connecting → active → ended
 *
 * 负责：
 *  - 发起、接听、拒绝、挂断、静音；
 *  - 超时：45s 无 answer 自动挂断并提示（reason=timeout）；
 *  - ICE 失败：connecting 后 10s 未 connected 结束并提示网络问题；
 *  - 状态变化广播给 UI（subscribe / getSnapshot，React-free）。
 *
 * 依赖注入（createPeer / getUserMedia / now / newCallId）便于在 node 测试中 stub
 * 浏览器 WebRTC API。本模块不 import core/ui，气泡事件用注入的 onToast 回调。
 */
import type { NetClient } from '../transport/types';
import {
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
import { createPeer, type PeerHandlers, type PeerLike } from './peer';
import type { CallInfo, CallMedia, CallState } from './types';

export const OFFER_TIMEOUT_MS = 45_000;
export const ICE_TIMEOUT_MS = 10_000;
const ENDED_RESET_MS = 1_500;

export interface CallSnapshot {
  state: CallState;
  info: CallInfo | null;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  muted: boolean;
}

export interface CallControllerDeps {
  createPeer(handlers: PeerHandlers, localStream: MediaStream | null): PeerLike;
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  now(): number;
  newCallId(): string;
}

export interface StartCallInput {
  convId: number;
  peerUserId: number;
  media: CallMedia;
  client: NetClient;
  selfId: number;
}

const defaultDeps: CallControllerDeps = {
  createPeer: (handlers, localStream) => createPeer(handlers, localStream),
  getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
  now: () => Date.now(),
  newCallId: () =>
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
};

export class CallController {
  private readonly deps: CallControllerDeps;

  private state: CallState = 'idle';
  private info: CallInfo | null = null;
  private localStream: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;
  private muted = false;

  private peer: PeerLike | null = null;
  private client: NetClient | null = null;
  private selfId = 0;
  private pendingOfferSdp: string | null = null;

  private offerTimer: ReturnType<typeof setTimeout> | null = null;
  private iceTimer: ReturnType<typeof setTimeout> | null = null;
  private resetTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly listeners = new Set<() => void>();
  private snap: CallSnapshot;

  /** 提示回调（i18n key）；由 composition root 注入 toast。 */
  onToast: (key: string) => void = () => {};

  constructor(deps: CallControllerDeps = defaultDeps) {
    this.deps = deps;
    this.snap = {
      state: 'idle',
      info: null,
      localStream: null,
      remoteStream: null,
      muted: false,
    };
  }

  // ---------------------------------------------------------------------------
  // 对外观察接口（useSyncExternalStore 兼容）
  // ---------------------------------------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): CallSnapshot => this.snap;

  private emit(): void {
    this.snap = {
      state: this.state,
      info: this.info,
      localStream: this.localStream,
      remoteStream: this.remoteStream,
      muted: this.muted,
    };
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        console.error('[call] listener failed', error);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 发起 / 接听 / 拒绝 / 挂断
  // ---------------------------------------------------------------------------

  async startCall(input: StartCallInput): Promise<boolean> {
    if (this.state !== 'idle') return false;
    this.client = input.client;
    this.selfId = input.selfId;
    this.info = {
      callId: this.deps.newCallId(),
      convId: input.convId,
      peerUserId: input.peerUserId,
      media: input.media,
      startedAt: this.deps.now(),
    };
    this.setState('outgoing');

    try {
      this.localStream = await this.deps.getUserMedia({
        audio: true,
        video: input.media === 'video',
      });
    } catch (error) {
      console.warn('[call] getUserMedia failed', error);
      this.onToast('call.mediaError');
      this.finish('error', { silent: true });
      return false;
    }
    this.emit();

    this.peer = this.deps.createPeer(this.handlers(), this.localStream);
    try {
      const offer = await this.peer.createOffer();
      sendOffer(input.client, {
        callId: this.info.callId,
        convId: input.convId,
        toUserId: input.peerUserId,
        sdp: offer.sdp ?? '',
        media: input.media,
        fromUserId: input.selfId,
      });
    } catch (error) {
      console.warn('[call] createOffer failed', error);
      this.onToast('call.networkIssue');
      this.finish('error', { silent: true });
      return false;
    }

    this.startOfferTimer();
    this.emit();
    return true;
  }

  /** 承接来电（如 UI 已确认接听后再调用 getMedia）。 */
  async answer(): Promise<boolean> {
    if (this.state !== 'incoming' || !this.info || !this.pendingOfferSdp) return false;
    try {
      this.localStream = await this.deps.getUserMedia({
        audio: true,
        video: this.info.media === 'video',
      });
    } catch (error) {
      console.warn('[call] getUserMedia failed', error);
      this.onToast('call.mediaError');
      this.sendHangupSafe('error');
      this.finish('error', { silent: true });
      return false;
    }

    this.peer = this.deps.createPeer(this.handlers(), this.localStream);
    try {
      const answer = await this.peer.createAnswer(this.pendingOfferSdp);
      if (this.client) {
        sendAnswer(this.client, this.info.peerUserId, {
          callId: this.info.callId,
          sdp: answer.sdp ?? '',
          fromUserId: this.selfId,
        });
      }
    } catch (error) {
      console.warn('[call] createAnswer failed', error);
      this.onToast('call.networkIssue');
      this.sendHangupSafe('error');
      this.finish('error', { silent: true });
      return false;
    }

    this.setState('connecting');
    this.startIceTimer();
    this.emit();
    return true;
  }

  reject(): void {
    if (this.state !== 'incoming' || !this.info) return;
    if (this.client) {
      sendBusy(this.client, this.info.peerUserId, {
        callId: this.info.callId,
        reason: 'declined',
        fromUserId: this.selfId,
      });
    }
    this.finish('declined', { silent: true });
  }

  hangup(): void {
    if (this.state === 'idle' || this.state === 'ended') return;
    this.sendHangupSafe('hangup');
    this.finish('hangup', { silent: true });
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    if (this.localStream) {
      for (const track of this.localStream.getAudioTracks()) track.enabled = !this.muted;
    }
    this.emit();
    return this.muted;
  }

  // ---------------------------------------------------------------------------
  // 入站信令处理（由 5 个 kind handler 调用）
  // ---------------------------------------------------------------------------

  handleOffer(payload: CallOfferPayload, client: NetClient, selfId: number): 'incoming' | 'busy' {
    this.client = client;
    this.selfId = selfId;
    if (this.state !== 'idle') {
      sendBusy(client, payload.fromUserId, {
        callId: payload.callId,
        reason: 'busy',
        fromUserId: selfId,
      });
      return 'busy';
    }
    this.info = {
      callId: payload.callId,
      convId: payload.convId,
      peerUserId: payload.fromUserId,
      media: payload.media,
      startedAt: this.deps.now(),
    };
    this.pendingOfferSdp = payload.sdp;
    this.localStream = null;
    this.remoteStream = null;
    this.muted = false;
    this.setState('incoming');
    return 'incoming';
  }

  handleAnswer(payload: CallAnswerPayload, client: NetClient, selfId: number): void {
    this.client = client;
    this.selfId = selfId;
    if (this.state !== 'outgoing' || !this.info || payload.callId !== this.info.callId) return;
    this.clearOfferTimer();
    this.setState('connecting');
    const peer = this.peer;
    void peer?.setRemoteSdp(payload.sdp).catch((error) => {
      console.warn('[call] setRemoteSdp failed', error);
      this.onToast('call.networkIssue');
      this.finish('networkIssue', { silent: true });
    });
    this.startIceTimer();
  }

  handleCandidate(payload: CallCandidatePayload): void {
    if (!this.info || payload.callId !== this.info.callId) return;
    void this.peer
      ?.addIceCandidate({
        candidate: payload.candidate,
        sdpMid: payload.sdpMid,
        sdpMLineIndex: payload.sdpMLineIndex,
      })
      .catch(() => {
        /* 单条候选失败可容忍，等待后续候选 */
      });
  }

  handleBusy(payload: CallBusyPayload): void {
    if (!this.info || payload.callId !== this.info.callId) return;
    const key =
      payload.reason === 'busy'
        ? 'call.busy'
        : payload.reason === 'declined'
          ? 'call.declined'
          : 'call.unsupported';
    this.onToast(key);
    this.finish(payload.reason, { silent: true });
  }

  handleHangup(payload: CallHangupPayload): void {
    if (!this.info || payload.callId !== this.info.callId) return;
    this.finish(payload.reason, { silent: false });
  }

  // ---------------------------------------------------------------------------
  // 内部
  // ---------------------------------------------------------------------------

  private handlers(): PeerHandlers {
    return {
      onIceCandidate: (candidate) => {
        if (this.client && this.info) {
          sendCandidate(this.client, this.info.peerUserId, {
            callId: this.info.callId,
            candidate: candidate.candidate,
            sdpMid: candidate.sdpMid,
            sdpMLineIndex: candidate.sdpMLineIndex,
            fromUserId: this.selfId,
          });
        }
      },
      onTrack: (stream) => {
        this.remoteStream = stream;
        this.emit();
      },
      onConnectionState: (state) => this.handlePeerState(state),
    };
  }

  private handlePeerState(state: string): void {
    if (this.state === 'ended' || this.state === 'idle') return;
    if (state === 'connected') {
      this.clearIceTimer();
      if (this.state !== 'active') {
        this.state = 'active';
        if (this.info) this.info.startedAt = this.deps.now();
        this.emit();
      }
      return;
    }
    if (state === 'failed') {
      this.sendHangupSafe('error');
      this.finish('networkIssue', { silent: false });
    }
  }

  private sendHangupSafe(reason: 'hangup' | 'timeout' | 'error'): void {
    if (this.client && this.info) {
      sendHangup(this.client, this.info.peerUserId, {
        callId: this.info.callId,
        reason,
        fromUserId: this.selfId,
      });
    }
  }

  private finish(reason: string, opts: { silent?: boolean } = {}): void {
    this.clearTimers();
    if (this.peer) {
      this.peer.close();
      this.peer = null;
    }
    if (this.localStream) {
      for (const track of this.localStream.getTracks()) {
        try {
          track.stop();
        } catch {
          /* ignore */
        }
      }
    }
    this.localStream = null;
    this.remoteStream = null;
    this.state = 'ended';
    if (this.info) {
      this.info.endedAt = this.deps.now();
      this.info.endReason = reason;
    }
    if (!opts.silent) this.onToast(this.toastKeyFor(reason));
    this.emit();
    this.resetTimer = setTimeout(() => this.reset(), ENDED_RESET_MS);
  }

  private reset(): void {
    this.clearTimers();
    this.state = 'idle';
    this.info = null;
    this.pendingOfferSdp = null;
    this.muted = false;
    this.peer = null;
    this.client = null;
    this.localStream = null;
    this.remoteStream = null;
    this.emit();
  }

  private setState(state: CallState): void {
    this.state = state;
    this.emit();
  }

  private toastKeyFor(reason: string): string {
    switch (reason) {
      case 'timeout':
        return 'call.timeout';
      case 'busy':
        return 'call.busy';
      case 'declined':
        return 'call.declined';
      case 'networkIssue':
      case 'error':
        return 'call.networkIssue';
      case 'unsupported':
        return 'call.unsupported';
      default:
        return 'call.ended';
    }
  }

  private startOfferTimer(): void {
    this.clearOfferTimer();
    this.offerTimer = setTimeout(() => {
      if (this.state !== 'outgoing') return;
      this.sendHangupSafe('timeout');
      this.finish('timeout', { silent: false });
    }, OFFER_TIMEOUT_MS);
  }

  private startIceTimer(): void {
    this.clearIceTimer();
    this.iceTimer = setTimeout(() => {
      if (this.state !== 'connecting') return;
      this.sendHangupSafe('error');
      this.finish('networkIssue', { silent: false });
    }, ICE_TIMEOUT_MS);
  }

  private clearOfferTimer(): void {
    if (this.offerTimer) {
      clearTimeout(this.offerTimer);
      this.offerTimer = null;
    }
  }

  private clearIceTimer(): void {
    if (this.iceTimer) {
      clearTimeout(this.iceTimer);
      this.iceTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearOfferTimer();
    this.clearIceTimer();
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
      this.resetTimer = null;
    }
  }
}

/** 全局单例：handlers 与 UI（useCall）共用同一实例。 */
export const callController = new CallController();
