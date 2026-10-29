/**
 * CONV_DATA_RESULT(931)：930 会话数据操作结果。
 *
 * 目前用户面的入口是 CONV_CREATE(200)：请求由装配层映射为 930 op1，
 * 成功时 931.body 携带完整 ConvPayload（含新 cid）。requestId 以
 * `conv-create-` 开头的帧是「发起会话」的应答：upsert 后直接进入会话。
 */
import { decodeConvPayload, decodeDataResult } from '../../proto/payload';
import type { Handler } from '../registry';

export const CONV_CREATE_REQUEST_PREFIX = 'conv-create-';

export const handleConvDataResult: Handler = (env, ctx) => {
  let result;
  try {
    result = decodeDataResult(env.payload);
  } catch (error) {
    console.warn('[conv-result] bad payload', error);
    return;
  }
  if (!result.ok) {
    if (env.requestId.startsWith(CONV_CREATE_REQUEST_PREFIX)) {
      ctx.toast('conv.create.failed');
    }
    return;
  }
  if (!result.body || result.body.length === 0) return;
  let payload;
  try {
    payload = decodeConvPayload(result.body);
  } catch (error) {
    console.warn('[conv-result] bad conv body', error);
    return;
  }
  const convId = payload.convId || env.convId || 0;
  if (!convId) return;
  ctx.convs.upsertFromWire({ ...payload, convId });
  if (env.requestId.startsWith(CONV_CREATE_REQUEST_PREFIX)) {
    ctx.convs.setActive(convId);
    ctx.navigate(`/chat/${convId}`);
  }
};
