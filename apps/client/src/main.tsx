/**
 * 入口只做三件事：注册 handlers + 注册 renderers + 挂载。
 * 任何业务逻辑/条件分支都不属于这里（接线在 app/bootstrap.ts）。
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './ui/styles/index.css';

import { KINDS } from './net/protocol/kinds';
import { createRegistry } from './net/protocol/registry';
import { handleMsgNew } from './net/protocol/handlers/msg-new';
import { handleMsgAck } from './net/protocol/handlers/msg-ack';
import { handleReceipt } from './net/protocol/handlers/receipt';
import { handleMsgMutation } from './net/protocol/handlers/msg-mutation';
import { handleResumeResult } from './net/protocol/handlers/resume-result';
import { handleFeatureFlags } from './net/protocol/handlers/feature-flags';
import { handleKicked } from './net/protocol/handlers/kicked';
import { handleError } from './net/protocol/handlers/error';
import { handleRateLimited } from './net/protocol/handlers/rate-limited';
import { handleConvPayload } from './net/protocol/handlers/conv-payload';
import { handleConvDataResult } from './net/protocol/handlers/conv-result';
import { handleTyping } from './net/protocol/handlers/typing';
import { handlePresence } from './net/protocol/handlers/presence';
import { handlePong } from './net/protocol/handlers/pong';
import { handleCallOffer } from './net/protocol/handlers/call-offer';
import { handleCallAnswer } from './net/protocol/handlers/call-answer';
import { handleCallCandidate } from './net/protocol/handlers/call-candidate';
import { handleCallBusy } from './net/protocol/handlers/call-busy';
import { handleCallHangup } from './net/protocol/handlers/call-hangup';

import { registerRenderer } from './ui/renderers/registry';
import { TextMessage } from './ui/renderers/text';
import { ImageMessage } from './ui/renderers/image';
import { AudioMessage } from './ui/renderers/audio';
import { FileMessage } from './ui/renderers/file';
import { SystemMessage } from './ui/renderers/system';
import { UnknownMessage } from './ui/renderers/unknown';

import { bootstrap } from './app/bootstrap';
import { App } from './ui/App';

async function main(): Promise<void> {
  const registry = createRegistry();

  registry.register(KINDS.MSG_NEW, handleMsgNew);
  registry.register(KINDS.MSG_ACK, handleMsgAck);
  registry.register(KINDS.MSG_READ, handleReceipt);
  registry.register(KINDS.MSG_DELIVERED, handleReceipt);
  registry.register(KINDS.MSG_EDIT, handleMsgMutation);
  registry.register(KINDS.MSG_DELETE, handleMsgMutation);
  registry.register(KINDS.MSG_RECALL, handleMsgMutation);
  registry.register(KINDS.RESUME_RESULT, handleResumeResult);
  registry.register(KINDS.FEATURE_FLAGS, handleFeatureFlags);
  registry.register(KINDS.KICKED, handleKicked);
  registry.register(KINDS.ERROR, handleError);
  registry.register(KINDS.RATE_LIMITED, handleRateLimited);
  registry.register(KINDS.CONV_CREATE, handleConvPayload);
  registry.register(KINDS.CONV_UPDATE, handleConvPayload);
  registry.register(KINDS.CONV_PAYLOAD, handleConvPayload);
  registry.register(KINDS.CONV_DATA_RESULT, handleConvDataResult);
  registry.register(KINDS.TYPING, handleTyping);
  registry.register(KINDS.PRESENCE_UPDATE, handlePresence);
  registry.register(KINDS.PONG, handlePong);
  registry.register(KINDS.CALL_OFFER, handleCallOffer);
  registry.register(KINDS.CALL_ANSWER, handleCallAnswer);
  registry.register(KINDS.CALL_CANDIDATE, handleCallCandidate);
  registry.register(KINDS.CALL_BUSY, handleCallBusy);
  registry.register(KINDS.CALL_HANGUP, handleCallHangup);

  registerRenderer('text', TextMessage);
  registerRenderer('image', ImageMessage);
  registerRenderer('audio', AudioMessage);
  registerRenderer('file', FileMessage);
  registerRenderer('video', FileMessage);
  registerRenderer('system', SystemMessage, { chrome: 'plain' });
  registerRenderer('unknown', UnknownMessage);

  await bootstrap(registry);

  const container = document.getElementById('root');
  if (!container) throw new Error('#root not found');
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void main().catch((error: unknown) => {
  console.error('[openchat] bootstrap failed', error);
  const container = document.getElementById('root');
  if (container) {
    container.innerHTML =
      '<div style="padding:24px;font-family:system-ui;color:#E5484D">应用启动失败，请刷新重试。</div>';
  }
});
