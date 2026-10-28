import { useEffect, useState, type ReactNode } from 'react';
import { cn } from '../../lib/format';
import { IconX } from '../components/icons';
import { SideNav } from './SideNav';
import { TopBar } from './TopBar';
import { findNav } from './nav';

const COLLAPSE_KEY = 'oc.admin.nav.collapsed';

/**
 * 后台外壳（docs/web-ui-spec.md §9）：
 * 左侧 240px 固定导航（可收窄 64px）+ 顶栏 56px + 内容区 24px；
 * <1024px 导航变抽屉（后台最低支持 768 平板横屏，不做移动端小屏优化）。
 */
export function Shell({
  path,
  onNavigate,
  children,
}: {
  path: string;
  onNavigate: (path: string) => void;
  children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
    } catch {
      /* 忽略 */
    }
  }, [collapsed]);

  useEffect(() => {
    setDrawerOpen(false);
  }, [path]);

  const item = findNav(path);

  return (
    <div className="flex h-full overflow-hidden bg-bg-page">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-tooltip focus:rounded-md focus:bg-bg-elevated focus:px-3 focus:py-2"
      >
        跳到主内容
      </a>

      <aside
        className="hidden shrink-0 transition-[width] duration-normal ease-out lg:block"
        style={{ width: collapsed ? 64 : 240 }}
      >
        <SideNav
          current={path}
          collapsed={collapsed}
          onNavigate={onNavigate}
          onToggleCollapsed={() => setCollapsed((v) => !v)}
        />
      </aside>

      {drawerOpen && (
        <div className="fixed inset-0 z-drawer lg:hidden">
          <div className="absolute inset-0 bg-scrim/40" onClick={() => setDrawerOpen(false)} aria-hidden />
          <div className="absolute left-0 top-0 h-full w-side-nav shadow-lg">
            <SideNav
              current={path}
              collapsed={false}
              onNavigate={(next) => {
                onNavigate(next);
                setDrawerOpen(false);
              }}
              onToggleCollapsed={() => setDrawerOpen(false)}
            />
            <button
              type="button"
              className="btn btn-secondary btn-sm absolute -right-3 top-3 shadow-md"
              onClick={() => setDrawerOpen(false)}
              aria-label="关闭导航"
            >
              <IconX size={14} />
            </button>
          </div>
        </div>
      )}

      <div className={cn('flex min-w-0 flex-1 flex-col')}>
        <TopBar item={item} onOpenNav={() => setDrawerOpen(true)} />
        <main id="main-content" className="min-h-0 flex-1 overflow-y-auto p-6">
          <div className="mx-auto h-full max-w-[1600px]">{children}</div>
        </main>
      </div>
    </div>
  );
}
