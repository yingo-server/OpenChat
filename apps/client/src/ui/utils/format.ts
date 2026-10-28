/**
 * 展示格式化（数字方向保持 LTR；时间用 Intl，避免手写中文月份）。
 */
import { getLocale, t } from '../i18n';

export function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** 消息时间：HH:mm */
export function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** 日期分割线：今天显示"3月15日"，昨天显示"昨天"，7 天内显示星期，更早显示年月日 */
export function formatDayDivider(timestamp: number, now = Date.now()): string {
  const date = new Date(timestamp);
  const today = new Date(now);
  const locale = getLocale();
  if (sameDay(date, today)) {
    return new Intl.DateTimeFormat(locale, { month: 'long', day: 'numeric' }).format(date);
  }
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (sameDay(date, yesterday)) return t('chat.yesterday');
  const diffDays = Math.floor((today.getTime() - date.getTime()) / 86_400_000);
  if (diffDays < 7) {
    return new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(date);
  }
  if (date.getFullYear() === today.getFullYear()) {
    return new Intl.DateTimeFormat(locale, { month: '2-digit', day: '2-digit' }).format(date);
  }
  return new Intl.DateTimeFormat(locale, { year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

/** 会话列表时间：今天 HH:mm / 昨天 / MM-DD / YYYY-MM-DD */
export function formatConvTime(timestamp: number, now = Date.now()): string {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  const today = new Date(now);
  if (sameDay(date, today)) return formatTime(timestamp);
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (sameDay(date, yesterday)) return t('chat.yesterday');
  const locale = getLocale();
  if (date.getFullYear() === today.getFullYear()) {
    return new Intl.DateTimeFormat(locale, { month: '2-digit', day: '2-digit' }).format(date);
  }
  return new Intl.DateTimeFormat(locale, { year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  const digits = index === 0 ? 0 : value >= 10 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[index]}`;
}

/** 语音时长：12" / 1:05 */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}"`;
  return `${Math.floor(seconds / 60)}:${pad2(seconds % 60)}`;
}

export function formatDateTime(timestamp: number): string {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${formatTime(timestamp)}`;
}
