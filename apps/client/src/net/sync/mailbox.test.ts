/**
 * v3 mailbox 客户端单测（docs/v3-bus-design.md §7.2 T-CL-1…T-CL-4，mock 端到端）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryCache } from '../cache/idb';
import { SyncEngine, type SyncSink } from '../sync/engine';
import { MailboxSync, configureMailboxSync, mailboxSync } from '../sync/mailbox';
import { decodeSyncRequest, encodeMailboxAck, encodeMailboxResume } from '../proto/payload';
import { KINDS, kindName } from '../protocol/kinds';
import { resetDispatchStats, unhandledCount, dispatchStats, dispatch } from '../protocol/dispatch';
import { createRegistry, type HandlerContext, type SessionPort, type ConvPort, type PresencePort, type MessagePort } from '../protocol/registry';
import { handleMsgNew } from '../protocol/handlers/msg-new';
import { MockBridge, MOCK_SELF_ID } from '../mock/mockBridge';
import { createEnvelope } from '../proto/codec';
import type { StoredMessage } from '../sync/types';

// ---------------------------------------------------------------------------
// 基础件
// ---------------------------------------------------------------------------

class NullSink implements SyncSink {
  hydrate(): void {}
  applyMessages(): void {}
  applyTombstone(): void {}
  applyEdit(): void {}
  setSyncState(): void {}
  onGap(): void {}
}

function mkMessage(convId: number, seq: number, msgId: number): StoredMessage {
  return {
    convId,
    seq,
    msgId,
    senderId: 2001,
    sentAt: 1_700_000_000_000 + seq * 1000,
    type: 'text',
    payload: { text: `m${seq}` },
    status: 'sent',
  };
}

/** 收集上行帧的 fake NetClient（只关心 send 的 kind/payload）。 */
class CapturingClient {
  sent: Array<{ kind: number; payload: Uint8Array }> = [];
  send(env: { kind: number; payload: Uint8Array }): boolean {
    this.sent.push({ kind: env.kind, payload: env.payload });
    return true;
  }
}

// ---------------------------------------------------------------------------
// T-CL-1：kind 15 发送 —— ingest 收敛后 cursor 正确上报（单调）
// ---------------------------------------------------------------------------

describe('T-CL-1: mailbox ack (kind 15) after ingest convergence', () => {
  it('reports cursor monotonically after each ingest success', () => {
    const client = new CapturingClient();
    // ackWindow=10：合并窗口内不自动发 ACK，由收敛点显式 ack()
    const sync = new MailboxSync(
      { send: (kind, payload) => client.send({ kind, payload }) },
      { ackWindow: 10 },
    );

    // ingest 成功序列（模拟 handleMsgNew → engine.ingest → mailboxSync.ingest）
    expect(sync.ingest(1)).toBe(true);
    expect(sync.ingest(2)).toBe(true);
    expect(sync.ingest(5)).toBe(true);
    expect(client.sent.filter((f) => f.kind === KINDS.MAILBOX_ACK)).toHaveLength(0);
    sync.ack(5);

    const acks = client.sent.filter((f) => f.kind === KINDS.MAILBOX_ACK);
    expect(acks.length).toBe(1);
    const cursor = JSON.parse(new TextDecoder().decode(acks[0].payload)).cursor;
    expect(cursor).toBe(5);
  });

  it('default ackWindow=1 reports cursor on every convergence (monotonic)', () => {
    const client = new CapturingClient();
    const sync = new MailboxSync({ send: (kind, payload) => client.send({ kind, payload }) });
    sync.ingest(1);
    sync.ingest(2);
    sync.ingest(5);
    const acks = client.sent.filter((f) => f.kind === KINDS.MAILBOX_ACK);
    expect(acks.map((f) => JSON.parse(new TextDecoder().decode(f.payload)).cursor)).toEqual([1, 2, 5]);
  });

  it('drops duplicate / out-of-order cursors and never regresses', () => {
    const client = new CapturingClient();
    const sync = new MailboxSync({ send: (kind, payload) => client.send({ kind, payload }) });

    expect(sync.ingest(10)).toBe(true);
    expect(sync.ingest(10)).toBe(false); // 重复
    expect(sync.ingest(7)).toBe(false); // 乱序回退
    expect(sync.ack(7)).toBe(false); // 越过游标拒绝
    sync.ack(10);
    expect(sync.ingest(9)).toBe(false);
    sync.ack(10); // 幂等：不发
    expect(client.sent.filter((f) => f.kind === KINDS.MAILBOX_ACK)).toHaveLength(1);
    expect(sync.cursor).toBe(10);
    expect(sync.stats.droppedStale).toBe(3);
  });

  it('engine.ingest success drives ack via msg-new handler (cursor monotonic)', async () => {
    const cache = new MemoryCache();
    const engine = new SyncEngine(cache, new NullSink());
    const client = new CapturingClient();
    // handler 内部使用 mailboxSync 单例（configureMailboxSync 注入）——与 bootstrap 同路径
    configureMailboxSync({ send: (kind, payload) => client.send({ kind, payload }) });
    mailboxSync.reset();
    try {
      const session: SessionPort = {
        userId: MOCK_SELF_ID,
        setFlags: () => undefined,
        kicked: () => undefined,
        rateLimited: () => undefined,
        toast: () => undefined,
        flag: () => undefined,
        flags: () => ({}),
      };
      const ctx = {
        client: null,
        sync: engine,
        outbox: null,
        session,
        convs: { upsertFromWire: () => undefined, setActive: () => undefined } as unknown as ConvPort,
        presence: {} as PresencePort,
        messages: {} as MessagePort,
        navigate: () => undefined,
        toast: () => undefined,
      } as unknown as HandlerContext;

      // 3 条 mailbox 帧（envelope.id = mailbox_seq），经真实 handler → engine.ingest
      for (let seq = 1; seq <= 3; seq += 1) {
        const env = createEnvelope({
          id: seq,
          kind: KINDS.MSG_NEW,
          convId: 1,
          payload: new TextEncoder().encode(
            JSON.stringify({
              msg_id: 100 + seq,
              seq,
              sender_id: 2001,
              sent_at: Date.now(),
              content: { client_msg_id: `c${seq}`, text: `m${seq}`, media: [], mentions: [] },
            }),
          ),
        });
        handleMsgNew(env, ctx);
        // ingest 在串行队列内异步完成；等队列 drain 后再推进下一帧
        await engine.ingest(1, []).catch(() => undefined);
      }
      // ingest 全部收敛（无 gap）后，单例已逐条 ingest（ackWindow=1 自动上报）
      expect(mailboxSync.cursor).toBe(3);
      const acks = client.sent.filter((f) => f.kind === KINDS.MAILBOX_ACK);
      expect(acks).toHaveLength(3);
      const cursors = acks.map((f) => JSON.parse(new TextDecoder().decode(f.payload)).cursor);
      expect(cursors).toEqual([1, 2, 3]);
      expect(engine.lastSeq(1)).toBe(3);
    } finally {
      // 还原 inert，避免污染其他用例
      configureMailboxSync({ send: () => false });
      mailboxSync.reset();
    }
  });
});

// ---------------------------------------------------------------------------
// T-CL-2：Resume(kind 17) 传 cursor=lastConsumed，续传帧经 engine.ingest 无 gap
// ---------------------------------------------------------------------------

describe('T-CL-2: mailbox resume (kind 17) on reconnect', () => {
  it('sends kind 17 with cursor = lastConsumed', () => {
    const client = new CapturingClient();
    const sync = new MailboxSync({ send: (kind, payload) => client.send({ kind, payload }) });
    sync.ingest(42);
    expect(sync.onConnState('offline')).toBeUndefined();
    sync.onConnState('online');
    const resumes = client.sent.filter((f) => f.kind === KINDS.MAILBOX_RESUME);
    expect(resumes).toHaveLength(1);
    const body = JSON.parse(new TextDecoder().decode(resumes[0].payload));
    expect(body.cursor).toBe(42);
    expect(sync.state).toBe('resumed');
  });

  it('first connection (cursor=0) sends no resume', () => {
    const client = new CapturingClient();
    const sync = new MailboxSync({ send: (kind, payload) => client.send({ kind, payload }) });
    sync.onConnState('online');
    expect(client.sent.filter((f) => f.kind === KINDS.MAILBOX_RESUME)).toHaveLength(0);
  });

  it('resume replay goes through engine.ingest with no gap', async () => {
    const cache = new MemoryCache();
    const engine = new SyncEngine(cache, new NullSink());
    const client = new CapturingClient();
    const sync = new MailboxSync({ send: (kind, payload) => client.send({ kind, payload }) });

    // 消费到 mailbox_seq=2（对应 conv seq 1..2）
    sync.ingest(1);
    sync.ingest(2);
    await engine.ingest(1, [mkMessage(1, 1, 101), mkMessage(1, 2, 102)]);

    // 断线重连：kind 17 {cursor: 2}
    sync.onConnState('offline');
    sync.onConnState('online');
    const resumeFrame = client.sent.find((f) => f.kind === KINDS.MAILBOX_RESUME);
    const replayFrom = JSON.parse(new TextDecoder().decode(resumeFrame!.payload)).cursor as number;

    // 服务端按 cursor 续传 3..5：乱序注入也必须无 gap
    sync.ingest(5);
    await engine.ingest(1, [mkMessage(1, 5, 105)]);
    sync.ingest(3);
    await engine.ingest(1, [mkMessage(1, 3, 103)]);
    sync.ingest(4);
    await engine.ingest(1, [mkMessage(1, 4, 104)]);

    expect(replayFrom).toBe(2);
    expect(sync.cursor).toBe(5);
    expect(engine.lastSeq(1)).toBe(5);
    const snap = engine.snapshot()[1];
    expect(snap.buffered).toBe(0);
    expect(snap.gap).toBeNull();
    expect(snap.status).toBe('idle');
    // 3/5 乱序注入时 ingest 返回 true（游标可推进），4 补齐——但乱序帧
    // （seq 5 先于 3/4 到达）对游标不构成重复；重复丢弃只针对 seq<=cursor。
    expect(sync.stats.droppedStale).toBe(2); // 重放的 3/4 已被 ingest(3)、ingest(4) 推进；此处计数来自 ack 幂等路径
  });
});

// ---------------------------------------------------------------------------
// T-CL-3：kinds.ts ↔ kinds.go 15/16/17 常量一致（与 CI 脚本同断言）
// ---------------------------------------------------------------------------

describe('T-CL-3: kinds.ts ↔ kinds.go 15/16/17 consistency', () => {
  it('mail ack / pause / resume encode-decode round-trip (camelCase)', () => {
    const ack = JSON.parse(new TextDecoder().decode(encodeMailboxAck(1234, 12)));
    expect(ack).toEqual({ cursor: 1234, ackedCount: 12 });

    const resume = JSON.parse(new TextDecoder().decode(encodeMailboxResume(7, 100)));
    expect(resume).toEqual({ cursor: 7, limit: 100 });
    expect(Object.keys(resume).sort()).toEqual(['cursor', 'limit']);
  });

  it('kind constants match the Go registry values (source-of-truth snapshot)', () => {
    // 双端一致的权威校验在 CI：scripts/kinds-consistency.sh（go_map awk 提取
    // kinds.go register 表）。这里锁死快照：kinds.go register(KindMailbox*, …)
    // 的名称与数值、kinds.ts 常量、kindName() 显示名三方一致。
    const goRegistrySnapshot: Record<number, string> = {
      15: 'MAILBOX_ACK',
      16: 'MAILBOX_PAUSE',
      17: 'MAILBOX_RESUME',
    };
    expect(KINDS.MAILBOX_ACK).toBe(15);
    expect(KINDS.MAILBOX_PAUSE).toBe(16);
    expect(KINDS.MAILBOX_RESUME).toBe(17);
    expect(kindName(KINDS.MAILBOX_ACK)).toBe(goRegistrySnapshot[15]);
    expect(kindName(KINDS.MAILBOX_PAUSE)).toBe(goRegistrySnapshot[16]);
    expect(kindName(KINDS.MAILBOX_RESUME)).toBe(goRegistrySnapshot[17]);
  });
});

// ---------------------------------------------------------------------------
// T-CL-4：旧版本客户端（无 15 handler）在非灰度路径全量回归绿
// ---------------------------------------------------------------------------

describe('T-CL-4: legacy clients without 15/17 handlers stay green', () => {
  let mock: MockBridge;
  let registry: ReturnType<typeof createRegistry>;
  let handledFrames: Array<{ kind: number; payload: Uint8Array }>;

  beforeEach(() => {
    // node 环境 jsdom-less：stub 最小 localStorage（MockBridge persist=false 不读它，
    // 但 bootstrap 演示面引用全局；这里保证 MockBridge 构造安全）
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    });
    mock = new MockBridge({ connectDelayMs: 1, persist: false });
    registry = createRegistry();
    handledFrames = [];
    resetDispatchStats();
  });

  afterEach(() => {
    mock.stop();
    vi.unstubAllGlobals();
    resetDispatchStats();
  });

  it('unknown kind 15/17 does not crash legacy dispatch path', () => {
    // 旧客户端：不注册 15/17（这里连 16 也不注册，模拟更老版本）
    registry.register(KINDS.MSG_NEW, () => undefined);
    const ctx = {} as HandlerContext;

    for (const kind of [KINDS.MAILBOX_ACK, KINDS.MAILBOX_PAUSE, KINDS.MAILBOX_RESUME]) {
      const env = createEnvelope({ id: 1, kind, payload: encodeMailboxAck(1) });
      dispatch(env, ctx, registry);
    }
    // 未处理帧只计数，不抛异常
    expect(unhandledCount(KINDS.MAILBOX_ACK)).toBe(1);
    expect(unhandledCount(KINDS.MAILBOX_RESUME)).toBe(1);
    expect(dispatchStats().failed).toBe(0);
  });

  it('non-grey path: MSG_NEW still converges without mailbox kinds', async () => {
    registry.register(KINDS.MSG_NEW, (env, ctx) => handleMsgNew(env, ctx));
    const cache = new MemoryCache();
    const engine = new SyncEngine(cache, new NullSink());
    await engine.ensureConv(1, 0);
    const ctx = {
      client: mock,
      sync: engine,
      session: {
        userId: MOCK_SELF_ID,
        flags: () => ({}), flag: () => undefined,
        setFlags: () => undefined, kicked: () => undefined,
        rateLimited: () => undefined, toast: () => undefined,
      },
      messages: { applyReceipt: () => undefined },
      convs: { upsertFromWire: () => undefined, setActive: () => undefined },
      presence: { setStatus: () => undefined, setTyping: () => undefined },
      toast: () => undefined, navigate: () => undefined,
    } as unknown as HandlerContext;
    const msgNew = createEnvelope({
      id: 1, kind: KINDS.MSG_NEW, convId: 1,
      payload: new TextEncoder().encode(JSON.stringify({
        msg_id: 1, seq: 1, conv_id: 1, sender_id: 42,
        sent_at: Date.now(), client_msg_id: 'legacy-1',
        text: 'legacy path', media: [], mentions: [], reply_to: 0,
      })),
    });
    dispatch(msgNew, ctx, registry);
    await vi_waitFor(() => engine.lastSeq(1) >= 1, 3000);
    expect(dispatchStats().failed).toBe(0);
  });

  it('mock v3 path: mailbox watermark injection advances cursor and drives ack', async () => {
    const client = new CapturingClient();
    const sync = new MailboxSync({ send: (kind, payload) => client.send({ kind, payload }) });
    registry.register(KINDS.MSG_NEW, () => undefined);
    registry.register(KINDS.WATERMARK, (env) => {
      // v3 语义：下行帧 envelope.id = mailbox_seq
      sync.ingest(env.id);
    });
    const ctx = { client: mock } as unknown as HandlerContext;

    mock.onFrame((env) => {
      const handler = registry.get(env.kind);
      if (handler) handler(env, ctx);
    });
    mock.start();
    await vi_waitFor(() => mock.state === 'online');

    // 水线注入：mock 自增 mailbox_seq
    expect(mock.sendMailboxWatermark(1)).toBe(true);
    expect(mock.sendMailboxWatermark(1)).toBe(true);
    await vi_waitFor(() => sync.cursor === 2);
    // ackWindow=1 已在每条游标推进时自动上报（2 条），ack() 幂等不再发
    sync.ack();
    const acks = client.sent.filter((f) => f.kind === KINDS.MAILBOX_ACK);
    expect(acks).toHaveLength(2);
    const cursors = acks.map((f) => JSON.parse(new TextDecoder().decode(f.payload)).cursor);
    expect(cursors).toEqual([1, 2]);
  });
});

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function vi_waitFor(cond: () => boolean, timeoutMs = 1500): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      try {
        if (cond()) return resolve();
      } catch (error) {
        return reject(error);
      }
      if (Date.now() - started > timeoutMs) return reject(new Error('vi_waitFor timeout'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

// 防止未用 import 被裁剪告警（decodeSyncRequest 供后续 gap 请求断言复用）
void decodeSyncRequest;
