/**
 * 应用外壳：hash 路由 + 会话列表/聊天窗两栏（移动单栏）+ 登录/封禁门禁。
 * 移动端进入聊天后卸载会话列表（虚拟列表销毁），返回时重建。
 */
import { useEffect } from 'react';
import { useRoute, navigate, matchChat } from './router';
import { useSessionStore } from '../core/stores/session-store';
import { ConvList } from './views/conv-list/ConvList';
import { ChatView } from './views/chat/ChatView';
import { Settings } from './views/settings/Settings';
import { Banned } from './views/banned/Banned';
import { LoginScreen } from './views/login/LoginScreen';
import { Toaster } from './components/Toast';
import { CallOverlay } from './views/call/CallOverlay';

export function App() {
  const path = useRoute();
  const status = useSessionStore((state) => state.status);

  useEffect(() => {
    if (status === 'banned') {
      if (path !== '/banned') navigate('/banned');
      return;
    }
    if (status === 'anonymous') {
      if (path !== '/login') navigate('/login');
      return;
    }
    if (path === '/' || path === '/login' || path === '/banned') navigate('/chats');
  }, [status, path]);

  if (status === 'banned') {
    return (
      <>
        <Banned />
        <Toaster />
      </>
    );
  }

  if (status === 'anonymous') {
    return (
      <>
        <LoginScreen />
        <Toaster />
      </>
    );
  }

  if (path === '/settings') {
    return (
      <>
        <Settings />
        <Toaster />
      </>
    );
  }

  const convId = matchChat(path);
  const chatOpen = convId !== null;

  return (
    <div className="flex h-[100dvh] overflow-hidden bg-page">
      <ConvList
        className={`${chatOpen ? 'hidden tablet:flex' : 'flex'} w-full shrink-0 border-e border-line tablet:w-sidebar`}
      />
      <main
        className={`${chatOpen ? 'flex' : 'hidden tablet:flex'} min-h-0 min-w-0 flex-1 flex-col`}
        aria-label={chatOpen ? undefined : 'chat'}
      >
        <ChatView convId={chatOpen ? convId : null} />
      </main>
      <CallOverlay />
      <Toaster />
    </div>
  );
}
