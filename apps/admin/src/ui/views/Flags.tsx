import { useCallback, useEffect, useState } from 'react';
import { listFlags, setFlag, type FeatureFlag, type FlagValue } from '../../api/flags';
import type { DryRunResult } from '../../api/types';
import { errorMessage, useTransientFlag } from '../../lib/hooks';
import { cn, formatRelative } from '../../lib/format';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { DryRunPreview } from '../components/DryRunPreview';
import { PageHeader, Placeholder } from '../components/PageHeader';
import { StatusTag } from '../components/StatusTag';
import { IconAlert, IconRefresh } from '../components/icons';

const FLAG_LABEL: Record<string, string> = {
  registration: '开放注册',
  readonly: '全站只读',
  video_enabled: '视频消息',
  e2ee: '端到端加密',
  call_enabled: '语音/视频通话',
};

const FLAG_HINT: Record<string, string> = {
  registration: '关闭后注册接口与游客通道同时停用（应急封禁预案 §6.4.3）',
  readonly: '开启后网关拒绝 MSG_SEND（NACK code=READONLY），保留收信与 ack',
  video_enabled: '客户端功能开关，经 FEATURE_FLAGS 帧（kind 911）下发',
  e2ee: '实验特性，关闭时不影响历史消息读取',
  call_enabled: '通话号段 350-399，默认关闭',
};

function describeValue(value: FlagValue): string {
  return typeof value === 'boolean' ? (value ? '开启' : '关闭') : String(value);
}

export function Flags() {
  const [flags, setFlags] = useState<FeatureFlag[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [flash, fireFlash] = useTransientFlag();

  const [editing, setEditing] = useState<{ flag: FeatureFlag; next: FlagValue } | null>(null);
  const [reason, setReason] = useState('');
  const [customValue, setCustomValue] = useState('');
  const [preview, setPreview] = useState<DryRunResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    listFlags(controller.signal)
      .then((res) => {
        setFlags(res);
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

  const open = useCallback((flag: FeatureFlag, next: FlagValue) => {
    setEditing({ flag, next });
    setReason('');
    setCustomValue(typeof next === 'boolean' ? '' : String(next));
    setPreview(null);
    setPreviewError(null);
    setFormError(null);
  }, []);

  const loadPreview = useCallback(async () => {
    if (!editing) return;
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const res = await setFlag(editing.flag.key, { value: editing.next, reason: reason || 'preview' }, { dryRun: true });
      setPreview('dry_run' in res ? res : null);
    } catch (err) {
      setPreviewError(errorMessage(err));
    } finally {
      setPreviewLoading(false);
    }
  }, [editing, reason]);

  const confirm = async (totp?: string) => {
    if (!editing) return;
    if (reason.trim().length < 4) {
      setFormError('请填写变更原因（≥4 字），会写入审计日志');
      return;
    }
    let next = editing.next;
    if (editing.flag.type === 'number') next = Number(customValue);
    if (editing.flag.type === 'string') next = customValue;
    if (editing.flag.type === 'number' && Number.isNaN(next as number)) {
      setFormError('请输入合法数字');
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      await setFlag(editing.flag.key, {
        value: next,
        reason: reason.trim(),
        confirm: totp,
      });
      setEditing(null);
      setReloadKey((k) => k + 1);
      fireFlash();
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const highImpact = editing?.flag.high_impact ?? false;

  return (
    <>
      <PageHeader
        title="Flag 管理"
        description="feature flag 即策略表：改动立即生效（经 kind 911 下发全端），并写入不可删除的审计流。"
        meta={
          <>
            <span>
              共 <span className="nums font-semibold text-text-secondary">{flags.length}</span> 个 flag
            </span>
            {flash && <span className="text-success-600">已生效</span>}
          </>
        }
        actions={
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setReloadKey((k) => k + 1)}>
            <IconRefresh size={14} /> 刷新
          </button>
        }
      />

      {error && (
        <div className="mb-4 flex items-center gap-2 rounded-md bg-danger-50 px-3 py-2 text-body-sm text-danger-700">
          <IconAlert size={16} /> {error}
        </div>
      )}

      {loading && flags.length === 0 && (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="skeleton h-16 w-full" />
          ))}
        </div>
      )}

      {!loading && flags.length === 0 && !error && (
        <Placeholder title="没有可管理的 flag" description="检查 chatd 的 feature flags 初始化与 admin 层连通性。" />
      )}

      <div className="space-y-6">
        {[
          { title: '安全与合规（高危）', items: flags.filter((f) => f.high_impact) },
          { title: '产品功能', items: flags.filter((f) => !f.high_impact) },
        ].map((group) =>
          group.items.length === 0 ? null : (
            <section key={group.title}>
              <h2 className="mb-2 text-body-sm font-semibold uppercase tracking-wide text-text-tertiary">{group.title}</h2>
              <div className="card divide-y divide-border-default">
                {group.items.map((flag) => (
                  <div key={flag.key} className="flex flex-wrap items-center gap-4 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-table font-semibold text-text-primary">{FLAG_LABEL[flag.key] ?? flag.key}</span>
                        <span className="code">{flag.key}</span>
                        {flag.high_impact && <StatusTag tone="danger">高危</StatusTag>}
                        {flag.value === true && flag.key === 'readonly' && <StatusTag tone="warning">全站只读中</StatusTag>}
                      </div>
                      <p className="mt-1 text-body-sm text-text-tertiary">
                        {FLAG_HINT[flag.key] ?? flag.description}
                      </p>
                      <p className="mt-1 text-caption text-text-tertiary">
                        最近变更 {formatRelative(flag.updated_at)} · {flag.updated_by || '—'} ·
                        <span className="nums"> v{flag.version}</span>
                      </p>
                    </div>

                    <div className="flex items-center gap-3">
                      {flag.type === 'bool' ? (
                        <Switch
                          checked={flag.value === true}
                          busy={loading}
                          label={FLAG_LABEL[flag.key] ?? flag.key}
                          onChange={(next) => open(flag, next)}
                        />
                      ) : (
                        <>
                          <span className="nums text-table text-text-secondary">{describeValue(flag.value)}</span>
                          <button type="button" className="btn btn-secondary btn-sm" onClick={() => open(flag, flag.value)}>
                            编辑
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ),
        )}
      </div>

      <ConfirmDialog
        open={editing !== null}
        title={editing ? `将 ${FLAG_LABEL[editing.flag.key] ?? editing.flag.key} 改为「${describeValue(editing.next)}」？` : ''}
        description={editing ? `flag: ${editing.flag.key} · 变更立即下发，无需重启` : undefined}
        tone={highImpact ? 'danger' : 'primary'}
        confirmLabel="应用变更"
        confirmWord={highImpact ? editing?.flag.key : undefined}
        requireTotp={highImpact}
        busy={busy}
        error={formError}
        onCancel={() => setEditing(null)}
        onConfirm={({ totp }) => void confirm(totp)}
      >
        <div className="space-y-3">
          {editing && editing.flag.type !== 'bool' && (
            <div>
              <label className="label" htmlFor="flag-value">
                新值（{editing.flag.type}）
              </label>
              <input
                id="flag-value"
                className="input"
                value={customValue}
                onChange={(event) => setCustomValue(event.target.value)}
                placeholder={describeValue(editing.flag.value)}
              />
            </div>
          )}

          <div>
            <label className="label" htmlFor="flag-reason">
              变更原因（写入审计）
            </label>
            <textarea
              id="flag-reason"
              className="textarea"
              rows={3}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="如：注册接口被刷，按应急预案临时关闭注册"
            />
          </div>

          {highImpact && (
            <div className="flex items-start gap-2 rounded-md bg-danger-50 px-3 py-2 text-body-sm text-danger-700">
              <IconAlert size={16} className="mt-0.5 shrink-0" />
              <span>高危开关，影响全站。需输入 flag 名确认并完成二次 TOTP；要求 5 分钟内可执行（security-spec §6.4.3）。</span>
            </div>
          )}

          <div className="flex justify-end">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void loadPreview()} disabled={previewLoading}>
              {previewLoading ? '预估中…' : '预估影响'}
            </button>
          </div>
          <DryRunPreview result={preview} loading={previewLoading} error={previewError} compact />
        </div>
      </ConfirmDialog>
    </>
  );
}

/** 开关：无动效依赖，键盘 Space/Enter 可切换（role=switch） */
function Switch({
  checked,
  busy,
  label,
  onChange,
}: {
  checked: boolean;
  busy?: boolean;
  label: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={busy}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors duration-normal',
        checked ? 'bg-primary-500' : 'bg-border-default',
        busy && 'opacity-50',
      )}
    >
      <span
        className={cn(
          'inline-block h-5 w-5 transform rounded-full bg-white shadow-sm transition-transform duration-normal',
          checked ? 'translate-x-[22px]' : 'translate-x-0.5',
        )}
      />
    </button>
  );
}
