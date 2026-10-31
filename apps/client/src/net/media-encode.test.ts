/**
 * 媒体编码纯计算部分测试（node 环境，不触碰浏览器 API）。
 *   - waveformFromChannelData：24 段峰值包络归一化 0-100
 *   - computeThumbSize：缩略图长边收缩
 *   - estimateDataUriBytes：data URI 字节估算
 */
import { describe, expect, it } from 'vitest';
import {
  computeThumbSize,
  estimateDataUriBytes,
  THUMB_LIMIT_BYTES,
  waveformFromChannelData,
} from './media-encode';

function sineData(length: number, amplitude: number): Float32Array {
  const data = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    data[i] = Math.sin((i / length) * Math.PI * 8) * amplitude;
  }
  return data;
}

describe('waveformFromChannelData', () => {
  it('返回 24 个值且都在 0-100 整数区间', () => {
    const data = sineData(2400, 0.9);
    const wave = waveformFromChannelData(data, 24);
    expect(wave).toHaveLength(24);
    for (const value of wave) {
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(100);
    }
  });

  it('至少有一段达到 100（峰值归一化）', () => {
    const wave = waveformFromChannelData(sineData(2400, 0.9), 24);
    expect(Math.max(...wave)).toBe(100);
  });

  it('全静音 → 全 0', () => {
    const wave = waveformFromChannelData(new Float32Array(1000), 24);
    expect(wave).toEqual(new Array(24).fill(0));
  });

  it('空数据 → 全 0', () => {
    expect(waveformFromChannelData(new Float32Array(0), 24)).toEqual(new Array(24).fill(0));
  });

  it('振幅不同段形成梯度（前半响、后半轻）', () => {
    const data = new Float32Array(2400);
    for (let i = 0; i < data.length; i += 1) {
      data[i] = i < data.length / 2 ? 0.8 : 0.1;
    }
    const wave = waveformFromChannelData(data, 24);
    const firstHalf = wave.slice(0, 12);
    const secondHalf = wave.slice(12);
    expect(Math.min(...firstHalf)).toBeGreaterThan(Math.max(...secondHalf));
  });
});

describe('computeThumbSize', () => {
  it('长边超过 maxEdge 时等比缩放', () => {
    expect(computeThumbSize(800, 600, 320)).toEqual({ width: 320, height: 240 });
    expect(computeThumbSize(600, 800, 320)).toEqual({ width: 240, height: 320 });
  });

  it('小于 maxEdge 时不放大', () => {
    expect(computeThumbSize(200, 100, 320)).toEqual({ width: 200, height: 100 });
  });

  it('方形图长边对齐', () => {
    expect(computeThumbSize(1000, 1000, 240)).toEqual({ width: 240, height: 240 });
  });

  it('非法尺寸回退方框', () => {
    expect(computeThumbSize(0, 0, 320)).toEqual({ width: 320, height: 320 });
    expect(computeThumbSize(-5, 10, 240)).toEqual({ width: 240, height: 240 });
  });
});

describe('estimateDataUriBytes', () => {
  it('估算 base64 解码字节数（去掉 data URI 前缀）', () => {
    // 4 个 base64 字符 = 3 字节
    expect(estimateDataUriBytes('data:image/jpeg;base64,AAAA')).toBe(3);
    // 带 padding
    expect(estimateDataUriBytes('data:image/jpeg;base64,AAA=')).toBe(2);
    expect(estimateDataUriBytes('data:image/jpeg;base64,AA==')).toBe(1);
  });

  it('阈值常量为 8KB', () => {
    expect(THUMB_LIMIT_BYTES).toBe(8 * 1024);
  });
});
