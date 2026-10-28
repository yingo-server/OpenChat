import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { auth, cachedIdentity, clearSession, getAccessToken, saveSession, type AdminIdentity, type TokenBundle } from './api/client';

interface AuthState {
  status: 'loading' | 'anon' | 'authed';
  admin: AdminIdentity | null;
}

interface AuthContextValue extends AuthState {
  completeLogin: (bundle: TokenBundle) => void;
  logout: () => Promise<void>;
  refreshIdentity: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * 会话引导：access token 在 sessionStorage（关标签即失效），refresh 走 httpOnly cookie。
 * 启动时用 /auth/me 校验，避免拿着过期 token 渲染出错页面。
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>(() =>
    getAccessToken() ? { status: 'loading', admin: cachedIdentity() } : { status: 'anon', admin: null },
  );

  useEffect(() => {
    let cancelled = false;
    if (!getAccessToken()) return undefined;
    auth
      .me()
      .then((admin) => {
        if (!cancelled) setState({ status: 'authed', admin });
      })
      .catch(() => {
        clearSession();
        if (!cancelled) setState({ status: 'anon', admin: null });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const completeLogin = useCallback((bundle: TokenBundle) => {
    saveSession(bundle);
    setState({ status: 'authed', admin: bundle.admin });
  }, []);

  const logout = useCallback(async () => {
    await auth.logout().catch(() => undefined);
    setState({ status: 'anon', admin: null });
  }, []);

  const refreshIdentity = useCallback(async () => {
    const admin = await auth.me();
    setState({ status: 'authed', admin });
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ ...state, completeLogin, logout, refreshIdentity }),
    [state, completeLogin, logout, refreshIdentity],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth 必须在 AuthProvider 内使用');
  return ctx;
}
