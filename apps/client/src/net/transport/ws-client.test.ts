/**
 * WsClient 鉴权契约测试（security-spec §2.3 红线）：
 *  - 构造的握手 URL 永远不含 `token` query 参数；
 *  - token（原生壳路径，无 window 环境）走 Sec-WebSocket-Protocol
 *    `["bearer", <token>]`（与 server/internal/user/net/ws/acceptor.go:288
 *    的 `bearer, <token>` 解析格式对齐）；
 *  - 浏览器路径（有 window）依赖同源 Cookie，不发 subprotocol。
 */
import { describe, expect, it, vi } from 'vitest';
import { WsClient } from './ws-client';
import type { SocketFactory, WsSocket } from './ws-connection';

class FakeSocket implements WsSocket {
  readyState = 1; // OPEN
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  send(): void {}
  close(): void {}
}

function fakeFactory(log: Array<{ url: string; protocols?: string[] }>): SocketFactory {
  return (url, protocols) => {
    log.push({ url, protocols });
    return new FakeSocket();
  };
}

function makeClient(overrides: Partial<ConstructorParameters<typeof WsClient>[0]> = {}) {
  const log: Array<{ url: string; protocols?: string[] }> = [];
  const client = new WsClient({
    url: 'ws://api.example.com/ws',
    token: () => 'secret-token',
    deviceId: () => 'dev-1',
    onFrame: () => undefined,
    socketFactory: fakeFactory(log),
    heartbeatMs: 60_000,
    ...overrides,
  });
  return { client, log };
}

describe('WsClient 鉴权（P0：token 不进 URL query）', () => {
  it('握手 URL 不含 token 参数（仅有 device_id）', () => {
    const { client, log } = makeClient();
    client.start();
    expect(log).toHaveLength(1);
    const url = new URL(log[0].url);
    expect(url.searchParams.has('token')).toBe(false);
    expect(url.searchParams.get('device_id')).toBe('dev-1');
    client.stop();
  });

  it('原生壳路径：token 走 Sec-WebSocket-Protocol ["bearer", token]', () => {
    // vitest node 环境无 window → 原生壳路径
    expect(typeof window).toBe('undefined');
    const { client, log } = makeClient();
    client.start();
    expect(log[0].protocols).toEqual(['bearer', 'secret-token']);
    client.stop();
  });

  it('无 token 时不发 subprotocol（同源 Cookie 路径）', () => {
    const { client, log } = makeClient({ token: undefined });
    client.start();
    expect(log[0].protocols).toBeUndefined();
    expect(new URL(log[0].url).searchParams.has('token')).toBe(false);
    client.stop();
  });

  it('浏览器路径（有 window）：即使有 token 也不发 subprotocol，URL 无 token', () => {
    // jsdom-less：临时注入全局 window 模拟浏览器
    vi.stubGlobal('window', { addEventListener: () => {}, removeEventListener: () => {} });
    try {
      const { client, log } = makeClient();
      client.start();
      expect(log[0].protocols).toBeUndefined();
      expect(new URL(log[0].url).searchParams.has('token')).toBe(false);
      client.stop();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
