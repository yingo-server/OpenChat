/**
 * conv-store：会话列表的唯一状态源。
 * 只 import net 类型 + bus；不 import 其他 store（跨域联动走事件总线）。
 */
import { create } from 'zustand';
import { bus } from '../bus';
import type { ConvRecord, SyncStateView } from '../../net/sync/types';
import type { ConvPayload } from '../../net/proto/payload';
import type { ChatMessage } from '../types';

export interface ConvStore {
  convs: Record<number, ConvRecord>;
  order: number[];
  activeConvId: number | null;
  sync: Record<number, SyncStateView>;
  drafts: Record<number, string>;
  selfUserId: number;

  setSelfUserId(userId: number): void;
  hydrate(records: ConvRecord[]): void;
  upsert(record: ConvRecord): void;
  upsertFromWire(payload: ConvPayload): void;
  setActive(convId: number | null): void;
  setSyncState(convId: number, state: SyncStateView): void;
  markRead(convId: number): void;
  setDraft(convId: number, text: string): void;
  togglePin(convId: number): void;
  toggleMute(convId: number): void;
  remove(convId: number): void;
  clear(): void;
}

export const useConvStore = create<ConvStore>()((set, get) => ({
  convs: {},
  order: [],
  activeConvId: null,
  sync: {},
  drafts: {},
  selfUserId: 0,

  setSelfUserId: (userId) => set({ selfUserId: userId }),

  hydrate: (records) => {
    const convs: Record<number, ConvRecord> = {};
    for (const record of records) convs[record.convId] = record;
    set({ convs, order: sortConvs(convs) });
  },

  upsert: (record) => {
    const convs = { ...get().convs, [record.convId]: record };
    set({ convs, order: sortConvs(convs) });
  },

  upsertFromWire: (payload) => {
    const existing = get().convs[payload.convId];
    const now = Date.now();
    const record: ConvRecord = {
      convId: payload.convId,
      title: payload.title || existing?.title || '',
      convType: payload.convType ?? existing?.convType ?? 0,
      createdAt: payload.createdAt || existing?.createdAt || now,
      members: payload.members.length > 0 ? payload.members : (existing?.members ?? []),
      version: Math.max(payload.version, existing?.version ?? 0),
      lastSeq: Math.max(payload.lastSeq ?? 0, existing?.lastSeq ?? 0),
      unread: payload.unread ?? existing?.unread ?? 0,
      avatar: payload.avatar ?? existing?.avatar,
      updatedAt: now,
      lastMessageAt: existing?.lastMessageAt,
      lastPreview: existing?.lastPreview,
      lastMessageType: existing?.lastMessageType,
      lastSenderId: existing?.lastSenderId,
      pinned: existing?.pinned ?? false,
      muted: existing?.muted ?? false,
    };
    const convs = { ...get().convs, [record.convId]: record };
    set({ convs, order: sortConvs(convs) });
  },

  setActive: (convId) => {
    set({ activeConvId: convId });
    bus.emit('conv:activated', { convId });
  },

  setSyncState: (convId, state) => {
    const convs = { ...get().convs };
    const conv = convs[convId];
    if (conv && state.lastSeq > conv.lastSeq) {
      convs[convId] = { ...conv, lastSeq: state.lastSeq, updatedAt: Date.now() };
    }
    set({ sync: { ...get().sync, [convId]: state }, convs });
  },

  markRead: (convId) => {
    const conv = get().convs[convId];
    if (!conv || conv.unread === 0) return;
    set({ convs: { ...get().convs, [convId]: { ...conv, unread: 0 } } });
  },

  setDraft: (convId, text) => {
    set({ drafts: { ...get().drafts, [convId]: text } });
  },

  togglePin: (convId) => {
    const conv = get().convs[convId];
    if (!conv) return;
    const convs = { ...get().convs, [convId]: { ...conv, pinned: !conv.pinned } };
    set({ convs, order: sortConvs(convs) });
  },

  toggleMute: (convId) => {
    const conv = get().convs[convId];
    if (!conv) return;
    set({ convs: { ...get().convs, [convId]: { ...conv, muted: !conv.muted } } });
  },

  remove: (convId) => {
    const convs = { ...get().convs };
    delete convs[convId];
    const sync = { ...get().sync };
    delete sync[convId];
    const drafts = { ...get().drafts };
    delete drafts[convId];
    set({
      convs,
      sync,
      drafts,
      order: sortConvs(convs),
      activeConvId: get().activeConvId === convId ? null : get().activeConvId,
    });
  },

  clear: () => set({ convs: {}, order: [], activeConvId: null, sync: {}, drafts: {} }),
}));

/** 置顶优先 → 最新消息时间倒序。 */
export function sortConvs(convs: Record<number, ConvRecord>): number[] {
  return Object.values(convs)
    .sort((a, b) => {
      if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
      const at = a.lastMessageAt ?? a.updatedAt ?? 0;
      const bt = b.lastMessageAt ?? b.updatedAt ?? 0;
      return bt - at || a.convId - b.convId;
    })
    .map((conv) => conv.convId);
}

// ---------------------------------------------------------------------------
// 跨域联动：消息事件 → 未读/摘要/排序（不 import message-store）
// ---------------------------------------------------------------------------
bus.on('message:upserted', ({ message }) => {
  const state = useConvStore.getState();
  const existing = state.convs[message.convId];
  const now = Date.now();
  const base: ConvRecord = existing ?? {
    convId: message.convId,
    title: '',
    convType: 0,
    createdAt: message.sentAt || now,
    members: [],
    version: 0,
    lastSeq: 0,
    unread: 0,
    updatedAt: now,
  };
  const mine = isMine(message, state.selfUserId);
  // unread 的权威来源是 CONV_PAYLOAD；这里只对"刚发生"的消息做本地兜底计数，
  // 避免首次同步把整段历史消息误计为未读。
  const recent = message.sentAt > now - 10 * 60_000;
  const unread =
    !mine && recent && state.activeConvId !== message.convId ? base.unread + 1 : base.unread;
  const preview = message.payload.text ?? '';
  const next: ConvRecord = {
    ...base,
    unread,
    lastMessageAt: message.sentAt || now,
    lastPreview: preview,
    lastMessageType: message.type,
    updatedAt: now,
  };
  const convs = { ...state.convs, [next.convId]: next };
  useConvStore.setState({ convs, order: sortConvs(convs) });
});

bus.on('message:updated', ({ message }) => {
  const state = useConvStore.getState();
  const existing = state.convs[message.convId];
  if (!existing || existing.lastMessageAt !== message.sentAt || message.deleted) return;
  const convs = {
    ...state.convs,
    [message.convId]: {
      ...existing,
      lastPreview: message.payload.text ?? existing.lastPreview,
      lastMessageType: message.type,
    },
  };
  useConvStore.setState({ convs });
});

function isMine(message: ChatMessage, selfUserId: number): boolean {
  return message.id.startsWith('local:') || (selfUserId > 0 && message.senderId === selfUserId);
}
