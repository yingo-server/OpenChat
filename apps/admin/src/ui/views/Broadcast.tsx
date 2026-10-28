import { useCallback, useEffect, useState } from 'react';
import {
  cancelDraft,
  createDraft,
  listDrafts,
  previewDraft,
  sendDraft,
  type AudienceType,
  type BroadcastDraft,
  type BroadcastPreview,
  type BroadcastStatus,
} from '../../api/broadcast';
import type { Page } from '../../api/types';
import { errorMessage, useTransientFlag } from '../../lib/hooks';
import { cn, formatDateTime, formatDuration, formatNumber, formatRelative } from '../../lib/format';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { DataTable, type Column } from '../components/DataTable';
import { Modal } from '../components/Modal';
import { PageHeader } from '../components/PageHeader';
import { StatusTag } from '../components/StatusTag';
import { IconAlert, IconMegaphone, IconRefresh } from '../components/icons';

const STATUS: Record<BroadcastStatus, { label: string; tone: 'muted' | 'info' | 'warning' | 'success' | 'danger' }> = {
  draft: { label: '草稿', tone: 'muted' },
  previewed: { label: '已预览', tone: 'info' },
  scheduled: { label: '待发送', tone: 'warning' },
  sending: { label: '发送中', tone: 'warning' },
  sent: { label: '已发送', tone: 'success' },
  failed: { label: '失败', tone: 'danger' },
};

const AUDIENCE_LABEL: Record<AudienceType, string> = {
  all: '全体用户',
  segment: '人群包',
  uids: '指定用户',
};

/** 发布确认词（§9.3 广播发布需输入确认词） */
const CONFIRM_WORD = 'SEND';

export function Broadcast() {
  const [data, setData] = useState<Page<BroadcastDraft> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [flash, fireFlash] = useTransientFlag();

  const [composeOpen, setComposeOpen] = useState(false);
  const [sendTarget, setSendTarget] = useState<BroadcastDraft | null>(null);
  const [cancelTarget, setCancelTarget] = useState<BroadcastDraft | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    listDrafts({ page: 1, per_page: 50 }, controller.signal)
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
  }, [reloadKey]);

  const refresh = useCallback(() => {
    setReloadKey((k) => k + 1);
    fireFlash();
  }, [fireFlash]);

  const columns: Column<BroadcastDraft>[] = [
    {
      key: 'title',
      header: '标题 / 内容',
      width: 420,
      render: (d) => (
        <div className="min-w-0 py-1">
          <div className="truncate text-table font-semibold text-text-primary">{d.title || '(无标题)'}</div>
          <div className="line-clamp-2 text-body-sm text-text-secondary">{d.body}</div>
        </div>
      ),
    },
    {
      key: 'audience',
      header: '受众',
      width: 180,
      render: (d) => (
        <div>
          <div className="text-body-sm text-text-primary">{AUDIENCE_LABEL[d.audience.type]}</div>
          {d.audience.segment && <div className="text-caption text-text-tertiary">{d.audience.segment}</div>}
          {d.audience.type === 'uids' && (
            <div className="nums text-caption text-text-tertiary">{d.audience.uids?.length ?? 0} 人</div>
          )}
        </div>
      ),
    },
    {
      key: 'status',
      header: '状态',
      width: 110,
      render: (d) => <StatusTag tone={STATUS[d.status].tone}>{STATUS[d.status].label}</StatusTag>,
    },
    {
      key: 'updated',
      header: '更新时间',
      width: 170,
      render: (d) => (
        <div>
          <div className="text-body-sm text-text-secondary">{formatRelative(d.updated_at)}</div>
          <div className="nums text-caption text-text-tertiary">{formatDateTime(d.updated_at)}</div>
        </div>
      ),
    },
    {
      key: 'actions',
      header: '操作',
      width: 200,
      align: 'right',
      render: (d) => (
        <div className="flex items-center justify-end gap-1">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={d.status === 'sending' || d.status === 'sent'}
            onClick={() => setSendTarget(d)}
          >
            预览并发送
          </button>
          {(d.status === 'scheduled' || d.status === 'sending') && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setCancelTarget(d)}>
              取消
            </button>
          )}
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="广播"
        description="草稿 → dry-run 预览触达人数 → 输入确认词发送。发送失败可按人群包重试，已触达用户由服务端去重。"
        meta={
          <>
            <span>
              草稿 <span className="nums font-semibold text-text-secondary">{formatNumber(data?.total ?? 0)}</span> 条
            </span>
            {flash && <span className="text-success-600">已刷新</span>}
          </>
        }
        actions={
          <>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setReloadKey((k) => k + 1)}>
              <IconRefresh size={14} /> 刷新
            </button>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setComposeOpen(true)}>
              <IconMegaphone size={14} /> 新建广播
            </button>
          </>
        }
      />

      <DataTable<BroadcastDraft>
        columns={columns}
        rows={data?.items ?? []}
        rowKey={(d) => d.id}
        loading={loading}
        error={error}
        emptyText="还没有广播草稿"
        footerLeft="发布需输入确认词并二次 TOTP；全量广播建议先在测试人群包验证"
      />

      <ComposeDialog
        open={composeOpen}
        onClose={() => setComposeOpen(false)}
        onCreated={() => {
          setComposeOpen(false);
          refresh();
        }}
      />

      <SendDialog target={sendTarget} onClose={() => setSendTarget(null)} onSent={refresh} />

      <ConfirmDialog
        open={cancelTarget !== null}
        title="取消这条广播？"
        description="取消后不可恢复；已发送的部分不受影响。"
        confirmLabel="确认取消"
        onCancel={() => setCancelTarget(null)}
        onConfirm={() => {
          const target = cancelTarget;
          if (!target) return;
          cancelDraft(target.id)
            .then(() => {
              setCancelTarget(null);
              refresh();
            })
            .catch((err) => setError(errorMessage(err)));
        }}
      />
    </>
  );
}

function ComposeDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (draft: BroadcastDraft) => void;
}) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [audience, setAudience] = useState<AudienceType>('all');
  const [segment, setSegment] = useState('active_30d');
  const [channel, setChannel] = useState<'inapp' | 'inapp_push'>('inapp');
  const [scheduledAt, setScheduledAt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setTitle('');
      setBody('');
      setAudience('all');
      setChannel('inapp');
      setScheduledAt('');
      setError(null);
    }
  }, [open]);

  return (
    <Modal
      open={open}
      title="新建广播草稿"
      description="草稿保存后不会发送；需在列表中预览并确认发送。"
      width={680}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !title.trim() || !body.trim()}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                const draft = await createDraft({
                  title: title.trim(),
                  body: body.trim(),
                  audience: audience === 'segment' ? { type: 'segment', segment } : { type: audience },
                  channel,
                  scheduled_at: scheduledAt ? new Date(scheduledAt).toISOString() : null,
                });
                onCreated(draft);
              } catch (err) {
                setError(errorMessage(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? '保存中…' : '保存草稿'}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <label className="label" htmlFor="bc-title">
            标题
          </label>
          <input
            id="bc-title"
            className="input"
            maxLength={60}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="如：服务升级通知"
          />
        </div>
        <div>
          <label className="label" htmlFor="bc-body">
            正文
          </label>
          <textarea
            id="bc-body"
            className="textarea"
            rows={5}
            maxLength={500}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder="不超过 500 字；将作为系统消息下发"
          />
          <div className="mt-1 text-right text-caption text-text-tertiary nums">{body.length}/500</div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label" htmlFor="bc-audience">
              受众
            </label>
            <select
              id="bc-audience"
              className="select"
              value={audience}
              onChange={(event) => setAudience(event.target.value as AudienceType)}
            >
              <option value="all">全体用户</option>
              <option value="segment">人群包</option>
              <option value="uids">指定用户（CSV 导入）</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="bc-channel">
              通道
            </label>
            <select
              id="bc-channel"
              className="select"
              value={channel}
              onChange={(event) => setChannel(event.target.value as 'inapp' | 'inapp_push')}
            >
              <option value="inapp">仅站内信</option>
              <option value="inapp_push">站内信 + 推送</option>
            </select>
          </div>
        </div>
        {audience === 'segment' && (
          <div>
            <label className="label" htmlFor="bc-segment">
              人群包
            </label>
            <input
              id="bc-segment"
              className="input"
              value={segment}
              onChange={(event) => setSegment(event.target.value)}
              placeholder="active_30d"
            />
          </div>
        )}
        <div>
          <label className="label" htmlFor="bc-schedule">
            定时发送（可选）
          </label>
          <input
            id="bc-schedule"
            type="datetime-local"
            className="input"
            value={scheduledAt}
            onChange={(event) => setScheduledAt(event.target.value)}
          />
        </div>
        {error && <p className="text-body-sm text-danger-600">{error}</p>}
      </div>
    </Modal>
  );
}

/**
 * 发送向导：打开即 dry-run 预估；触达人数未加载成功前禁止发送。
 * 这是"预览触达人数"这一硬性步骤的界面约束（不靠操作者自觉）。
 */
function SendDialog({
  target,
  onClose,
  onSent,
}: {
  target: BroadcastDraft | null;
  onClose: () => void;
  onSent: () => void;
}) {
  const [preview, setPreview] = useState<BroadcastPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [totp, setTotp] = useState('');

  const load = useCallback(async () => {
    if (!target) return;
    setLoading(true);
    setError(null);
    try {
      const res = await previewDraft(target.id);
      setPreview(res);
    } catch (err) {
      setError(errorMessage(err));
      setPreview(null);
    } finally {
      setLoading(false);
    }
  }, [target]);

  useEffect(() => {
    if (!target) return;
    setPreview(null);
    setTotp('');
    setError(null);
    void load();
  }, [target?.id]);

  const canSend = preview !== null && !loading && !busy;

  return (
    <ConfirmDialog
      open={target !== null}
      title="发送广播"
      description={target ? `「${target.title}」· ${AUDIENCE_LABEL[target.audience.type]}` : undefined}
      confirmLabel={busy ? '发送中…' : '确认发送'}
      confirmWord={CONFIRM_WORD}
      requireTotp
      busy={busy || loading}
      error={error}
      onCancel={onClose}
      onConfirm={async ({ totp: code }) => {
        if (!target || !canSend) return;
        setBusy(true);
        setError(null);
        try {
          await sendDraft(target.id, CONFIRM_WORD, code ?? totp);
          onSent();
          onClose();
        } catch (err) {
          setError(errorMessage(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="space-y-3">
        <div className="rounded-md border border-border-default bg-bg-surface-2 px-3 py-2">
          <div className="text-table font-semibold text-text-primary">{target?.title}</div>
          <p className="mt-1 whitespace-pre-wrap text-body-sm text-text-secondary">{target?.body}</p>
        </div>

        <div className="rounded-md border border-primary-300 bg-primary-50 px-3 py-3">
          <div className="flex items-center justify-between">
            <span className="text-body-sm text-text-secondary">dry-run 预估触达</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void load()} disabled={loading}>
              {loading ? '预估中…' : '重新预估'}
            </button>
          </div>
          {preview ? (
            <>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="nums text-display font-bold text-primary-700">{formatNumber(preview.estimated_recipients)}</span>
                <span className="text-body-sm text-text-secondary">人</span>
              </div>
              <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-body-sm">
                <div className="flex justify-between">
                  <dt className="text-text-tertiary">跳过</dt>
                  <dd className="nums text-text-primary">{formatNumber(preview.estimated_skipped)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-text-tertiary">预计耗时</dt>
                  <dd className="nums text-text-primary">{formatDuration(preview.estimated_duration_sec)}</dd>
                </div>
              </dl>
              {preview.warnings.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {preview.warnings.map((w) => (
                    <li key={w} className="flex items-start gap-1.5 text-body-sm text-warning-700">
                      <IconAlert size={14} className="mt-0.5 shrink-0" />
                      <span>{w}</span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <p className={cn('mt-1 text-body-sm', loading ? 'text-text-tertiary' : 'text-danger-600')}>
              {loading ? '正在预估触达人数…' : '必须成功预估后才能发送'}
            </p>
          )}
        </div>

        {preview && preview.estimated_recipients > 10000 && (
          <p className="rounded-sm bg-warning-50 px-3 py-2 text-body-sm text-warning-700">
            触达超过 1 万人：建议先发 1% 灰度人群包验证文案与链接。
          </p>
        )}

        <div>
          <label className="label" htmlFor="send-totp">
            动态验证码（6 位）
          </label>
          <input
            id="send-totp"
            className="input nums tracking-[0.4em]"
            inputMode="numeric"
            maxLength={6}
            value={totp}
            onChange={(event) => setTotp(event.target.value.replace(/\D/g, '').slice(0, 6))}
            placeholder="000000"
          />
        </div>
      </div>
    </ConfirmDialog>
  );
}
