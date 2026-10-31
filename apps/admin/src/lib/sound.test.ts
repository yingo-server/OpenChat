import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * sound.ts 依赖 window/localStorage/document —— Node 下手工搭桩。
 */
function installDom() {
  const store = new Map<string, string>();
  const listeners: Record<string, Array<() => void>> = {};
  (globalThis as Record<string, unknown>).window = {
    AudioContext: undefined,
    webkitAudioContext: undefined,
  };
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  };
  (globalThis as Record<string, unknown>).document = {
    hidden: false,
    addEventListener: (t: string, fn: () => void) => {
      (listeners[t] ??= []).push(fn);
    },
    removeEventListener: () => {},
  };
  return { store, listeners };
}

let dom: ReturnType<typeof installDom>;

beforeEach(async () => {
  dom = installDom();
  const sound = await import('./sound');
  sound.resetAudioForTest();
  sound.setAudioSinkForTest(null);
});

test('默认关闭；setSoundEnabled 写入 localStorage', async () => {
  const sound = await import('./sound');
  assert.equal(sound.soundEnabled(), false);
  sound.setSoundEnabled(true);
  assert.equal(sound.soundEnabled(), true);
  assert.equal(dom.store.get('oc.admin.sound.enabled'), '1');
  sound.setSoundEnabled(false);
  assert.equal(dom.store.get('oc.admin.sound.enabled'), '0');
});

test('合成参数：alert 双音 880/660 各 80ms、-6dB', async () => {
  const sound = await import('./sound');
  assert.deepEqual(sound.SOUND_DEFS.alert.map((t) => t.freq), [880, 660]);
  assert.ok(sound.SOUND_DEFS.alert.every((t) => t.duration === 80));
  assert.ok(sound.SOUND_DEFS.alert.every((t) => Math.abs(t.gain - 0.5) < 1e-9)); // -6dB
});

test('合成参数：success 单音 1200Hz/60ms，error 200Hz/150ms', async () => {
  const sound = await import('./sound');
  assert.equal(sound.SOUND_DEFS.success.length, 1);
  assert.equal(sound.SOUND_DEFS.success[0]!.freq, 1200);
  assert.equal(sound.SOUND_DEFS.success[0]!.duration, 60);
  assert.equal(sound.SOUND_DEFS.error[0]!.freq, 200);
  assert.equal(sound.SOUND_DEFS.error[0]!.duration, 150);
});

test('总开关关闭时 playSound 不出声；开启且解锁后走 sink', async () => {
  const sound = await import('./sound');
  const played: unknown[] = [];
  sound.setAudioSinkForTest({ play: (tones) => played.push(tones), currentTime: () => 0 });
  sound.playSound('success');
  assert.equal(played.length, 0); // 开关关
  sound.setSoundEnabled(true);
  sound.playSound('success');
  assert.equal(played.length, 0); // 未解锁（自动播放策略）
  sound.unlockAudio(); // 注册首次交互监听
  // 模拟首次交互解锁
  for (const fn of dom.listeners.pointerdown ?? []) fn();
  sound.playSound('success');
  assert.equal(played.length, 1);
  // 400ms 去重
  sound.playSound('success');
  assert.equal(played.length, 1);
});

test('localStorage 异常时降级为内存态不抛错', async () => {
  const sound = await import('./sound');
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
  };
  assert.doesNotThrow(() => sound.setSoundEnabled(true));
  assert.equal(sound.soundEnabled(), true);
});
