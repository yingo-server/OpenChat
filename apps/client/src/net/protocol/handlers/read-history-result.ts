/**
 * READ_HISTORY_RESULT(921) → 三段式 loader 的等待者。
 *
 * 只做 payload 解码并把结果交给 historyLoader 的 pending 表（按 convId 唤醒）；
 * 写 IndexedDB / 合并投影由 loader 与 sync 引擎负责。迟到的 921（无等待者）
 * 由 loader.handleResult 返回 false 丢弃——不写错会话。
 */
import { decodeReadHistoryResult } from '../../proto/payload';
import { historyLoader } from '../../sync/history-loader';
import type { Handler } from '../registry';

export const handleReadHistoryResult: Handler = (env) => {
  let result;
  try {
    result = decodeReadHistoryResult(env.payload);
  } catch (error) {
    console.warn('[read-history] bad payload', error);
    return;
  }
  const convId = result.convId || env.convId || 0;
  if (!convId) return;
  historyLoader.handleResult({ ...result, convId });
};
