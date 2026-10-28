import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { auditTypes, fetchAudit, verifyChain, type AuditEvent } from '../../api/audit';
import { copyText, errorMessage, useDebouncedValue } from '../../lib/hooks';
import { cn, formatClock, formatDateTime, formatNumber } from '../../lib/format';
import { PageHeader } from '../components/PageHeader';
import { StatusTag, type Tone } from '../components/StatusTag';
import { Highlight } from '../components/Highlight';
import { JsonTree } from '../components/JsonTree';
import { IconCopy, IconPause, IconPlay, IconRefresh, IconScroll } from '../components/icons';

const PAGE_SIZE = 200;
const ROW_HEIGHT = 32;
const FOLLOW_INTERVAL = 2000;

const TYPE_GROUPS: Array<{ label: string; prefixes: string[] }> = [
  { label: '全部事件', prefixes: [] },
  { label: '用户与封禁', prefixes: ['user.'] },
  { label: '举报处置', prefixes: ['report.'] },
  { label: 'Feature flag', prefixes: ['flag.'] },
  { label: '广播', prefixes: ['broadcast.'] },
  { label: '归档/备份', prefixes: ['archive.', 'backup.', 'job.'] },
  { label: '登录与权限', prefixes: ['auth.', 'admin.'] },
];

function toneForType(type: string): Tone {
  if (/(ban|delete|revoke|broken|failed|denied)/.test(type)) return 'danger';
  if (/^(flag|broadcast|archive|backup|job|report)\./.test(type)) return 'warning';
  if (/^(auth\.login|user\.unban|user\.kick|auth\.logout)/.test(type)) return 'info';
  if (/^audit\./.test(type)) return 'primary';
  return 'muted';
}

/** 展开行高度：按 JSON 字符数估算行数，夹在 120–360px 之间（与渲染时的实际高度一致） */
function expandedPanelHeight(event: AuditEvent): number {
  const lines = Math.min(16, Math.ceil(JSON.stringify(event.payload ?? {}).length / 88) + 2);
  return Math.min(360, Math.max(120, lines * 20 + 44));
}

function estimateHeight(event: AuditEvent): number {
  return ROW_HEIGHT + expandedPanelHeight(event);
}

export function Audit() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [firstId, setFirstId] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [hasOlder, setHasOlder] = useState(false);
  const [hasNewer, setHasNewer] = useState(false);

  const [following, setFollowing] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingNew, setPendingNew] = useState(0);

  const [grep, setGrep] = useState('');
  const debouncedGrep = useDebouncedValue(grep, 300);
  const [typeGroup, setTypeGroup] = useState(0);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [types, setTypes] = useState<string[]>([]);
  const [filterVersion, setFilterVersion] = useState(0);

  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(560);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [chain, setChain] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<{ height: number; top: number } | null>(null);
  const stickToBottom = useRef(true);

  const typesForGroup = TYPE_GROUPS[typeGroup]?.prefixes ?? [];

  /* ---------------- 初始加载 / 筛选变更 ---------------- */
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setExpanded(new Set());
    fetchAudit(
      {
        limit: PAGE_SIZE,
        q: debouncedGrep.trim() || undefined,
        types: typesForGroup.length > 0 ? typesForGroup : undefined,
        from: from ? new Date(from).toISOString() : undefined,
        to: to ? new Date(`${to}T23:59:59`).toISOString() : undefined,
      },
      controller.signal,
    )
      .then((page) => {
        setEvents(page.events);
        setFirstId(page.first_id);
        setCursor(page.next_since_id);
        setHasOlder(page.has_more);
        setHasNewer(false);
        setPendingNew(0);
        stickToBottom.current = true;
        requestAnimationFrame(() => {
          const el = scrollRef.current;
          if (el) el.scrollTop = el.scrollHeight;
        });
      })
      .catch((err) => {
        if ((err as Error).name === 'AbortError') return;
        setError(errorMessage(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [debouncedGrep, typeGroup, from, to, filterVersion]);

  /* ---------------- 跟随新条目 ---------------- */
  const pullNewer = useCallback(async () => {
    if (!cursor) return;
    try {
      const page = await fetchAudit({
        since_id: cursor,
        limit: PAGE_SIZE,
        q: debouncedGrep.trim() || undefined,
        types: typesForGroup.length > 0 ? typesForGroup : undefined,
        from: from ? new Date(from).toISOString() : undefined,
        to: to ? new Date(`${to}T23:59:59`).toISOString() : undefined,
      });
      if (page.events.length === 0) {
        setHasNewer(false);
        return;
      }
      setEvents((prev) => {
        const seen = new Set(prev.map((e) => e.id));
        const additions = page.events.filter((e) => !seen.has(e.id));
        return additions.length > 0 ? [...prev, ...additions] : prev;
      });
      setCursor(page.next_since_id);
      if (following) {
        stickToBottom.current = true;
        setPendingNew(0);
      } else {
        setPendingNew((n) => n + page.events.length);
      }
      setHasNewer(page.has_more);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [cursor, debouncedGrep, typeGroup, from, to, following]);

  useEffect(() => {
    if (!following) return undefined;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void pullNewer();
    }, FOLLOW_INTERVAL);
    return () => window.clearInterval(timer);
  }, [following, pullNewer]);

  /* ---------------- 向上加载更早 ---------------- */
  const loadOlder = useCallback(async () => {
    if (loadingOlder || !hasOlder || firstId <= 0) return;
    setLoadingOlder(true);
    const el = scrollRef.current;
    anchorRef.current = el ? { height: el.scrollHeight, top: el.scrollTop } : null;
    try {
      const page = await fetchAudit({
        before_id: firstId,
        limit: PAGE_SIZE,
        q: debouncedGrep.trim() || undefined,
        types: typesForGroup.length > 0 ? typesForGroup : undefined,
        from: from ? new Date(from).toISOString() : undefined,
        to: to ? new Date(`${to}T23:59:59`).toISOString() : undefined,
      });
      if (page.events.length > 0) {
        setEvents((prev) => {
          const seen = new Set(prev.map((e) => e.id));
          return [...page.events.filter((e) => !seen.has(e.id)), ...prev];
        });
        setFirstId(page.first_id);
      }
      setHasOlder(page.has_more);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoadingOlder(false);
    }
  }, [loadingOlder, hasOlder, firstId, debouncedGrep, typeGroup, from, to]);

  /* 向上追加后锚定视口：scrollTop += (新 scrollHeight - 旧 scrollHeight) */
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const el = scrollRef.current;
    if (!anchor || !el) return;
    el.scrollTop = anchor.top + (el.scrollHeight - anchor.height);
    anchorRef.current = null;
  }, [events]);

  /* 贴底时自动滚到最新 */
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickToBottom.current || !following) return;
    el.scrollTop = el.scrollHeight;
  }, [events, following]);

  /* ---------------- 虚拟滚动 ---------------- */
  const layout = useMemo(() => {
    const heights = events.map((e) => (expanded.has(e.id) ? estimateHeight(e) : ROW_HEIGHT));
    const offsets: number[] = new Array(events.length);
    let total = 0;
    for (let i = 0; i < events.length; i += 1) {
      offsets[i] = total;
      total += heights[i]!;
    }
    return { heights, offsets, total };
  }, [events, expanded]);

  const { start, end } = useMemo(() => {
    const overscan = 8;
    const top = scrollTop - 240;
    const bottom = scrollTop + viewport + 240;
    let s = 0;
    while (s < events.length && (layout.offsets[s] ?? 0) + (layout.heights[s] ?? 0) < top) s += 1;
    let e = s;
    while (e < events.length && (layout.offsets[e] ?? 0) < bottom) e += 1;
    return { start: Math.max(0, s - overscan), end: Math.min(events.length, e + overscan) };
  }, [scrollTop, viewport, events.length, layout]);

  const visible = events.slice(start, end);

  /* ---------------- 交互 ---------------- */
  const onScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget;
    setScrollTop(el.scrollTop);
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    stickToBottom.current = atBottom;
    if (atBottom && !following) setPendingNew(0);
    if (el.scrollTop < 120 && hasOlder) void loadOlder();
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(() => setViewport(el.clientHeight));
    ro.observe(el);
    setViewport(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    auditTypes()
      .then((list) => setTypes(list))
      .catch(() => setTypes([]));
  }, []);

  const toggle = (id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="审计日志"
        description="journalctl 式顺序流：since_id 游标只进不退，向上加载更早、暂停后继续跟随。写入为 append-only 哈希链。"
        meta={
          <>
            <span>
              已加载 <span className="nums font-semibold text-text-secondary">{formatNumber(events.length)}</span> 条
            </span>
            <span>
              游标 <span className="nums">#{cursor || '—'}</span>
            </span>
            {following ? (
              <span className="flex items-center gap-1.5 text-success-600">
                <span className="h-2 w-2 animate-pulse rounded-full bg-success-500" /> 跟随中（2s）
              </span>
            ) : (
              <span className="text-warning-700">已暂停{pendingNew > 0 ? ` · 新增 ${pendingNew}` : ''}</span>
            )}
            {chain && <span className="text-danger-600">{chain}</span>}
          </>
        }
        actions={
          <>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={verifying}
              onClick={async () => {
                setVerifying(true);
                try {
                  const res = await verifyChain();
                  setChain(res.ok ? null : `审计链断裂 @#${res.broken_at ?? '?'}`);
                } catch (err) {
                  setChain(errorMessage(err));
                } finally {
                  setVerifying(false);
                }
              }}
            >
              <IconRefresh size={14} /> {verifying ? '校验中…' : '校验哈希链'}
            </button>
            <button
              type="button"
              className={cn('btn btn-sm', following ? 'btn-secondary' : 'btn-primary')}
              onClick={() => {
                if (following) {
                  setFollowing(false);
                } else {
                  setFollowing(true);
                  stickToBottom.current = true;
                  void pullNewer();
                }
              }}
            >
              {following ? <IconPause size={14} /> : <IconPlay size={14} />}
              {following ? '暂停跟随' : '继续跟随'}
            </button>
          </>
        }
      />

      {/* 过滤条：时间段 + 事件类型 + grep */}
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <div>
          <label className="label" htmlFor="audit-from">
            起始时间
          </label>
          <input id="audit-from" type="datetime-local" className="input w-[200px]" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="audit-to">
            结束时间
          </label>
          <input id="audit-to" type="datetime-local" className="input w-[200px]" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="audit-type">
            事件类型
          </label>
          <select id="audit-type" className="select w-[180px]" value={typeGroup} onChange={(e) => setTypeGroup(Number(e.target.value))}>
            {TYPE_GROUPS.map((group, index) => (
              <option key={group.label} value={index}>
                {group.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="audit-grep">
            grep（空格分隔多关键词）
          </label>
          <div className="relative">
            <input
              id="audit-grep"
              className="input w-[280px] pr-8"
              value={grep}
              onChange={(e) => setGrep(e.target.value)}
              placeholder="如 user.ban 12345"
            />
            {grep && (
              <button
                type="button"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-primary"
                onClick={() => setGrep('')}
                aria-label="清空 grep"
              >
                ×
              </button>
            )}
          </div>
        </div>
        <button
          type="button"
          className="btn btn-ghost btn-sm mb-0.5"
          onClick={() => {
            setGrep('');
            setFrom('');
            setTo('');
            setTypeGroup(0);
            setFilterVersion((v) => v + 1);
          }}
        >
          重置
        </button>
        {types.length > 0 && (
          <span className="mb-1.5 text-caption text-text-tertiary">
            共 {types.length} 种事件类型
          </span>
        )}
      </div>

      {error && (
        <div className="mb-2 rounded-sm bg-danger-50 px-3 py-2 text-body-sm text-danger-700">{error}</div>
      )}

      {/* 顺序流容器 */}
      <div className="card flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex h-9 shrink-0 items-center gap-3 border-b border-border-default bg-bg-surface-2 px-3 text-caption text-text-tertiary">
          <span className="w-[92px] shrink-0">时间</span>
          <span className="w-[150px] shrink-0">事件类型</span>
          <span className="w-[120px] shrink-0">操作者</span>
          <span className="min-w-0 flex-1">摘要</span>
          <span className="w-10" />
        </div>

        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="min-h-0 flex-1 overflow-y-auto"
          style={{ contain: 'strict' }}
          role="log"
          aria-live={following ? 'polite' : 'off'}
        >
          {hasOlder && (
            <div className="flex h-8 items-center justify-center border-b border-border-default text-caption text-text-tertiary">
              {loadingOlder ? '加载更早的日志…' : '向上滚动加载更早的日志'}
            </div>
          )}

          {loading && events.length === 0 && (
            <div className="space-y-1 p-3">
              {Array.from({ length: 10 }, (_, i) => (
                <div key={i} className="skeleton h-6 w-full" />
              ))}
            </div>
          )}

          {!loading && events.length === 0 && (
            <div className="flex flex-col items-center gap-2 py-16 text-center">
              <IconScroll size={26} className="text-text-tertiary" />
              <p className="text-table text-text-secondary">没有匹配的事件</p>
              <p className="text-body-sm text-text-tertiary">放宽时间范围或清空 grep 关键词</p>
            </div>
          )}

          <div style={{ height: layout.total, position: 'relative' }}>
            {visible.map((event, index) => {
              const absoluteIndex = start + index;
              const top = layout.offsets[absoluteIndex] ?? 0;
              const height = layout.heights[absoluteIndex] ?? ROW_HEIGHT;
              return (
                <AuditRow
                  key={event.id}
                  event={event}
                  top={top}
                  height={height}
                  query={debouncedGrep}
                  expanded={expanded.has(event.id)}
                  onToggle={() => toggle(event.id)}
                  onCopy={async () => {
                    const ok = await copyText(event.ts);
                    if (!ok) return;
                    setCopiedId(event.id);
                    window.setTimeout(() => setCopiedId((current) => (current === event.id ? null : current)), 1600);
                  }}
                  copied={copiedId === event.id}
                />
              );
            })}
          </div>
        </div>

        <div className="flex h-8 shrink-0 items-center justify-between border-t border-border-default bg-bg-surface-2 px-3 text-caption text-text-tertiary">
          <span>
            显示 {start + 1}–{Math.min(end, events.length)} / {formatNumber(events.length)} 行（虚拟滚动）
          </span>
          <div className="flex items-center gap-3">
            {hasNewer && !following && (
              <button
                type="button"
                className="text-primary-600 underline"
                onClick={() => {
                  setFollowing(true);
                  stickToBottom.current = true;
                  void pullNewer();
                }}
              >
                跳到底部 · {pendingNew} 条新日志
              </button>
            )}
            <span>{following ? '实时跟随中' : '暂停中（不会丢失，继续时补齐）'}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 单行：固定表头列宽，展开时在行内渲染 JSON 树 */
function AuditRow({
  event,
  top,
  height,
  query,
  expanded,
  onToggle,
  onCopy,
  copied,
}: {
  event: AuditEvent;
  top: number;
  height: number;
  query: string;
  expanded: boolean;
  onToggle: () => void;
  onCopy: () => void;
  copied: boolean;
}) {
  const tone = toneForType(event.type);
  return (
    <div
      className={cn(
        'absolute left-0 right-0 overflow-hidden border-b border-border-default',
        tone === 'danger' ? 'bg-danger-50 hover:bg-danger-100' : 'hover:bg-bg-surface-2',
      )}
      style={{ top, height }}
    >
      <div className="flex h-8 items-center gap-3 px-3">
        <button
          type="button"
          className="nums w-[92px] shrink-0 text-left text-caption text-text-tertiary hover:text-primary-600"
          onClick={onCopy}
          title={`复制 ${event.ts}`}
        >
          {formatClock(event.ts)}
          {copied && <span className="ml-1 text-success-600">已复制</span>}
        </button>
        <span className="w-[150px] shrink-0">
          <StatusTag tone={tone} dot={false}>
            <span className="nums">{event.type}</span>
          </StatusTag>
        </span>
        <span className="w-[120px] shrink-0 truncate text-body-sm text-text-secondary" title={event.actor?.username}>
          {event.actor?.username ?? '—'}
        </span>
        <span className="min-w-0 flex-1 truncate text-body-sm text-text-primary">
          <Highlight text={event.summary} query={query} />
        </span>
        <button
          type="button"
          className="w-10 shrink-0 text-center text-caption text-text-tertiary hover:text-primary-600"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={expanded ? '收起载荷' : '展开载荷'}
        >
          {expanded ? '收起' : 'JSON'}
        </button>
      </div>

      {expanded && (
        <div
          className="overflow-auto border-t border-border-default bg-bg-surface px-3 py-2"
          style={{ height: height - ROW_HEIGHT }}
        >
          <div className="mb-2 flex flex-wrap items-center gap-3 text-caption text-text-tertiary">
            <span className="nums">{formatDateTime(event.ts)}</span>
            <span>id <span className="nums">#{event.id}</span></span>
            {event.request_id && (
              <span className="flex items-center gap-1">
                trace <span className="nums">{event.request_id}</span>
                <button
                  type="button"
                  className="hover:text-text-primary"
                  aria-label="复制 trace id"
                  onClick={async () => {
                    await copyText(event.request_id ?? '');
                  }}
                >
                  <IconCopy size={12} />
                </button>
              </span>
            )}
            {event.ip && <span className="nums">{event.ip}</span>}
            {event.prev_hash && <span className="truncate">prev {event.prev_hash.slice(0, 16)}…</span>}
          </div>
          <JsonTree data={event.payload} />
        </div>
      )}
    </div>
  );
}
