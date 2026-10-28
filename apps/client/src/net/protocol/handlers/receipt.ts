/**
 * MSG_READ(104) / MSG_DELIVERED(105) → 回执状态（不影响 last_seq）。
 */
import { decodeReceipt } from '../../proto/payload';
import { KINDS } from '../kinds';
import type { Handler } from '../registry';

export const handleReceipt: Handler = (env, ctx) => {
  let receipt;
  try {
    receipt = decodeReceipt(env.payload);
  } catch (error) {
    console.warn('[receipt] bad payload', error);
    return;
  }
  if (!receipt || !receipt.msgId) return;
  const type = env.kind === KINDS.MSG_READ ? 'read' : 'delivered';
  ctx.messages.applyReceipt(env.convId ?? 0, receipt.msgId, type, receipt.userId, receipt.at);
};
