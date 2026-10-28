import type { ReactNode } from 'react';

/** 视图标题区：标题 + 一句话说明 + 右侧操作（后台页面统一节奏） */
export function PageHeader({
  title,
  description,
  actions,
  meta,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  meta?: ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-display text-text-primary">{title}</h1>
        {description && <p className="mt-1 text-body-sm text-text-secondary">{description}</p>}
        {meta && <div className="mt-2 flex flex-wrap items-center gap-3 text-body-sm text-text-tertiary">{meta}</div>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** 空状态 / 错误态统一容器 */
export function Placeholder({
  title,
  description,
  action,
  tone = 'muted',
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  tone?: 'muted' | 'danger';
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-md border border-dashed border-border-default px-6 py-10 text-center">
      <p className={tone === 'danger' ? 'text-table text-danger-600' : 'text-table text-text-secondary'}>{title}</p>
      {description && <p className="max-w-lg text-body-sm text-text-tertiary">{description}</p>}
      {action}
    </div>
  );
}

/** 行内小按钮组，避免每个表格单元格堆满主按钮 */
export function RowActions({ children }: { children: ReactNode }) {
  return <div className="flex items-center justify-end gap-1">{children}</div>;
}
