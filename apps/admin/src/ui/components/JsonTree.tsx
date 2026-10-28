import { useState, type ReactNode } from 'react';
import { IconChevronDown, IconChevronRight } from './icons';

/** 审计载荷的缩进树形视图：对象/数组可折叠，标量按类型着色。 */
export function JsonTree({ data }: { data: unknown }) {
  return (
    <div className="font-mono text-caption leading-5 text-text-secondary">
      <Node value={data} depth={0} name={null} isRoot />
    </div>
  );
}

function scalar(value: unknown): ReactNode {
  if (value === null) return <span className="text-text-tertiary">null</span>;
  if (typeof value === 'string') return <span className="break-all text-success-700">&quot;{value}&quot;</span>;
  if (typeof value === 'number') return <span className="nums text-info-600">{value}</span>;
  if (typeof value === 'boolean') return <span className="text-warning-700">{String(value)}</span>;
  return <span className="text-text-tertiary">{String(value)}</span>;
}

function isContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return typeof value === 'object' && value !== null;
}

function Node({
  value,
  depth,
  name,
  isRoot = false,
}: {
  value: unknown;
  depth: number;
  name: string | null;
  isRoot?: boolean;
}) {
  const [open, setOpen] = useState(depth < 2);

  if (!isContainer(value)) {
    return (
      <div className="flex gap-1" style={{ paddingLeft: isRoot ? 0 : 16 }}>
        {name !== null && <span className="shrink-0 text-text-primary">{name}:</span>}
        {scalar(value)}
      </div>
    );
  }

  const entries: Array<[string, unknown]> = Array.isArray(value)
    ? value.map((v, i) => [String(i), v] as [string, unknown])
    : Object.entries(value);
  const bracket = Array.isArray(value) ? ['[', ']'] : ['{', '}'];
  const label = Array.isArray(value) ? `Array(${entries.length})` : `${entries.length} keys`;

  if (entries.length === 0) {
    return (
      <div className="flex gap-1" style={{ paddingLeft: isRoot ? 0 : 16 }}>
        {name !== null && <span className="text-text-primary">{name}:</span>}
        <span className="text-text-tertiary">{bracket[0]}{bracket[1]}</span>
      </div>
    );
  }

  return (
    <div>
      <button
        type="button"
        className="flex w-full items-center gap-1 rounded-sm text-left hover:bg-bg-surface-2"
        style={{ paddingLeft: isRoot ? 0 : 16 }}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {open ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
        {name !== null && <span className="text-text-primary">{name}:</span>}
        <span className="text-text-tertiary">
          {bracket[0]} <span className="opacity-70">{label}</span>
        </span>
      </button>
      {open && (
        <div>
          {entries.map(([key, child]) => (
            <Node key={key} value={child} depth={depth + 1} name={Array.isArray(value) ? `[${key}]` : key} />
          ))}
          <div className="text-text-tertiary" style={{ paddingLeft: name === null ? 0 : 16 }}>
            {bracket[1]}
          </div>
        </div>
      )}
    </div>
  );
}
