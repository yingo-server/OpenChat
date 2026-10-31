/**
 * useCall —— 通话控制器的 React 适配层。
 * 状态来自 callController（useSyncExternalStore），动作转发给控制器；
 * NetClient 与 selfId 从 app-services / session store 取，UI 不直接碰信令。
 */
import { useSyncExternalStore } from 'react';
import { callController } from '../../../net/call/controller';
import type { CallInfo, CallMedia, CallState } from '../../../net/call/types';
import { useSessionStore } from '../../../core/stores/session-store';
import { getAppServices } from '../../services/app-services';

export interface UseCall {
  state: CallState;
  info: CallInfo | null;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  muted: boolean;
  startCall(convId: number, peerUserId: number, media: CallMedia): void;
  answer(): void;
  reject(): void;
  hangup(): void;
  toggleMute(): void;
}

export function useCall(): UseCall {
  const snapshot = useSyncExternalStore(
    callController.subscribe,
    callController.getSnapshot,
    callController.getSnapshot,
  );
  const selfId = useSessionStore((state) => state.userId);

  return {
    state: snapshot.state,
    info: snapshot.info,
    localStream: snapshot.localStream,
    remoteStream: snapshot.remoteStream,
    muted: snapshot.muted,
    startCall: (convId, peerUserId, media) => {
      const client = getAppServices().client;
      if (!client) return;
      void callController.startCall({ convId, peerUserId, media, client, selfId });
    },
    answer: () => {
      void callController.answer();
    },
    reject: () => callController.reject(),
    hangup: () => callController.hangup(),
    toggleMute: () => callController.toggleMute(),
  };
}
