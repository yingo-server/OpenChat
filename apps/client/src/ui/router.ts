/**
 * 极简 hash 路由（无第三方依赖）：#/chats、#/chat/1、#/settings、#/login、#/banned。
 * 移动端三页用栈式语义（进入聊天后列表卸载）。
 */
import { useEffect, useState } from 'react';

export function currentPath(): string {
  const raw = typeof location === 'undefined' ? '' : location.hash.replace(/^#/, '');
  return raw.startsWith('/') ? raw : `/${raw}`.replace(/\/+/g, '/');
}

export function navigate(path: string): void {
  const next = path.startsWith('/') ? path : `/${path}`;
  if (typeof location === 'undefined') return;
  if (currentPath() === next) return;
  location.hash = next;
}

export function useRoute(): string {
  const [path, setPath] = useState<string>(() => currentPath());
  useEffect(() => {
    const handler = () => setPath(currentPath());
    window.addEventListener('hashchange', handler);
    return () => window.removeEventListener('hashchange', handler);
  }, []);
  return path;
}

export function matchChat(path: string): number | null {
  const match = /^\/chat\/(\d+)/.exec(path);
  if (!match) return null;
  const convId = Number(match[1]);
  return Number.isFinite(convId) && convId > 0 ? convId : null;
}

export function isChatRoute(path: string): boolean {
  return path.startsWith('/chat/');
}
