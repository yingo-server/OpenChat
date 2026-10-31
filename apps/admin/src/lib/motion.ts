/**
 * 动效工具（Web Animations API / rAF，零依赖）。
 * prefers-reduced-motion 时全部动效归零：数值直接跳终态、入场/闪烁不播放。
 */
import { useEffect, useRef, useState } from 'react';

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/* --------------------------- 数值滚动 --------------------------- */

const EASE_OUT = (t: number) => 1 - Math.pow(1 - t, 3);

/**
 * 指标卡数字滚动：value 变化时从旧值滚到新值（ease-out，~400ms）。
 * reduced-motion 或首帧直接到终态；页面隐藏（visibilitychange）时跳终态。
 */
export function useCountUp(value: number | null, durationMs = 400): number | null {
  const [display, setDisplay] = useState(value);
  const fromRef = useRef<number | null>(value);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (value === null) {
      setDisplay(null);
      fromRef.current = null;
      return undefined;
    }
    const from = fromRef.current;
    fromRef.current = value;
    if (from === null || from === value) {
      setDisplay(value);
      return undefined;
    }
    if (prefersReducedMotion() || document.hidden) {
      setDisplay(value);
      return undefined;
    }
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      setDisplay(from + (value - from) * EASE_OUT(t));
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [value, durationMs]);

  return display;
}

/** 判断「本次值确实变了」（用于闪边，首帧不闪） */
export function useValueChanged(value: number | null): boolean {
  const prev = useRef<number | null>(value);
  const [changed, setChanged] = useState(false);
  useEffect(() => {
    const isChange = prev.current !== null && value !== null && prev.current !== value;
    prev.current = value;
    if (!isChange) return;
    if (prefersReducedMotion() || document.hidden) return;
    setChanged(true);
    const timer = window.setTimeout(() => setChanged(false), 320);
    return () => window.clearTimeout(timer);
  }, [value]);
  return changed;
}

/* --------------------------- 卡片入场 stagger --------------------------- */

/** Dashboard 卡片入场：淡入 + 上移 12px，index*60ms stagger；reduced-motion 归零。 */
export function enterStagger(el: HTMLElement, index: number): void {
  if (prefersReducedMotion() || document.hidden) return;
  el.animate(
    [
      { opacity: '0', transform: 'translateY(12px)' },
      { opacity: '1', transform: 'translateY(0)' },
    ],
    { duration: 260, delay: index * 60, easing: 'cubic-bezier(0.2, 0, 0, 1)', fill: 'backwards' },
  );
}

/** 变化高亮：品牌色边框闪一次 300ms。 */
export function flashCard(el: HTMLElement): void {
  if (prefersReducedMotion() || document.hidden) return;
  el.animate([{ boxShadow: '0 0 0 2px rgb(var(--oc-primary-500))' }, { boxShadow: '0 0 0 0 rgb(var(--oc-primary-500) / 0)' }], {
    duration: 300,
    easing: 'ease-out',
  });
}

/** 新事件行：顶部滑入 + 背景闪烁一次。 */
export function slideInRow(el: HTMLElement): void {
  if (prefersReducedMotion() || document.hidden) return;
  el.animate(
    [
      { opacity: '0', transform: 'translateY(-8px)', backgroundColor: 'rgb(var(--oc-primary-100))' },
      { opacity: '1', transform: 'translateY(0)', backgroundColor: 'rgb(var(--oc-primary-100) / 0.25)' },
      { opacity: '1', transform: 'translateY(0)', backgroundColor: 'rgb(var(--oc-primary-100) / 0)' },
    ],
    { duration: 500, easing: 'cubic-bezier(0.2, 0, 0, 1)' },
  );
}
