/** 管理 API 共享类型。字段与 docs/admin-data-design.md §3.1 / §8 的资源对齐。 */

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  per_page: number;
}

export type SortOrder = 'asc' | 'desc';

/** 大影响操作的 dry-run 预估（§8：?dry_run=true 返回预估，不产审计动作行）。 */
export interface DryRunResult {
  dry_run: true;
  /** 人类可读的一行结论，直接展示在 DryRunPreview */
  summary: string;
  affected: Record<string, number | string>;
  warnings?: string[];
}

export interface AuditActor {
  id: string;
  username: string;
}

/** 所有写操作的统一响应包（含审计 id，便于前端回链） */
export interface MutateResult {
  ok: boolean;
  audit_id?: number;
  affected?: number;
}
