/**
 * CALL_OFFER(350) → 来电。
 * idle 时进入 incoming（UI 弹来电）；非 idle（已在通话）→ 自动回 BUSY(busy)。
 * call_enabled 关闭时回 BUSY(unsupported)。
 */
import { decodeOffer, sendBusy } from '../../call/signal';
import { callController } from '../../call/controller';
import type { Handler } from '../registry';

export const handleCallOffer: Handler = (env, ctx) => {
  let payload;
  try {
    payload = decodeOffer(env.payload);
  } catch {
    return;
  }
  if (!payload.callId || !payload.fromUserId) return;
  if (ctx.session.flag('call_enabled') === '0') {
    sendBusy(ctx.client, payload.fromUserId, {
      callId: payload.callId,
      reason: 'unsupported',
      fromUserId: ctx.session.userId,
    });
    return;
  }
  callController.handleOffer(payload, ctx.client, ctx.session.userId);
};
