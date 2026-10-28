/**
 * 系统消息渲染器：无气泡，居中 12px 灰字 + 胶囊底。
 * 直接由 MessageList 渲染，不经过 Bubble。
 */
import type { RendererProps } from './registry';

export function SystemMessage({ message }: RendererProps) {
  const text = typeof message.payload.text === 'string' ? message.payload.text : '';
  if (!text) return null;
  return (
    <div className="flex justify-center px-4 py-1.5">
      <span className="max-w-[80%] rounded-full bg-surface-2 px-3 py-1 text-center text-caption text-ink-tertiary">
        {text}
      </span>
    </div>
  );
}
