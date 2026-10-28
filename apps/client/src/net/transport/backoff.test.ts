import { describe, expect, it } from 'vitest';
import { BASE_DELAY_MS, MAX_DELAY_MS, backoffDelay } from './backoff';

describe('backoffDelay', () => {
  it('grows exponentially 500ms → 8s and caps', () => {
    const values = [0, 1, 2, 3, 4, 5, 10].map((attempt) => backoffDelay(attempt, { jitter: 0 }));
    expect(values).toEqual([500, 1000, 2000, 4000, 8000, 8000, 8000]);
    expect(BASE_DELAY_MS).toBe(500);
    expect(MAX_DELAY_MS).toBe(8000);
  });

  it('applies ±20% jitter around the exponential value', () => {
    expect(backoffDelay(0, { random: () => 0 })).toBe(400);
    expect(backoffDelay(0, { random: () => 1 })).toBe(600);
    expect(backoffDelay(2, { random: () => 0 })).toBe(1600);
    expect(backoffDelay(2, { random: () => 1 })).toBe(2400);
  });

  it('never exceeds max even with positive jitter', () => {
    expect(backoffDelay(8, { random: () => 1 })).toBe(8000);
  });

  it('treats negative attempts as 0 and is pure with injected random', () => {
    expect(backoffDelay(-3, { jitter: 0 })).toBe(500);
    const first = backoffDelay(3, { random: () => 0.37 });
    const second = backoffDelay(3, { random: () => 0.37 });
    expect(first).toBe(second);
    expect(first).toBeGreaterThan(0);
  });
});
