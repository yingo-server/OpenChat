/**
 * MessageList —— 只负责位置与交互：虚拟滚动 / 长按菜单 / 滚动锚定。
 * 任何一种消息的渲染都在 renderers 注册表里，本文件不含类型分支。
 */
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useMessageStore } from '../../../core/stores/message-store';
import { useConvStore } from '../../../core/stores/conv-store';
import { useSessionStore } from '../../../core/stores/session-store';
import { selectIsMine } from '../../../core/selectors';
import type { ChatMessage, ConvRecord } from '../../../core/types';
import { getRenderer, getRendererChrome } from '../../renderers/registry';
import { Bubble } from '../../components/Bubble';
import { Avatar } from '../../components/Avatar';
import { SpinnerIcon, AlertIcon, CopyIcon, FlagIcon, ForwardIcon, ReplyIcon, SelectIcon, TrashIcon } from '../../components/icons';
import { t } from '../../i18n';
import { formatDayDivider, formatTime } from '../../utils/format';
import { discardSend, retrySend } from '../../services/app-services';
import { toast } from '../../components/Toast';

const EMPTY_IDS: string[] = [];
const FIVE_MINUTES = 5 * 60 * 1000;

export interface MessageListProps {
  convId: number;
  onReply: (message: ChatMessage) => void;
  /** 发送成功后强制贴底（用户上滚时也回到底部） */
  scrollSignal?: number;
}

interface MenuState {
  messageId: string;
  x: number;
  y: number;
}

export function MessageList({ convId, onReply, scrollSignal = 0 }: MessageListProps) {
  const ids = useMessageStore((state) => state.idsByConv[convId] ?? EMPTY_IDS);
  const loadingHistory = useMessageStore((state) => state.loadingHistory[convId] ?? false);
  const unreadTotal = useConvStore((state) => state.convs[convId]?.unread ?? 0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [newCount, setNewCount] = useState(0);
  const [atBottom, setAtBottom] = useState(true);
  const atBottomRef = useRef(true);
  const [unreadIndex, setUnreadIndex] = useState<number | null>(null);

  const virtualizer = useVirtualizer({
    count: ids.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 72,
    overscan: 8,
    getItemKey: (index) => ids[index] ?? index,
  });

  const prevCount = useRef(0);
  const prevFirst = useRef<string | undefined>(undefined);
  const prevLast = useRef<string | undefined>(undefined);
  const initialized = useRef(false);
  const anchorId = useRef<string | null>(null);

  useEffect(() => {
    atBottomRef.current = atBottom;
  }, [atBottom]);

  // 切换会话：重置全部滚动锚点状态
  useEffect(() => {
    prevCount.current = 0;
    prevFirst.current = undefined;
    prevLast.current = undefined;
    initialized.current = false;
    anchorId.current = null;
    setNewCount(0);
    setAtBottom(true);
    atBottomRef.current = true;
    setUnreadIndex(null);
  }, [convId]);

  // 首次渲染：有未读 → 停到未读分隔线；否则贴底
  useEffect(() => {
    if (initialized.current || ids.length === 0) return;
    initialized.current = true;
    const target = unreadTotal > 0 ? Math.max(0, ids.length - unreadTotal) : ids.length - 1;
    if (unreadTotal > 0) setUnreadIndex(target);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        virtualizer.scrollToIndex(target, { align: unreadTotal > 0 ? 'start' : 'end' });
      });
    });
    prevCount.current = ids.length;
    prevFirst.current = ids[0];
    prevLast.current = ids[ids.length - 1];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids.length, convId, unreadTotal]);

  // 新消息 / 历史加载：保持锚点，不把用户视口顶走
  useEffect(() => {
    const count = ids.length;
    const previous = prevCount.current;
    if (initialized.current && count !== previous) {
      const appended = previous > 0 && ids[ids.length - 1] !== prevLast.current && ids[0] === prevFirst.current;
      const prepended = previous > 0 && ids[0] !== prevFirst.current && ids[ids.length - 1] === prevLast.current;
      if (appended) {
        if (atBottomRef.current) {
          requestAnimationFrame(() => virtualizer.scrollToIndex(count - 1, { align: 'end' }));
        } else {
          setNewCount((value) => value + (count - previous));
        }
      } else if (prepended && anchorId.current) {
        const target = ids.indexOf(anchorId.current);
        anchorId.current = null;
        if (target >= 0) {
          requestAnimationFrame(() => virtualizer.scrollToIndex(target, { align: 'start' }));
        }
      }
    }
    prevCount.current = count;
    prevFirst.current = ids[0];
    prevLast.current = ids[ids.length - 1];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids]);

  // 停留 1.2s 后回写已读（分隔线保持到离开会话）
  useEffect(() => {
    if (unreadTotal <= 0) return;
    const timer = setTimeout(() => useConvStore.getState().markRead(convId), 1200);
    return () => clearTimeout(timer);
  }, [convId, unreadTotal]);

  const loadOlder = useCallback(() => {
    if (loadingHistory) return;
    const state = useMessageStore.getState();
    const first = state.byId[ids[0]] as ChatMessage | undefined;
    const firstSeq = first?.seq ?? 0;
    if (!firstSeq || firstSeq <= 1) return;
    const firstVisible = virtualizer.getVirtualItems()[0];
    anchorId.current = firstVisible ? ids[firstVisible.index] ?? null : ids[0] ?? null;
    void state.loadOlder(convId, firstSeq);
  }, [convId, ids, loadingHistory, virtualizer]);

  const handleScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    const bottom = distance < 120;
    setAtBottom(bottom);
    if (bottom) setNewCount(0);
    if (element.scrollTop < 200) loadOlder();
  }, [loadOlder]);

  const openMenu = useCallback((messageId: string) => {
    const element = scrollRef.current;
    const rect = element?.getBoundingClientRect();
    setMenu({
      messageId,
      x: Math.max(8, Math.min((rect?.left ?? 0) + 24, window.innerWidth - 220)),
      y: Math.max(8, Math.min((rect?.top ?? 0) + 80, window.innerHeight - 300)),
    });
  }, []);

  useEffect(() => {
    if (!scrollSignal || ids.length === 0) return;
    setNewCount(0);
    setAtBottom(true);
    requestAnimationFrame(() => virtualizer.scrollToIndex(ids.length - 1, { align: 'end' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollSignal]);

  if (ids.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
        <div className="mb-4 flex h-32 w-32 items-center justify-center rounded-full bg-surface-2 text-ink-tertiary">
          <ReplyIcon size={48} />
        </div>
        <p className="text-title text-ink">{t('chat.empty.title')}</p>
        <p className="mt-1 text-body-sm text-ink-tertiary">{t('chat.empty.desc')}</p>
      </div>
    );
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="scroll-thin min-h-0 flex-1 overflow-y-auto px-0 py-4"
        role="log"
        aria-live="polite"
        aria-label={t('conv.title')}
      >
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
          {virtualizer.getVirtualItems().map((item) => {
            const id = ids[item.index];
            return (
              <div
                key={id}
                data-index={item.index}
                ref={virtualizer.measureElement}
                style={{
                  position: 'absolute',
                  insetInline: 0,
                  top: 0,
                  transform: `translateY(${item.start}px)`,
                }}
              >
                <MessageRow
                  id={id}
                  prevId={item.index > 0 ? ids[item.index - 1] : undefined}
                  isUnreadStart={unreadIndex === item.index}
                  onOpenMenu={openMenu}
                  onReply={onReply}
                />
              </div>
            );
          })}
        </div>
      </div>

      {loadingHistory ? (
        <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-center py-2">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-elevated px-3 py-1 text-caption text-ink-tertiary shadow-sm">
            <SpinnerIcon size={12} />
            {t('chat.loadingOlder')}
          </span>
        </div>
      ) : null}

      {!atBottom && newCount > 0 ? (
        <button
          type="button"
          onClick={() => {
            virtualizer.scrollToIndex(ids.length - 1, { align: 'end' });
            setNewCount(0);
          }}
          className="absolute bottom-3 end-4 z-sticky inline-flex items-center gap-1.5 rounded-full bg-primary-500 px-3 py-1.5 text-caption text-ink-inverse shadow-md animate-slide-up"
        >
          ↓ {t('chat.newMessages', { count: newCount })}
        </button>
      ) : null}

      {menu ? (
        <MessageMenu
          state={menu}
          onClose={() => setMenu(null)}
          onReply={(message) => {
            onReply(message);
            setMenu(null);
          }}
        />
      ) : null}
    </div>
  );
}

interface RowProps {
  id: string;
  prevId?: string;
  isUnreadStart: boolean;
  onOpenMenu: (messageId: string) => void;
  onReply: (message: ChatMessage) => void;
}

const MessageRow = memo(function MessageRow({ id, prevId, isUnreadStart, onOpenMenu, onReply }: RowProps) {
  const message = useMessageStore((state) => state.byId[id]);
  const prev = useMessageStore((state) => (prevId ? state.byId[prevId] : undefined));
  const conv = useConvStore((state) => state.convs[message?.convId ?? 0]);
  const userId = useSessionStore((state) => state.userId);

  if (!message) return null;

  const mine = selectIsMine(message, userId);
  const showDate = !prev || dayKey(prev.sentAt) !== dayKey(message.sentAt);
  const gap = prev ? message.sentAt - prev.sentAt : Number.POSITIVE_INFINITY;
  const grouped = Boolean(prev) && gap < FIVE_MINUTES && prev?.senderId === message.senderId;
  const showAvatar = !mine && !grouped;
  const showSenderName = !mine && !grouped && Boolean(conv && conv.convType !== 1);
  const senderName = memberName(conv, message.senderId);
  const Renderer = getRenderer(message.type) ?? getRenderer('unknown');
  const plain = getRendererChrome(message.type) === 'plain';

  return (
    <div>
      {showDate ? <DayDivider timestamp={message.sentAt} /> : null}
      {isUnreadStart ? <UnreadDivider /> : null}

      {!Renderer ? null : plain ? (
        <Renderer message={message} />
      ) : (
        <Bubble
          mine={mine}
          status={message.status}
          timeLabel={formatTime(message.sentAt)}
          deleted={Boolean(message.deleted)}
          deletedLabel={mine ? t('chat.recalledByMe') : t('chat.recalled')}
          error={message.error}
          senderName={senderName}
          showSenderName={showSenderName}
          showAvatar={showAvatar}
          avatar={<Avatar name={senderName} size="sm" userId={message.senderId} />}
          flush={message.type === 'image'}
          animate={message.status === 'sending'}
          onRetry={() => {
            const localId = localIdOf(message);
            if (localId) retrySend(localId);
          }}
          onLongPress={() => onOpenMenu(message.id)}
        >
          <Renderer message={message} />
        </Bubble>
      )}
    </div>
  );
});

function dayKey(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function DayDivider({ timestamp }: { timestamp: number }) {
  return (
    <div className="flex justify-center py-2">
      <span className="rounded-full bg-surface-2 px-2.5 py-0.5 text-caption text-ink-tertiary">
        {formatDayDivider(timestamp)}
      </span>
    </div>
  );
}

function UnreadDivider() {
  return (
    <div className="flex items-center gap-3 px-6 py-2">
      <span className="h-px flex-1 bg-primary-300" />
      <span className="text-caption text-primary-500">{t('chat.unreadBelow')}</span>
      <span className="h-px flex-1 bg-primary-300" />
    </div>
  );
}

function memberName(conv: ConvRecord | undefined, userId: number): string {
  if (!conv) return t('common.unknownUser', { id: userId });
  const member = conv.members.find((candidate) => candidate.userId === userId);
  return member?.name || conv.title || t('common.unknownUser', { id: userId });
}

function localIdOf(message: ChatMessage): string | null {
  if (!message.id.startsWith('local:')) return null;
  return `l_${message.id.slice('local:'.length)}`;
}

// ---------------------------------------------------------------------------
// 长按 / 右键菜单
// ---------------------------------------------------------------------------

interface MenuItem {
  key: string;
  label: string;
  icon: ReactNode;
  danger?: boolean;
  action: () => void;
}

function MessageMenu({
  state,
  onClose,
  onReply,
}: {
  state: MenuState;
  onClose: () => void;
  onReply: (message: ChatMessage) => void;
}) {
  const message = useMessageStore((store) => store.byId[state.messageId]);
  const userId = useSessionStore((store) => store.userId);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!message) return null;
  const mine = selectIsMine(message, userId);
  const localId = localIdOf(message);
  const text = typeof message.payload.text === 'string' ? message.payload.text : '';

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t('toast.copied'));
    } catch {
      toast.danger(t('toast.serverError', { reason: 'clipboard' }));
    }
    onClose();
  };

  const items: MenuItem[] = [];
  if (localId) {
    items.push({
      key: 'retry',
      label: t('menu.retrySend'),
      icon: <AlertIcon size={18} />,
      action: () => {
        retrySend(localId);
        onClose();
      },
    });
    items.push({
      key: 'discard',
      label: t('menu.deleteLocal'),
      icon: <TrashIcon size={18} />,
      danger: true,
      action: () => {
        discardSend(localId);
        onClose();
      },
    });
  } else {
    items.push({
      key: 'reply',
      label: t('chat.reply'),
      icon: <ReplyIcon size={18} />,
      action: () => onReply(message),
    });
    if (text) {
      items.push({
        key: 'copy',
        label: t('chat.copy'),
        icon: <CopyIcon size={18} />,
        action: () => void copy(),
      });
    }
    items.push(
      {
        key: 'forward',
        label: t('chat.forward'),
        icon: <ForwardIcon size={18} />,
        action: () => {
          toast.info(t('common.comingSoon'));
          onClose();
        },
      },
      {
        key: 'select',
        label: t('chat.select'),
        icon: <SelectIcon size={18} />,
        action: () => {
          toast.info(t('common.comingSoon'));
          onClose();
        },
      },
      {
        key: 'report',
        label: t('chat.report'),
        icon: <FlagIcon size={18} />,
        action: () => {
          toast.info(t('common.comingSoon'));
          onClose();
        },
      },
    );
    if (mine && Date.now() - message.sentAt < 2 * 60_000) {
      items.push({
        key: 'recall',
        label: t('chat.recall'),
        icon: <TrashIcon size={18} />,
        danger: true,
        action: () => {
          toast.info(t('common.comingSoon'));
          onClose();
        },
      });
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-menu"
      onClick={onClose}
      onContextMenu={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div
        role="menu"
        aria-label={t('menu.message')}
        className="absolute w-52 animate-scale-in overflow-hidden rounded-md border border-line bg-elevated py-1 shadow-md"
        style={{ left: state.x, top: state.y }}
        onClick={(event) => event.stopPropagation()}
      >
        {items.map((item) => (
          <button
            key={item.key}
            type="button"
            role="menuitem"
            onClick={item.action}
            className={[
              'flex h-10 w-full items-center gap-2.5 px-3 text-start text-body-sm transition-colors duration-micro hover:bg-surface-2',
              item.danger ? 'text-danger-500' : 'text-ink',
            ].join(' ')}
          >
            <span className="text-current opacity-80">{item.icon}</span>
            {item.label}
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
}
