/**
 * MSG_NEW(102) → sync 引擎唯一入口。
 * handler 只做 payload 解码与领域映射；seq 校验/落库/投影全部由 sync 引擎负责。
 */
import { decodeMsgNew } from '../../proto/payload';
import { mailboxSync } from '../../sync/mailbox';
import type { Handler } from '../registry';
import type { StoredMessage } from '../../sync/types';

export const handleMsgNew: Handler = (env, ctx) => {
  let payload;
  try {
    payload = decodeMsgNew(env.payload);
  } catch (error) {
    console.warn('[msg-new] bad payload', error);
    return;
  }
  const convId = env.convId ?? payload.convId ?? 0;
  if (!convId) return;
  const { content } = payload;
  const type = content.media.length > 0 ? content.media[0].type : content.text ? 'text' : 'system';
  const message: StoredMessage = {
    convId,
    seq: payload.seq,
    msgId: payload.msgId,
    senderId: payload.senderId,
    sentAt: payload.sentAt,
    type,
    payload: {
      text: content.text,
      media: content.media,
      replyTo: content.replyTo,
      mentions: content.mentions,
    },
    status: 'sent',
    clientMsgId: content.clientMsgId || undefined,
    // A recalled message that we learn about via history/sync must land as a
    // tombstone immediately — otherwise a device that reinstalls would show
    // the original text that the server already hides elsewhere.
    deleted: payload.recalled ? true : undefined,
  };
  void ctx.sync.ingestNew(convId, message).then((outcome) => {
    // v3 mailbox（docs/v3-bus-design.md §4.2）：ingest 收敛成功 → 上报 kind 15。
    // mailbox_seq 由 v3 服务端承载于下行帧 envelope.id（单写者递增）；
    // MailboxSync 内部做重复/乱序丢弃与 cursor 单调，重复上报幂等无害。
    mailboxSync.ingest(env.id);
    void outcome;
  }).catch((error) => {
    console.warn('[msg-new] ingest failed', error);
    ctx.session.toast('toast.syncFailed');
  });
};
