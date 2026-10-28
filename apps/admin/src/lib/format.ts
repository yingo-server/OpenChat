/** 展示格式化：时间戳/数字/字节统一走这里，避免各视图各写一套。 */

export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

export function toDate(value: string | number | Date | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 2026-10-28 22:45:10（本地时区，等宽显示用 .nums） */
export function formatDateTime(value: string | number | Date | null | undefined): string {
  const d = toDate(value);
  if (!d) return '—';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}:${pad(d.getSeconds())}`;
}

export function formatDate(value: string | number | Date | null | undefined): string {
  const d = toDate(value);
  if (!d) return '—';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** journalctl 风格行首：只保留 时:分:秒 */
export function formatClock(value: string | number | Date | null | undefined): string {
  const d = toDate(value);
  if (!d) return '--:--:--';
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function formatRelative(value: string | number | Date | null | undefined, now = Date.now()): string {
  const d = toDate(value);
  if (!d) return '—';
  const diff = Math.round((now - d.getTime()) / 1000);
  const abs = Math.abs(diff);
  if (abs < 45) return diff >= 0 ? '刚刚' : '即将';
  if (abs < 3600) return `${Math.round(abs / 60)} 分钟${diff >= 0 ? '前' : '后'}`;
  if (abs < 86400) return `${Math.round(abs / 3600)} 小时${diff >= 0 ? '前' : '后'}`;
  if (abs < 86400 * 30) return `${Math.round(abs / 86400)} 天${diff >= 0 ? '前' : '后'}`;
  return formatDate(d);
}

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return value.toLocaleString('zh-CN');
}

export function formatPercent(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return '—';
  if (seconds < 60) return `${Math.round(seconds)} 秒`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟`;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
}

/** <input type="datetime-local"> 需要本地时区的 yyyy-MM-ddTHH:mm */
export function toDatetimeLocal(value: string | number | Date | null | undefined): string {
  const d = toDate(value);
  if (!d) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 相对时间转 ISO（筛选器传参用） */
export function daysAgoISO(days: number): string {
  return new Date(Date.now() - days * 86400_000).toISOString();
}
