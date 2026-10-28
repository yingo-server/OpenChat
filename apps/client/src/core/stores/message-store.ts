/**
 * message-store：渲染投影（IndexedDB 的只读镜像 + 本地乐观消息）。
 *
 * 约束：
 *  - 服务端消息只能经 sync 引擎（sink.applyMessages）进来；
 *  - 本 store 不写 IndexedDB、不发网络帧；
 *  - 单条消息组件用 `useMessageStore(s => s.byId[id])` 订阅，未读变化不触发兄弟项重渲染。
 */
import { create } from 'zustand';
import { bus } from '../bus';
import type { StoredMessage } from '../../net/sync/types';
import type { OutboxItem } from '../../net/sync/outbox';
import type { ChatMessage } from '../types';

export type TombstoneOp = 'delete' | 'recall';

type HistoryLoader = (
  convId: number,
  limit: number,
  beforeSeq?: number,
) => Promise<StoredMessage[]>;

let historyLoader: HistoryLoader | null = null;

export interface MessageStore {
  byId: Record<string, ChatMessage>;
  idsByConv: Record<number, string[]>;
  loadingHistory: Record<number, boolean>;
  tombstones: Record<number, Record<number, TombstoneOp>>;

  hydrate(messages: StoredMessage[]): void;
  upsertMessages(messages: StoredMessage[]): void;
  applyOptimistic(item: OutboxItem): void;
  confirmLocal(item: OutboxItem, ack: { msgId: number; seq: number }): void;
  failLocal(item: OutboxItem, reason?: string): void;
  removeLocal(localId: string): void;
  applyTombstone(convId: number, msgId: number, seq: number, op: TombstoneOp): void;
  applyEdit(convId: number, msgId: number, text: string): void;
  applyReceipt(
    convId: number,
    msgId: number,
    type: 'read' | 'delivered',
    userId: number,
    at: number,
  ): void;
  setHistoryLoader(loader: HistoryLoader | null): void;
  loadOlder(convId: number, beforeSeq: number): Promise<number>;
  clear(): void;
}

export function messageKey(convId: number, seq: number): string {
  return `${convId}:${seq}`;
}

export function localMessageKey(clientMsgId: string): string {
  return `local:${clientMsgId}`;
}

interface MergeResult {
  byId: Record<string, ChatMessage>;
  idsByConv: Record<number, string[]>;
  upserted: ChatMessage[];
  updated: ChatMessage[];
}

function mergeMessages(
  state: Pick<MessageStore, 'byId' | 'idsByConv' | 'tombstones'>,
  raws: StoredMessage[],
): MergeResult {
  const byId = { ...state.byId };
  const idsByConv = { ...state.idsByConv };
  const touched = new Set<number>();
  const upserted: ChatMessage[] = [];
  const updated: ChatMessage[] = [];

  for (const raw of raws) {
    const id = messageKey(raw.convId, raw.seq);
    const message: ChatMessage = { ...raw, id };

    if (raw.clientMsgId) {
      const twinId = localMessageKey(raw.clientMsgId);
      if (twinId !== id && byId[twinId]) {
        delete byId[twinId];
        removeId(idsByConv, raw.convId, twinId);
      }
    }

    const sameMsgId = findIdByMsgId(byId, idsByConv[raw.convId] ?? [], raw.msgId);
    if (sameMsgId && sameMsgId !== id) {
      delete byId[sameMsgId];
      removeId(idsByConv, raw.convId, sameMsgId);
    }

    if (state.tombstones[raw.convId]?.[raw.msgId]) {
      message.deleted = true;
    }

    const existed = Boolean(byId[id]);
    byId[id] = message;
    addId(idsByConv, raw.convId, id);
    touched.add(raw.convId);
    (existed ? updated : upserted).push(message);
  }

  for (const convId of touched) {
    const ids = idsByConv[convId] ?? [];
    ids.sort((a, b) => compareMessages(byId[a], byId[b]));
  }
  return { byId, idsByConv, upserted, updated };
}

function compareMessages(a: ChatMessage | undefined, b: ChatMessage | undefined): number {
  if (!a || !b) return 0;
  const as = a.seq > 0 ? a.seq : Number.MAX_SAFE_INTEGER;
  const bs = b.seq > 0 ? b.seq : Number.MAX_SAFE_INTEGER;
  if (as !== bs) return as - bs;
  if (a.sentAt !== b.sentAt) return a.sentAt - b.sentAt;
  return a.id.localeCompare(b.id);
}

function addId(map: Record<number, string[]>, convId: number, id: string): void {
  const ids = map[convId] ?? [];
  if (!ids.includes(id)) ids.push(id);
  map[convId] = ids;
}

function removeId(map: Record<number, string[]>, convId: number, id: string): void {
  map[convId] = (map[convId] ?? []).filter((candidate) => candidate !== id);
}

function findIdByMsgId(
  byId: Record<string, ChatMessage>,
  ids: string[],
  msgId: number,
): string | undefined {
  if (!msgId) return undefined;
  return ids.find((id) => byId[id]?.msgId === msgId);
}

function emitMerged(result: MergeResult): void {
  for (const message of result.upserted) bus.emit('message:upserted', { message });
  for (const message of result.updated) bus.emit('message:updated', { message });
}

export const useMessageStore = create<MessageStore>()((set, get) => ({
  byId: {},
  idsByConv: {},
  loadingHistory: {},
  tombstones: {},

  hydrate: (messages) => {
    const byId: Record<string, ChatMessage> = {};
    const idsByConv: Record<number, string[]> = {};
    for (const raw of messages) {
      const id = messageKey(raw.convId, raw.seq);
      byId[id] = { ...raw, id };
      addId(idsByConv, raw.convId, id);
    }
    for (const convId of Object.keys(idsByConv).map(Number)) {
      idsByConv[convId].sort((a, b) => compareMessages(byId[a], byId[b]));
    }
    set({ byId, idsByConv });
  },

  upsertMessages: (messages) => {
    if (messages.length === 0) return;
    const result = mergeMessages(get(), messages);
    set({ byId: result.byId, idsByConv: result.idsByConv });
    emitMerged(result);
  },

  applyOptimistic: (item) => {
    const type = item.content.media?.length
      ? item.content.media[0].type
      : item.content.text
        ? 'text'
        : 'system';
    const raw: StoredMessage = {
      convId: item.convId,
      seq: 0,
      msgId: 0,
      senderId: 0,
      sentAt: item.createdAt,
      type,
      payload: {
        text: item.content.text,
        media: item.content.media,
        replyTo: item.content.replyTo,
        mentions: item.content.mentions,
      },
      status: 'sending',
      clientMsgId: item.clientMsgId,
    };
    const result = mergeMessages(get(), [raw]);
    // mergeMessages 以 seq=0 生成 `${convId}:0`，这里换成 localId 语义
    const generated = messageKey(item.convId, 0);
    const localId = localMessageKey(item.clientMsgId);
    const message = result.byId[generated];
    if (message) {
      delete result.byId[generated];
      removeId(result.idsByConv, item.convId, generated);
      result.byId[localId] = { ...message, id: localId };
      addId(result.idsByConv, item.convId, localId);
      result.idsByConv[item.convId].sort((a, b) => compareMessages(result.byId[a], result.byId[b]));
    }
    set({ byId: result.byId, idsByConv: result.idsByConv });
    if (message) bus.emit('message:upserted', { message: { ...message, id: localId } });
  },

  confirmLocal: (item, ack) => {
    const localId = localMessageKey(item.clientMsgId);
    const local = get().byId[localId];
    if (!local) return;
    const serverId = messageKey(item.convId, ack.seq);
    const byId = { ...get().byId };
    const idsByConv = { ...get().idsByConv };
    delete byId[localId];
    removeId(idsByConv, item.convId, localId);
    let outcome: ChatMessage;
    if (byId[serverId]) {
      outcome = byId[serverId];
    } else {
      outcome = {
        ...local,
        id: serverId,
        seq: ack.seq,
        msgId: ack.msgId,
        status: 'sent',
        error: undefined,
        clientMsgId: item.clientMsgId,
      };
      byId[serverId] = outcome;
      addId(idsByConv, item.convId, serverId);
      idsByConv[item.convId].sort((a, b) => compareMessages(byId[a], byId[b]));
    }
    set({ byId, idsByConv });
    bus.emit('message:updated', { message: outcome });
  },

  failLocal: (item, reason) => {
    const localId = localMessageKey(item.clientMsgId);
    const message = get().byId[localId];
    if (!message) return;
    const next: ChatMessage = { ...message, status: 'failed', error: reason };
    set({ byId: { ...get().byId, [localId]: next } });
    bus.emit('message:updated', { message: next });
  },

  removeLocal: (localId) => {
    const message = get().byId[localId];
    if (!message) return;
    const byId = { ...get().byId };
    delete byId[localId];
    const idsByConv = { ...get().idsByConv };
    removeId(idsByConv, message.convId, localId);
    set({ byId, idsByConv });
    bus.emit('message:removed', { convId: message.convId, id: localId });
  },

  applyTombstone: (convId, msgId, seq, op) => {
    const tombstones = {
      ...get().tombstones,
      [convId]: { ...(get().tombstones[convId] ?? {}), [msgId]: op },
    };
    const ids = get().idsByConv[convId] ?? [];
    const id = ids.find((candidate) => get().byId[candidate]?.msgId === msgId) ?? messageKey(convId, seq);
    const existing = get().byId[id];
    if (!existing) {
      set({ tombstones });
      return;
    }
    const next: ChatMessage = { ...existing, deleted: true };
    set({ tombstones, byId: { ...get().byId, [id]: next } });
    bus.emit('message:updated', { message: next });
  },

  applyEdit: (convId, msgId, text) => {
    const ids = get().idsByConv[convId] ?? [];
    const id = ids.find((candidate) => get().byId[candidate]?.msgId === msgId);
    if (!id) return;
    const existing = get().byId[id];
    const next: ChatMessage = {
      ...existing,
      payload: { ...existing.payload, text },
      editedAt: Date.now(),
    };
    set({ byId: { ...get().byId, [id]: next } });
    bus.emit('message:updated', { message: next });
  },

  applyReceipt: (convId, msgId, type, _userId, _at) => {
    const convIds = convId ? [convId] : Object.keys(get().idsByConv).map(Number);
    for (const id of convIds) {
      const ids = get().idsByConv[id] ?? [];
      const messageId = ids.find((candidate) => get().byId[candidate]?.msgId === msgId);
      if (!messageId) continue;
      const existing = get().byId[messageId];
      if (existing.status === 'failed' || existing.status === 'sending') return;
      if (existing.status === 'read' && type === 'delivered') return;
      const next: ChatMessage = { ...existing, status: type };
      set({ byId: { ...get().byId, [messageId]: next } });
      bus.emit('message:updated', { message: next });
      return;
    }
  },

  setHistoryLoader: (loader) => {
    historyLoader = loader;
  },

  loadOlder: async (convId, beforeSeq) => {
    if (!historyLoader || get().loadingHistory[convId]) return 0;
    set({ loadingHistory: { ...get().loadingHistory, [convId]: true } });
    try {
      const older = await historyLoader(convId, 50, beforeSeq);
      if (older.length > 0) {
        const result = mergeMessages(get(), older);
        set({ byId: result.byId, idsByConv: result.idsByConv });
      }
      return older.length;
    } finally {
      set({ loadingHistory: { ...get().loadingHistory, [convId]: false } });
    }
  },

  clear: () => set({ byId: {}, idsByConv: {}, loadingHistory: {}, tombstones: {} }),
}));
