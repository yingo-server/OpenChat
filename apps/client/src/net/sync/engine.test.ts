import { describe, expect, it } from 'vitest';
import { MemoryCache } from '../cache/idb';
import { SyncEngine, type SyncSink } from './engine';
import type { ConvRecord, GapRange, HydratedCache, StoredMessage, SyncStateView } from './types';

function message(convId: number, seq: number, msgId: number, text = `m${seq}`): StoredMessage {
  return {
    convId,
    seq,
    msgId,
    senderId: 2001,
    sentAt: 1_700_000_000_000 + seq * 1000,
    type: 'text',
    payload: { text },
    status: 'sent',
  };
}

class TestSink implements SyncSink {
  hydrated: HydratedCache | null = null;
  messages: StoredMessage[] = [];
  tombstones: Array<{ convId: number; msgId: number; seq: number; op: string }> = [];
  edits: Array<{ convId: number; msgId: number; text: string }> = [];
  gaps: Array<{ convId: number; gap: GapRange }> = [];
  states = new Map<number, SyncStateView>();
  failures: string[] = [];

  hydrate(cache: HydratedCache): void {
    this.hydrated = cache;
  }

  applyMessages(messages: StoredMessage[]): void {
    this.messages.push(...messages);
  }

  applyTombstone(convId: number, msgId: number, seq: number, op: 'delete' | 'recall'): void {
    this.tombstones.push({ convId, msgId, seq, op });
  }

  applyEdit(convId: number, msgId: number, text: string): void {
    this.edits.push({ convId, msgId, text });
  }

  setSyncState(convId: number, state: SyncStateView): void {
    this.states.set(convId, state);
  }

  onGap(convId: number, gap: GapRange): void {
    this.gaps.push({ convId, gap });
  }

  onError(error: unknown, context: string): void {
    this.failures.push(`${context}:${String(error)}`);
  }
}

function engineWithCache(): { engine: SyncEngine; sink: TestSink; cache: MemoryCache } {
  const cache = new MemoryCache();
  const sink = new TestSink();
  return { engine: new SyncEngine(cache, sink), sink, cache };
}

describe('SyncEngine', () => {
  it('accepts contiguous seq and persists before projecting', async () => {
    const { engine, sink, cache } = engineWithCache();
    const result = await engine.ingest(1, [message(1, 1, 101), message(1, 2, 102)]);
    expect(result.accepted).toBe(2);
    expect(result.lastSeq).toBe(2);
    expect(engine.lastSeq(1)).toBe(2);
    expect(sink.messages.map((m) => m.seq)).toEqual([1, 2]);
    expect((await cache.listMessages(1, 10)).map((m) => m.seq)).toEqual([1, 2]);
    expect(sink.gaps).toHaveLength(0);
  });

  it('buffers a forward gap, requests backfill, then flushes in order', async () => {
    const { engine, sink } = engineWithCache();
    await engine.ingest(1, [message(1, 1, 101), message(1, 2, 102)]);

    const gapped = await engine.ingest(1, [message(1, 4, 104)]);
    expect(gapped.buffered).toBe(1);
    expect(gapped.accepted).toBe(0);
    expect(engine.lastSeq(1)).toBe(2);
    expect(sink.gaps).toEqual([{ convId: 1, gap: { from: 3, to: 3 } }]);
    expect(sink.messages.map((m) => m.seq)).toEqual([1, 2]);

    const filled = await engine.ingest(1, [message(1, 3, 103)]);
    expect(filled.accepted).toBe(2);
    expect(filled.lastSeq).toBe(4);
    expect(sink.messages.map((m) => m.seq)).toEqual([1, 2, 3, 4]);
    expect(engine.snapshot()[1].buffered).toBe(0);
  });

  it('dedupes by seq and by msgId', async () => {
    const { engine, sink } = engineWithCache();
    await engine.ingest(1, [message(1, 1, 101), message(1, 2, 102)]);
    const duplicateSeq = await engine.ingest(1, [message(1, 2, 999)]);
    expect(duplicateSeq.duplicate).toBe(1);
    expect(engine.lastSeq(1)).toBe(2);
    expect(sink.messages).toHaveLength(2);

    // 同 msgId 换一个 seq 也视为重复（服务端重放）
    await engine.ingest(1, [message(1, 3, 102)]);
    expect(engine.lastSeq(1)).toBe(2);
    expect(sink.messages).toHaveLength(2);
  });

  it('applies tombstone without advancing last_seq and never resurrects', async () => {
    const { engine, sink, cache } = engineWithCache();
    await engine.ingest(1, [message(1, 1, 101), message(1, 2, 102)]);

    expect(await engine.applyTombstone(1, 102, 'recall')).toBe(true);
    expect(engine.lastSeq(1)).toBe(2);
    expect(sink.tombstones).toEqual([{ convId: 1, msgId: 102, seq: 2, op: 'recall' }]);
    expect((await cache.getMessageByMsgId(1, 102))?.deleted).toBe(true);

    // 已删除消息的重放不应复活
    const replay = await engine.ingest(1, [message(1, 2, 102)]);
    expect(replay.duplicate).toBe(1);
    expect(engine.lastSeq(1)).toBe(2);
  });

  it('applies edit without advancing last_seq', async () => {
    const { engine, sink } = engineWithCache();
    await engine.ingest(1, [message(1, 1, 101, 'old')]);
    expect(await engine.applyEdit(1, 101, 'new')).toBe(true);
    expect(engine.lastSeq(1)).toBe(1);
    expect(sink.edits).toEqual([{ convId: 1, msgId: 101, text: 'new' }]);
  });

  it('hydrates from cache and resumes from the persisted cursor', async () => {
    const cache = new MemoryCache();
    const conv: ConvRecord = {
      convId: 5,
      title: 'cached',
      convType: 0,
      createdAt: 1,
      members: [],
      version: 1,
      lastSeq: 5,
      unread: 0,
      updatedAt: 1,
    };
    await cache.putConv(conv);
    await cache.putMessages([message(5, 4, 204), message(5, 5, 205)]);

    const sink = new TestSink();
    const engine = new SyncEngine(cache, sink);
    await engine.hydrate();

    expect(sink.hydrated?.convs).toHaveLength(1);
    expect(sink.hydrated?.messages).toHaveLength(2);
    expect(engine.lastSeq(5)).toBe(5);
    expect(engine.resumeTickets()).toEqual([{ convId: 5, lastSeq: 5 }]);
    expect(sink.states.get(5)?.lastSeq).toBe(5);
  });

  it('serializes concurrent writes (single-writer)', async () => {
    const { engine, sink } = engineWithCache();
    const [a, b] = await Promise.all([
      engine.ingestNew(1, message(1, 1, 101)),
      engine.ingestNew(1, message(1, 2, 102)),
    ]);
    // 串行队列保证第二条在第一条之后落库，不会互相覆盖
    expect(a.lastSeq === 1 || a.lastSeq === 2).toBe(true);
    expect(b.lastSeq).toBe(2);
    expect(engine.lastSeq(1)).toBe(2);
    expect(sink.messages.map((m) => m.seq)).toEqual([1, 2]);
  });

  it('onResumeResult requests the missing range', async () => {
    const { engine, sink } = engineWithCache();
    await engine.ingest(1, [message(1, 1, 101)]);
    await engine.onResumeResult({ convId: 1, fromSeq: 2, complete: true, serverSeq: 4 });
    expect(sink.gaps[sink.gaps.length - 1]).toEqual({ convId: 1, gap: { from: 2, to: 4 } });
    expect(engine.syncState(1).status).toBe('syncing');
  });
});
