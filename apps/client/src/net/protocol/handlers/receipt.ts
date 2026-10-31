/**
 * MSG_READ(104) / MSG_DELIVERED(105) → 回执状态（不影响 last_seq）。
 * payload 可能是批量形态（{"receipts":[...]}），逐条应用。
 */
import { decodeReceipt } from '../../proto/payload';
import { KINDS } from '../kinds';
import type { Handler } from '../registry';

export const handleReceipt: Handler = (env, ctx) => {
  let receipts;
  try {
    receipts = decodeReceipt(env.payload);
  } catch (error) {
    console.warn('[receipt] bad payload', error);
    return;
  }
  if (receipts.length === 0) return;
  const type = env.kind === KINDS.MSG_READ ? 'read' : 'delivered';
  for (const receipt of receipts) {
    if (!receipt.msgId) continue;
    ctx.messages.applyReceipt(env.convId ?? 0, receipt.msgId, type, receipt.userId, receipt.at);
  }
};
