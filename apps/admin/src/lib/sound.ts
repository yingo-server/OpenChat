/**
 * WebAudio 原生合成声效（零音频文件）。
 * 默认全关，右上角 🔔 开关 + localStorage 记忆；首次用户交互后才创建 AudioContext。
 * 所有音量统一 -6dB 峰值，避免刺耳（docs/web-ui-spec.md §9 反馈原则）。
 */

const STORAGE_KEY = 'oc.admin.sound.enabled';

export type SoundName = 'alert' | 'success' | 'error';

/** 单个音参数（断言/测试用） */
export interface ToneSpec {
  freq: number;
  /** ms */
  duration: number;
  /** 相对 1.0 的峰值增益；-6dB ≈ 0.5 */
  gain: number;
  /** 相对铃音起始的延迟 ms */
  offset: number;
  type: OscillatorType;
}

export const SOUND_DEFS: Record<SoundName, ToneSpec[]> = {
  /** 新举报/告警：短促双音 880Hz → 660Hz，各 80ms */
  alert: [
    { freq: 880, duration: 80, gain: 0.5, offset: 0, type: 'sine' },
    { freq: 660, duration: 80, gain: 0.5, offset: 90, type: 'sine' },
  ],
  /** 操作成功：单音 1200Hz 60ms */
  success: [{ freq: 1200, duration: 60, gain: 0.5, offset: 0, type: 'sine' }],
  /** 错误：200Hz 长音 150ms */
  error: [{ freq: 200, duration: 150, gain: 0.5, offset: 0, type: 'sine' }],
};

/** 开关状态（localStorage 记忆，隐私模式降级为内存态） */
const fallbackState = { on: false };

export function soundEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return fallbackState.on;
  }
}

export function setSoundEnabled(on: boolean): void {
  fallbackState.on = on;
  try {
    localStorage.setItem(STORAGE_KEY, on ? '1' : '0');
  } catch {
    /* 隐私模式忽略 */
  }
}

/* ------------------------------------------------------------------ */
/* AudioContext 生命周期：首次用户交互后才创建（自动播放策略）           */
/* ------------------------------------------------------------------ */

let ctx: AudioContext | null = null;
let unlocked = false;

function createCtx(): AudioContext | null {
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  return new Ctor();
}

/** 首次用户交互解锁；document 上只挂一次监听。 */
export function unlockAudio(): void {
  if (unlocked) return;
  unlocked = true;
  const kick = () => {
    if (!ctx) ctx = createCtx();
    if (ctx && ctx.state === 'suspended') void ctx.resume();
    document.removeEventListener('pointerdown', kick);
    document.removeEventListener('keydown', kick);
  };
  document.addEventListener('pointerdown', kick, { once: false });
  document.addEventListener('keydown', kick, { once: false });
}

/** 测试/卸载用 */
export function resetAudioForTest(): void {
  ctx = null;
  unlocked = false;
}

export interface AudioSink {
  /** 真实实现用 WebAudio；测试注入 mock，返回实际合成的 tone 序列 */
  play(tones: ToneSpec[]): void;
  currentTime(): number;
}

const webAudioSink: AudioSink = {
  play(tones) {
    if (!ctx) ctx = createCtx();
    if (!ctx) return;
    if (ctx.state === 'suspended') void ctx.resume();
    const now = ctx.currentTime;
    for (const t of tones) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      const start = now + t.offset / 1000;
      const end = start + t.duration / 1000;
      osc.type = t.type;
      osc.frequency.setValueAtTime(t.freq, start);
      // 5ms 快起快落，避免爆音（click）
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(t.gain, start + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, end);
      osc.connect(g).connect(ctx.destination);
      osc.start(start);
      osc.stop(end + 0.01);
    }
  },
  currentTime() {
    return ctx?.currentTime ?? 0;
  },
};

let sink: AudioSink = webAudioSink;

/** 测试注入 mock sink */
export function setAudioSinkForTest(s: AudioSink | null): void {
  sink = s ?? webAudioSink;
}

/** 同名音效 400ms 内去重（避免一屏多卡同时响成噪音） */
const lastPlayed = new Map<string, number>();

/** 播放入口：总开关关闭时静默；开着但未解锁也静默（等首次交互）。 */
export function playSound(name: SoundName): void {
  if (!soundEnabled()) return;
  if (!unlocked) return;
  const now = Date.now();
  const last = lastPlayed.get(name) ?? 0;
  if (now - last < 400) return;
  lastPlayed.set(name, now);
  sink.play(SOUND_DEFS[name]);
}
