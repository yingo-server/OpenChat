/**
 * 会话列表（§3.4）：行组件按 convId 订阅，未读数变化不触发兄弟项重渲染。
 * 搜索、置顶/静音快捷操作、空状态与骨架屏。
 */
import { memo, useMemo, useState } from 'react';
import { useConvStore } from '../../../core/stores/conv-store';
import { usePresenceStore } from '../../../core/stores/presence-store';
import { useConnStore } from '../../../core/stores/conn-store';
import type { ConvRecord } from '../../../core/types';
import { Avatar } from '../../components/Avatar';
import { NetworkBar } from '../../components/NetworkBar';
import { ConvListSkeleton } from '../../components/Skeleton';
import { MuteIcon, PinIcon, SearchIcon, SettingsIcon } from '../../components/icons';
import { t, type I18nKey } from '../../i18n';
import { formatConvTime } from '../../utils/format';
import { navigate } from '../../router';
import { toast } from '../../components/Toast';

const PREVIEW_KEYS: Record<string, I18nKey> = {
  image: 'conv.preview.image',
  audio: 'conv.preview.audio',
  video: 'conv.preview.video',
  file: 'conv.preview.file',
  system: 'conv.preview.system',
};

export function ConvList({ className = '' }: { className?: string }) {
  const order = useConvStore((state) => state.order);
  const convs = useConvStore((state) => state.convs);
  const conn = useConnStore((state) => state.state);
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return order;
    return order.filter((convId) => {
      const conv = convs[convId];
      if (!conv) return false;
      return (
        conv.title.toLowerCase().includes(keyword) ||
        (conv.lastPreview ?? '').toLowerCase().includes(keyword)
      );
    });
  }, [order, convs, query]);

  return (
    <section className={`flex min-h-0 flex-col bg-surface ${className}`} aria-label={t('conv.title')}>
      <header className="pt-safe flex h-14 shrink-0 items-center justify-between border-b border-line px-4">
        <h1 className="text-title text-ink">{t('conv.title')}</h1>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => toast.info(t('common.comingSoon'))}
            aria-label={t('common.search')}
            className="hidden h-9 w-9 items-center justify-center rounded-full text-ink-secondary hover:bg-surface-2 desktop:inline-flex"
          >
            <SearchIcon size={20} />
          </button>
          <button
            type="button"
            onClick={() => navigate('/settings')}
            aria-label={t('settings.title')}
            className="inline-flex h-9 w-9 items-center justify-center rounded-full text-ink-secondary hover:bg-surface-2"
          >
            <SettingsIcon size={20} />
          </button>
        </div>
      </header>

      <NetworkBar />

      <div className="shrink-0 px-3 py-2">
        <div className="relative">
          <span className="pointer-events-none absolute inset-y-0 start-3 flex items-center text-ink-tertiary">
            <SearchIcon size={16} />
          </span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('conv.search')}
            aria-label={t('conv.search')}
            className="h-9 w-full rounded-sm border border-line bg-surface-2 ps-9 pe-3 text-body-sm text-ink placeholder:text-ink-tertiary focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
          />
        </div>
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto pb-2" role="listbox" aria-label={t('conv.title')}>
        {order.length === 0 && (conn === 'connecting' || conn === 'reconnecting') ? (
          <ConvListSkeleton loading />
        ) : filtered.length === 0 ? (
          <EmptyConv search={query.trim().length > 0} />
        ) : (
          filtered.map((convId) => <ConvRow key={convId} convId={convId} />)
        )}
      </div>
    </section>
  );
}

const ConvRow = memo(function ConvRow({ convId }: { convId: number }) {
  const conv = useConvStore((state) => state.convs[convId]);
  const active = useConvStore((state) => state.activeConvId === convId);
  const draft = useConvStore((state) => state.drafts[convId]);
  const selfId = useConvStore((state) => state.selfUserId);
  const otherId =
    conv && conv.convType === 0 ? (conv.members.find((member) => member.userId !== selfId)?.userId ?? 0) : 0;
  const presence = usePresenceStore((state) => (otherId ? state.byUserId[otherId]?.status : undefined));

  if (!conv) return null;

  const preview = previewOf(conv, draft, selfId);
  const unread = conv.unread;
  const time = formatConvTime(conv.lastMessageAt ?? conv.updatedAt);
  const avatarName = conv.title || t('conv.untitled');

  return (
    <div
      role="option"
      aria-selected={active}
      tabIndex={0}
      onClick={() => {
        useConvStore.getState().setActive(convId);
        navigate(`/chat/${convId}`);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          useConvStore.getState().setActive(convId);
          navigate(`/chat/${convId}`);
        }
      }}
      aria-label={`${avatarName}${unread > 0 ? `，${t('conv.unread', { count: unread })}` : ''}`}
      className={[
        'group relative flex h-row-conv-mobile cursor-pointer items-center gap-3 px-4 transition-colors duration-micro tablet:h-row-conv',
        active ? 'bg-primary-50' : 'hover:bg-surface-2',
      ].join(' ')}
    >
      <Avatar name={avatarName} src={conv.avatar} size="md" presence={presence} userId={otherId || conv.convId} />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="min-w-0 truncate text-body font-medium text-ink">{avatarName}</span>
          {conv.pinned ? <PinIcon size={12} className="shrink-0 text-ink-tertiary" /> : null}
          {conv.muted ? <MuteIcon size={12} className="shrink-0 text-ink-tertiary" /> : null}
        </div>
        <p
          className={`mt-0.5 truncate text-body-sm ${draft ? 'text-danger-500' : 'text-ink-tertiary'}`}
        >
          {preview}
        </p>
      </div>

      <div className="flex h-full shrink-0 flex-col items-end justify-center gap-1 pt-1">
        <span className="nums text-caption text-ink-tertiary">{time}</span>
        {unread > 0 ? (
          <span
            className={[
              'nums inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-caption font-medium text-ink-inverse',
              conv.muted ? 'bg-ink-tertiary' : 'bg-danger-500',
            ].join(' ')}
          >
            {unread > 99 ? '99+' : unread}
          </span>
        ) : (
          <span className="h-4" aria-hidden="true" />
        )}
      </div>

      <div className="absolute end-2 top-1 hidden items-center gap-1 rounded-md bg-elevated p-0.5 shadow-sm group-hover:flex">
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            useConvStore.getState().togglePin(convId);
          }}
          title={conv.pinned ? t('conv.unpin') : t('conv.pin')}
          aria-label={conv.pinned ? t('conv.unpin') : t('conv.pin')}
          className="inline-flex h-7 w-7 items-center justify-center rounded-sm text-ink-secondary hover:bg-surface-2"
        >
          <PinIcon size={16} />
        </button>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            useConvStore.getState().toggleMute(convId);
          }}
          title={conv.muted ? t('conv.unmute') : t('conv.mute')}
          aria-label={conv.muted ? t('conv.unmute') : t('conv.mute')}
          className="inline-flex h-7 w-7 items-center justify-center rounded-sm text-ink-secondary hover:bg-surface-2"
        >
          <MuteIcon size={16} />
        </button>
      </div>
    </div>
  );
});

function previewOf(conv: ConvRecord, draft: string | undefined, selfId: number): string {
  if (draft) return t('conv.draft', { text: draft });
  const type = conv.lastMessageType;
  if (type && type !== 'text' && type !== 'system' && PREVIEW_KEYS[type]) {
    return t(PREVIEW_KEYS[type]);
  }
  const text = conv.lastPreview ?? '';
  if (!text) return '';
  return conv.lastSenderId && conv.lastSenderId === selfId ? t('conv.you', { text }) : text;
}

function EmptyConv({ search }: { search: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
      <div className="mb-4 flex h-32 w-32 items-center justify-center rounded-full bg-surface-2 text-ink-tertiary">
        <SearchIcon size={48} />
      </div>
      <p className="text-title text-ink">{t(search ? 'conv.searchEmpty.title' : 'conv.empty.title')}</p>
      <p className="mt-1 text-body-sm text-ink-tertiary">
        {t(search ? 'conv.searchEmpty.desc' : 'conv.empty.desc')}
      </p>
      {!search ? (
        <button
          type="button"
          onClick={() => toast.info(t('common.comingSoon'))}
          className="mt-4 rounded-md bg-primary-500 px-4 py-2 text-body text-ink-inverse hover:bg-primary-600"
        >
          {t('conv.empty.action')}
        </button>
      ) : null}
    </div>
  );
}
