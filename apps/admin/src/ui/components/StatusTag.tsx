import type { ReactNode } from 'react';
import { cn } from '../../lib/format';

export type Tone = 'success' | 'danger' | 'warning' | 'muted' | 'info' | 'primary';

const TONE_CLASS: Record<Tone, string> = {
  success: 'text-success-700 bg-success-50',
  danger: 'text-danger-700 bg-danger-50',
  warning: 'text-warning-700 bg-warning-50',
  muted: 'text-text-secondary bg-bg-surface-2',
  info: 'text-info-600 bg-info-50',
  primary: 'text-primary-700 bg-primary-50',
};

const DOT_CLASS: Record<Tone, string> = {
  success: 'bg-success-500',
  danger: 'bg-danger-500',
  warning: 'bg-warning-500',
  muted: 'bg-text-tertiary',
  info: 'bg-info-500',
  primary: 'bg-primary-500',
};

/**
 * 行内状态标签：8px 圆点 + 13px 文字（docs/web-ui-spec.md §9.1）。
 * 不用纯色胶囊，保持后台的信息密度。
 */
export function StatusTag({
  tone,
  children,
  dot = true,
  className,
}: {
  tone: Tone;
  children: ReactNode;
  dot?: boolean;
  className?: string;
}) {
  return (
    <span className={cn('tag', TONE_CLASS[tone], className)}>
      {dot && <span className={cn('inline-block h-2 w-2 shrink-0 rounded-full', DOT_CLASS[tone])} aria-hidden />}
      <span className="text-body-sm leading-none">{children}</span>
    </span>
  );
}

/** 计数徽标（未处理举报数等） */
export function CountBadge({ value, tone = 'danger' }: { value: number; tone?: 'danger' | 'primary' | 'muted' }) {
  if (!value) return null;
  const cls =
    tone === 'danger' ? 'bg-danger-500 text-text-inverse' : tone === 'primary' ? 'bg-primary-500 text-text-inverse' : 'bg-bg-surface-2 text-text-secondary';
  return (
    <span className={cn('nums ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-caption', cls)}>
      {value > 99 ? '99+' : value}
    </span>
  );
}
