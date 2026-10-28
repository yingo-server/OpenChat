import { api, type QueryValue } from './client';
import type { MutateResult, Page } from './types';

export type BroadcastStatus = 'draft' | 'previewed' | 'scheduled' | 'sending' | 'sent' | 'failed';
export type AudienceType = 'all' | 'segment' | 'uids';

export interface BroadcastAudience {
  type: AudienceType;
  /** segment 时生效：如 "active_30d"、"not_banned" */
  segment?: string;
  uids?: string[];
}

export interface BroadcastDraft {
  id: string;
  title: string;
  body: string;
  audience: BroadcastAudience;
  status: BroadcastStatus;
  channel: 'inapp' | 'inapp_push';
  created_at: string;
  updated_at: string;
  scheduled_at: string | null;
  sent_at: string | null;
}

export interface BroadcastPreview {
  draft_id: string;
  estimated_recipients: number;
  estimated_skipped: number;
  /** 预计下发耗时（秒），超过 5 分钟提示管理员 */
  estimated_duration_sec: number;
  by_platform: Record<string, number>;
  sample_uids: string[];
  warnings: string[];
}

export interface DraftInput {
  title: string;
  body: string;
  audience: BroadcastAudience;
  channel: 'inapp' | 'inapp_push';
  scheduled_at?: string | null;
}

export function listDrafts(query: { status?: BroadcastStatus; page?: number; per_page?: number } = {}, signal?: AbortSignal) {
  return api.get<Page<BroadcastDraft>>('/broadcast/drafts', query as Record<string, QueryValue>, signal);
}

export function createDraft(body: DraftInput): Promise<BroadcastDraft> {
  return api.post<BroadcastDraft>('/broadcast/drafts', body);
}

export function updateDraft(id: string, body: Partial<DraftInput>): Promise<BroadcastDraft> {
  return api.patch<BroadcastDraft>(`/broadcast/drafts/${encodeURIComponent(id)}`, body);
}

/** dry_run=true：只预估触达人数，不发送、不产审计动作行（§8）。 */
export function previewDraft(id: string, signal?: AbortSignal): Promise<BroadcastPreview> {
  return api.get<BroadcastPreview>(`/broadcast/drafts/${encodeURIComponent(id)}/preview`, { dry_run: true }, signal);
}

export interface SendResult extends MutateResult {
  task_id: string;
  recipients: number;
  status: BroadcastStatus;
}

/** 发布需输入确认词（§9.3），确认词由服务端下发，避免前端硬编码。 */
export function sendDraft(id: string, confirmWord: string, totpCode?: string): Promise<SendResult> {
  return api.post<SendResult>(`/broadcast/drafts/${encodeURIComponent(id)}/send`, {
    confirm_word: confirmWord,
    totp_code: totpCode,
  });
}

export function cancelDraft(id: string): Promise<MutateResult> {
  return api.post<MutateResult>(`/broadcast/drafts/${encodeURIComponent(id)}/cancel`, {});
}
