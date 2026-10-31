/**
 * presence-store 乱序守卫（P0-3）：
 * presence 无服务端序号，setStatus 用 at（毫秒）做单调守卫 —— 乱序到达的
 * 旧事件不得覆盖新状态，否则对端状态会永久错误。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { usePresenceStore } from './presence-store';

const store = () => usePresenceStore.getState();

beforeEach(() => {
  usePresenceStore.setState({ byUserId: {}, typing: {}, selfUserId: 0 });
  store().setSelfUserId(0);
});

describe('presence-store.setStatus 单调守卫', () => {
  it('首次写入生效', () => {
    store().setStatus({ userId: 2001, status: 'online', at: 1000 });
    expect(store().byUserId[2001]).toEqual({ status: 'online', at: 1000 });
  });

  it('更新的 at 覆盖旧状态', () => {
    store().setStatus({ userId: 2001, status: 'online', at: 1000 });
    store().setStatus({ userId: 2001, status: 'offline', at: 2000 });
    expect(store().byUserId[2001]).toEqual({ status: 'offline', at: 2000 });
  });

  it('乱序到达的旧事件被丢弃（online 不会被迟到的 offline 覆盖）', () => {
    store().setStatus({ userId: 2001, status: 'online', at: 5000 });
    store().setStatus({ userId: 2001, status: 'offline', at: 4000 }); // 迟到旧事件
    expect(store().byUserId[2001].status).toBe('online');
    expect(store().byUserId[2001].at).toBe(5000);
  });

  it('at 相等时允许覆盖（同刻重放不阻塞）', () => {
    store().setStatus({ userId: 2001, status: 'online', at: 1000 });
    store().setStatus({ userId: 2001, status: 'away', at: 1000 });
    expect(store().byUserId[2001].status).toBe('away');
  });

  it('忽略自身与非法 userId', () => {
    store().setSelfUserId(2001);
    store().setStatus({ userId: 2001, status: 'online', at: 1000 });
    store().setStatus({ userId: 0, status: 'online', at: 1000 });
    expect(store().byUserId).toEqual({});
  });
});
