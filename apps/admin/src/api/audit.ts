import { api, type QueryValue } from './client';

/**
 * 审计 journal 读=顺序游标流（docs §6）：
 *   GET /audit?since_id=<id>&limit=500  → id 升序返回，翻页唯一方式是 since_id。
 * 向前看（更新）：since_id = 已知最大 id。
 * 向后看（更早）：before_id = 已知最小 id（服务端反向取 N 条后正序返回）。
 */
export interface AuditEvent {
  id: number;
  ts: string;
  type: string;
  actor: { id: string; username: string };
  summary: string;
  /** 完整载荷：展开行时以树形渲染 */
  payload: Record<string, unknown>;
  request_id?: string;
  ip?: string;
  /** 哈希链前序，供审计链校验对齐 */
  prev_hash?: string;
}

export interface AuditPage {
  events: AuditEvent[];
  /** 下次拉取起点：本批最大 id */
  next_since_id: number;
  /** 本批最小 id，用于向后加载 */
  first_id: number;
  has_more: boolean;
}

export interface AuditQuery {
  since_id?: number;
  before_id?: number;
  limit?: number;
  /** 事件类型前缀，如 ["user.", "report."] */
  types?: string[];
  q?: string;
  from?: string;
  to?: string;
}

export function fetchAudit(query: AuditQuery, signal?: AbortSignal): Promise<AuditPage> {
  return api.get<AuditPage>('/audit', query as Record<string, QueryValue>, signal);
}

/** 事件类型清单（下拉过滤用），由冷库 sys.audit_log 的 distinct type 提供。 */
export function auditTypes(signal?: AbortSignal): Promise<string[]> {
  return api.get<string[]>('/audit/types', undefined, signal);
}

/** 链条校验（每月 cron + 手动）；断链即 audit_chain_broken=1 告警。 */
export interface ChainVerifyResult {
  ok: boolean;
  checked: number;
  broken_at?: number;
  verified_at: string;
}

export function verifyChain(): Promise<ChainVerifyResult> {
  return api.post<ChainVerifyResult>('/audit/verify', {});
}
