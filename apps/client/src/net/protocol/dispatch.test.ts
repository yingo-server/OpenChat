import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope } from '../proto/codec';
import { createRegistry, type HandlerContext } from './registry';
import {
  dispatch,
  dispatchStats,
  resetDispatchStats,
  unhandledCount,
  unhandledKinds,
} from './dispatch';
import { KINDS } from './kinds';

const ctx = {} as unknown as HandlerContext;

beforeEach(() => {
  resetDispatchStats();
});

describe('handler registry', () => {
  it('registers, looks up and unregisters by kind', () => {
    const registry = createRegistry();
    const handler = vi.fn();
    const off = registry.register(KINDS.MSG_NEW, handler);
    expect(registry.has(KINDS.MSG_NEW)).toBe(true);
    expect(registry.get(KINDS.MSG_NEW)).toBe(handler);
    expect(registry.size).toBe(1);
    off();
    expect(registry.has(KINDS.MSG_NEW)).toBe(false);
  });

  it('keeps registries isolated', () => {
    const a = createRegistry();
    const b = createRegistry();
    a.register(KINDS.MSG_NEW, vi.fn());
    expect(a.size).toBe(1);
    expect(b.size).toBe(0);
  });
});

describe('dispatch', () => {
  it('calls the handler for a registered kind', () => {
    const registry = createRegistry();
    const handler = vi.fn();
    registry.register(KINDS.MSG_NEW, handler);
    const env = createEnvelope({ kind: KINDS.MSG_NEW, convId: 1, payload: new Uint8Array([1]) });

    expect(dispatch(env, ctx, registry)).toBe(true);
    expect(handler).toHaveBeenCalledWith(env, ctx);
    expect(dispatchStats().handled).toBe(1);
    expect(dispatchStats().unhandled).toBe(0);
  });

  it('drops unknown kinds, counts them, and never throws', () => {
    const registry = createRegistry();
    const unknownKind = 777;
    const env = createEnvelope({ kind: unknownKind });

    expect(dispatch(env, ctx, registry)).toBe(false);
    expect(dispatch(env, ctx, registry)).toBe(false);
    expect(unhandledCount(unknownKind)).toBe(2);
    expect(dispatchStats().unhandled).toBe(2);
    expect(dispatchStats().lastUnhandledKind).toBe(unknownKind);
    expect(unhandledKinds()).toContainEqual({ kind: unknownKind, count: 2 });
  });

  it('isolates handler exceptions', () => {
    const registry = createRegistry();
    registry.register(KINDS.MSG_NEW, () => {
      throw new Error('boom');
    });
    const env = createEnvelope({ kind: KINDS.MSG_NEW });
    expect(() => dispatch(env, ctx, registry)).not.toThrow();
    expect(dispatch(env, ctx, registry)).toBe(false);
    expect(dispatchStats().failed).toBe(2);
  });

  it('does not dispatch a kind registered in another registry', () => {
    const used = createRegistry();
    const other = createRegistry();
    const handler = vi.fn();
    other.register(KINDS.MSG_ACK, handler);
    const env = createEnvelope({ kind: KINDS.MSG_ACK });
    expect(dispatch(env, ctx, used)).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });
});
