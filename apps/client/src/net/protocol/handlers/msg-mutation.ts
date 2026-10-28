/**
 * MSG_EDIT(106) / MSG_DELETE(107) / MSG_RECALL(108) → 既有 seq 的变更（tombstone）。
 */
import { decodeMsgMutation } from '../../proto/payload';
import { KINDS } from '../kinds';
import type { Handler } from '../registry';

export const handleMsgMutation: Handler = (env, ctx) => {
  let payload;
  try {
    payload = decodeMsgMutation(env.payload);
  } catch (error) {
    console.warn('[msg-mutation] bad payload', error);
    return;
  }
  const convId = env.convId ?? payload.convId ?? 0;
  if (!convId || !payload.msgId) return;

  if (env.kind === KINDS.MSG_EDIT) {
    if (typeof payload.text !== 'string') return;
    void ctx.sync.applyEdit(convId, payload.msgId, payload.text);
    return;
  }
  const op = env.kind === KINDS.MSG_RECALL ? 'recall' : 'delete';
  void ctx.sync.applyTombstone(convId, payload.msgId, op);
};
