/**
 * PONG(5) → 心跳应答。RTT 已由 WsClient 在传输层计算，这里只做登记，
 * 保持「所有 kind 都有 handler」的可观测性（dispatch 未处理计数为 0）。
 */
import { decodePong } from '../../proto/payload';
import type { Handler } from '../registry';

export const handlePong: Handler = (env) => {
  try {
    decodePong(env.payload);
  } catch {
    /* payload 畸形不影响心跳 */
  }
};
