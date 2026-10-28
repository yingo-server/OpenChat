/**
 * FEATURE_FLAGS(12) → session store（flag 即策略表，UI 能力开关全部读这里）。
 */
import { decodeFeatureFlags } from '../../proto/payload';
import type { Handler } from '../registry';

export const handleFeatureFlags: Handler = (env, ctx) => {
  let payload;
  try {
    payload = decodeFeatureFlags(env.payload);
  } catch (error) {
    console.warn('[feature-flags] bad payload', error);
    return;
  }
  ctx.session.setFlags(payload.flags, payload.version);
};
