/**
 * Toast（§3.6）：单例队列、最多同时 1 条、3s（含操作 5s）自动消失。
 * 位置：移动端底部安全区上方，桌面右上角；不覆盖输入区。
 */
import { useEffect, useState, type ReactNode } from 'react';

export type ToastKind = 'info' | 'success' | 'danger';

export interface ToastOptions {
  kind?: ToastKind;
  durationMs?: number;
  actionLabel?: string;
  onAction?: () => void;
}

interface ToastItem {
  id: number;
  message: ReactNode;
  kind: ToastKind;
  actionLabel?: string;
  onAction?: () => void;
}

let current: ToastItem | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let nextId = 1;
const listeners = new Set<(item: ToastItem | null) => void>();

function publish(): void {
  for (const listener of listeners) listener(current);
}

function dismiss(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  current = null;
  publish();
}

function show(message: ReactNode, options: ToastOptions = {}): void {
  if (timer) clearTimeout(timer);
  current = {
    id: nextId++,
    message,
    kind: options.kind ?? 'info',
    actionLabel: options.actionLabel,
    onAction: options.onAction,
  };
  publish();
  const duration = options.durationMs ?? (options.actionLabel ? 5_000 : 3_000);
  timer = setTimeout(dismiss, duration);
}

export const toast = {
  show,
  info: (message: ReactNode, options: Omit<ToastOptions, 'kind'> = {}) =>
    show(message, { ...options, kind: 'info' }),
  success: (message: ReactNode, options: Omit<ToastOptions, 'kind'> = {}) =>
    show(message, { ...options, kind: 'success' }),
  danger: (message: ReactNode, options: Omit<ToastOptions, 'kind'> = {}) =>
    show(message, { ...options, kind: 'danger' }),
  dismiss,
};

export function Toaster() {
  const [item, setItem] = useState<ToastItem | null>(current);

  useEffect(() => {
    listeners.add(setItem);
    return () => {
      listeners.delete(setItem);
    };
  }, []);

  if (!item) return null;

  const tone =
    item.kind === 'danger'
      ? 'bg-danger-600 text-ink-inverse'
      : item.kind === 'success'
        ? 'bg-success-600 text-ink-inverse'
        : 'bg-ink text-ink-inverse';

  return (
    <div
      className="pointer-events-none fixed inset-x-4 bottom-4 z-toast flex justify-center desktop:inset-x-auto desktop:bottom-auto desktop:end-6 desktop:top-6"
      role="status"
      aria-live="polite"
    >
      <div
        key={item.id}
        className={`pointer-events-auto flex max-w-[calc(100vw-32px)] animate-slide-up items-center gap-3 rounded-md px-4 py-2.5 text-body-sm shadow-md ${tone}`}
      >
        <span className="min-w-0 break-words">{item.message}</span>
        {item.actionLabel && (
          <button
            type="button"
            className="shrink-0 font-medium underline underline-offset-2"
            onClick={() => {
              item.onAction?.();
              dismiss();
            }}
          >
            {item.actionLabel}
          </button>
        )}
      </div>
    </div>
  );
}
