/**
 * CALL_ANSWER(351) → 我发起的通话收到应答：outgoing → connecting。
 */
import { decodeAnswer } from '../../call/signal';
import { callController } from '../../call/controller';
import type { Handler } from '../registry';

export const handleCallAnswer: Handler = (env, ctx) => {
  let payload;
  try {
    payload = decodeAnswer(env.payload);
  } catch {
    return;
  }
  if (!payload.callId) return;
  callController.handleAnswer(payload, ctx.client, ctx.session.userId);
};
