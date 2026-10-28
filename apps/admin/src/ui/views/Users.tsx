import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  banUser,
  batchUsers,
  exportUsers,
  kickUser,
  listUsers,
  unbanUser,
  type AdminUser,
  type BanRequest,
  type UserQuery,
  type UserStatus,
} from '../../api/users';
import type { DryRunResult, Page, SortOrder } from '../../api/types';
import { errorMessage, useDebouncedValue, useTransientFlag } from '../../lib/hooks';
import { formatDateTime, formatNumber, cn } from '../../lib/format';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { DataTable, FilterBar, SearchInput, type Column } from '../components/DataTable';
import { DryRunPreview, ImpactList } from '../components/DryRunPreview';
import { PageHeader } from '../components/PageHeader';
import { StatusTag } from '../components/StatusTag';
import { IconDownload, IconRefresh } from '../components/icons';

const STATUS_LABEL: Record<UserStatus, { label: string; tone: 'success' | 'danger' | 'muted' }> = {
  active: { label: '正常', tone: 'success' },
  banned: { label: '已封禁', tone: 'danger' },
  pending_deletion: { label: '注销中', tone: 'muted' },
};

const LEVEL_LABEL: Record<number, string> = { 1: 'L1 观察', 2: 'L2 限时封禁', 3: 'L3 永久封禁' };

const EMPTY_BAN: BanRequest = {
  reason: '',
  level: 2,
  days: 7,
  notify_user: true,
};

export function Users() {
  const [q, setQ] = useState('');
  const debouncedQ = useDebouncedValue(q, 300);
  const [status, setStatus] = useState<UserStatus | 'all'>('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(20);
  const [sort, setSort] = useState<{ key: string; order: SortOrder }>({ key: 'created_at', order: 'desc' });

  const [data, setData] = useState<Page<AdminUser> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [allAcross, setAllAcross] = useState(false);
  const [flash, fireFlash] = useTransientFlag();

  const [banTargets, setBanTargets] = useState<AdminUser[] | null>(null);
  const [banIds, setBanIds] = useState<string[]>([]);
  const [unbanTarget, setUnbanTarget] = useState<AdminUser | null>(null);
  const [kickTarget, setKickTarget] = useState<AdminUser | null>(null);
  const [batchUnban, setBatchUnban] = useState(false);
  const [batchKick, setBatchKick] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const query = useMemo<UserQuery>(
    () => ({
      q: debouncedQ || undefined,
      status,
      registered_from: from || undefined,
      registered_to: to || undefined,
      page,
      per_page: perPage,
      sort: sort.key as UserQuery['sort'],
      order: sort.order,
    }),
    [debouncedQ, status, from, to, page, perPage, sort],
  );

  useEffect(() => {
    setPage(1);
  }, [debouncedQ, status, from, to, perPage]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    listUsers(query, controller.signal)
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
  }, [query, reloadKey]);

  const rows = data?.items ?? [];

  const closeDialogs = useCallback(() => {
    setBanTargets(null);
    setUnbanTarget(null);
    setKickTarget(null);
    setBatchUnban(false);
    setBatchKick(false);
    setActionError(null);
  }, []);

  const runAction = useCallback(
    async (fn: () => Promise<unknown>, message: string) => {
      setActionBusy(true);
      setActionError(null);
      try {
        await fn();
        closeDialogs();
        setSelected(new Set());
        setAllAcross(false);
        setReloadKey((k) => k + 1);
        fireFlash();
        setError(null);
        return message;
      } catch (err) {
        setActionError(errorMessage(err));
        return null;
      } finally {
        setActionBusy(false);
      }
    },
    [closeDialogs, fireFlash],
  );

  const selectAllAcrossPages = useCallback(async () => {
    setActionError(null);
    setLoading(true);
    try {
      const collected = new Set<string>();
      let current = 1;
      // 上限 2000 条，避免把浏览器拖死；超过时提示缩小筛选范围
      for (;;) {
        const chunk = await listUsers({ ...query, page: current, per_page: 200 });
        chunk.items.forEach((u) => collected.add(u.id));
        if (collected.size >= chunk.total || chunk.items.length === 0 || collected.size >= 2000) break;
        current += 1;
      }
      setSelected(collected);
      setAllAcross(true);
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [query]);

  const columns: Column<AdminUser>[] = [
    {
      key: 'user',
      header: '用户',
      width: 280,
      render: (u) => (
        <div className="min-w-0">
          <div className="truncate text-table font-semibold text-text-primary">{u.nickname || '(未设置昵称)'}</div>
          <div className="truncate text-caption text-text-tertiary">
            @{u.username} · <span className="nums">#{u.id}</span>
          </div>
        </div>
      ),
    },
    {
      key: 'status',
      header: '状态',
      width: 120,
      render: (u) => <StatusTag tone={STATUS_LABEL[u.status].tone}>{STATUS_LABEL[u.status].label}</StatusTag>,
    },
    {
      key: 'ban',
      header: '封禁',
      width: 200,
      render: (u) =>
        u.ban ? (
          <div className="text-body-sm">
            <div className="text-danger-600">{LEVEL_LABEL[u.ban.level] ?? `L${u.ban.level}`}</div>
            <div className="truncate text-caption text-text-tertiary" title={u.ban.reason}>
              {u.ban.expires_at ? `至 ${formatDateTime(u.ban.expires_at)}` : '永久'} · {u.ban.reason}
            </div>
          </div>
        ) : (
          <span className="text-body-sm text-text-tertiary">—</span>
        ),
    },
    {
      key: 'report_count',
      header: '举报',
      width: 88,
      align: 'right',
      sortKey: 'report_count',
      render: (u) => (
        <span className={cn('nums', u.report_count > 0 ? 'font-semibold text-danger-600' : 'text-text-tertiary')}>
          {u.report_count}
        </span>
      ),
    },
    {
      key: 'created_at',
      header: '注册时间',
      width: 168,
      sortKey: 'created_at',
      render: (u) => <span className="nums text-body-sm text-text-secondary">{formatDateTime(u.created_at)}</span>,
    },
    {
      key: 'last_seen_at',
      header: '最近活跃',
      width: 168,
      sortKey: 'last_seen_at',
      render: (u) => <span className="nums text-body-sm text-text-secondary">{formatDateTime(u.last_seen_at)}</span>,
    },
    {
      key: 'actions',
      header: '操作',
      width: 150,
      align: 'right',
      render: (u) => (
        <div className="flex items-center justify-end gap-1">
          {u.status === 'banned' ? (
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setUnbanTarget(u)}>
              解封
            </button>
          ) : (
            <button type="button" className="btn btn-danger-ghost btn-sm" onClick={() => {
              const ids = selected.has(u.id) && selected.size > 1 ? [...selected] : [u.id];
              setBanIds(ids);
              setBanTargets(selected.has(u.id) && selected.size > 1 ? rows.filter((r) => selected.has(r.id)) : [u]);
            }}>
              封禁
            </button>
          )}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setKickTarget(u)} title="断开全部连接">
            踢出
          </button>
        </div>
      ),
    },
  ];

  const selectedUsers = rows.filter((u) => selected.has(u.id));

  return (
    <>
      <PageHeader
        title="用户管理"
        description="检索账号、处理封禁与强制下线。封禁立即撤销全部 token 家族并断连（security-spec §6.4.3）。"
        meta={
          <>
            <span>
              共 <span className="nums font-semibold text-text-secondary">{formatNumber(data?.total ?? 0)}</span> 个账号
            </span>
            {flash && <span className="text-success-600">已刷新</span>}
            {actionError && <span className="text-danger-600">{actionError}</span>}
          </>
        }
        actions={
          <>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setReloadKey((k) => k + 1)}>
              <IconRefresh size={14} /> 刷新
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={loading}
              onClick={() => {
                setActionError(null);
                exportUsers({ ...query, page: 1 })
                  .then((res) => {
                    window.open(res.download_url, '_blank', 'noopener');
                    fireFlash();
                  })
                  .catch((err) => setActionError(errorMessage(err)));
              }}
            >
              <IconDownload size={14} /> 导出当前筛选
            </button>
          </>
        }
      />

      <FilterBar
        onReset={() => {
          setQ('');
          setStatus('all');
          setFrom('');
          setTo('');
          setPage(1);
        }}
      >
        <div>
          <label className="label" htmlFor="user-search">
            搜索
          </label>
          <SearchInput value={q} onChange={setQ} placeholder="昵称 / 用户名 / 用户 ID" width={300} />
        </div>
        <div>
          <label className="label" htmlFor="user-status">
            状态
          </label>
          <select
            id="user-status"
            className="select w-[140px]"
            value={status}
            onChange={(event) => setStatus(event.target.value as UserStatus | 'all')}
          >
            <option value="all">全部状态</option>
            <option value="active">正常</option>
            <option value="banned">已封禁</option>
            <option value="pending_deletion">注销中</option>
          </select>
        </div>
        <div>
          <label className="label" htmlFor="user-from">
            注册时间起
          </label>
          <input id="user-from" type="date" className="input w-[168px]" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="user-to">
            注册时间止
          </label>
          <input id="user-to" type="date" className="input w-[168px]" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
      </FilterBar>

      <DataTable<AdminUser>
        columns={columns}
        rows={rows}
        rowKey={(u) => u.id}
        loading={loading}
        error={error}
        emptyText="没有匹配的账号，试着放宽筛选条件"
        selectable
        selected={selected}
        onSelectedChange={(next) => {
          setSelected(next);
          setAllAcross(false);
        }}
        allAcrossPages={allAcross}
        onSelectAllAcrossPages={selectAllAcrossPages}
        sort={sort}
        onSortChange={(next) => {
          setSort(next);
          setPage(1);
        }}
        pagination={{
          page,
          perPage,
          total: data?.total ?? 0,
          onPageChange: setPage,
          onPerPageChange: setPerPage,
        }}
        batchBar={
          <>
            <button
              type="button"
              className="btn btn-danger btn-sm"
              onClick={() => {
                const ids = selectedUsers.length > 0 ? selectedUsers.map((u) => u.id) : [...selected];
                setBanIds(ids);
                setBanTargets(selectedUsers);
              }}
            >
              批量封禁
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setBatchUnban(true)}>
              批量解封
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setBatchKick(true)}>
              批量踢出
            </button>
          </>
        }
        footerLeft={
          selected.size > 0 ? <span>已选 {formatNumber(selected.size)} 条 · 危险操作均留审计</span> : undefined
        }
      />

      <BanDialog
        users={banTargets ?? []}
        ids={banIds}
        open={banTargets !== null}
        busy={actionBusy}
        error={actionError}
        onClose={closeDialogs}
        onConfirm={async (body) => {
          const ids = banIds;
          await runAction(
            () =>
              ids.length === 1
                ? banUser(ids[0]!, body)
                : batchUsers({ action: 'ban', ids, ban: body }),
            '已提交封禁',
          );
        }}
      />

      <ConfirmDialog
        open={unbanTarget !== null}
        title={`解封 ${unbanTarget?.nickname ?? ''}？`}
        description="解封后该账号可立即重新登录；历史封禁记录保留在审计日志中。"
        tone="primary"
        confirmLabel="确认解封"
        busy={actionBusy}
        error={actionError}
        onCancel={closeDialogs}
        onConfirm={() => {
          const target = unbanTarget;
          if (!target) return;
          void runAction(() => unbanUser(target.id, '后台解封'), '已解封');
        }}
      >
        {unbanTarget?.ban && (
          <ImpactList
            items={[
              { label: '封禁档位', value: LEVEL_LABEL[unbanTarget.ban.level] ?? `L${unbanTarget.ban.level}` },
              { label: '原封禁原因', value: unbanTarget.ban.reason },
              { label: '操作者', value: unbanTarget.ban.banned_by },
              { label: '封禁时间', value: formatDateTime(unbanTarget.ban.banned_at) },
            ]}
          />
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={kickTarget !== null}
        title={`将 ${kickTarget?.nickname ?? ''} 踢下线？`}
        description="断开该账号全部设备的连接，不影响登录凭证；客户端会自动重连。"
        tone="primary"
        confirmLabel="断开连接"
        busy={actionBusy}
        error={actionError}
        onCancel={closeDialogs}
        onConfirm={() => {
          if (!kickTarget) return;
          void runAction(() => kickUser(kickTarget.id, '后台强制下线'), '已断开');
        }}
      >
        <ImpactList
          items={[
            { label: '设备数', value: String(kickTarget?.device_count ?? 0) },
            { label: '最近活跃', value: formatDateTime(kickTarget?.last_seen_at) },
          ]}
        />
      </ConfirmDialog>

      <ConfirmDialog
        open={batchUnban}
        title={`批量解封 ${formatNumber(selected.size)} 个账号？`}
        description="仅对当前处于封禁状态的账号生效，其余账号会被跳过。"
        tone="primary"
        confirmLabel="确认解封"
        busy={actionBusy}
        error={actionError}
        onCancel={closeDialogs}
        onConfirm={() => {
          void runAction(
            () => batchUsers({ action: 'unban', ids: [...selected], select_all: allAcross, note: '后台批量解封' }),
            '已提交',
          );
        }}
      >
        <ImpactList items={[{ label: '目标账号', value: `${formatNumber(selected.size)} 个` }]} />
      </ConfirmDialog>

      <ConfirmDialog
        open={batchKick}
        title={`批量踢出 ${formatNumber(selected.size)} 个账号？`}
        description="断开所选账号的全部连接，用户可立即重连。"
        confirmLabel="确认踢出"
        busy={actionBusy}
        error={actionError}
        onCancel={closeDialogs}
        onConfirm={() => {
          void runAction(
            () => batchUsers({ action: 'kick', ids: [...selected], select_all: allAcross, note: '后台批量踢出' }),
            '已提交',
          );
        }}
      >
        <ImpactList items={[{ label: '目标账号', value: `${formatNumber(selected.size)} 个` }]} />
      </ConfirmDialog>
    </>
  );
}

/**
 * 封禁对话框：档位 + 时长 + 原因 + 通知 + 双人审批（L3）。
 * 打开即请求 dry-run 预估；改档位/时长后可手动重新预估。
 */
function BanDialog({
  users,
  ids,
  open,
  busy,
  error,
  onClose,
  onConfirm,
}: {
  users: AdminUser[];
  ids: string[];
  open: boolean;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: (body: BanRequest) => Promise<void>;
}) {
  const [body, setBody] = useState<BanRequest>(EMPTY_BAN);
  const [preview, setPreview] = useState<DryRunResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const loadPreview = useCallback(async () => {
    if (ids.length !== 1) {
      setPreview({
        dry_run: true,
        summary: `将对 ${ids.length} 个账号执行封禁，服务端逐条校验当前状态`,
        affected: { users: ids.length, devices: users.reduce((n, u) => n + u.device_count, 0) },
        warnings: body.level === 3 ? ['L3 永久封禁需双人审批单号，且会撤销全部 token 家族'] : [],
      });
      setPreviewError(null);
      return;
    }
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const res = await banUser(users[0]!.id, body, { dryRun: true });
      setPreview('dry_run' in res ? res : null);
    } catch (err) {
      setPreviewError(errorMessage(err));
    } finally {
      setPreviewLoading(false);
    }
  }, [body, users, ids]);

  useEffect(() => {
    if (!open) return;
    setBody(EMPTY_BAN);
    setPreview(null);
  }, [open]);

  useEffect(() => {
    if (open && preview === null && !previewLoading && !previewError) void loadPreview();
  }, [open, preview, previewLoading, previewError, loadPreview]);

  const target = users[0];

  return (
    <ConfirmDialog
      open={open}
      title={ids.length > 1 ? `批量封禁 ${ids.length} 个账号` : `封禁 ${target?.nickname ?? '账号'}？`}
      description={
        ids.length > 1
          ? '逐条写入封禁记录并断连；失败项会在审计日志中标记。'
          : `@${target?.username ?? ''} · 用户 #${target?.id ?? ''}`
      }
      confirmLabel="确认封禁"
      confirmWord={body.level === 3 ? 'PERMANENT' : undefined}
      requireTotp={body.level === 3}
      busy={busy}
      error={error}
      onCancel={onClose}
      onConfirm={() => void onConfirm(body)}
    >
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label" htmlFor="ban-level">
              封禁档位
            </label>
            <select
              id="ban-level"
              className="select"
              value={body.level}
              onChange={(event) => {
                const level = Number(event.target.value) as 1 | 2 | 3;
                setBody((prev) => ({ ...prev, level, days: level === 3 ? null : prev.days ?? 7 }));
              }}
            >
              <option value={1}>L1 观察（不禁言，仅标记）</option>
              <option value={2}>L2 限时封禁</option>
              <option value={3}>L3 永久封禁（需审批 + TOTP）</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="ban-days">
              时长（天）
            </label>
            <input
              id="ban-days"
              className="input nums"
              type="number"
              min={1}
              max={3650}
              disabled={body.level === 3}
              value={body.days ?? ''}
              onChange={(event) => setBody((prev) => ({ ...prev, days: Number(event.target.value) || null }))}
            />
          </div>
        </div>

        {body.level === 3 && (
          <div>
            <label className="label" htmlFor="ban-approval">
              双人审批单号
            </label>
            <input
              id="ban-approval"
              className="input"
              value={body.approval_ticket ?? ''}
              onChange={(event) => setBody((prev) => ({ ...prev, approval_ticket: event.target.value }))}
              placeholder="SEC-2026-0001"
            />
          </div>
        )}

        <div>
          <label className="label" htmlFor="ban-reason">
            原因（写入审计，用户可见摘要）
          </label>
          <textarea
            id="ban-reason"
            className="textarea"
            rows={3}
            value={body.reason}
            onChange={(event) => setBody((prev) => ({ ...prev, reason: event.target.value }))}
            placeholder="如：群发垃圾广告，违反社区规范 3.2"
          />
        </div>

        <label className="flex items-center gap-2 text-body-sm text-text-secondary">
          <input
            type="checkbox"
            className="h-4 w-4 accent-primary-500"
            checked={body.notify_user}
            onChange={(event) => setBody((prev) => ({ ...prev, notify_user: event.target.checked }))}
          />
          站内信通知用户封禁原因与申诉入口
        </label>

        <DryRunPreview
          result={preview}
          loading={previewLoading}
          error={previewError}
          onRetry={() => void loadPreview()}
          compact
        />

        <div className="flex justify-end">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void loadPreview()} disabled={previewLoading}>
            重新预估影响
          </button>
        </div>
      </div>
    </ConfirmDialog>
  );
}
