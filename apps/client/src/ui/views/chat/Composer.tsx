/**
 * Composer（§3.2）：自适应高度、草稿持久化、Enter 发送（桌面）、
 * 500 字计数（90% 出现）、回复预览、离线仍可入队。
 */
import { useEffect, useRef } from 'react';
import { useConvStore } from '../../../core/stores/conv-store';
import { useSessionStore } from '../../../core/stores/session-store';
import { useConnStore } from '../../../core/stores/conn-store';
import { selectCanSendMessage } from '../../../core/selectors';
import type { ChatMessage } from '../../../core/types';
import { getAppServices } from '../../services/app-services';
import { t } from '../../i18n';
import { AttachIcon, CloseIcon, SendIcon } from '../../components/icons';
import { toast } from '../../components/Toast';

export interface ComposerProps {
  convId: number;
  replyTo?: ChatMessage | null;
  replySenderName?: string;
  onCancelReply?: () => void;
  onSent?: () => void;
}

export function Composer({ convId, replyTo, replySenderName, onCancelReply, onSent }: ComposerProps) {
  const text = useConvStore((state) => state.drafts[convId] ?? '');
  const setDraft = useConvStore((state) => state.setDraft);
  const canSend = useSessionStore(selectCanSendMessage);
  const guest = useSessionStore((state) => state.status === 'guest');
  const maxLength = useSessionStore((state) => Number(state.flags['chat.max_length'] ?? 500) || 500);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = 'auto';
    const max = Math.min(window.innerHeight * 0.4, 220);
    element.style.height = `${Math.min(element.scrollHeight, max)}px`;
  }, [text]);

  const send = () => {
    const value = text.trim();
    if (!value || !canSend) return;
    const outbox = getAppServices().outbox;
    if (!outbox) return;
    void outbox.enqueue({
      convId,
      text: value,
      replyTo: replyTo?.msgId || undefined,
    });
    setDraft(convId, '');
    onCancelReply?.();
    onSent?.();
    if (useConnStore.getState().state !== 'online') {
      toast.info(t('toast.queued'));
    }
    textareaRef.current?.focus();
  };

  const attach = () => {
    if (guest) {
      toast.info(t('toast.mediaUnsupported'));
      return;
    }
    toast.info(t('toast.comingSoon'));
  };

  const remaining = maxLength - text.length;
  const showCounter = text.length >= maxLength * 0.9;

  return (
    <div className="shrink-0 border-t border-line bg-surface pb-safe">
      {replyTo ? (
        <div className="mx-3 mt-2 flex items-start gap-2 rounded-sm border-s-2 border-primary-500 bg-surface-2 px-2.5 py-1.5">
          <div className="min-w-0 flex-1">
            <p className="text-caption text-primary-500">{t('chat.replyTo', { name: replySenderName ?? '' })}</p>
            <p className="truncate text-caption text-ink-tertiary">{previewOfMessage(replyTo)}</p>
          </div>
          <button
            type="button"
            aria-label={t('chat.cancelReply')}
            onClick={onCancelReply}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-ink-tertiary hover:bg-surface"
          >
            <CloseIcon size={14} />
          </button>
        </div>
      ) : null}

      <div className="flex items-end gap-2 px-3 py-2">
        <button
          type="button"
          onClick={attach}
          aria-label={t('chat.attach')}
          className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-ink-secondary hover:bg-surface-2"
        >
          <AttachIcon size={22} />
        </button>

        <div className="relative min-w-0 flex-1">
          <textarea
            ref={textareaRef}
            value={text}
            rows={1}
            maxLength={maxLength}
            onChange={(event) => setDraft(convId, event.target.value)}
            onKeyDown={(event) => {
              const isMobile = window.matchMedia('(max-width: 767px)').matches;
              if (event.key === 'Enter' && !event.shiftKey && !isMobile) {
                event.preventDefault();
                send();
              }
            }}
            placeholder={t('chat.placeholder')}
            aria-label={t('chat.placeholder')}
            className="max-h-[40vh] min-h-[44px] w-full resize-none overflow-y-auto rounded-lg border border-line bg-surface-2 px-3 py-2.5 pe-14 text-base text-ink placeholder:text-ink-tertiary focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20 tablet:text-body"
          />
          {showCounter ? (
            <span
              className={`nums pointer-events-none absolute bottom-1.5 end-2 text-caption ${
                remaining < 0 ? 'text-danger-500' : 'text-ink-tertiary'
              }`}
            >
              {text.length}/{maxLength}
            </span>
          ) : null}
        </div>

        <button
          type="button"
          onClick={send}
          disabled={!text.trim() || !canSend}
          aria-label={t('chat.send')}
          className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary-500 text-ink-inverse transition-colors duration-micro hover:bg-primary-600 disabled:cursor-not-allowed disabled:bg-primary-100 disabled:text-ink/40"
        >
          <SendIcon size={20} />
        </button>
      </div>
    </div>
  );
}

function previewOfMessage(message: ChatMessage): string {
  const text = typeof message.payload.text === 'string' ? message.payload.text : '';
  if (text) return text;
  const type = message.payload.media?.[0]?.type;
  if (type === 'image') return t('chat.image');
  if (type === 'audio') return t('chat.audio');
  if (type === 'video') return t('chat.video');
  if (type === 'file') return t('chat.file');
  return t('chat.unsupported');
}
