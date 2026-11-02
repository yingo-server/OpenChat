/**
 * WATERMARK(14) → 拉取模式水位线（spec v1.2 §2.1/§2.3）。
 *
 * 解析采用宽松 JSON 双形态（camelCase 服务端 jsonMode / snake_case proto 形态）。
 * reason 仅诊断断言用，handler 逻辑不依赖其取值（spec §1.1 字段语义约束）。
 * 本模块只解析帧并把 (convId, latestSeq) 交给 pull-scheduler.onWatermark；
 * 不写 cache/sink，不感知拉取循环。
 */
import { decodeJsonPayload, num } from '../../proto/payload';
import { pullScheduler } from '../../sync/pull-scheduler';
import type { Handler } from '../registry';

export interface WatermarkPayload {
  convId: number;
  latestSeq: number;
  reason: number;
  memberCount: number;
}

export function decodeWatermark(bytes: Uint8Array): WatermarkPayload {
  const raw = decodeJsonPayload<Record<string, unknown>>(bytes);
  return {
    convId: num(raw.convId, num(raw.conv_id)),
    latestSeq: num(raw.latestSeq, num(raw.latest_seq)),
    reason: num(raw.reason),
    memberCount: num(raw.memberCount, num(raw.member_count)),
  };
}

export function encodeWatermark(payload: WatermarkPayload): Uint8Array {
  // mock 注入 / 压测端复用：JSON 形态（spec §1.1，≈70 字节）
  return encodeWatermarkJson(payload);
}

function encodeWatermarkJson(payload: WatermarkPayload): Uint8Array {
  const enc = new TextEncoder();
  return enc.encode(
    JSON.stringify({
      convId: payload.convId,
      latestSeq: payload.latestSeq,
      reason: payload.reason ?? 0,
      memberCount: payload.memberCount ?? 0,
    }),
  );
}

export const handleWatermark: Handler = (env) => {
  let payload: WatermarkPayload;
  try {
    payload = decodeWatermark(env.payload);
  } catch {
    return; // 畸形帧：丢弃，不进调度器
  }
  const convId = payload.convId || env.convId || 0;
  if (!convId || payload.latestSeq <= 0) return;
  pullScheduler.onWatermark({
    convId,
    latestSeq: payload.latestSeq,
    reason: payload.reason,
    memberCount: payload.memberCount,
  });
};
