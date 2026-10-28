import { api, type QueryValue } from './client';
import type { DryRunResult, MutateResult, Page } from './types';

export type ReportStatus = 'pending' | 'handling' | 'handled' | 'escalated';
export type ReportPriority = 'p0' | 'p1' | 'p2';
export type ReportTarget = 'message' | 'user' | 'conversation';

/** 举报证据（加密保全，不随普通删除流程清除，docs/admin-guide.md 合规要点）。 */
export interface ReportEvidence {
  message_id: string;
  conv_id: string;
  conv_name: string;
  sender_id: string;
  excerpt: string;
  sent_at: string;
  media?: { kind: 'image' | 'video' | 'file'; url: string; sha256: string }[];
}

export interface Report {
  id: string;
  target_type: ReportTarget;
  target_id: string;
  reporter_id: string;
  reason_code: string;
  reason_text: string;
  status: ReportStatus;
  priority: ReportPriority;
  created_at: string;
  /** 普通 24h，涉未成年人/人身威胁 2h（admin-guide） */
  sla_due_at: string;
  assignee: string | null;
  evidence: ReportEvidence[];
}

export interface ReportQuery {
  status?: ReportStatus | 'open' | 'all';
  priority?: ReportPriority | 'all';
  q?: string;
  page?: number;
  per_page?: number;
}

export function listReports(query: ReportQuery, signal?: AbortSignal): Promise<Page<Report>> {
  return api.get<Page<Report>>('/reports', query as Record<string, QueryValue>, signal);
}

export function getReport(id: string, signal?: AbortSignal): Promise<Report> {
  return api.get<Report>(`/reports/${encodeURIComponent(id)}`, undefined, signal);
}

export type HandleAction = 'dismiss' | 'warn' | 'remove_content' | 'mute' | 'ban';

export interface HandleRequest {
  action: HandleAction;
  note: string;
  /** mute/ban 的时长；ban 永久传 null */
  duration_days?: number | null;
  notify_user: boolean;
  /** 二次 TOTP（高危操作单独 10 op/min 且需二次确认，security-spec A-3） */
  totp_code?: string;
}

export function handleReport(
  id: string,
  body: HandleRequest,
  opts: { dryRun?: boolean } = {},
): Promise<MutateResult | DryRunResult> {
  return api.post(`/reports/${encodeURIComponent(id)}/handle`, body, {
    query: opts.dryRun ? { dry_run: true } : undefined,
  }) as Promise<MutateResult | DryRunResult>;
}

export function assignReport(id: string, assignee: string): Promise<MutateResult> {
  return api.post<MutateResult>(`/reports/${encodeURIComponent(id)}/assign`, { assignee });
}

export const REPORT_REASON_LABELS: Record<string, string> = {
  spam: '垃圾广告',
  abuse: '辱骂骚扰',
  minor: '涉未成年人',
  threat: '人身威胁',
  illegal: '违法内容',
  privacy: '侵犯隐私',
  other: '其他',
};

export const HANDLE_ACTION_LABELS: Record<HandleAction, string> = {
  dismiss: '驳回举报',
  warn: '警告用户',
  remove_content: '下架内容',
  mute: '禁言',
  ban: '封禁账号',
};
