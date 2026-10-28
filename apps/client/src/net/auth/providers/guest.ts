/**
 * 游客进入：拿到受限会话（不能发媒体/建群），后续可升级为正式账号。
 */
import {
  mapAuthSession,
  type AuthApi,
  type AuthProvider,
  type AuthSession,
  type RawAuthSession,
} from '../provider';

export interface GuestRequest {
  nickname?: string;
}

export class GuestAuthProvider implements AuthProvider<GuestRequest, AuthSession> {
  readonly id = 'guest' as const;

  constructor(private readonly api: AuthApi) {}

  async request(input: GuestRequest = {}): Promise<AuthSession> {
    const raw = await this.api.post<RawAuthSession>('/api/auth/guest', {
      nickname: input.nickname?.trim() || undefined,
    });
    return mapAuthSession(raw);
  }
}
