/**
 * RESUME_RESULT(7) → 告知 sync 引擎服务端水位，缺的区间继续补拉。
 */
import { decodeResumeResult } from '../../proto/payload';
import type { Handler } from '../registry';

export const handleResumeResult: Handler = (env, ctx) => {
  let payload;
  try {
    payload = decodeResumeResult(env.payload);
  } catch (error) {
    console.warn('[resume-result] bad payload', error);
    return;
  }
  const convId = payload.convId || env.convId || 0;
  if (!convId) return;
  void ctx.sync.onResumeResult({ ...payload, convId });
};
