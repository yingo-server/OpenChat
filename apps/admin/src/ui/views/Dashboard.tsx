import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchMetricsText, firstMetric, parseMetrics, sumMetric, type MetricFamily } from '../../api/metrics';
import { archiveStatus, type ArchiveStatus } from '../../api/archive';
import { fetchAudit, type AuditEvent } from '../../api/audit';
import { errorMessage } from '../../lib/hooks';
import { cn, formatBytes, formatNumber, formatRelative, formatDateTime, formatClock } from '../../lib/format';
import { formatThousands, formatRate, trendOf, TREND_ARROW } from '../../lib/numbers';
import { useCountUp, useValueChanged, enterStagger, flashCard, prefersReducedMotion } from '../../lib/motion';
import { POLL_MS, SampleBuffer, usePolling } from '../../lib/polling';
import { playSound } from '../../lib/sound';
import { PageHeader } from '../components/PageHeader';
import { Sparkline } from '../components/Sparkline';
import { IconAlert, IconRefresh } from '../components/icons';

/* ------------------------------------------------------------------ */
/* 指标卡                                                              */
/* ------------------------------------------------------------------ */

type Tone = 'default' | 'success' | 'warning' | 'danger';

function StatCard({
  label,
  value,
  raw,
  unit,
  hint,
  tone = 'default',
  index,
  footer,
  missing,
}: {
  label: string;
  value: string;
  /** 数值型卡片传 raw 触发滚动动画 + 变化闪边 */
  raw?: number | null;
  unit?: string;
  hint?: string;
  tone?: Tone;
  index: number;
  footer?: React.ReactNode;
  /** 数据源未接入（诚实标注） */
  missing?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const animated = useCountUp(raw ?? null);
  const changed = useValueChanged(raw ?? null);

  useEffect(() => {
    if (ref.current) enterStagger(ref.current, index);
  }, [index]);
  useEffect(() => {
    if (changed && ref.current) flashCard(ref.current);
  }, [changed]);

  const shown = raw !== undefined && raw !== null && animated !== null ? formatThousands(animated) : value;
  const toneClass =
    tone === 'success'
      ? 'text-success-600'
      : tone === 'warning'
        ? 'text-warning-700'
        : tone === 'danger'
          ? 'text-danger-600'
          : 'text-text-primary';

  return (
    <div ref={ref} className="card card-pad" data-testid="stat-card">
      <div className="flex items-center justify-between">
        <span className="text-body-sm text-text-tertiary">{label}</span>
        {tone !== 'default' && (
          <span
            className={cn(
              'tag',
              tone === 'success' && 'bg-success-50 text-success-700',
              tone === 'warning' && 'bg-warning-50 text-warning-700',
              tone === 'danger' && 'bg-danger-50 text-danger-700',
            )}
          >
            {tone === 'success' ? '正常' : tone === 'warning' ? '关注' : '告警'}
          </span>
        )}
      </div>
      <div className="mt-1 flex items-baseline gap-1">
        <span className={cn('nums text-display font-bold', toneClass)}>{shown}</span>
        {unit && <span className="nums text-body-sm text-text-tertiary">{unit}</span>}
      </div>
      {missing && (
        <div className="mt-1 text-caption text-warning-700" title={missing}>
          数据源未接入：缺 {missing}
        </div>
      )}
      {hint && !missing && <div className="mt-1 truncate text-caption text-text-tertiary" title={hint}>{hint}</div>}
      {footer}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 实时事件流（右栏）                                                   */
/* ------------------------------------------------------------------ */

function EventFeed({ events }: { events: AuditEvent[] }) {
  const seen = useRef<Set<number>>(new Set());
  const listRef = useRef<HTMLUListElement>(null);
  const freshIds = useRef<Set<number>>(new Set());

  useEffect(() => {
    const fresh = events.filter((e) => !seen.current.has(e.id) && seen.current.size > 0);
    fresh.forEach((e) => freshIds.current.add(e.id));
    events.forEach((e) => seen.current.add(e.id));
    if (fresh.length > 0 && listRef.current) {
      // 对新插入的行做滑入动画
      const rows = listRef.current.querySelectorAll('li');
      rows.forEach((row) => {
        const id = Number((row as HTMLElement).dataset.id);
        if (freshIds.current.has(id)) {
          row.animate?.(
            [
              { opacity: '0', transform: 'translateY(-8px)', backgroundColor: 'rgb(var(--oc-primary-100))' },
              { opacity: '1', transform: 'translateY(0)', backgroundColor: 'rgb(var(--oc-primary-100) / 0)' },
            ],
            { duration: prefersReducedMotion() ? 0 : 500, easing: 'ease-out' },
          );
          freshIds.current.delete(id);
        }
      });
      playSound('alert');
    }
  }, [events]);

  return (
    <div className="card card-pad flex h-full min-h-[320px] flex-col">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-table font-semibold text-text-primary">实时事件流</span>
        <span className="text-caption text-text-tertiary">audit · 每 {POLL_MS / 1000}s</span>
      </div>
      <ul ref={listRef} className="min-h-0 flex-1 space-y-1 overflow-y-auto">
        {events.length === 0 && <li className="py-6 text-center text-caption text-text-tertiary">暂无事件</li>}
        {events.map((e) => (
          <li key={e.id} data-id={e.id} className="rounded-sm px-2 py-1.5 text-caption">
            <div className="flex items-center gap-2">
              <span className="nums text-text-tertiary">{formatClock(e.ts)}</span>
              <span className="code">{e.type}</span>
            </div>
            <div className="truncate text-text-secondary" title={e.summary}>
              {e.summary}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 健康矩阵                                                            */
/* ------------------------------------------------------------------ */

type Health = 'green' | 'yellow' | 'red' | 'na';

const HEALTH_DOT: Record<Health, string> = {
  green: 'bg-success-500',
  yellow: 'bg-warning-500',
  red: 'bg-danger-500',
  na: 'bg-bg-surface-2 border border-border-default',
};

const HEALTH_TEXT: Record<Health, string> = {
  green: 'text-success-700',
  yellow: 'text-warning-700',
  red: 'text-danger-700',
  na: 'text-text-tertiary',
};

function HealthMatrix({ items }: { items: Array<{ name: string; status: Health; note: string }> }) {
  return (
    <div className="card card-pad">
      <div className="mb-2 text-table font-semibold text-text-primary">健康矩阵</div>
      <ul className="space-y-1.5">
        {items.map((it) => (
          <li key={it.name} className="flex items-center gap-2 text-body-sm" data-testid="health-item">
            <span className={cn('h-2.5 w-2.5 shrink-0 rounded-full', HEALTH_DOT[it.status])} aria-hidden />
            <span className="text-text-primary">{it.name}</span>
            <span className={cn('ml-auto truncate text-caption', HEALTH_TEXT[it.status])} title={it.note}>
              {it.note}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Dashboard 主体                                                      */
/* ------------------------------------------------------------------ */

interface Snap {
  families: MetricFamily[];
  archive: ArchiveStatus | null;
  archiveError: string | null;
}

export function Dashboard() {
  const [snap, setSnap] = useState<Snap>({ families: [], archive: null, archiveError: null });
  const [auto, setAuto] = useState(true);
  const [pendingReports, setPendingReports] = useState<number | null>(null);

  const connBuf = useRef(new SampleBuffer(60));
  const bridgeBuf = useRef(new SampleBuffer(60));
  const [samplesVersion, setSamplesVersion] = useState(0);

  const tick = useCallback(async (signal: AbortSignal) => {
    const [metricsText, archive] = await Promise.allSettled([
      fetchMetricsText(signal),
      archiveStatus(signal),
    ]);
    const families = metricsText.status === 'fulfilled' ? parseSafe(metricsText.value) : [];
    setSnap({
      families,
      archive: archive.status === 'fulfilled' ? archive.value : null,
      archiveError: archive.status === 'rejected' ? errorMessage(archive.reason) : null,
    });

    const conn = firstMetric(families, [
      'openchat_ws_connections_active',
      'ws_connections_active',
      'gateway_connections_active',
      'openchat_connections_active',
    ]);
    if (conn) {
      connBuf.current.push(Date.now(), conn.value);
      setSamplesVersion((v) => v + 1);
    }
    const bridge = sumMetric(families, 'openchat_admin_bridge_requests_total');
    if (bridge !== null) {
      bridgeBuf.current.push(Date.now(), bridge);
      setSamplesVersion((v) => v + 1);
    }

    // 举报待处理：status=pending 第一页的 total
    try {
      const res = await fetch('/api/admin/v1/reports?status=pending&per_page=1', { signal });
      if (res.ok) {
        const body = (await res.json()) as { total?: number };
        const total = typeof body.total === 'number' ? body.total : null;
        if (total !== null && total !== pendingReports) {
          if (pendingReports !== null && total > pendingReports) playSound('alert');
          setPendingReports(total);
        }
      }
    } catch {
      /* 忽略，卡片显示 — */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { state, refreshNow } = usePolling(tick, auto);

  /* 审计事件流：独立 5s 拉新 */
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const sinceRef = useRef(0);
  useEffect(() => {
    let stopped = false;
    const load = async () => {
      if (document.hidden) return;
      try {
        const query = sinceRef.current > 0 ? { since_id: sinceRef.current, limit: 50 } : { limit: 20 };
        const page = await fetchAudit(query);
        if (stopped) return;
        sinceRef.current = Math.max(sinceRef.current, page.next_since_id);
        if (page.events.length > 0) {
          setEvents((prev) => {
            const ids = new Set(prev.map((e) => e.id));
            return [...page.events.filter((e) => !ids.has(e.id)).reverse(), ...prev].slice(0, 80);
          });
        }
      } catch {
        /* 静默：右栏是非关键路径 */
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    const onVis = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  const f = snap.families;
  const connections = firstMetric(f, [
    'openchat_ws_connections_active',
    'ws_connections_active',
    'gateway_connections_active',
    'openchat_connections_active',
  ]);
  const totalUsers = sumMetric(f, 'openchat_users_total');
  const newUsersToday = sumMetric(f, 'openchat_users_created_today_total');
  const messagesToday = sumMetric(f, 'openchat_messages_today_total');
  const auditFail = firstMetric(f, ['openchat_admin_audit_append_failures_total']);
  const goroutines = firstMetric(f, ['go_goroutines'], 'max');
  const rss = firstMetric(f, ['process_resident_memory_bytes'], 'max');
  const uptime = firstMetric(f, ['openchat_admin_uptime_seconds'], 'max');
  const bridgeFail = sumMetric(f, 'openchat_admin_bridge_failures_total');
  const loginFail = sumMetric(f, 'openchat_admin_login_failures_total');
  const circuitOpen = firstMetric(f, ['openchat_admin_bridge_circuit_open'], 'max');
  const buildInfo = f.find((x) => x.name === 'openchat_admin_build_info');

  const connTrend = trendOf(connections?.value ?? null, connBuf.current.points.length >= 2 ? connBuf.current.points[connBuf.current.points.length - 2]!.value : null);
  const bridgeRate = bridgeBuf.current.ratePerSecond();

  const health: Array<{ name: string; status: Health; note: string }> = [
    {
      name: '归档作业',
      status: !snap.archive ? 'na' : snap.archive.running ? 'green' : snap.archive.last_run?.status === 'failed' || snap.archive.last_run?.status === 'partial' ? 'red' : snap.archive.lag_days > 1 ? 'yellow' : 'green',
      note: !snap.archive
        ? snap.archiveError
          ? `拉取失败：${snap.archiveError}`
          : 'GET /archive/status 无数据'
        : snap.archive.running
          ? '运行中'
          : snap.archive.last_run
            ? `上次 ${formatRelative(snap.archive.last_run.started_at)} · 滞后 ${snap.archive.lag_days} 天`
            : '从未运行',
    },
    {
      name: '冷库可达性',
      status: !snap.archive ? 'na' : snap.archive.cold_db.reachable ? (snap.archive.cold_db.latency_ms > 500 ? 'yellow' : 'green') : 'red',
      note: !snap.archive
        ? '数据源未接入'
        : snap.archive.cold_db.reachable
          ? `${snap.archive.cold_db.latency_ms} ms`
          : (snap.archive.cold_db.error ?? '不可达'),
    },
    {
      name: '审计追加链',
      status: auditFail === null ? 'na' : auditFail.value > 0 ? 'red' : 'green',
      note: auditFail === null ? '数据源未接入：缺 openchat_admin_audit_append_failures_total' : `追加失败 ${formatNumber(auditFail.value)} 次`,
    },
    {
      name: 'Bridge 熔断器',
      status: circuitOpen === null ? 'na' : circuitOpen.value > 0 ? 'red' : bridgeFail !== null && bridgeFail > 0 ? 'yellow' : 'green',
      note: circuitOpen === null ? '数据源未接入：缺 openchat_admin_bridge_circuit_open' : circuitOpen.value > 0 ? '熔断打开' : `失败 ${formatNumber(bridgeFail ?? 0)} 次`,
    },
    {
      name: 'DB integrity（doctor）',
      status: 'na',
      note: '数据源未接入：需后端暴露 openchat_db_integrity_ok 指标',
    },
  ];

  void samplesVersion; // 触发 sparkline 重渲染

  return (
    <>
      <PageHeader
        title="仪表盘"
        description="全局统计 + 实时刷新。轮询 5s（metrics + archive/status），页面隐藏自动暂停。"
        meta={
          <>
            <span>
              更新于 <span className="nums">{state.lastAt ? formatClock(state.lastAt) : '—'}</span>
            </span>
            {state.inFlight && <span className="text-text-tertiary">拉取中…</span>}
            {!state.visible && <span className="text-warning-700">页面隐藏，轮询已暂停</span>}
            {state.error && <span className="text-danger-600">{state.error}</span>}
            {buildInfo && <span className="text-text-tertiary">build {buildInfo.samples[0]?.labels.version ?? '?'}</span>}
            {uptime !== null && <span className="text-text-tertiary">运行 {formatDurationShort(uptime.value)}</span>}
          </>
        }
        actions={
          <>
            <label className="flex items-center gap-2 text-body-sm text-text-secondary">
              <input type="checkbox" className="h-4 w-4 accent-primary-500" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
              自动刷新
            </label>
            <button type="button" className="btn btn-secondary btn-sm" onClick={refreshNow}>
              <IconRefresh size={14} /> 立即刷新
            </button>
          </>
        }
      />

      {(auditFail?.value ?? 0) > 0 && (
        <div className="mb-4 flex items-start gap-2 rounded-md border border-danger-300 bg-danger-50 px-3 py-2 text-body-sm text-danger-700">
          <IconAlert size={16} className="mt-0.5 shrink-0" />
          <div>
            <strong className="font-semibold">审计追加失败（P0）</strong>
            <p>openchat_admin_audit_append_failures_total = {formatNumber(auditFail!.value)}。主操作已成功但审计未落库，需立即排查。</p>
          </div>
        </div>
      )}
      {circuitOpen && circuitOpen.value > 0 && (
        <div className="mb-4 flex items-start gap-2 rounded-md border border-danger-300 bg-danger-50 px-3 py-2 text-body-sm text-danger-700">
          <IconAlert size={16} className="mt-0.5 shrink-0" />
          <div>
            <strong className="font-semibold">Bridge 熔断打开</strong>
            <p>注入通道已熔断，消息桥接暂不可用（openchat_admin_bridge_circuit_open=1）。</p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          index={0}
          label="在线 WS 连接"
          raw={connections?.value ?? null}
          value={connections ? formatNumber(connections.value) : '—'}
          unit="条"
          tone="default"
          hint={connections ? `${connections.name} · ${TREND_ARROW[connTrend]}` : 'openchat_ws_connections_active'}
          missing={connections ? undefined : 'openchat_ws_connections_active（chatd 未暴露）'}
          footer={
            connBuf.current.points.length >= 2 ? (
              <div className="mt-2">
                <Sparkline points={connBuf.current.points} ariaLabel="在线连接趋势" />
              </div>
            ) : undefined
          }
        />
        <StatCard
          index={1}
          label="总用户数"
          raw={totalUsers}
          value="—"
          hint={totalUsers !== null ? 'openchat_users_total' : undefined}
          missing={totalUsers === null ? 'openchat_users_total（未接入 /users 全量计数）' : undefined}
        />
        <StatCard
          index={2}
          label="今日新增用户"
          raw={newUsersToday}
          value="—"
          hint={newUsersToday !== null ? 'openchat_users_created_today_total' : undefined}
          missing={newUsersToday === null ? 'openchat_users_created_today_total' : undefined}
        />
        <StatCard
          index={3}
          label="今日消息数"
          raw={messagesToday}
          value="—"
          hint={messagesToday !== null ? `openchat_messages_today_total · ${formatRate(bridgeRate ?? undefined)}` : undefined}
          missing={messagesToday === null ? 'openchat_messages_today_total' : undefined}
          footer={
            bridgeBuf.current.points.length >= 2 ? (
              <div className="mt-2">
                <div className="text-caption text-text-tertiary">
                  注入速率 <span className="nums">{formatRate(bridgeRate)}</span>（openchat_admin_bridge_requests_total）
                </div>
                <Sparkline points={bridgeBuf.current.points} stroke="rgb(var(--oc-success-500))" ariaLabel="注入请求趋势" />
              </div>
            ) : undefined
          }
        />
        <StatCard
          index={4}
          label="举报待处理"
          raw={pendingReports}
          value="—"
          tone={pendingReports !== null && pendingReports > 0 ? 'warning' : 'default'}
          hint="GET /reports?status=pending 的 total"
        />
        <StatCard
          index={5}
          label="归档状态 / 上次运行"
          value={
            !snap.archive
              ? '—'
              : snap.archive.running
                ? '运行中'
                : snap.archive.last_run
                  ? snap.archive.last_run.status
                  : '未运行'
          }
          hint={
            snap.archive?.last_run
              ? `${formatDateTime(snap.archive.last_run.started_at)} · 移动 ${formatNumber(snap.archive.last_run.moved_rows)} 行`
              : 'GET /archive/status last_run'
          }
          tone={snap.archive?.last_run && (snap.archive.last_run.status === 'failed' || snap.archive.last_run.status === 'partial') ? 'danger' : 'default'}
        />
        <StatCard
          index={6}
          label="进程内存 / Goroutine"
          value={rss ? formatBytes(rss.value) : '—'}
          hint={goroutines ? `${formatNumber(goroutines.value)} goroutines · go_goroutines` : 'process_resident_memory_bytes'}
          tone={goroutines && goroutines.value > 5000 ? 'warning' : 'default'}
        />
        <StatCard
          index={7}
          label="登录失败累计"
          raw={loginFail}
          value={loginFail !== null ? formatNumber(loginFail) : '—'}
          hint="openchat_admin_login_failures_total"
          tone={loginFail !== null && loginFail > 100 ? 'warning' : 'default'}
        />
      </div>

      <div className="mt-3 grid grid-cols-1 gap-3 xl:grid-cols-3">
        <div className="xl:col-span-2">
          <HealthMatrix items={health} />
        </div>
        <EventFeed events={events} />
      </div>
    </>
  );
}

function formatDurationShort(seconds: number): string {
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟`;
  const h = Math.floor(seconds / 3600);
  if (h < 48) return `${h} 小时`;
  return `${Math.round(h / 24)} 天`;
}

function parseSafe(text: string): MetricFamily[] {
  try {
    return parseMetrics(text);
  } catch {
    return [];
  }
}
