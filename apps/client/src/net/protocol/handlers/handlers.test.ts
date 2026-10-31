/**
 * handler 层回归测试：
 *  - receipt：批量 receipts 逐条应用（P1）；
 *  - member-update(212)：add/role 合入会话、remove 交由 202 快照（P1）；
 *  - call-offer：call_enabled 只认 "true"（P0-4）。
 */
import { describe, expect, it, vi } from 'vitest';
import { createEnvelope } from '../../proto/codec';
import { KINDS } from '../kinds';
import type { HandlerContext } from '../registry';
import { handleReceipt } from './receipt';
import { handleMemberUpdate } from './member-update';
import { handleCallOffer } from './call-offer';

const enc = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

function makeCtx(overrides: Partial<HandlerContext> = {}): HandlerContext {
  return {
    client: { send: vi.fn() } as unknown as HandlerContext['client'],
    sync: {} as HandlerContext['sync'],
    outbox: {} as HandlerContext['outbox'],
    session: {
      userId: 1,
      setFlags: vi.fn(),
      kicked: vi.fn(),
      rateLimited: vi.fn(),
      toast: vi.fn(),
      flag: vi.fn(),
      flags: vi.fn(() => ({})),
    },
    convs: { upsertFromWire: vi.fn(), setActive: vi.fn() },
    presence: { setStatus: vi.fn(), setTyping: vi.fn() },
    messages: { applyReceipt: vi.fn() },
    navigate: vi.fn(),
    toast: vi.fn(),
    ...overrides,
  };
}

describe('handleReceipt 批量 receipts（P1）', () => {
  it('遍历应用全部回执，不只第一条', () => {
    const ctx = makeCtx();
    const env = createEnvelope({
      kind: KINDS.MSG_READ,
      convId: 9,
      payload: enc({ receipts: [
        { msg_id: 10, user_id: 1, at: 100 },
        { msg_id: 11, user_id: 2, at: 200 },
      ] }),
    });
    handleReceipt(env, ctx);
    const apply = ctx.messages.applyReceipt as unknown as ReturnType<typeof vi.fn>;
    expect(apply).toHaveBeenCalledTimes(2);
    expect(apply.mock.calls[0][1]).toBe(10);
    expect(apply.mock.calls[1][1]).toBe(11);
    expect(apply.mock.calls[0][2]).toBe('read');
  });
});

describe('handleMemberUpdate(212)', () => {
  it('add：把成员合入会话（upsertFromWire）', () => {
    const ctx = makeCtx();
    const env = createEnvelope({
      kind: KINDS.MEMBER_UPDATE,
      convId: 5,
      payload: enc({ convId: 5, op: 'add', member: { userId: 42, role: 1, joinedAt: 1000 } }),
    });
    handleMemberUpdate(env, ctx);
    const upsert = ctx.convs.upsertFromWire as unknown as ReturnType<typeof vi.fn>;
    expect(upsert).toHaveBeenCalledTimes(1);
    const payload = upsert.mock.calls[0][0];
    expect(payload.convId).toBe(5);
    expect(payload.members[0]).toMatchObject({ userId: 42, role: 1, joinedAt: 1000 });
  });

  it('role：同样合入成员行', () => {
    const ctx = makeCtx();
    const env = createEnvelope({
      kind: KINDS.MEMBER_UPDATE,
      convId: 5,
      payload: enc({ convId: 5, op: 'role', member: { userId: 7, role: 2 } }),
    });
    handleMemberUpdate(env, ctx);
    expect(ctx.convs.upsertFromWire).toHaveBeenCalledTimes(1);
  });

  it('remove：本地不改成员（交由伴随的 202 快照收敛）', () => {
    const ctx = makeCtx();
    const env = createEnvelope({
      kind: KINDS.MEMBER_UPDATE,
      convId: 5,
      payload: enc({ convId: 5, op: 'remove', member: { userId: 7 } }),
    });
    handleMemberUpdate(env, ctx);
    expect(ctx.convs.upsertFromWire).not.toHaveBeenCalled();
  });
});

describe('handleCallOffer call_enabled 判定（P0-4）', () => {
  const offer = enc({ callId: 'c1', convId: 1, toUserId: 1, sdp: 'x', media: 'audio', fromUserId: 2 });

  it("flags={'call_enabled':'true'} 时不回 BUSY", () => {
    const ctx = makeCtx({ session: { ...makeCtx().session, flags: () => ({ call_enabled: 'true' }) } });
    handleCallOffer(createEnvelope({ kind: KINDS.CALL_OFFER, payload: offer }), ctx);
    expect(ctx.client.send).not.toHaveBeenCalled();
  });

  it("flags={'call_enabled':'false'} 时回 BUSY(unsupported)", () => {
    const ctx = makeCtx({ session: { ...makeCtx().session, flags: () => ({ call_enabled: 'false' }) } });
    handleCallOffer(createEnvelope({ kind: KINDS.CALL_OFFER, payload: offer }), ctx);
    expect(ctx.client.send).toHaveBeenCalledTimes(1);
  });

  it('flags 为空（拿不到）时保守回 BUSY', () => {
    const ctx = makeCtx(); // flags: () => ({})
    handleCallOffer(createEnvelope({ kind: KINDS.CALL_OFFER, payload: offer }), ctx);
    expect(ctx.client.send).toHaveBeenCalledTimes(1);
  });
});
