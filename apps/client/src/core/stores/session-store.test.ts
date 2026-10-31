/**
 * feature flag 判定同源（P0-4）：
 * 服务端下发的 flag 值是字符串 "true"/"false"（router.go flagString），
 * 从不是 "0"/"1"。判定口径统一为「值 === 'true' 才算开」，缺失一律关闭。
 */
import { describe, expect, it } from 'vitest';
import { isFlagEnabled } from './session-store';

describe('isFlagEnabled（P0-4 前后端同源）', () => {
  it("flags={'call_enabled':'false'} → false", () => {
    expect(isFlagEnabled({ call_enabled: 'false' }, 'call_enabled')).toBe(false);
  });

  it("flags={'call_enabled':'true'} → true", () => {
    expect(isFlagEnabled({ call_enabled: 'true' }, 'call_enabled')).toBe(true);
  });

  it('flags 为空 → false（保守：拿不到 flag 就不显示入口）', () => {
    expect(isFlagEnabled({}, 'call_enabled')).toBe(false);
  });

  it('缺 key → false', () => {
    expect(isFlagEnabled({ video_enabled: 'true' }, 'call_enabled')).toBe(false);
  });

  it('null / undefined flags → false', () => {
    expect(isFlagEnabled(undefined, 'call_enabled')).toBe(false);
    expect(isFlagEnabled(null, 'call_enabled')).toBe(false);
  });

  it('遗留 "0"/"1" 不再被当作开关（服务端从不下发这两个值）', () => {
    expect(isFlagEnabled({ call_enabled: '0' }, 'call_enabled')).toBe(false);
    expect(isFlagEnabled({ call_enabled: '1' }, 'call_enabled')).toBe(false);
  });
});
