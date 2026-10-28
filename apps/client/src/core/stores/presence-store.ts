/**
 * presence-store：在线状态 + "正在输入"（3s TTL）。
 */
import { create } from 'zustand';
import type { PresencePayload } from '../../net/proto/payload';

export interface PresenceEntry {
  status: 'online' | 'away' | 'offline';
  at: number;
}

export const TYPING_TTL_MS = 3_000;

export interface PresenceStore {
  byUserId: Record<number, PresenceEntry>;
  /** convId → userId → 过期时间戳 */
  typing: Record<number, Record<number, number>>;
  selfUserId: number;

  setSelfUserId(userId: number): void;
  setStatus(payload: PresencePayload): void;
  setTyping(convId: number, userId: number, typing: boolean, at?: number): void;
  prune(now?: number): void;
  clear(): void;
}

export const usePresenceStore = create<PresenceStore>()((set, get) => ({
  byUserId: {},
  typing: {},
  selfUserId: 0,

  setSelfUserId: (userId) => set({ selfUserId: userId }),

  setStatus: (payload) => {
    if (!payload.userId || payload.userId === get().selfUserId) return;
    set({
      byUserId: {
        ...get().byUserId,
        [payload.userId]: { status: payload.status, at: payload.at },
      },
    });
  },

  setTyping: (convId, userId, typing, at) => {
    if (!userId || userId === get().selfUserId) return;
    const current = { ...(get().typing[convId] ?? {}) };
    if (typing) current[userId] = (at ?? Date.now()) + TYPING_TTL_MS;
    else delete current[userId];
    set({ typing: { ...get().typing, [convId]: current } });
  },

  prune: (now = Date.now()) => {
    const typing = get().typing;
    let changed = false;
    const next: Record<number, Record<number, number>> = {};
    for (const [convId, users] of Object.entries(typing)) {
      const kept: Record<number, number> = {};
      for (const [userId, expiresAt] of Object.entries(users)) {
        if (expiresAt > now) kept[Number(userId)] = expiresAt;
        else changed = true;
      }
      if (Object.keys(kept).length > 0) next[Number(convId)] = kept;
    }
    if (changed) set({ typing: next });
  },

  clear: () => set({ byUserId: {}, typing: {} }),
}));
