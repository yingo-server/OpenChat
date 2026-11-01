import { describe, expect, it } from 'vitest';
import { computeLoadThreshold, computeScrollCompensation } from './scroll-math';

describe('computeLoadThreshold（perf-spec §1.3 动态预取）', () => {
  it('慢速/静止 → 200px 基础阈值', () => {
    expect(computeLoadThreshold(0)).toBe(200);
    expect(computeLoadThreshold(0.2)).toBe(200);
    expect(computeLoadThreshold(-1)).toBe(200); // 非法速度按慢速
    expect(computeLoadThreshold(NaN)).toBe(200);
  });
  it('快速上滑 → 放大到 800px（提前预取，无 loading 空窗）', () => {
    expect(computeLoadThreshold(2.0)).toBe(800);
    expect(computeLoadThreshold(5)).toBe(800); // 极快封顶
  });
  it('中间速度线性插值且单调', () => {
    const t1 = computeLoadThreshold(0.6);
    const t2 = computeLoadThreshold(1.2);
    expect(t1).toBeGreaterThan(200);
    expect(t2).toBeGreaterThan(t1);
    expect(t2).toBeLessThan(800);
  });
});

describe('computeScrollCompensation（perf-spec §1.3 锚定）', () => {
  it('插入 N 条旧消息后，视口"距底距离"保持不变', () => {
    // 插入前：高 5000，视口在 4800 → 距底 200
    // 插入后高度 +1500 → 新 scrollTop = 6500 - 200 = 6300
    expect(computeScrollCompensation(5000, 4800, 6500)).toBe(6300);
  });
  it('未插入（高度不变）→ scrollTop 不变', () => {
    expect(computeScrollCompensation(5000, 4800, 5000)).toBe(4800);
  });
  it('结果不为负（防御畸形输入）', () => {
    // 100-99=1 距底；新高度 50 → 50-1=49 仍是合法锚定（内容已小于视口）。
    // 函数只保证非负与取整，不判定内容是否比视口短——那是调用方的事。
    expect(computeScrollCompensation(100, 99, 50)).toBe(49);
    expect(computeScrollCompensation(0, 0, 0)).toBe(0);
  });
  it('取整为整数像素', () => {
    expect(Number.isInteger(computeScrollCompensation(100.5, 50.2, 200.7))).toBe(true);
  });
});
