import { useCallback, useEffect, useState } from 'react';
import { archiveHistory, archiveStatus, runArchive, type ArchiveRun, type ArchiveStatus } from '../../api/archive';

/** ArchiveRun 也有 dry_run 布尔字段，`in` 无法判别，用结构判别 dry-run 结果 */
function isDryRun(res: ArchiveRun | DryRunResult): res is DryRunResult {
  return 'summary' in res && 'affected' in res;
}
import type { DryRunResult } from '../../api/types';
import { errorMessage, useTransientFlag } from '../../lib/hooks';
import { cn, formatBytes, formatDateTime, formatNumber, formatRelative } from '../../lib/format';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { DataTable, type Column } from '../components/DataTable';
import { DryRunPreview } from '../components/DryRunPreview';
import { PageHeader } from '../components/PageHeader';
import { StatusTag } from '../components/StatusTag';
import { IconAlert, IconArchive, IconRefresh } from '../components/icons';

export function Archive() {
  const [status, setStatus] = useState<ArchiveStatus | null>(null);
  const [runs, setRuns] = useState<ArchiveRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [flash, fireFlash] = useTransientFlag();

  const [preview, setPreview] = useState<DryRunResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [runOpen, setRunOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    Promise.all([archiveStatus(controller.signal), archiveHistory(20, controller.signal)])
      .then(([st, history]) => {
        setStatus(st);
        setRuns(history);
        setError(null);
      })
      .catch((err) => {
        if ((err as Error).name === 'AbortError') return;
        setError(errorMessage(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [reloadKey]);

  /* 运行中每 5s 刷新一次，结束即停 */
  useEffect(() => {
    if (!status?.running) return undefined;
    const timer = window.setInterval(() => setReloadKey((k) => k + 1), 5000);
    return () => window.clearInterval(timer);
  }, [status?.running]);

  const dryRun = useCallback(async () => {
    setPreviewLoading(true);
    setPreviewError(null);
    setPreview(null);
    try {
      const res = await runArchive({}, { dryRun: true });
      setPreview(isDryRun(res) ? res : null);
      setRunOpen(true);
    } catch (err) {
      setPreviewError(errorMessage(err));
      setRunOpen(true);
    } finally {
      setPreviewLoading(false);
    }
  }, []);

  const running = status?.running ?? false;

  const columns: Column<ArchiveRun>[] = [
    {
      key: 'id',
      header: '运行',
      width: 90,
      render: (r) => <span className="nums text-body-sm text-text-secondary">#{r.id}</span>,
    },
    {
      key: 'status',
      header: '状态',
      width: 110,
      render: (r) => (
        <StatusTag tone={r.status === 'ok' ? 'success' : r.status === 'running' ? 'warning' : 'danger'}>
          {r.status === 'ok' ? '成功' : r.status === 'running' ? '运行中' : r.status === 'partial' ? '部分成功' : '失败'}
        </StatusTag>
      ),
    },
    {
      key: 'moved',
      header: '搬运行数',
      width: 120,
      align: 'right',
      render: (r) => <span className="nums text-table text-text-primary">{formatNumber(r.moved_rows)}</span>,
    },
    {
      key: 'convs',
      header: '涉及会话',
      width: 110,
      align: 'right',
      render: (r) => <span className="nums text-table text-text-secondary">{formatNumber(r.convs_touched)}</span>,
    },
    {
      key: 'started',
      header: '开始时间',
      width: 180,
      render: (r) => <span className="nums text-body-sm text-text-secondary">{formatDateTime(r.started_at)}</span>,
    },
    {
      key: 'duration',
      header: '耗时',
      width: 120,
      render: (r) => {
        if (!r.finished_at) return <span className="text-body-sm text-warning-700">进行中</span>;
        const sec = (new Date(r.finished_at).getTime() - new Date(r.started_at).getTime()) / 1000;
        return <span className="nums text-body-sm text-text-secondary">{sec < 60 ? `${Math.round(sec)}s` : `${Math.round(sec / 60)}m`}</span>;
      },
    },
    {
      key: 'error',
      header: '备注',
      render: (r) => <span className="text-body-sm text-text-tertiary">{r.error ?? '—'}</span>,
    },
  ];

  return (
    <>
      <PageHeader
        title="归档"
        description="热库 SQLite 按 hot_retention_days 搬运至冷库 Postgres。作业幂等、可重跑，运行中禁止再次触发（单飞）。"
        meta={
          <>
            {status && (
              <span>
                下次运行 <span className="nums">{formatDateTime(status.next_run_at)}</span>（{formatRelative(status.next_run_at)}）
              </span>
            )}
            {flash && <span className="text-success-600">已刷新</span>}
          </>
        }
        actions={
          <>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setReloadKey((k) => k + 1)}>
              <IconRefresh size={14} /> 刷新
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void dryRun()} disabled={previewLoading || running}>
              <IconArchive size={14} /> dry-run 预览
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={running || loading}
              onClick={() => {
                setActionError(null);
                setRunOpen(true);
                if (!preview) void dryRun();
              }}
              title={running ? '作业运行中，禁止重复触发（409）' : undefined}
            >
              手动触发归档
            </button>
          </>
        }
      />

      {error && (
        <div className="mb-4 flex items-center gap-2 rounded-md bg-danger-50 px-3 py-2 text-body-sm text-danger-700">
          <IconAlert size={16} /> {error}
        </div>
      )}

      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="作业状态"
          value={running ? '运行中' : status?.last_run ? '空闲' : '未运行'}
          tone={running ? 'warning' : 'success'}
          hint={
            status?.last_run
              ? `上次 ${formatRelative(status.last_run.finished_at ?? status.last_run.started_at)} · 搬运 ${formatNumber(status.last_run.moved_rows)} 行`
              : '尚无归档记录'
          }
        />
        <StatCard
          label="热库行数"
          value={formatNumber(status?.hot_rows ?? null)}
          hint={`占用 ${formatBytes(status?.hot_bytes ?? null)}`}
        />
        <StatCard
          label="最老消息"
          value={status?.oldest_message_at ? formatRelative(status.oldest_message_at) : '—'}
          hint={status?.oldest_message_at ? formatDateTime(status.oldest_message_at) : '热库为空'}
          tone={(status?.lag_days ?? 0) > 7 ? 'danger' : 'default'}
        />
        <StatCard
          label="冷库连通性"
          value={status?.cold_db.reachable ? '正常' : '不可达'}
          tone={status?.cold_db.reachable ? 'success' : 'danger'}
          hint={status?.cold_db.reachable ? `延迟 ${status.cold_db.latency_ms} ms` : status?.cold_db.error ?? '检查 cold_dsn'}
        />
      </div>

      <div className="card mb-4 card-pad">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-table font-semibold text-text-primary">当前策略</h2>
            <p className="text-body-sm text-text-tertiary">
              策略来自 <span className="code">/etc/openchat/policy.json</span>，改完 <span className="code">systemctl reload openchat</span> 热生效。
            </p>
          </div>
          <dl className="flex flex-wrap gap-x-6 gap-y-2 text-body-sm">
            <div className="flex items-center gap-2">
              <dt className="text-text-tertiary">保留天数</dt>
              <dd className="nums font-semibold text-text-primary">{status?.policy.hot_retention_days ?? '—'}</dd>
            </div>
            <div className="flex items-center gap-2">
              <dt className="text-text-tertiary">cron</dt>
              <dd className="code">{status?.policy.cron ?? '—'}</dd>
            </div>
            <div className="flex items-center gap-2">
              <dt className="text-text-tertiary">批大小</dt>
              <dd className="nums font-semibold text-text-primary">{status?.policy.batch_size ?? '—'}</dd>
            </div>
            <div className="flex items-center gap-2">
              <dt className="text-text-tertiary">滞后</dt>
              <dd className={cn('nums font-semibold', (status?.lag_days ?? 0) > 0 ? 'text-warning-700' : 'text-success-600')}>
                {status?.lag_days ?? 0} 天
              </dd>
            </div>
          </dl>
        </div>
        {(status?.lag_days ?? 0) > 0 && (
          <p className="mt-3 flex items-start gap-2 rounded-sm bg-warning-50 px-3 py-2 text-body-sm text-warning-700">
            <IconAlert size={16} className="mt-0.5 shrink-0" />
            热库存在早于截止线的数据（{status?.lag_days} 天）。检查作业是否被频繁 409 打断，或冷库写入延迟。
          </p>
        )}
      </div>

      <h2 className="mb-2 text-body-sm font-semibold uppercase tracking-wide text-text-tertiary">最近运行（archive_runs 账本）</h2>
      <DataTable<ArchiveRun>
        columns={columns}
        rows={runs}
        rowKey={(r) => String(r.id)}
        loading={loading}
        error={null}
        emptyText="还没有归档运行记录"
        footerLeft="dry-run 不计入账本；真实运行的断点可在下轮幂等续跑"
      />

      <ConfirmDialog
        open={runOpen}
        title="手动触发归档"
        description="dry-run 只估算；确认后立即执行一轮真实搬运并写入 archive_runs 账本。"
        tone="primary"
        confirmLabel="确认执行"
        busy={busy || previewLoading}
        error={actionError ?? previewError}
        onCancel={() => {
          setRunOpen(false);
          setPreview(null);
        }}
        onConfirm={async () => {
          setBusy(true);
          setActionError(null);
          try {
            await runArchive({});
            setRunOpen(false);
            setPreview(null);
            setReloadKey((k) => k + 1);
            fireFlash();
          } catch (err) {
            setActionError(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="space-y-3">
          <DryRunPreview result={preview} loading={previewLoading} error={previewError} onRetry={() => void dryRun()} compact />
          <p className="text-body-sm text-text-tertiary">
            cutoff 由策略决定（{status?.policy.hot_retention_days ?? '—'} 天）。若上一轮仍在运行，本次会被服务端以 409 拒绝。
          </p>
        </div>
      </ConfirmDialog>
    </>
  );
}

function StatCard({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'default' | 'success' | 'warning' | 'danger';
}) {
  const valueClass =
    tone === 'success'
      ? 'text-success-600'
      : tone === 'warning'
        ? 'text-warning-700'
        : tone === 'danger'
          ? 'text-danger-600'
          : 'text-text-primary';
  return (
    <div className="card card-pad">
      <div className="text-body-sm text-text-tertiary">{label}</div>
      <div className={cn('mt-1 text-display font-bold', valueClass)}>{value}</div>
      {hint && <div className="mt-1 truncate text-caption text-text-tertiary">{hint}</div>}
    </div>
  );
}
