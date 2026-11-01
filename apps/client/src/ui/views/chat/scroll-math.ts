/**
 * 滚动体验的**纯函数**（无 DOM、无 React）——便于单测，MessageList 只做编排。
 * 对应 sepc §1.3 的两条硬指标：
 *  - 动态触发阈值（慢速 200px / 快速上滑 600–800px，按速度 Δpx/Δt 放大）
 *  - 滚动锚定补偿（插入旧消息前记 scrollHeight-scrollTop，rAF 后恢复）
 */

/**
 * 依据上滑速度（px/ms）计算"距顶多远就开始加载更早"的动态阈值。
 *
 * 语义：
 *  - 慢速/静止（velocity ≤ 0.2）→ 200px：靠近底部阈值，避免过早打扰；
 *  - 快速上滑（velocity → 2+）→ 线性放大到 800px：快速甩到顶时已预取，无 loading 空窗；
 *  - 中间区间在 200..800 之间线性插值。
 *
 * clamp 到 [200, 800]，且非法/负速度按慢速处理。
 */
export function computeLoadThreshold(velocity: number): number {
  const SLOW = 200;
  const FAST = 800;
  if (!Number.isFinite(velocity) || velocity <= 0.2) return SLOW;
  // 0.2..2.0 px/ms 映射到 SLOW..FAST，超过 2.0 视为极快（封顶 FAST）。
  const t = Math.min((velocity - 0.2) / 1.8, 1);
  return Math.round(SLOW + t * (FAST - SLOW));
}

/**
 * 插入旧消息后为保持视口内容不位移，需要设置的 scrollTop。
 *
 * 锚点 = 距底部距离 = prevHeight - prevTop（scrollHeight - scrollTop）。
 * 插入后 scrollHeight 变为 newHeight；为保持"距底距离"不变，
 * 新 scrollTop = newHeight - (prevHeight - prevTop)。
 *
 * 返回 >= 0 的整数像素（滚动位置不能为负）。
 */
export function computeScrollCompensation(
  prevHeight: number,
  prevTop: number,
  newHeight: number,
): number {
  const anchor = prevHeight - prevTop;
  return Math.max(0, Math.round(newHeight - anchor));
}
