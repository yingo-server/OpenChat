/**
 * v3 mailbox 帧处理（docs/v3-bus-design.md §4，P1 客户端先行）。
 *
 * kind 语义：
 *  - 15 MAILBOX_ACK  C→S：客户端只发送，正常不收；handler 仅防御性吞掉
 *    （mock 回环 / 灰度误投不炸，满足 T-CL-4「未知/错向帧不崩溃」）。
 *  - 16 MAILBOX_PAUSE S→C：仅诊断，本端记录，不做任何行为切换（正常暂停靠
 *    服务端 credit==0 停发，不发帧）。
 *  - 17 MAILBOX_RESUME C→S：同 15，客户端只发送；handler 防御性吞掉。
 *
 * 游标状态机在 net/sync/mailbox.ts（MailboxSync）；数据帧仍走既有
 * 102 → engine.ingest 链路，本文件绝不写缓存。
 */
import { decodeMailboxPause } from '../../proto/payload';
import type { Handler } from '../registry';

export const handleMailboxAck: Handler = () => {
  /* C→S 方向：防御性吞掉（不做诊断记录，保持 dispatch stats 干净） */
};

export const handleMailboxResume: Handler = () => {
  /* C→S 方向：防御性吞掉 */
};

export const handleMailboxPause: Handler = (env) => {
  if (env.payload.length === 0) return;
  try {
    void decodeMailboxPause(env.payload);
  } catch {
    /* 畸形诊断帧：丢弃 */
  }
};
