import { useCallback, useEffect, useState } from 'react';
import {
  HANDLE_ACTION_LABELS,
  REPORT_REASON_LABELS,
  assignReport,
  getReport,
  handleReport,
  listReports,
  type HandleAction,
  type HandleRequest,
  type Report,
  type ReportPriority,
  type ReportStatus,
} from '../../api/reports';
import type { DryRunResult, Page } from '../../api/types';
import { errorMessage, useDebouncedValue, useTransientFlag } from '../../lib/hooks';
import { cn, formatDateTime, formatNumber, formatRelative } from '../../lib/format';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { DataTable, FilterBar, SearchInput, type Column } from '../components/DataTable';
import { DryRunPreview, ImpactList } from '../components/DryRunPreview';
import { Modal } from '../components/Modal';
import { PageHeader } from '../components/PageHeader';
import { StatusTag } from '../components/StatusTag';
import { IconRefresh } from '../components/icons';

const STATUS: Record<ReportStatus, { label: string; tone: 'warning' | 'info' | 'muted' | 'danger' }> = {
  pending: { label: '待处理', tone: 'warning' },
  handling: { label: '处理中', tone: 'info' },
  handled: { label: '已处理', tone: 'muted' },
  escalated: { label: '已升级', tone: 'danger' },
};

const PRIORITY: Record<ReportPriority, { label: string; tone: 'danger' | 'warning' | 'muted' }> = {
  p0: { label: 'P0 紧急', tone: 'danger' },
  p1: { label: 'P1 高', tone: 'warning' },
  p2: { label: 'P2 常规', tone: 'muted' },
};

const TARGET_LABEL: Record<string, string> = { message: '消息', user: '用户', conversation: '会话' };

export function Reports() {
  const [status, setStatus] = useState<ReportStatus | 'open' | 'all'>('open');
  const [priority, setPriority] = useState<ReportPriority | 'all'>('all');
  const [q, setQ] = useState('');
  const debouncedQ = useDebouncedValue(q, 300);
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(20);

  const [data, setData] = useState<Page<Report> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [flash, fireFlash] = useTransientFlag();

  const [active, setActive] = useState<Report | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  useEffect(() => {
    setPage(1);
  }, [status, priority, debouncedQ, perPage]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    listReports(
      {
        status,
        priority,
        q: debouncedQ || undefined,
        page,
        per_page: perPage,
      },
      controller.signal,
    )
      .then((res) => {
        setData(res);
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
  }, [status, priority, debouncedQ, page, perPage, reloadKey]);

  const openDetail = useCallback(async (report: Report) => {
    setActive(report);
    setDetailLoading(true);
    setDetailError(null);
    try {
      const full = await getReport(report.id);
      setActive(full);
    } catch (err) {
      setDetailError(errorMessage(err));
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const rows = data?.items ?? [];
  const overdue = rows.filter((r) => new Date(r.sla_due_at).getTime() < Date.now() && r.status !== 'handled').length;

  const columns: Column<Report>[] = [
    {
      key: 'id',
      header: '举报',
      width: 220,
      render: (r) => (
        <div>
          <div className="text-table font-semibold text-text-primary">
            {REPORT_REASON_LABELS[r.reason_code] ?? r.reason_code}
          </div>
          <div className="nums text-caption text-text-tertiary">#{r.id}</div>
        </div>
      ),
    },
    {
      key: 'priority',
      header: '优先级',
      width: 110,
      render: (r) => <StatusTag tone={PRIORITY[r.priority].tone}>{PRIORITY[r.priority].label}</StatusTag>,
    },
    {
      key: 'target',
      header: '目标',
      width: 320,
      render: (r) => (
        <div className="min-w-0">
          <div className="text-body-sm text-text-secondary">
            {TARGET_LABEL[r.target_type] ?? r.target_type} <span className="nums">#{r.target_id}</span>
          </div>
          <div className="truncate text-caption text-text-tertiary">{r.evidence[0]?.excerpt ?? r.reason_text}</div>
        </div>
      ),
    },
    {
      key: 'reporter',
      header: '举报人',
      width: 120,
      render: (r) => <span className="nums text-body-sm text-text-secondary">#{r.reporter_id}</span>,
    },
    {
      key: 'status',
      header: '状态',
      width: 110,
      render: (r) => <StatusTag tone={STATUS[r.status].tone}>{STATUS[r.status].label}</StatusTag>,
    },
    {
      key: 'sla',
      header: '处理时限',
      width: 180,
      render: (r) => {
        const late = new Date(r.sla_due_at).getTime() < Date.now() && r.status !== 'handled';
        return (
          <div className={cn('text-body-sm', late ? 'text-danger-600' : 'text-text-secondary')}>
            <span className="nums">{formatDateTime(r.sla_due_at)}</span>
            {late && <div className="text-caption">已超时</div>}
          </div>
        );
      },
    },
    {
      key: 'created',
      header: '举报时间',
      width: 150,
      render: (r) => <span className="text-body-sm text-text-secondary">{formatRelative(r.created_at)}</span>,
    },
    {
      key: 'actions',
      header: '操作',
      width: 150,
      align: 'right',
      render: (r) => (
        <div className="flex items-center justify-end gap-1">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void openDetail(r)}>
            {r.status === 'handled' ? '查看' : '处置'}
          </button>
          {!r.assignee && r.status !== 'handled' && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                assignReport(r.id, 'me')
                  .then(() => setReloadKey((k) => k + 1))
                  .catch((err) => setError(errorMessage(err)));
              }}
            >
              认领
            </button>
          )}
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="举报处理"
        description="按时间倒序的举报队列。普通举报 24h 内处理，涉未成年人/人身威胁 2h 内升级（admin-guide）。"
        meta={
          <>
            <span>
              待处理 <span className="nums font-semibold text-text-secondary">{formatNumber(data?.total ?? 0)}</span>
            </span>
            {overdue > 0 && <span className="text-danger-600">本页超时 {overdue} 条</span>}
            {flash && <span className="text-success-600">已刷新</span>}
          </>
        }
        actions={
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setReloadKey((k) => k + 1)}>
            <IconRefresh size={14} /> 刷新队列
          </button>
        }
      />

      <FilterBar
        onReset={() => {
          setStatus('open');
          setPriority('all');
          setQ('');
          setPage(1);
        }}
      >
        <div>
          <label className="label" htmlFor="report-status">
            状态
          </label>
          <select
            id="report-status"
            className="select w-[160px]"
            value={status}
            onChange={(event) => setStatus(event.target.value as ReportStatus | 'open' | 'all')}
          >
            <option value="open">待处理（含处理中）</option>
            <option value="pending">待处理</option>
            <option value="handling">处理中</option>
            <option value="escalated">已升级</option>
            <option value="handled">已处理</option>
            <option value="all">全部</option>
          </select>
        </div>
        <div>
          <label className="label" htmlFor="report-priority">
            优先级
          </label>
          <select
            id="report-priority"
            className="select w-[140px]"
            value={priority}
            onChange={(event) => setPriority(event.target.value as ReportPriority | 'all')}
          >
            <option value="all">全部</option>
            <option value="p0">P0 紧急</option>
            <option value="p1">P1 高</option>
            <option value="p2">P2 常规</option>
          </select>
        </div>
        <div>
          <label className="label" htmlFor="report-q">
            搜索
          </label>
          <SearchInput value={q} onChange={setQ} placeholder="举报 ID / 原因 / 用户 ID" width={260} />
        </div>
      </FilterBar>

      <DataTable<Report>
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        loading={loading}
        error={error}
        emptyText="队列已清空，辛苦"
        pagination={{
          page,
          perPage,
          total: data?.total ?? 0,
          onPageChange: setPage,
          onPerPageChange: setPerPage,
        }}
        footerLeft="处置动作全部写入审计日志；证据加密保全，不随内容删除清除"
      />

      <ReportDetail
        report={active}
        loading={detailLoading}
        error={detailError}
        onClose={() => setActive(null)}
        onHandled={() => {
          setActive(null);
          setReloadKey((k) => k + 1);
          fireFlash();
        }}
      />
    </>
  );
}

/** 处置对话框：证据 + 动作 + 说明 + 时长 + 通知 + 二次 TOTP；打开即 dry-run 预估。 */
function ReportDetail({
  report,
  loading,
  error,
  onClose,
  onHandled,
}: {
  report: Report | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onHandled: () => void;
}) {
  const [action, setAction] = useState<HandleAction>('warn');
  const [note, setNote] = useState('');
  const [duration, setDuration] = useState<number | null>(7);
  const [notify, setNotify] = useState(true);
  const [preview, setPreview] = useState<DryRunResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const highImpact = action === 'ban' || action === 'mute' || action === 'remove_content';

  useEffect(() => {
    if (!report) return;
    setAction('warn');
    setNote('');
    setDuration(7);
    setNotify(true);
    setPreview(null);
    setPreviewError(null);
    setFormError(null);
  }, [report?.id]);

  useEffect(() => {
    setPreview(null);
    setPreviewError(null);
  }, [action]);

  const buildBody = useCallback((): HandleRequest => {
    return {
      action,
      note: note.trim(),
      duration_days: action === 'ban' ? null : action === 'mute' ? duration : undefined,
      notify_user: notify,
    };
  }, [action, note, duration, notify]);

  const loadPreview = useCallback(async () => {
    if (!report) return;
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const res = await handleReport(report.id, buildBody(), { dryRun: true });
      setPreview('dry_run' in res ? res : null);
    } catch (err) {
      setPreviewError(errorMessage(err));
    } finally {
      setPreviewLoading(false);
    }
  }, [report, buildBody]);

  const submit = async (totp?: string) => {
    if (!report) return;
    if (note.trim().length < 4) {
      setFormError('请填写处置说明（至少 4 个字），会写入审计日志');
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      const body: HandleRequest = { ...buildBody(), totp_code: totp };
      await handleReport(report.id, body);
      onHandled();
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={report !== null}
      title={`处置举报 #${report?.id ?? ''}`}
      description={report ? `${REPORT_REASON_LABELS[report.reason_code] ?? report.reason_code} · ${TARGET_LABEL[report.target_type]} #${report.target_id}` : undefined}
      width={880}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>
            关闭
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => void loadPreview()} disabled={previewLoading || busy}>
            预览影响
          </button>
          {action !== 'ban' && (
            <button
              type="button"
              className={highImpact ? 'btn btn-danger' : 'btn btn-primary'}
              onClick={() => void submit()}
              disabled={busy || loading}
            >
              {busy ? '提交中…' : HANDLE_ACTION_LABELS[action]}
            </button>
          )}
        </>
      }
    >
      {loading && <div className="skeleton h-24 w-full" />}
      {error && <p className="text-body-sm text-danger-600">{error}</p>}

      {report && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="space-y-3">
            <section className="rounded-md border border-border-default">
              <header className="border-b border-border-default bg-bg-surface-2 px-3 py-2 text-body-sm font-semibold">
                举报信息
              </header>
              <dl className="space-y-1.5 px-3 py-2 text-body-sm">
                <div className="flex justify-between gap-3">
                  <dt className="text-text-tertiary">举报人</dt>
                  <dd className="nums text-text-primary">#{report.reporter_id}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-text-tertiary">举报时间</dt>
                  <dd className="nums text-text-primary">{formatDateTime(report.created_at)}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-text-tertiary">处理时限</dt>
                  <dd className="nums text-text-primary">{formatDateTime(report.sla_due_at)}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-text-tertiary">当前状态</dt>
                  <dd><StatusTag tone={STATUS[report.status].tone}>{STATUS[report.status].label}</StatusTag></dd>
                </div>
                <div className="pt-1">
                  <dt className="text-text-tertiary">举报描述</dt>
                  <dd className="mt-1 whitespace-pre-wrap text-text-primary">{report.reason_text || '（无补充）'}</dd>
                </div>
              </dl>
            </section>

            <section className="rounded-md border border-border-default">
              <header className="flex items-center justify-between border-b border-border-default bg-bg-surface-2 px-3 py-2">
                <span className="text-body-sm font-semibold">证据（{report.evidence.length}）</span>
                <span className="text-caption text-text-tertiary">加密保全 · 不可普通删除</span>
              </header>
              <ul className="divide-y divide-border-default">
                {report.evidence.map((item) => (
                  <li key={item.message_id} className="px-3 py-2">
                    <div className="flex items-center justify-between text-caption text-text-tertiary">
                      <span className="nums">msg #{item.message_id}</span>
                      <span className="nums">{formatDateTime(item.sent_at)}</span>
                    </div>
                    <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-body-sm text-text-primary">{item.excerpt}</p>
                    <div className="mt-1 text-caption text-text-tertiary">
                      会话 {item.conv_name} <span className="nums">#{item.conv_id}</span> · 发送者 <span className="nums">#{item.sender_id}</span>
                    </div>
                  </li>
                ))}
                {report.evidence.length === 0 && <li className="px-3 py-4 text-body-sm text-text-tertiary">无证据附件</li>}
              </ul>
            </section>
          </div>

          <div className="space-y-3">
            <div>
              <label className="label" htmlFor="handle-action">
                处置动作
              </label>
              <select
                id="handle-action"
                className="select"
                value={action}
                onChange={(event) => setAction(event.target.value as HandleAction)}
              >
                {(Object.keys(HANDLE_ACTION_LABELS) as HandleAction[]).map((key) => (
                  <option key={key} value={key}>
                    {HANDLE_ACTION_LABELS[key]}
                  </option>
                ))}
              </select>
            </div>

            {action === 'mute' && (
              <div>
                <label className="label" htmlFor="handle-duration">
                  禁言时长（天）
                </label>
                <input
                  id="handle-duration"
                  type="number"
                  min={1}
                  max={365}
                  className="input nums"
                  value={duration ?? 7}
                  onChange={(event) => setDuration(Number(event.target.value) || 1)}
                />
              </div>
            )}

            <div>
              <label className="label" htmlFor="handle-note">
                处置说明（写入审计，必填）
              </label>
              <textarea
                id="handle-note"
                className="textarea"
                rows={4}
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="如：核实为广告引流，按社区规范 3.2 下架并警告"
              />
            </div>

            <label className="flex items-center gap-2 text-body-sm text-text-secondary">
              <input
                type="checkbox"
                className="h-4 w-4 accent-primary-500"
                checked={notify}
                onChange={(event) => setNotify(event.target.checked)}
              />
              通知举报人与被举报人处置结果
            </label>

            {highImpact && (
              <p className="rounded-sm bg-warning-50 px-3 py-2 text-body-sm text-warning-700">
                该动作会即时生效并写入哈希链审计；封禁类操作需要二次 TOTP。
              </p>
            )}

            <DryRunPreview result={preview} loading={previewLoading} error={previewError} onRetry={() => void loadPreview()} compact />

            {action === 'ban' && report && (
              <BanConfirm
                reportId={report.id}
                body={buildBody()}
                onDone={onHandled}
                onError={setFormError}
              />
            )}

            {formError && <p className="text-body-sm text-danger-600">{formError}</p>}
          </div>
        </div>
      )}
    </Modal>
  );
}

/** 封禁是唯一需要独立二次确认 + TOTP 的处置动作，单独拆出来避免误触。 */
function BanConfirm({
  reportId,
  body,
  onDone,
  onError,
}: {
  reportId: string;
  body: HandleRequest;
  onDone: () => void;
  onError: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <>
      <button type="button" className="btn btn-danger w-full" onClick={() => setOpen(true)}>
        封禁被举报账号…
      </button>
      <ConfirmDialog
        open={open}
        title="封禁被举报账号"
        description="封禁将撤销该账号全部 token 家族并断开所有连接（security-spec §6.4.3）。"
        confirmLabel="确认封禁"
        requireTotp
        busy={busy}
        error={error}
        onCancel={() => setOpen(false)}
        onConfirm={async ({ totp }) => {
          setBusy(true);
          setError(null);
          try {
            await handleReport(reportId, { ...body, action: 'ban', totp_code: totp });
            setOpen(false);
            onDone();
          } catch (err) {
            const message = errorMessage(err);
            setError(message);
            onError(message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <ImpactList
          items={[
            { label: '动作', value: '封禁账号（永久，需复核）' },
            { label: '副作用', value: '撤销全部登录凭证 + 立即断连' },
            { label: '审计', value: '写入哈希链，不可删除' },
          ]}
        />
      </ConfirmDialog>
    </>
  );
}
