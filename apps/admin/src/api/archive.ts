import { api } from './client';
import type { DryRunResult } from './types';

/** 归档作业账本 archive_runs（冷库 sys.archive_runs，docs §5）。 */
export type RunStatus = 'running' | 'ok' | 'failed' | 'partial';

export interface ArchiveRun {
  id: number;
  started_at: string;
  finished_at: string | null;
  moved_rows: number;
  convs_touched: number;
  status: RunStatus;
  dry_run: boolean;
  error?: string;
}

export interface ArchiveStatus {
  running: boolean;
  current_run: ArchiveRun | null;
  last_run: ArchiveRun | null;
  next_run_at: string;
  hot_rows: number;
  hot_bytes: number;
  oldest_message_at: string | null;
  /** 热库最老数据与 cutoff 的差；>0 说明归档滞后 */
  lag_days: number;
  policy: {
    hot_retention_days: number;
    cron: string;
    batch_size: number;
  };
  cold_db: {
    reachable: boolean;
    latency_ms: number;
    error?: string;
  };
}

export function archiveStatus(signal?: AbortSignal): Promise<ArchiveStatus> {
  return api.get<ArchiveStatus>('/archive/status', undefined, signal);
}

export interface ArchiveRunRequest {
  /** 覆盖策略 cutoff（仅排障用，默认跟 policy.hot_retention_days） */
  older_than_days?: number;
  batch_size?: number;
}

/** 手动触发；运行中再触发返回 409（单飞保护）。dry_run=true 只估算。 */
export function runArchive(
  body: ArchiveRunRequest = {},
  opts: { dryRun?: boolean } = {},
): Promise<ArchiveRun | DryRunResult> {
  return api.post('/archive/run', body, {
    query: opts.dryRun ? { dry_run: true } : undefined,
  }) as Promise<ArchiveRun | DryRunResult>;
}

export function archiveHistory(limit = 20, signal?: AbortSignal): Promise<ArchiveRun[]> {
  return api.get<ArchiveRun[]>('/archive/runs', { limit }, signal);
}
