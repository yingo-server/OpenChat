/**
 * 应用接线（composition root）——main.tsx 只负责注册与挂载，具体装配集中在这里。
 *
 * 依赖方向：本文件可 import net/core/ui；core/net 不可反向 import 本文件。
 */
import { openCache } from '../net/cache/idb';
import { SyncEngine, type SyncSink } from '../net/sync/engine';
import { Outbox, createLocalStoragePersistence } from '../net/sync/outbox';
import { createEnvelope } from '../net/proto/codec';
import { encodeSyncRequest } from '../net/proto/payload';
import { KINDS } from '../net/protocol/kinds';
import { dispatch } from '../net/protocol/dispatch';
import type { HandlerContext, HandlerRegistry, SessionPort, ConvPort, PresencePort, MessagePort } from '../net/protocol/registry';
import { WsClient } from '../net/transport/ws-client';
import type { NetClient } from '../net/transport/types';
import { TokenStore } from '../net/auth/token-store';
import { createHttpAuthApi, type AuthSession } from '../net/auth/provider';
import { MockBridge, createMockAuthApi, setActiveBridge } from '../net/mock/mockBridge';
import { useConnStore } from '../core/stores/conn-store';
import { useSessionStore } from '../core/stores/session-store';
import { useConvStore } from '../core/stores/conv-store';
import { useMessageStore } from '../core/stores/message-store';
import { usePresenceStore } from '../core/stores/presence-store';
import { navigate } from '../ui/router';
import { getThemePref, applyTheme, watchSystemTheme } from '../ui/theme';
import { toast } from '../ui/components/Toast';
import { t } from '../ui/i18n';
import { setAppServices } from '../ui/services/app-services';
import { callController } from '../net/call/controller';

const IS_MOCK = import.meta.env.VITE_MOCK === '1';

export async function bootstrap(registry: HandlerRegistry): Promise<void> {
  applyTheme(getThemePref());
  watchSystemTheme();

  const tokenStore = new TokenStore();
  const cache = await openCache();

  // 引用占位：sink.onGap 需要 client，而 client 需要 engine；两者在启动后才互相使用。
  let client: NetClient | null = null;

  const sink: SyncSink = {
    hydrate(data) {
      useConvStore.getState().hydrate(data.convs);
      useMessageStore.getState().hydrate(data.messages);
    },
    applyMessages(messages) {
      useMessageStore.getState().upsertMessages(messages);
    },
    applyTombstone(convId, msgId, seq, op) {
      useMessageStore.getState().applyTombstone(convId, msgId, seq, op);
    },
    applyEdit(convId, msgId, text) {
      useMessageStore.getState().applyEdit(convId, msgId, text);
    },
    setSyncState(convId, state) {
      useConvStore.getState().setSyncState(convId, state);
    },
    onGap(convId, gap) {
      // 缺帧 → 主动 SYNC_REQUEST（与 RESUME 共用同一 ingest 入口）
      if (!client) return;
      client.send(
        createEnvelope({
          kind: KINDS.SYNC_REQUEST,
          convId,
          payload: encodeSyncRequest({
            convId,
            sinceSeq: gap.from,
            limit: Math.min(200, Math.max(1, gap.to - gap.from + 1)),
          }),
        }),
      );
    },
    onError(error, context) {
      console.error(`[sync] ${context}`, error);
    },
  };

  const engine = new SyncEngine(cache, sink);
  await engine.hydrate();

  const outbox = new Outbox(
    {
      onOptimistic: (item) => useMessageStore.getState().applyOptimistic(item),
      onSending: () => undefined,
      onSent: (item, ack) => useMessageStore.getState().confirmLocal(item, ack),
      onFailed: (item, reason) => useMessageStore.getState().failLocal(item, reason),
      onRemoved: (localId) => useMessageStore.getState().removeLocal(localId),
      onQueueChange: () => undefined,
    },
    createLocalStoragePersistence(),
  );
  await outbox.load();

  useMessageStore.getState().setHistoryLoader((convId, limit, beforeSeq) =>
    cache.listMessages(convId, limit, beforeSeq),
  );

  // 会话元数据/未读/摘要随 store 变化落库（IndexedDB 为事实源，刷新后立即可渲染）
  useConvStore.subscribe((state, previous) => {
    if (state.convs === previous.convs) return;
    for (const [key, conv] of Object.entries(state.convs)) {
      if (previous.convs[Number(key)] !== conv) void cache.putConv(conv);
    }
  });

  // 会话恢复：UI 先离线渲染 IndexedDB，连接建立后增量收敛
  const stored = tokenStore.current;
  if (stored) {
    useSessionStore.getState().signIn(stored);
    useConvStore.getState().setSelfUserId(stored.userId);
    usePresenceStore.getState().setSelfUserId(stored.userId);
  }

  const mock = IS_MOCK ? new MockBridge() : null;
  if (mock) {
    client = mock;
    setActiveBridge(mock);
  } else {
    client = new WsClient({
      url: resolveWsUrl(),
      token: () => tokenStore.accessToken,
      deviceId: () => tokenStore.getDeviceId(),
      sessionId: () => tokenStore.sessionId,
      resumeTickets: () => engine.resumeTickets(),
      onFrame: () => undefined,
      format: 'json',
    });
  }
  const net = client;
  net.setResumeProvider(() => engine.resumeTickets());
  outbox.attach(net);

  const sessionPort: SessionPort = {
    get userId() {
      return useSessionStore.getState().userId;
    },
    setFlags: (flags, version) => useSessionStore.getState().setFlags(flags, version),
    kicked: (reason, bannedUntil) => {
      tokenStore.clear();
      useSessionStore.getState().kicked(reason, bannedUntil);
      net.stop();
      useMessageStore.getState().clear();
      useConvStore.getState().clear();
      engine.reset();
      void outbox.clear();
    },
    rateLimited: (scope, retryAfterMs) => {
      toast.show(t('toast.rateLimited', { seconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) }));
    },
    toast: (key, params) => toast.show(t(key, params)),
    flag: (key) => useSessionStore.getState().flags[key],
    flags: () => useSessionStore.getState().flags,
  };

  const convPort: ConvPort = {
    upsertFromWire: (payload) => useConvStore.getState().upsertFromWire(payload),
    setActive: (convId) => useConvStore.getState().setActive(convId),
  };

  const presencePort: PresencePort = {
    setStatus: (payload) => usePresenceStore.getState().setStatus(payload),
    setTyping: (convId, userId, typing, at) =>
      usePresenceStore.getState().setTyping(convId, userId, typing, at),
  };

  const messagePort: MessagePort = {
    applyReceipt: (convId, msgId, type, userId, at) =>
      useMessageStore.getState().applyReceipt(convId, msgId, type, userId, at),
  };

  const ctx: HandlerContext = {
    client: net,
    sync: engine,
    outbox,
    session: sessionPort,
    convs: convPort,
    presence: presencePort,
    messages: messagePort,
    navigate: (route) => navigate(route),
    toast: (key, params) => toast.show(t(key, params)),
  };

  net.onFrame((env) => dispatch(env, ctx, registry));
  net.onState((state, meta) => {
    useConnStore.getState().applyState(state, meta);
    outbox.handleState(state);
  });

  const authenticate = (session: AuthSession) => {
    const previousUser = useSessionStore.getState().userId;
    const storedSession = tokenStore.set(session);
    if (previousUser > 0 && previousUser !== session.userId) {
      // 切换账号：本机缓存与同步游标全部作废，避免串号
      void cache.clear().then(() => {
        useMessageStore.getState().clear();
        useConvStore.getState().clear();
        engine.reset();
        void outbox.clear();
      });
    }
    useSessionStore.getState().signIn(storedSession);
    useConvStore.getState().setSelfUserId(session.userId);
    usePresenceStore.getState().setSelfUserId(session.userId);
    navigate('/chats');
    if (net.state === 'offline') net.start();
  };

  const doLogout = async () => {
    net.stop();
    tokenStore.clear();
    useSessionStore.getState().signOut();
    useMessageStore.getState().clear();
    useConvStore.getState().clear();
    usePresenceStore.getState().clear();
    useConnStore.getState().reset();
    engine.reset();
    await outbox.clear();
    await cache.clear();
    navigate('/login');
  };

  setAppServices({
    outbox,
    engine,
    cache,
    client: net,
    authApi: IS_MOCK ? createMockAuthApi() : createHttpAuthApi(),
    authenticate,
    logout: () => {
      void doLogout();
    },
  });

  // 通话控制器的提示统一走全局 toast（net 层不直连 UI，用注入回调）。
  callController.onToast = (key) => toast.show(t(key));

  if (mock) {
    (window as Window & { __openchatMock?: unknown }).__openchatMock = {
      goOffline: () => mock.simulateOffline(),
      goOnline: () => mock.simulateOnline(),
    };
  }

  if (stored) net.start();
}

function resolveWsUrl(): string {
  const explicit = import.meta.env.VITE_WS_URL;
  if (explicit) return explicit;
  if (typeof location === 'undefined') return 'ws://localhost:8080/ws';
  if (import.meta.env.DEV) {
    return `ws://${location.hostname}:8080/ws`;
  }
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.host}/ws`;
}
