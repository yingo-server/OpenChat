/**
 * RATE_LIMITED(13) → 限流提示（就地 toast，不阻塞发送队列）。
 */
import { decodeRateLimited } from '../../proto/payload';
import type { Handler } from '../registry';

export const handleRateLimited: Handler = (env, ctx) => {
  let payload;
  try {
    payload = decodeRateLimited(env.payload);
  } catch {
    return;
  }
  ctx.session.rateLimited(payload.scope, payload.retryAfterMs);
};
