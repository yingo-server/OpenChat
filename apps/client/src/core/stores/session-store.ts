/**
 * session-store：身份 / 权限 / 封禁 / feature flags。
 * 只存"是谁、能做什么"，不持有 token（token 在 net/auth/token-store）。
 */
import { create } from 'zustand';
import { bus } from '../bus';
import type { StoredSession } from '../../net/auth/token-store';

export type SessionStatus = 'anonymous' | 'authenticated' | 'guest' | 'banned';

/**
 * feature flag 判定 —— 唯一权威口径（P0-4）。
 *
 * 服务端下发的 flag 值是字符串（router.go 的 flagString：bool → "true"/"false"，
 * 字符串原样透传），**从不是 "0"/"1"**。因此「值 === 'true' 才算开」，
 * 缺失（flags 尚未到达 / 无该 key）一律视为关闭 —— 保守：拿不到 flag 就不显示入口。
 *
 * 历史遗留的 `flags[key] !== '0'` 判定恒真（服务端从不下发 "0"），导致
 * call_enabled 关闭时按钮照样显示。
 */
export function isFlagEnabled(
  flags: Record<string, string> | undefined | null,
  key: string,
): boolean {
  if (!flags) return false;
  const value = flags[key];
  if (typeof value !== 'string') return false;
  return value === 'true';
}

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
  flags: { 'media.enabled': 'true', 'read.receipt': 'true' },
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
