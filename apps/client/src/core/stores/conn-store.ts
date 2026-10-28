/**
 * conn-store：连接状态机在 UI 侧的投影（唯一职责 = 展示连接健康度）。
 * 不发起连接、不重连、不解析帧。
 */
import { create } from 'zustand';
import { bus } from '../bus';
import type { ConnState, ConnStateMeta } from '../../net/transport/types';

export interface ConnStore {
  state: ConnState;
  attempt: number;
  latencyMs: number;
  reason?: string;
  lastChangeAt: number;
  /** 断线恢复成功的时间点（NetworkBar "已恢复" 1.5s） */
  restoredAt: number | null;
  everOnline: boolean;
  applyState(state: ConnState, meta?: ConnStateMeta): void;
  dismissRestored(): void;
  reset(): void;
}

export const useConnStore = create<ConnStore>()((set, get) => ({
  state: 'offline',
  attempt: 0,
  latencyMs: 0,
  reason: undefined,
  lastChangeAt: 0,
  restoredAt: null,
  everOnline: false,

  applyState: (state, meta) => {
    const previous = get().state;
    const wasReconnecting = previous === 'reconnecting' || previous === 'offline';
    set({
      state,
      attempt: meta?.attempt ?? get().attempt,
      latencyMs: meta?.latencyMs ?? get().latencyMs,
      reason: meta?.reason ?? get().reason,
      lastChangeAt: meta?.at ?? Date.now(),
      everOnline: get().everOnline || state === 'online',
      restoredAt: state === 'online' && wasReconnecting && get().everOnline ? Date.now() : get().restoredAt,
    });
    if (previous !== state) bus.emit('conn:changed', { state, previous });
  },

  dismissRestored: () => set({ restoredAt: null }),

  reset: () =>
    set({
      state: 'offline',
      attempt: 0,
      latencyMs: 0,
      reason: undefined,
      lastChangeAt: 0,
      restoredAt: null,
      everOnline: false,
    }),
}));
