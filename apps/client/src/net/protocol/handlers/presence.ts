/**
 * PRESENCE_UPDATE(400) → presence store（在线点）。
 */
import { decodePresence } from '../../proto/payload';
import type { Handler } from '../registry';

export const handlePresence: Handler = (env, ctx) => {
  let payload;
  try {
    payload = decodePresence(env.payload);
  } catch {
    return;
  }
  if (!payload.userId) return;
  ctx.presence.setStatus(payload);
};
