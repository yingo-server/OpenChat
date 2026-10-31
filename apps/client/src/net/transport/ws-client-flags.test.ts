/**
 * 连接建立后主动拉取 feature flags（P0-4）：
 * 客户端此前只在 handler 注册里出现 FEATURE_FLAGS，从不发请求 → flags 恒空
 * → UI 能力开关恒真。ws-client 在 open 后必须主动发一帧 kind 12。
 */
import { describe, expect, it } from 'vitest';
import { WsClient } from './ws-client';
import { decodeEnvelope } from '../proto/codec';
import { KINDS } from '../protocol/kinds';
import type { SocketFactory, WsSocket } from './ws-connection';

class RecordingSocket implements WsSocket {
  readyState = 1; // OPEN
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly sent: Array<string | ArrayBuffer | Uint8Array> = [];
  send(data: string | ArrayBuffer | Uint8Array): void {
    this.sent.push(data);
  }
  close(): void {}
}

function makeClient() {
  const sockets: RecordingSocket[] = [];
  const factory: SocketFactory = () => {
    const socket = new RecordingSocket();
    sockets.push(socket);
    return socket;
  };
  const client = new WsClient({
    url: 'ws://api.example.com/ws',
    onFrame: () => undefined,
    socketFactory: factory,
    heartbeatMs: 60_000,
  });
  return { client, sockets };
}

function kindsOf(ssocket: RecordingSocket): number[] {
  return ssocket.sent
    .filter((frame): frame is string => typeof frame === 'string')
    .map((frame) => decodeEnvelope(frame).kind);
}

describe('WsClient 连接建立后请求 feature flags（P0-4）', () => {
  it('open 后发送一帧 kind 12（FEATURE_FLAGS 请求）', () => {
    const { client, sockets } = makeClient();
    client.start();
    const socket = sockets[0];
    socket.onopen?.(); // 触发握手完成
    expect(kindsOf(socket)).toContain(KINDS.FEATURE_FLAGS);
    client.stop();
  });

  it('重连（再次 open）后仍会重新请求 flags', () => {
    const { client, sockets } = makeClient();
    client.start();
    sockets[0].onopen?.();
    const before = kindsOf(sockets[0]).filter((kind) => kind === KINDS.FEATURE_FLAGS).length;
    // 模拟重连：再次 open
    sockets[0].onopen?.();
    const after = kindsOf(sockets[0]).filter((kind) => kind === KINDS.FEATURE_FLAGS).length;
    expect(before).toBe(1);
    expect(after).toBe(2);
    client.stop();
  });
});
