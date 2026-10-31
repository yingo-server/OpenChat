import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/** polling.ts 依赖 document/AbortSignal —— Node 22 有 AbortController，补 document 桩。 */
beforeEach(() => {
  (globalThis as Record<string, unknown>).document = {
    hidden: false,
    visibilityState: 'visible',
    addEventListener: () => {},
    removeEventListener: () => {},
  };
});

test('SampleBuffer：容量 60、push 超出 shift', async () => {
  const { SampleBuffer } = await import('./polling');
  const buf = new SampleBuffer(60);
  for (let i = 0; i < 70; i += 1) buf.push(i * 1000, i);
  assert.equal(buf.length, 60);
  assert.equal(buf.points[0]!.value, 10);
  assert.equal(buf.points.at(-1)!.value, 69);
});

test('SampleBuffer.ratePerSecond', async () => {
  const { SampleBuffer } = await import('./polling');
  const buf = new SampleBuffer(60);
  assert.equal(buf.ratePerSecond(), null);
  buf.push(0, 100);
  assert.equal(buf.ratePerSecond(), null);
  buf.push(5000, 150);
  assert.equal(buf.ratePerSecond(), 10);
});

test('usePolling / motion.ts 模块可加载（reduced-motion 桩）', async () => {
  (globalThis as Record<string, unknown>).window = {
    matchMedia: () => ({ matches: true }),
  };
  const motion = await import('./motion');
  assert.equal(motion.prefersReducedMotion(), true);
  const polling = await import('./polling');
  assert.equal(polling.POLL_MS, 5000);
});
