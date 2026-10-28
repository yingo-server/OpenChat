/**
 * 消息渲染器注册表（§2.2）。
 *
 * MessageList 只做虚拟滚动 + 长按菜单 + 滚动锚定；新增消息类型 =
 * 新文件实现 RendererProps + main.tsx 一行 registerRenderer，聊天窗不改。
 *
 * chrome:
 *  - bubble（默认）：渲染器内容放进 MessageBubble；
 *  - plain：无气泡（系统消息/日期提示），由渲染器自己布局。
 */
import type { ComponentType } from 'react';
import type { ChatMessage } from '../../core/types';

export interface RendererProps {
  message: ChatMessage;
}

export type MessageRenderer = ComponentType<RendererProps>;
export type RendererChrome = 'bubble' | 'plain';

interface RendererEntry {
  renderer: MessageRenderer;
  chrome: RendererChrome;
}

const renderers = new Map<string, RendererEntry>();

export function registerRenderer(
  type: string | number,
  renderer: MessageRenderer,
  options: { chrome?: RendererChrome } = {},
): () => void {
  const key = String(type);
  renderers.set(key, { renderer, chrome: options.chrome ?? 'bubble' });
  return () => {
    if (renderers.get(key)?.renderer === renderer) renderers.delete(key);
  };
}

export function getRenderer(type: string | number): MessageRenderer | undefined {
  return renderers.get(String(type))?.renderer;
}

export function getRendererChrome(type: string | number): RendererChrome {
  return renderers.get(String(type))?.chrome ?? 'bubble';
}

export function registeredRenderers(): string[] {
  return [...renderers.keys()];
}

export function clearRenderers(): void {
  renderers.clear();
}
