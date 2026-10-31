/**
 * RTCPeerConnection 封装（§ A.3）。
 *
 * - ICE servers 从 import.meta.env.VITE_ICE_SERVERS（JSON 数组）读取，缺省 STUN。
 * - ontrack → MediaStream 交给 UI；onicecandidate → 回调由 controller 发出 CANDIDATE。
 * - close() 停止所有 track 并关闭连接。
 *
 * 只在函数体内引用浏览器全局（RTCPeerConnection / MediaStream），模块导入本身
 * 不触碰 DOM，便于 node 测试 stub。
 */

export interface IceCandidateInfo {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
}

export type PeerConnectionState = 'new' | 'connecting' | 'connected' | 'disconnected' | 'failed' | 'closed';

export interface PeerHandlers {
  onIceCandidate(candidate: IceCandidateInfo): void;
  onTrack(stream: MediaStream): void;
  onConnectionState(state: PeerConnectionState): void;
}

export interface PeerLike {
  createOffer(): Promise<RTCSessionDescriptionInit>;
  createAnswer(remoteSdp: string): Promise<RTCSessionDescriptionInit>;
  setRemoteSdp(sdp: string): Promise<void>;
  addIceCandidate(candidate: IceCandidateInfo): Promise<void>;
  close(): void;
}

const DEFAULT_ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

/** 读取 ICE servers：VITE_ICE_SERVERS 为 JSON 数组（如 `[{"urls":"turn:..."}]`）。 */
export function resolveIceServers(): RTCIceServer[] {
  try {
    const raw = import.meta.env?.VITE_ICE_SERVERS;
    if (typeof raw === 'string' && raw.trim()) {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.filter((item): item is RTCIceServer => Boolean(item) && typeof item === 'object');
      }
    }
  } catch (error) {
    console.warn('[call] invalid VITE_ICE_SERVERS, fallback to STUN', error);
  }
  return DEFAULT_ICE_SERVERS;
}

/** 创建封装的 PeerConnection；localStream 存在时把其 track 加入连接。 */
export function createPeer(handlers: PeerHandlers, localStream?: MediaStream | null): PeerLike {
  const pc = new RTCPeerConnection({ iceServers: resolveIceServers() });

  pc.onicecandidate = (event) => {
    if (!event.candidate) return;
    handlers.onIceCandidate({
      candidate: event.candidate.candidate,
      sdpMid: event.candidate.sdpMid,
      sdpMLineIndex: event.candidate.sdpMLineIndex,
    });
  };

  pc.ontrack = (event) => {
    const stream = event.streams[0] ?? new MediaStream([event.track]);
    handlers.onTrack(stream);
  };

  pc.onconnectionstatechange = () => {
    handlers.onConnectionState(pc.connectionState as PeerConnectionState);
  };

  if (localStream) {
    for (const track of localStream.getTracks()) pc.addTrack(track, localStream);
  }

  return {
    async createOffer() {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      return offer;
    },
    async createAnswer(remoteSdp: string) {
      await pc.setRemoteDescription({ type: 'offer', sdp: remoteSdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      return answer;
    },
    async setRemoteSdp(sdp: string) {
      await pc.setRemoteDescription({ type: 'answer', sdp });
    },
    async addIceCandidate(candidate: IceCandidateInfo) {
      await pc.addIceCandidate(candidate);
    },
    close() {
      if (localStream) {
        for (const track of localStream.getTracks()) {
          try {
            track.stop();
          } catch {
            /* ignore */
          }
        }
      }
      try {
        pc.close();
      } catch {
        /* ignore */
      }
    },
  };
}
