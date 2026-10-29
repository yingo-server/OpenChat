/**
 * Provider 统一接口：所有登录方式对 UI 暴露同一种形状。
 *
 *   request(input)  → AuthChallenge（需要二次验证）或 AuthSession（直接登录）
 *   verify?(input)  → AuthSession（phone OTP / email magic link）
 *
 * 新增登录方式（微信/Apple/一键登录）= 新增 providers/xxx.ts 实现本接口，
 * 登录页不需要为每种方式写分支逻辑。
 */

export type AuthProviderId = 'phone' | 'email' | 'password' | 'guest';

export interface AuthSession {
  token: string;
  refreshToken?: string;
  userId: number;
  /** authsvc 下发（= session_id）；多设备踢下线/RESUME 需要 */
  deviceId?: string;
  sessionId: string;
  expiresAt: number;
  /** 是否首次注册即登录（authsvc sessionResponse.is_new_user） */
  isNewUser?: boolean;
  profile?: {
    displayName?: string;
    avatar?: string;
  };
  guest?: boolean;
}

export interface AuthChallenge {
  challengeId: string;
  channel: 'sms' | 'email';
  /** 验证码/链接有效期（秒） */
  expiresIn: number;
  /** 重发冷却（秒） */
  resendAfter: number;
  hint?: string;
}

export interface AuthProvider<Request, Result = AuthSession | AuthChallenge> {
  readonly id: AuthProviderId;
  request(input: Request): Promise<Result>;
}

export interface AuthApi {
  post<T>(path: string, body: unknown): Promise<T>;
}

export class AuthError extends Error {
  readonly code: string;
  readonly retryAfterMs?: number;

  constructor(message: string, code = 'AUTH_FAILED', retryAfterMs?: number) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

export function isChallenge(value: AuthSession | AuthChallenge): value is AuthChallenge {
  return typeof (value as AuthChallenge).challengeId === 'string';
}

/**
 * 后端 snake_case 应答 → 前端领域对象（所有 provider 共用一份映射）。
 * 契约唯一权威：server/internal/authsvc/tokens.go sessionResponse
 * （user_id/device_id/access_token/token/refresh_token/expires_at/
 * expires_at_unix/session_id/guest/is_new_user/profile{display_name}）。
 * mockBridge 返回同形应答，双形态（snake/camel）兜底已删除。
 */
export interface RawAuthSession {
  token?: string;
  access_token?: string;
  refresh_token?: string;
  user_id?: number;
  device_id?: string;
  session_id?: string;
  expires_at?: number;
  expires_at_unix?: number;
  guest?: boolean;
  is_new_user?: boolean;
  profile?: { display_name?: string; avatar?: string };
}

export interface RawAuthChallenge {
  challenge_id?: string;
  channel?: 'sms' | 'email';
  expires_in?: number;
  resend_after?: number;
  hint?: string;
}

export function mapAuthSession(raw: RawAuthSession): AuthSession {
  const token = raw.token ?? raw.access_token ?? '';
  if (!token) throw new AuthError('登录应答缺少 token', 'BAD_RESPONSE');
  const profile = raw.profile
    ? { displayName: raw.profile.display_name, avatar: raw.profile.avatar }
    : undefined;
  return {
    token,
    refreshToken: raw.refresh_token,
    userId: Number(raw.user_id ?? 0),
    deviceId: raw.device_id,
    isNewUser: Boolean(raw.is_new_user),
    sessionId: raw.session_id ?? '',
    expiresAt: Number(raw.expires_at ?? Date.now() + 7 * 24 * 3600 * 1000),
    guest: Boolean(raw.guest),
    profile,
  };
}

export function mapAuthChallenge(raw: RawAuthChallenge): AuthChallenge {
  if (!raw.challenge_id) throw new AuthError('登录应答缺少 challenge_id', 'BAD_RESPONSE');
  return {
    challengeId: raw.challenge_id,
    channel: raw.channel ?? 'sms',
    expiresIn: Number(raw.expires_in ?? 300),
    resendAfter: Number(raw.resend_after ?? 60),
    hint: raw.hint,
  };
}


/** fetch 实现，baseUrl 为空时走同源（vite dev 由 proxy 转发）。 */
export function createHttpAuthApi(baseUrl = ''): AuthApi {
  return {
    async post<T>(path: string, body: unknown): Promise<T> {
      const response = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
        code?: string;
        retry_after_ms?: number;
      };
      if (!response.ok) {
        throw new AuthError(
          data.error ?? `request failed (${response.status})`,
          data.code ?? `HTTP_${response.status}`,
          data.retry_after_ms,
        );
      }
      return data as T;
    },
  };
}
