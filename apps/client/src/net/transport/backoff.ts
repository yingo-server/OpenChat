/**
 * 指数退避纯函数（500ms → 8s）。
 *
 * attempt 0 → 500ms, 1 → 1000, 2 → 2000, 3 → 4000, 4+ → 8000（封顶）。
 * 默认叠加 ±20% 抖动，避免断网恢复时全量客户端同时重连（thundering herd）。
 * 纯函数：不读时钟、不持有状态，random 可注入，便于单测。
 */

export const BASE_DELAY_MS = 500;
export const MAX_DELAY_MS = 8_000;

export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  /** 抖动比例 0..1；0 = 关闭抖动 */
  jitter?: number;
  /** 注入随机源（默认 Math.random），测试用 */
  random?: () => number;
}

export function backoffDelay(attempt: number, options: BackoffOptions = {}): number {
  const base = options.baseMs ?? BASE_DELAY_MS;
  const max = options.maxMs ?? MAX_DELAY_MS;
  const jitter = options.jitter ?? 0.2;
  const random = options.random ?? Math.random;

  const safeAttempt = Math.max(0, Math.floor(attempt));
  const exponential = Math.min(max, base * 2 ** safeAttempt);
  const factor = 1 + (random() * 2 - 1) * jitter;
  return Math.min(max, Math.max(0, Math.round(exponential * factor)));
}

/** 供 NetworkBar 展示的档位（不参与调度）。 */
export function backoffLabel(attempt: number): string {
  return `${Math.round(backoffDelay(attempt, { jitter: 0 }) / 100) / 10}s`;
}
