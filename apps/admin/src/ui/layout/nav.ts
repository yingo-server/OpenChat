import type { ComponentType } from 'react';
import {
  IconArchive,
  IconFlag,
  IconGauge,
  IconMegaphone,
  IconMessage,
  IconReport,
  IconScroll,
  IconUsers,
} from '../components/icons';

export interface NavItem {
  path: string;
  label: string;
  /** 顶栏面包屑的一级名 */
  group: string;
  icon: ComponentType<{ size?: number; className?: string }>;
  description: string;
}

/** 侧边导航顺序与 docs/web-ui-spec.md §9 一致，按运维场景分组。 */
export const NAV_GROUPS: Array<{ title: string; items: NavItem[] }> = [
  {
    title: '概览',
    items: [
      {
        path: '/dashboard',
        label: '仪表盘',
        group: '仪表盘',
        icon: IconGauge,
        description: '全局统计、实时事件流、健康矩阵',
      },
      {
        path: '/metrics',
        label: '数据面板',
        group: '数据面板',
        icon: IconGauge,
        description: '在线连接、队列水位、错误率',
      },
    ],
  },
  {
    title: '用户与内容',
    items: [
      {
        path: '/users',
        label: '用户管理',
        group: '用户管理',
        icon: IconUsers,
        description: '检索、封禁、解封、强制下线',
      },
      {
        path: '/reports',
        label: '举报处理',
        group: '举报处理',
        icon: IconReport,
        description: '举报队列与处置',
      },
      {
        path: '/messages',
        label: '消息检索',
        group: '消息检索',
        icon: IconMessage,
        description: '关键词/会话检索与撤回',
      },
    ],
  },
  {
    title: '运营',
    items: [
      {
        path: '/broadcast',
        label: '广播',
        group: '广播',
        icon: IconMegaphone,
        description: '草稿 → 预估触达 → 发送',
      },
      {
        path: '/flags',
        label: 'Flag 管理',
        group: 'Flag 管理',
        icon: IconFlag,
        description: 'feature flag 开关（即策略）',
      },
    ],
  },
  {
    title: '系统',
    items: [
      {
        path: '/audit',
        label: '审计日志',
        group: '审计日志',
        icon: IconScroll,
        description: 'journalctl 式顺序流',
      },
      {
        path: '/archive',
        label: '归档',
        group: '归档',
        icon: IconArchive,
        description: '热库 → 冷库作业',
      },
    ],
  },
];

export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

export function findNav(path: string): NavItem {
  return NAV_ITEMS.find((item) => item.path === path) ?? NAV_ITEMS[0]!;
}
