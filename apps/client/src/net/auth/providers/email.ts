/**
 * 邮箱魔法链接登录。
 * request(email) 发链接 → 前端轮询 verify(email, challengeId) 直到回跳成功。
 */
import {
  mapAuthChallenge,
  mapAuthSession,
  type AuthApi,
  type AuthChallenge,
  type AuthProvider,
  type AuthSession,
  type RawAuthChallenge,
  type RawAuthSession,
} from '../provider';

export interface EmailRequest {
  email: string;
}

export interface EmailVerifyInput {
  email: string;
  challengeId: string;
}

export class EmailAuthProvider implements AuthProvider<EmailRequest, AuthChallenge> {
  readonly id = 'email' as const;

  constructor(private readonly api: AuthApi) {}

  async request(input: EmailRequest): Promise<AuthChallenge> {
    const raw = await this.api.post<RawAuthChallenge>('/api/auth/email/link', {
      email: normalizeEmail(input.email),
    });
    return mapAuthChallenge(raw);
  }

  /** 回跳/轮询换取会话；未点击链接时后端返回 202 → AuthError(code=PENDING)。 */
  async verify(input: EmailVerifyInput): Promise<AuthSession> {
    const raw = await this.api.post<RawAuthSession>('/api/auth/email/poll', {
      email: normalizeEmail(input.email),
      challenge_id: input.challengeId,
    });
    return mapAuthSession(raw);
  }
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(normalizeEmail(email));
}
