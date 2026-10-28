import { api } from './client';
import type { DryRunResult, MutateResult } from './types';

/** feature flag 即策略表（docs/admin-data-design.md §4），默认值见 server/internal/pkg/featureflags。 */
export type FlagValue = boolean | number | string;

export interface FeatureFlag {
  key: string;
  value: FlagValue;
  type: 'bool' | 'number' | 'string';
  description: string;
  /** true = 高危（registration/readonly 等），改动需二次确认 + 审计 */
  high_impact: boolean;
  updated_at: string;
  updated_by: string;
  version: number;
}

export function listFlags(signal?: AbortSignal): Promise<FeatureFlag[]> {
  return api.get<FeatureFlag[]>('/flags', undefined, signal);
}

export interface FlagUpdate {
  value: FlagValue;
  reason: string;
  /** 高危 flag 的确认词 = flag key */
  confirm?: string;
}

export function setFlag(
  key: string,
  body: FlagUpdate,
  opts: { dryRun?: boolean } = {},
): Promise<MutateResult | DryRunResult> {
  return api.patch(`/flags/${encodeURIComponent(key)}`, body, {
    query: opts.dryRun ? { dry_run: true } : undefined,
  }) as Promise<MutateResult | DryRunResult>;
}

/** flag 变更历史（走审计 journal，同一游标语义） */
export interface FlagChange {
  id: number;
  ts: string;
  key: string;
  from: FlagValue;
  to: FlagValue;
  actor: string;
}

export function flagHistory(key: string, signal?: AbortSignal): Promise<FlagChange[]> {
  return api.get<FlagChange[]>(`/flags/${encodeURIComponent(key)}/history`, { limit: 50 }, signal);
}
