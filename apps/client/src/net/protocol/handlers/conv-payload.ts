/**
 * CONV_CREATE(200) / CONV_UPDATE(201) / CONV_PAYLOAD(202) → 会话元数据 upsert。
 */
import { decodeConvPayload } from '../../proto/payload';
import type { Handler } from '../registry';

export const handleConvPayload: Handler = (env, ctx) => {
  let payload;
  try {
    payload = decodeConvPayload(env.payload);
  } catch (error) {
    console.warn('[conv-payload] bad payload', error);
    return;
  }
  const convId = payload.convId || env.convId || 0;
  if (!convId) return;
  ctx.convs.upsertFromWire({ ...payload, convId });
  // last_seq 是服务端水位，不是本地游标：先登记会话（本地游标从缓存读），
  // 若服务端水位更高则走 SYNC_REQUEST 补拉，避免新设备跳过历史消息。
  void (async () => {
    const localLastSeq = await ctx.sync.ensureConv(convId, 0);
    if (payload.lastSeq && payload.lastSeq > localLastSeq) {
      await ctx.sync.onResumeResult({
        convId,
        fromSeq: localLastSeq + 1,
        complete: false,
        serverSeq: payload.lastSeq,
      });
    }
  })();
};
