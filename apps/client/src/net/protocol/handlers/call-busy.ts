/**
 * CALL_BUSY(353) → 对端忙线 / 拒绝 / 不支持：结束通话并 toast（文案按 reason 区分）。
 */
import { decodeBusy } from '../../call/signal';
import { callController } from '../../call/controller';
import type { Handler } from '../registry';

export const handleCallBusy: Handler = (env) => {
  let payload;
  try {
    payload = decodeBusy(env.payload);
  } catch {
    return;
  }
  if (!payload.callId) return;
  callController.handleBusy(payload);
};
