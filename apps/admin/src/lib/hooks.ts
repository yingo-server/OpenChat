import { useCallback, useEffect, useRef, useState } from 'react';

/** 输入防抖 300ms（docs/web-ui-spec.md §9.1 筛选条规范） */
export function useDebouncedValue<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/** 可暂停的定时器：ms=null 时不启动（审计页"暂停跟随"用） */
export function useInterval(callback: () => void, ms: number | null): void {
  const saved = useRef(callback);
  useEffect(() => {
    saved.current = callback;
  }, [callback]);
  useEffect(() => {
    if (ms === null) return undefined;
    const timer = window.setInterval(() => saved.current(), ms);
    return () => window.clearInterval(timer);
  }, [ms]);
}

/** 复制到剪贴板，兼容非安全上下文（内网 http） */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    const el = document.createElement('textarea');
    el.value = text;
    el.setAttribute('readonly', '');
    el.style.position = 'fixed';
    el.style.opacity = '0';
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(el);
    return ok;
  } catch {
    return false;
  }
}

/** 一次性提示（3s 自动消失），后台不堆 toast，只做行内确认 */
export function useTransientFlag(timeout = 2400): [boolean, () => void] {
  const [on, setOn] = useState(false);
  const timer = useRef<number | null>(null);
  const fire = useCallback(() => {
    setOn(true);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOn(false), timeout);
  }, [timeout]);
  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );
  return [on, fire];
}

/** 本地错误兜底：把未知异常转成可展示文案 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
