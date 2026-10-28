/**
 * 纯函数 selectors —— core 不依赖 React，组件用 useMemo 组合。
 * 派生计算集中在此，避免组件里散落业务规则。
 */
import type { ConnStore } from '../stores/conn-store';
import type { ConvStore } from '../stores/conv-store';
import type { MessageStore } from '../stores/message-store';
import type { PresenceStore } from '../stores/presence-store';
import type { SessionStore } from '../stores/session-store';
import type { ChatMessage, ConvRecord } from '../types';

/** 会话列表（顺序已按置顶/最新排序） */
export function selectConvList(state: ConvStore): ConvRecord[] {
  return state.order.map((convId) => state.convs[convId]).filter((conv): conv is ConvRecord => Boolean(conv));
}

export function selectConv(state: ConvStore, convId: number | null): ConvRecord | null {
  return convId ? (state.convs[convId] ?? null) : null;
}

export function selectUnreadTotal(state: ConvStore): number {
  return Object.values(state.convs).reduce((sum, conv) => sum + (conv.muted ? 0 : conv.unread), 0);
}

export function selectMessages(state: MessageStore, convId: number): ChatMessage[] {
  const ids = state.idsByConv[convId] ?? [];
  return ids.map((id) => state.byId[id]).filter((message): message is ChatMessage => Boolean(message));
}

export function selectLastSeq(state: MessageStore, convId: number): number {
  const ids = state.idsByConv[convId] ?? [];
  for (let i = ids.length - 1; i >= 0; i -= 1) {
    const message = state.byId[ids[i]];
    if (message && message.seq > 0) return message.seq;
  }
  return 0;
}

export function selectIsMine(message: ChatMessage, userId: number): boolean {
  if (message.id.startsWith('local:')) return true;
  return userId > 0 && message.senderId === userId;
}

export function selectTypingUserIds(
  state: PresenceStore,
  convId: number,
  now = Date.now(),
): number[] {
  const users = state.typing[convId] ?? {};
  return Object.entries(users)
    .filter(([, expiresAt]) => expiresAt > now)
    .map(([userId]) => Number(userId));
}

export function selectPresence(state: PresenceStore, userId: number): 'online' | 'away' | 'offline' {
  return state.byUserId[userId]?.status ?? 'offline';
}

export function selectFlag(state: SessionStore, key: string, fallback = ''): string {
  return state.flags[key] ?? fallback;
}

export function selectBooleanFlag(state: SessionStore, key: string, fallback = false): boolean {
  const value = state.flags[key];
  if (value === undefined) return fallback;
  return value === '1' || value === 'true';
}

/** 游客不能发媒体；运营也可通过 flag 全局关闭 */
export function selectCanSendMedia(state: SessionStore): boolean {
  return state.status !== 'guest' && selectBooleanFlag(state, 'media.enabled', true);
}

export function selectCanSendMessage(state: SessionStore): boolean {
  return state.status === 'authenticated' || state.status === 'guest';
}

/** NetworkBar 的展示态（把 conn 状态 + 恢复窗口收敛成一个词） */
export type NetworkBanner = 'none' | 'offline' | 'connecting' | 'restored';

export function selectNetworkBanner(state: ConnStore, now = Date.now()): NetworkBanner {
  if (state.restoredAt && now - state.restoredAt < 1_500 && state.state === 'online') return 'restored';
  if (state.state === 'offline') return 'offline';
  if (state.state === 'connecting') return 'connecting';
  if (state.state === 'reconnecting') return state.attempt >= 3 ? 'offline' : 'connecting';
  return 'none';
}

/** 未读分隔线锚点：返回第一条未读消息的 index（-1 表示没有未读） */
export function selectUnreadDividerIndex(messages: ChatMessage[], unread: number): number {
  if (unread <= 0 || messages.length === 0) return -1;
  return Math.max(0, messages.length - unread);
}
