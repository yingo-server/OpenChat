/**
 * 聊天窗：头部（标题/在线态）+ 网络条 + 消息列表 + 输入栏。
 * 不包含任何消息类型渲染逻辑。
 */
import { useEffect, useState } from 'react';
import { useConvStore } from '../../../core/stores/conv-store';
import { useMessageStore } from '../../../core/stores/message-store';
import { usePresenceStore } from '../../../core/stores/presence-store';
import { useConnStore } from '../../../core/stores/conn-store';
import { useSessionStore, isFlagEnabled } from '../../../core/stores/session-store';
import { selectIsMine, selectPresence, selectTypingUserIds } from '../../../core/selectors';
import type { ChatMessage, ConvRecord } from '../../../core/types';
import { t } from '../../i18n';
import { Avatar } from '../../components/Avatar';
import { NetworkBar } from '../../components/NetworkBar';
import { ChatSkeleton } from '../../components/Skeleton';
import { BackIcon, MoreIcon, PhoneIcon, SpinnerIcon, VideoIcon } from '../../components/icons';
import { toast } from '../../components/Toast';
import { navigate } from '../../router';
import { MessageList } from './MessageList';
import { Composer } from './Composer';
import { useCall } from '../call/useCall';

export function ChatView({ convId }: { convId: number | null }) {
  if (convId === null) return <ChatPlaceholder />;
  return <ChatSession convId={convId} />;
}

function ChatSession({ convId }: { convId: number }) {
  const conv = useConvStore((state) => state.convs[convId]);
  const conn = useConnStore((state) => state.state);
  const ids = useMessageStore((state) => state.idsByConv[convId]);
  const selfId = useSessionStore((state) => state.userId);
  const otherId = conv && conv.convType === 1 ? (conv.members.find((member) => member.userId !== selfId)?.userId ?? 0) : 0;
  const presence = usePresenceStore((state) => (otherId ? selectPresence(state, otherId) : 'offline'));
  const callEnabled = useSessionStore((state) => isFlagEnabled(state.flags, 'call_enabled'));
  const call = useCall();
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [scrollSignal, setScrollSignal] = useState(0);
  const [, tick] = useState(0);

  // 正在输入 3s TTL：每 2s 重算一次，驱动副标题更新
  useEffect(() => {
    const timer = setInterval(() => {
      usePresenceStore.getState().prune();
      tick((value) => value + 1);
    }, 2000);
    return () => clearInterval(timer);
  }, [convId]);

  useEffect(() => {
    setReplyTo(null);
  }, [convId]);

  const typingCount = usePresenceStore((state) => selectTypingUserIds(state, convId).length);

  if (!conv) {
    return (
      <section className="flex min-h-0 flex-1 flex-col bg-page">
        <div className="pt-safe flex h-14 items-center border-b border-line bg-surface px-3">
          <button
            type="button"
            onClick={() => {
              useConvStore.getState().setActive(null);
              navigate('/chats');
            }}
            aria-label={t('common.back')}
            className="inline-flex h-10 w-10 items-center justify-center rounded-full text-ink-secondary hover:bg-surface-2 tablet:hidden"
          >
            <BackIcon size={22} />
          </button>
          <span className="text-title text-ink">{t('chat.selectConv')}</span>
        </div>
        <div className="flex flex-1 items-center justify-center">
          <SpinnerIcon size={24} className="text-ink-tertiary" />
        </div>
      </section>
    );
  }

  const title = conv.title || t('conv.untitled');
  const subtitle =
    typingCount > 0
      ? t('chat.typing')
      : conv.convType === 1 && presence === 'online'
        ? t('network.online')
        : conv.convType === 1
          ? ''
          : t('conv.members', { count: conv.members.length });

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-page" aria-label={title}>
      <header className="pt-safe flex h-14 shrink-0 items-center gap-2 border-b border-line bg-surface px-2 tablet:px-4">
        <button
          type="button"
          onClick={() => {
            useConvStore.getState().setActive(null);
            navigate('/chats');
          }}
          aria-label={t('common.back')}
          className="inline-flex h-10 w-10 items-center justify-center rounded-full text-ink-secondary hover:bg-surface-2 tablet:hidden"
        >
          <BackIcon size={22} />
        </button>

        <Avatar
          name={title}
          src={conv.avatar}
          size="sm"
          userId={otherId || conv.convId}
          presence={conv.convType === 1 ? presence : undefined}
        />

        <div className="min-w-0 flex-1">
          <h2 className="truncate text-title text-ink">{title}</h2>
          {subtitle ? (
            <p className={`truncate text-caption ${typingCount > 0 ? 'text-primary-500' : 'text-ink-tertiary'}`}>
              {subtitle}
            </p>
          ) : null}
        </div>

        {callEnabled ? (
          <CallButtons
            direct={conv.convType === 1}
            onStart={(media) => {
              if (conv.convType !== 1) {
                toast.info(t('call.groupUnsupported'));
                return;
              }
              call.startCall(convId, otherId, media);
            }}
          />
        ) : null}

        <button
          type="button"
          onClick={() => toast.info(t('common.comingSoon'))}
          aria-label={t('common.more')}
          className="inline-flex h-10 w-10 items-center justify-center rounded-full text-ink-secondary hover:bg-surface-2"
        >
          <MoreIcon size={20} />
        </button>
      </header>

      <NetworkBar />

      <div className="flex min-h-0 flex-1 flex-col">
        {ids === undefined && conn !== 'online' ? (
          <ChatSkeleton loading />
        ) : (
          <MessageList
            convId={convId}
            scrollSignal={scrollSignal}
            onReply={(message) => setReplyTo(message)}
          />
        )}
      </div>

      <Composer
        convId={convId}
        replyTo={replyTo}
        replySenderName={replyTo ? senderNameOf(conv, replyTo.senderId, selfId) : undefined}
        onCancelReply={() => setReplyTo(null)}
        onSent={() => setScrollSignal((value) => value + 1)}
      />
    </section>
  );
}

function CallButtons({
  direct,
  onStart,
}: {
  direct: boolean;
  onStart: (media: 'audio' | 'video') => void;
}) {
  const base =
    'inline-flex h-10 w-10 items-center justify-center rounded-full text-ink-secondary hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40';
  const tooltip = direct ? undefined : t('call.groupUnsupported');
  return (
    <>
      <button
        type="button"
        onClick={() => onStart('audio')}
        disabled={!direct}
        title={tooltip}
        aria-label={direct ? t('call.startAudio') : t('call.groupUnsupported')}
        className={base}
      >
        <PhoneIcon size={20} />
      </button>
      <button
        type="button"
        onClick={() => onStart('video')}
        disabled={!direct}
        title={tooltip}
        aria-label={direct ? t('call.startVideo') : t('call.groupUnsupported')}
        className={base}
      >
        <VideoIcon size={20} />
      </button>
    </>
  );
}

function senderNameOf(conv: ConvRecord, userId: number, selfId: number): string {
  if (userId === selfId) return t('common.me');
  return conv.members.find((member) => member.userId === userId)?.name ?? t('common.unknownUser', { id: userId });
}

export function ChatPlaceholder() {
  return (
    <section className="hidden min-h-0 flex-1 flex-col items-center justify-center bg-page tablet:flex">
      <div className="mb-4 flex h-32 w-32 items-center justify-center rounded-full bg-surface-2 text-ink-tertiary">
        <MoreIcon size={48} />
      </div>
      <p className="text-title text-ink">{t('chat.selectConv')}</p>
      <p className="mt-1 text-body-sm text-ink-tertiary">{t('chat.selectConvDesc')}</p>
    </section>
  );
}
