/**
 * UI 运行时服务单例：main.tsx 注入真实实例，组件只消费接口。
 * 依赖方向：ui → net（类型），不反向。
 */
import { createHttpAuthApi, type AuthApi, type AuthSession } from '../../net/auth/provider';
import type { Outbox } from '../../net/sync/outbox';
import type { SyncCache } from '../../net/cache/idb';
import type { SyncEngine } from '../../net/sync/engine';
import type { NetClient } from '../../net/transport/types';

export interface AppServices {
  outbox: Outbox | null;
  engine: SyncEngine | null;
  cache: SyncCache | null;
  client: NetClient | null;
  authApi: AuthApi;
  authenticate(session: AuthSession): void;
  logout(): void;
}

const fallback: AppServices = {
  outbox: null,
  engine: null,
  cache: null,
  client: null,
  authApi: createHttpAuthApi(),
  authenticate: () => {
    console.warn('[services] authenticate called before bootstrap');
  },
  logout: () => {
    console.warn('[services] logout called before bootstrap');
  },
};

let current: AppServices = fallback;

export function setAppServices(next: Partial<AppServices>): void {
  current = { ...current, ...next };
}

export function getAppServices(): AppServices {
  return current;
}

export function retrySend(localId: string): void {
  current.outbox?.retry(localId);
}

export function discardSend(localId: string): void {
  current.outbox?.discard(localId);
}
