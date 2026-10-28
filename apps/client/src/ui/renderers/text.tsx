/**
 * 文本消息渲染器：保留换行、长串断行、编辑标记。
 */
import { t } from '../i18n';
import type { RendererProps } from './registry';

export function TextMessage({ message }: RendererProps) {
  const text = typeof message.payload.text === 'string' ? message.payload.text : '';
  return (
    <span className="bubble-text">
      {text}
      {message.editedAt ? (
        <span className="ms-1 align-baseline text-caption opacity-60">({t('chat.edited')})</span>
      ) : null}
    </span>
  );
}
