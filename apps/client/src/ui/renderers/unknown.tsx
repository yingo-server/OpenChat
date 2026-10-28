/**
 * 未知消息类型：旧客户端向前兼容（"暂不支持的消息类型"）。
 */
import { t } from '../i18n';
import { AlertIcon } from '../components/icons';
import type { RendererProps } from './registry';

export function UnknownMessage({ message }: RendererProps) {
  return (
    <span className="flex items-center gap-2 text-body-sm text-ink-tertiary">
      <AlertIcon size={16} />
      <span>{t('chat.unsupported')}</span>
      <span className="nums text-caption opacity-70">{t('chat.unsupportedType', { type: message.type })}</span>
    </span>
  );
}
