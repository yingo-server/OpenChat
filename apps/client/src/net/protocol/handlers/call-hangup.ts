/**
 * CALL_HANGUP(354) → 对端挂断：结束通话并按 reason toast。
 */
import { decodeHangup } from '../../call/signal';
import { callController } from '../../call/controller';
import type { Handler } from '../registry';

export const handleCallHangup: Handler = (env) => {
  let payload;
  try {
    payload = decodeHangup(env.payload);
  } catch {
    return;
  }
  if (!payload.callId) return;
  callController.handleHangup(payload);
};
