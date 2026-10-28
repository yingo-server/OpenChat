/**
 * 防闪烁 hooks（§5.3）：骨架屏 300ms 延迟出现 + 最少展示 300ms；
 * 按钮 loading 200ms 延迟出现，快速请求不闪 spinner。
 */
import { useEffect, useRef, useState } from 'react';

function useDelayedFlag(active: boolean, delayMs: number, minVisibleMs: number): boolean {
  const [visible, setVisible] = useState(false);
  const shownAt = useRef(0);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    if (active && !visible) {
      timer = setTimeout(() => {
        shownAt.current = Date.now();
        setVisible(true);
      }, delayMs);
    } else if (!active && visible) {
      const elapsed = Date.now() - shownAt.current;
      timer = setTimeout(() => setVisible(false), Math.max(0, minVisibleMs - elapsed));
    }

    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [active, visible, delayMs, minVisibleMs]);

  return visible;
}

export function useDelayedLoading(loading: boolean, delayMs = 200, minVisibleMs = 300): boolean {
  return useDelayedFlag(loading, delayMs, minVisibleMs);
}

export function useSkeletonVisible(loading: boolean, delayMs = 300, minVisibleMs = 300): boolean {
  return useDelayedFlag(loading, delayMs, minVisibleMs);
}
