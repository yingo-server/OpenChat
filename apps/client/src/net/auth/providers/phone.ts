/**
 * 手机号 + 短信验证码登录。
 * 两阶段：request(phone) 发码 → verify(phone, code) 换取会话。
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

export interface PhoneRequest {
  phone: string;
}

export interface PhoneVerifyInput {
  phone: string;
  code: string;
  challengeId: string;
}

export class PhoneAuthProvider implements AuthProvider<PhoneRequest, AuthChallenge> {
  readonly id = 'phone' as const;

  constructor(private readonly api: AuthApi) {}

  async request(input: PhoneRequest): Promise<AuthChallenge> {
    const raw = await this.api.post<RawAuthChallenge>('/api/auth/phone/code', {
      phone: normalizePhone(input.phone),
    });
    return mapAuthChallenge(raw);
  }

  async verify(input: PhoneVerifyInput): Promise<AuthSession> {
    const raw = await this.api.post<RawAuthSession>('/api/auth/phone/verify', {
      phone: normalizePhone(input.phone),
      code: input.code,
      challenge_id: input.challengeId,
    });
    return mapAuthSession(raw);
  }
}

export function normalizePhone(phone: string): string {
  return phone.replace(/[\s-]/g, '');
}

/** 中国手机号；预留国际区号（+xxx 视为合法） */
export function isValidPhone(phone: string): boolean {
  const value = normalizePhone(phone);
  return /^1[3-9]\d{9}$/.test(value) || /^\+\d{6,15}$/.test(value);
}
