/**
 * MSG_NEW(102) → sync 引擎唯一入口。
 * handler 只做 payload 解码与领域映射；seq 校验/落库/投影全部由 sync 引擎负责。
 */
import { decodeMsgNew } from '../../proto/payload';
import type { Handler } from '../registry';
import type { StoredMessage } from '../../sync/types';

export const handleMsgNew: Handler = (env, ctx) => {
  if (!env.convId) return;
  let payload;
  try {
    payload = decodeMsgNew(env.payload);
  } catch (error) {
    console.warn('[msg-new] bad payload', error);
    return;
  }
  const { content } = payload;
  const type = content.media.length > 0 ? content.media[0].type : content.text ? 'text' : 'system';
  const message: StoredMessage = {
    convId: env.convId,
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
  };
  void ctx.sync.ingestNew(env.convId, message).catch((error) => {
    console.warn('[msg-new] ingest failed', error);
    ctx.session.toast('toast.syncFailed');
  });
};
