/**
 * 账号 + 密码登录；失败 5 次后后端要求图形验证码（captchaToken）。
 */
import {
  mapAuthSession,
  type AuthApi,
  type AuthProvider,
  type AuthSession,
  type RawAuthSession,
} from '../provider';

export interface PasswordRequest {
  account: string;
  password: string;
  captcha?: string;
  captchaToken?: string;
}

export class PasswordAuthProvider implements AuthProvider<PasswordRequest, AuthSession> {
  readonly id = 'password' as const;

  constructor(private readonly api: AuthApi) {}

  async request(input: PasswordRequest): Promise<AuthSession> {
    const raw = await this.api.post<RawAuthSession>('/api/auth/password', {
      account: input.account.trim(),
      password: input.password,
      captcha: input.captcha,
      captcha_token: input.captchaToken,
    });
    return mapAuthSession(raw);
  }
}
