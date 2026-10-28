/**
 * TYPING(230) → presence store（"对方正在输入…"，3s 自动过期）。
 */
import { decodeTyping } from '../../proto/payload';
import type { Handler } from '../registry';

export const handleTyping: Handler = (env, ctx) => {
  let payload;
  try {
    payload = decodeTyping(env.payload);
  } catch {
    return;
  }
  const convId = payload.convId || env.convId || 0;
  if (!convId || !payload.userId) return;
  ctx.presence.setTyping(convId, payload.userId, payload.typing, payload.at);
};
