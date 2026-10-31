/**
 * CALL_CANDIDATE(352) → 加入对端 ICE 候选。
 */
import { decodeCandidate } from '../../call/signal';
import { callController } from '../../call/controller';
import type { Handler } from '../registry';

export const handleCallCandidate: Handler = (env) => {
  let payload;
  try {
    payload = decodeCandidate(env.payload);
  } catch {
    return;
  }
  if (!payload.callId) return;
  callController.handleCandidate(payload);
};
