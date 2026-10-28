/**
 * Button（§3.1）：4 变体 × 3 尺寸；loading 200ms 延迟 + 宽度锁定。
 */
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { SpinnerIcon } from './icons';
import { useDelayedLoading } from '../hooks/useDelayedFlag';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  block?: boolean;
  icon?: ReactNode;
}

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-primary-500 text-ink-inverse hover:bg-primary-600 active:bg-primary-700 disabled:bg-primary-100 disabled:text-ink/40',
  secondary:
    'bg-surface text-ink border border-line hover:bg-surface-2 active:bg-surface-2 disabled:text-ink-tertiary',
  ghost:
    'bg-transparent text-primary-500 hover:bg-surface-2 active:bg-surface-2 disabled:text-ink-tertiary',
  danger:
    'bg-danger-500 text-ink-inverse hover:bg-danger-600 active:bg-danger-700 disabled:bg-danger-100 disabled:text-danger-900/60',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-control-sm px-2 text-body-sm rounded-sm gap-1',
  md: 'h-control-md px-4 text-body rounded-md gap-2',
  lg: 'h-control-lg px-6 text-title rounded-md gap-2',
};

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  block = false,
  icon,
  disabled,
  children,
  className = '',
  type = 'button',
  ...rest
}: ButtonProps) {
  const showSpinner = useDelayedLoading(loading);
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={[
        'inline-flex select-none items-center justify-center font-medium transition-colors duration-micro ease-out',
        'disabled:cursor-not-allowed',
        VARIANTS[variant],
        SIZES[size],
        block ? 'w-full' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    >
      {icon !== undefined && (
        <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center">
          {loading && showSpinner ? <SpinnerIcon size={size === 'sm' ? 14 : 16} /> : icon}
        </span>
      )}
      <span className="relative inline-flex items-center justify-center">
        {loading && showSpinner && icon === undefined && (
          <SpinnerIcon size={size === 'sm' ? 14 : 16} className="absolute -start-6" />
        )}
        {children}
      </span>
    </button>
  );
}
