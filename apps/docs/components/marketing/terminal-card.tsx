import type { ReactNode } from 'react';

interface TerminalCardProps {
  title: string;
  children: ReactNode;
}

export function TerminalCard({ title, children }: TerminalCardProps) {
  return (
    <div
      className="overflow-hidden rounded-lg border"
      style={{ borderColor: '#3f4044', background: '#26272c' }}
    >
      <div
        className="flex items-center gap-3 border-b px-4 py-2.5 font-mono text-xs"
        style={{ borderColor: '#3f4044', color: 'var(--mk-muted)' }}
      >
        <span aria-hidden className="flex select-none gap-1.5">
          <span className="h-2 w-2 rounded-full" style={{ background: '#3f4044' }} />
          <span className="h-2 w-2 rounded-full" style={{ background: '#3f4044' }} />
          <span className="h-2 w-2 rounded-full" style={{ background: '#3f4044' }} />
        </span>
        <span className="truncate">{title}</span>
      </div>
      <div className="overflow-x-auto p-4 font-mono text-sm leading-relaxed">{children}</div>
    </div>
  );
}
