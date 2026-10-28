import { useState, type FormEvent } from 'react';
import { ApiError, auth, type LoginChallenge } from '../../api/client';
import { useAuth } from '../../auth';
import { errorMessage } from '../../lib/hooks';
import { IconAlert } from '../components/icons';

/**
 * 管理后台登录：账密 + TOTP 两步（security-spec A-4 强制 TOTP）。
 * 错误文案统一，不区分"账号不存在/密码错/TOTP 错"，避免撞库探测（A-2）。
 */
export function Login() {
  const { completeLogin } = useAuth();
  const [step, setStep] = useState<'password' | 'totp'>('password');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [challenge, setChallenge] = useState<LoginChallenge | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const describe = (err: unknown) => {
    if (err instanceof ApiError) {
      if (err.status === 401) return '账号或凭证不正确。连续失败将触发锁定（5 次 / 15 分钟）。';
      if (err.status === 429) return '尝试过于频繁，请稍后再试。';
      return `${err.code}: ${err.reason}`;
    }
    return errorMessage(err);
  };

  const submitPassword = async (event: FormEvent) => {
    event.preventDefault();
    if (!username.trim() || !password) {
      setError('请填写账号与密码');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await auth.login(username.trim(), password);
      if (result.session) {
        completeLogin(result.session);
        return;
      }
      if (!result.mfa_required || !result.mfa_ticket) {
        setError('服务端未返回 TOTP 挑战，请联系超级管理员检查管理员账号配置。');
        return;
      }
      setChallenge(result);
      setStep('totp');
      setPassword('');
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  };

  const submitTotp = async (event: FormEvent) => {
    event.preventDefault();
    if (!challenge?.mfa_ticket || code.length !== 6) {
      setError('请输入 6 位动态验证码');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const bundle = await auth.verifyTotp(challenge.mfa_ticket, code);
      completeLogin(bundle);
    } catch (err) {
      setError(describe(err));
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-full items-center justify-center bg-bg-page px-4 py-10">
      <div className="w-full max-w-[400px]">
        <div className="mb-6 flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-md bg-primary-500 text-body font-bold text-text-inverse">
            OC
          </span>
          <div>
            <h1 className="text-title text-text-primary">OpenChat 管理后台</h1>
            <p className="text-body-sm text-text-tertiary">仅限授权管理员访问，所有操作均记入审计日志</p>
          </div>
        </div>

        <div className="card card-pad shadow-md">
          {step === 'password' ? (
            <form onSubmit={submitPassword} className="space-y-4" aria-label="账号密码登录">
              <div>
                <label className="label" htmlFor="username">
                  管理员账号
                </label>
                <input
                  id="username"
                  className="input"
                  autoComplete="username"
                  autoFocus
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  placeholder="admin"
                />
              </div>
              <div>
                <label className="label" htmlFor="password">
                  密码
                </label>
                <input
                  id="password"
                  className="input"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="••••••••"
                />
              </div>
              {error && <ErrorLine message={error} />}
              <button type="submit" className="btn btn-primary w-full" disabled={busy}>
                {busy ? '校验中…' : '下一步：动态验证码'}
              </button>
            </form>
          ) : (
            <form onSubmit={submitTotp} className="space-y-4" aria-label="两步验证">
              <div className="rounded-md bg-bg-surface-2 px-3 py-2 text-body-sm text-text-secondary">
                账号 <span className="font-semibold text-text-primary">{username}</span> 的密码已校验，请输入认证器中的 6 位动态验证码。
              </div>
              <div>
                <label className="label" htmlFor="totp">
                  动态验证码
                </label>
                <input
                  id="totp"
                  className="input nums text-center text-title tracking-[0.5em]"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  autoFocus
                  value={code}
                  onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="000000"
                  style={{ height: 44 }}
                />
              </div>
              {error && <ErrorLine message={error} />}
              <button type="submit" className="btn btn-primary w-full" disabled={busy || code.length !== 6}>
                {busy ? '验证中…' : '登录'}
              </button>
              <button
                type="button"
                className="btn btn-ghost w-full"
                onClick={() => {
                  setStep('password');
                  setChallenge(null);
                  setCode('');
                  setError(null);
                }}
                disabled={busy}
              >
                返回上一步
              </button>
            </form>
          )}
        </div>

        <p className="mt-4 text-center text-caption text-text-tertiary">
          登录失败 5 次锁定 15 分钟，再次 5 次锁定 1 小时（security-spec A-1）
        </p>
      </div>
    </div>
  );
}

function ErrorLine({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2 rounded-sm bg-danger-50 px-3 py-2 text-body-sm text-danger-700" role="alert">
      <IconAlert size={16} className="mt-0.5 shrink-0" />
      <span>{message}</span>
    </div>
  );
}
