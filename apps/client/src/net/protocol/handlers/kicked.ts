/**
 * KICKED(11) → 全设备踢下线；banned_until>0 跳封禁页。
 */
import { decodeKicked } from '../../proto/payload';
import type { Handler } from '../registry';

export const handleKicked: Handler = (env, ctx) => {
  let payload;
  try {
    payload = decodeKicked(env.payload);
  } catch (error) {
    console.warn('[kicked] bad payload', error);
    return;
  }
  ctx.session.kicked(payload.reason, payload.bannedUntil);
  ctx.navigate(payload.bannedUntil > 0 ? '/banned' : '/login');
};
