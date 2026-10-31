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

/**
 * PRESENCE_SUBSCRIBE(401) / PRESENCE_UNSUBSCRIBE(402) → presence store。
 *
 * 服务端下行的 401/402 是连接/断开事件：{user_id, online:bool, at}
 * （signaling.go onPresenceConnect 广播）。形态由 decodePresence 的 online
 * 分支兼容（P0-2）；乱序由 presence-store 的 at 单调守卫兜住（P0-3）。
 * 服务端同时按同一会员集广播 402 CONV_PAYLOAD 快照，故这里只更新在线点。
 */
export const handlePresenceConnect: Handler = (env, ctx) => {
  let payload;
  try {
    payload = decodePresence(env.payload);
  } catch {
    return;
  }
  if (!payload.userId) return;
  ctx.presence.setStatus(payload);
};
