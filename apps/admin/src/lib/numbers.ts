/** 数字展示扩展：千分位、速率、方向。format.ts 只保留纯函数，供视图与测试共用。 */

export function formatThousands(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return Math.round(value).toLocaleString('en-US');
}

/** 速率：值/秒。小数 1 位，<0.05 显示 "0/s" */
export function formatRate(perSecond: number | null | undefined): string {
  if (perSecond === null || perSecond === undefined || Number.isNaN(perSecond)) return '—';
  const v = perSecond;
  if (Math.abs(v) < 0.05) return '0/s';
  if (Math.abs(v) >= 1000) return `${formatThousands(v)}/s`;
  return `${v.toFixed(1)}/s`;
}

export type Trend = 'up' | 'down' | 'flat';

/** 与上一个采样比较的趋势（阈值 0.5 抖动死区） */
export function trendOf(current: number | null, previous: number | null, epsilon = 0.5): Trend {
  if (current === null || previous === null) return 'flat';
  const d = current - previous;
  if (d > epsilon) return 'up';
  if (d < -epsilon) return 'down';
  return 'flat';
}

export const TREND_ARROW: Record<Trend, string> = { up: '↑', down: '↓', flat: '→' };
