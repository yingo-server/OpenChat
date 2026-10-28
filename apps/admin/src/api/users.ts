import { api, qs, type QueryValue } from './client';
import type { DryRunResult, MutateResult, Page, SortOrder } from './types';

/** identity 域：users / devices（docs §3.1）。 */
export type UserStatus = 'active' | 'banned' | 'pending_deletion';

export interface BanInfo {
  level: 1 | 2 | 3;
  reason: string;
  banned_at: string;
  banned_by: string;
  expires_at: string | null;
}

export interface AdminUser {
  id: string;
  username: string;
  nickname: string;
  status: UserStatus;
  created_at: string;
  last_seen_at: string | null;
  device_count: number;
  report_count: number;
  ban: BanInfo | null;
}

export interface UserQuery {
  q?: string;
  status?: UserStatus | 'all';
  registered_from?: string;
  registered_to?: string;
  page?: number;
  per_page?: number;
  sort?: 'id' | 'created_at' | 'last_seen_at' | 'report_count';
  order?: SortOrder;
}

export function listUsers(query: UserQuery, signal?: AbortSignal): Promise<Page<AdminUser>> {
  return api.get<Page<AdminUser>>('/users', query as Record<string, QueryValue>, signal);
}

export interface BanRequest {
  reason: string;
  /** 1=警告观察 2=限时封禁 3=永久封禁（档位来自 policy，不硬编码） */
  level: 1 | 2 | 3;
  days: number | null;
  notify_user: boolean;
  /** 双人审批单号（level=3 必填，见 security-spec §6.4.3） */
  approval_ticket?: string;
}

export function banUser(
  id: string,
  body: BanRequest,
  opts: { dryRun?: boolean } = {},
): Promise<MutateResult | DryRunResult> {
  return api.post(`/users/${encodeURIComponent(id)}/ban`, body, {
    query: opts.dryRun ? { dry_run: true } : undefined,
  }) as Promise<MutateResult | DryRunResult>;
}

export function unbanUser(id: string, note: string): Promise<MutateResult> {
  return api.post<MutateResult>(`/users/${encodeURIComponent(id)}/unban`, { note });
}

export function kickUser(id: string, note: string): Promise<MutateResult> {
  return api.post<MutateResult>(`/users/${encodeURIComponent(id)}/kick`, { note });
}

export type BatchAction = 'ban' | 'unban' | 'kick' | 'export';

export interface BatchRequest {
  action: BatchAction;
  ids: string[];
  /** ids 由"跨页全选"物化而来；服务端可据此复核筛选条件 */
  select_all?: boolean;
  /** action=ban 时的封禁参数 */
  ban?: Omit<BanRequest, 'approval_ticket'>;
  note?: string;
}

export function batchUsers(
  body: BatchRequest,
  opts: { dryRun?: boolean } = {},
): Promise<MutateResult | DryRunResult> {
  return api.post('/users/batch', body, { query: opts.dryRun ? { dry_run: true } : undefined }) as Promise<
    MutateResult | DryRunResult
  >;
}

/** 导出走异步任务：5 req/hour（security-spec A-5），返回一次性下载票据。 */
export function exportUsers(query: UserQuery): Promise<{ download_url: string; expires_at: string; count: number }> {
  return api.post('/users/export', { query });
}

export function usersQueryString(query: UserQuery): string {
  return qs(query as Record<string, QueryValue>);
}
