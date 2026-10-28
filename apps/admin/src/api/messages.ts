import { api, type QueryValue } from './client';
import type { DryRunResult, MutateResult, Page } from './types';

export interface MessageHit {
  msg_id: string;
  conv_id: string;
  conv_name: string;
  sender_id: string;
  sender_name: string;
  content: string;
  sent_at: string;
  state: 'normal' | 'recalled' | 'deleted';
  attachments: { kind: string; name: string; size: number }[];
}

export interface MessageQuery {
  q?: string;
  /** 会话 id 精确过滤（与关键词可叠加） */
  conv?: string;
  sender?: string;
  from?: string;
  to?: string;
  page?: number;
  per_page?: number;
}

export function searchMessages(query: MessageQuery, signal?: AbortSignal): Promise<Page<MessageHit>> {
  return api.get<Page<MessageHit>>('/messages/search', query as Record<string, QueryValue>, signal);
}

export interface RecallRequest {
  reason: string;
  /** 全端撤回（含已下发到客户端的副本） */
  all_devices: boolean;
  notify_sender: boolean;
}

export function recallMessage(
  msgId: string,
  body: RecallRequest,
  opts: { dryRun?: boolean } = {},
): Promise<MutateResult | DryRunResult> {
  return api.post(`/messages/${encodeURIComponent(msgId)}/recall`, body, {
    query: opts.dryRun ? { dry_run: true } : undefined,
  }) as Promise<MutateResult | DryRunResult>;
}

/** 会话搜索下拉用（只返回 id + 名称） */
export interface ConvOption {
  id: string;
  name: string;
  member_count: number;
}

export function searchConversations(q: string, signal?: AbortSignal): Promise<ConvOption[]> {
  return api.get<ConvOption[]>('/conversations', { q, per_page: 20 }, signal);
}
