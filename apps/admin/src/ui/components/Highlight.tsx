import { Fragment } from 'react';

/**
 * grep 命中高亮（docs/web-ui-spec.md §9.2）。大小写不敏感，多关键词空格分隔。
 * 用 <mark class="mark">（warning 100 阶底）而不是浏览器默认黄底，跟随暗色主题。
 */
export function Highlight({ text, query }: { text: string; query?: string }) {
  const terms = (query ?? '')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  if (terms.length === 0 || !text) return <>{text}</>;

  const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`(${escaped.join('|')})`, 'gi');
  const parts = text.split(re);
  const lowered = new Set(terms.map((t) => t.toLowerCase()));

  return (
    <>
      {parts.map((part, i) =>
        lowered.has(part.toLowerCase()) ? (
          <mark key={i} className="mark">
            {part}
          </mark>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}
