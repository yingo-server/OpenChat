/**
 * Dashboard 轮询调度：5s 拉一次 metrics + archive/status；
 * 页面隐藏（visibilitychange）时完全暂停，回前台立即补一拍。
 * rAF 级动画只在卡片自身运行，轮询只做数据层 setState，不阻塞输入。
 */
import { useEffect, useRef, useState } from 'react';

export const POLL_MS = 5000;

export interface DashboardPollState {
  visible: boolean;
  /** 请求在途 */
  inFlight: boolean;
  lastAt: Date | null;
  error: string | null;
}

/** 订阅式轮询：onTick 里做 fetch；隐藏期不触发。返回 [state, refreshNow]。 */
export function usePolling(onTick: (signal: AbortSignal) => Promise<void>, enabled: boolean, intervalMs = POLL_MS) {
  const [state, setState] = useState<DashboardPollState>({
    visible: !document.hidden,
    inFlight: false,
    lastAt: null,
    error: null,
  });
  const tickRef = useRef(onTick);
  tickRef.current = onTick;
  const controllerRef = useRef<AbortController | null>(null);

  const run = useRef(async () => {
    if (document.hidden) return;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setState((s) => ({ ...s, inFlight: true }));
    try {
      await tickRef.current(controller.signal);
      setState((s) => ({ ...s, inFlight: false, lastAt: new Date(), error: null }));
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      setState((s) => ({ ...s, inFlight: false, error: (err as Error).message }));
    }
  });

  useEffect(() => {
    if (!enabled) return undefined;
    void run.current();
    const timer = window.setInterval(() => void run.current(), intervalMs);
    const onVis = () => {
      const visible = !document.hidden;
      setState((s) => ({ ...s, visible }));
      if (visible) void run.current(); // 回前台立即补一拍
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVis);
      controllerRef.current?.abort();
    };
  }, [enabled, intervalMs]);

  return { state, refreshNow: () => void run.current() };
}

/* --------------------------- sparkline 采样环形缓冲 --------------------------- */

export interface Sample {
  t: number;
  value: number;
}

/** 固定容量采样缓冲：新点 push，超容量 shift（容量=60）。 */
export class SampleBuffer {
  readonly capacity: number;
  private items: Sample[] = [];

  constructor(capacity = 60) {
    this.capacity = capacity;
  }

  push(t: number, value: number): void {
    this.items.push({ t, value });
    if (this.items.length > this.capacity) this.items.shift();
  }

  get length(): number {
    return this.items.length;
  }

  get points(): Sample[] {
    return [...this.items];
  }

  /** 每秒速率：与上一次采样的差 / 时间差 */
  ratePerSecond(): number | null {
    if (this.items.length < 2) return null;
    const a = this.items[this.items.length - 2]!;
    const b = this.items[this.items.length - 1]!;
    const dt = (b.t - a.t) / 1000;
    if (dt <= 0) return null;
    return (b.value - a.value) / dt;
  }
}
