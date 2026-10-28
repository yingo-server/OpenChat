/**
 * session-store：身份 / 权限 / 封禁 / feature flags。
 * 只存"是谁、能做什么"，不持有 token（token 在 net/auth/token-store）。
 */
import { create } from 'zustand';
import { bus } from '../bus';
import type { StoredSession } from '../../net/auth/token-store';

export type SessionStatus = 'anonymous' | 'authenticated' | 'guest' | 'banned';

export interface BanInfo {
  reason: string;
  until: number;
}

export interface SessionStore {
  status: SessionStatus;
  userId: number;
  sessionId: string;
  displayName: string;
  avatar?: string;
  guest: boolean;
  flags: Record<string, string>;
  flagsVersion: number;
  ban: BanInfo | null;
  signIn(session: StoredSession): void;
  signOut(): void;
  setFlags(flags: Record<string, string>, version: number): void;
  kicked(reason: string, bannedUntil: number): void;
  clearBan(): void;
}

export const useSessionStore = create<SessionStore>()((set, get) => ({
  status: 'anonymous',
  userId: 0,
  sessionId: '',
  displayName: '',
  avatar: undefined,
  guest: false,
  flags: { 'media.enabled': '1', 'read.receipt': '1' },
  flagsVersion: 0,
  ban: null,

  signIn: (session) => {
    const status: SessionStatus = session.guest ? 'guest' : 'authenticated';
    set({
      status,
      userId: session.userId,
      sessionId: session.sessionId,
      displayName: session.displayName ?? `用户 ${session.userId}`,
      guest: session.guest,
      ban: null,
    });
    bus.emit('session:changed', { userId: session.userId, status });
  },

  signOut: () => {
    set({
      status: 'anonymous',
      userId: 0,
      sessionId: '',
      displayName: '',
      avatar: undefined,
      guest: false,
      flags: {},
      flagsVersion: 0,
      ban: null,
    });
    bus.emit('session:changed', { userId: 0, status: 'anonymous' });
  },

  setFlags: (flags, version) => {
    // 版本单调：旧广播（乱序到达）不得覆盖新策略
    if (version > 0 && version < get().flagsVersion) return;
    set({ flags: { ...flags }, flagsVersion: version });
  },

  kicked: (reason, bannedUntil) => {
    if (bannedUntil > 0) {
      set({ status: 'banned', ban: { reason, until: bannedUntil } });
      bus.emit('session:changed', { userId: get().userId, status: 'banned' });
      return;
    }
    set({ status: 'anonymous', userId: 0, sessionId: '', guest: false, ban: null });
    bus.emit('session:changed', { userId: 0, status: 'anonymous' });
  },

  clearBan: () => set({ ban: null }),
}));
