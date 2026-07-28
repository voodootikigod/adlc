import type { ReactNode } from 'react';

interface TerminalCardProps {
  title: string;
  children: ReactNode;
}

/**
 * A capture. Evidence keeps the terminal ground and the unmodified An Old Hope
 * palette wherever it appears, including on the record's paper surface — that
 * contrast is the argument, so it is not softened to match the page around it.
 *
 * The traffic-light dots are gone: they were window chrome imitating a terminal
 * app, and this is a captured stream, not a window.
 */
export function TerminalCard({ title, children }: TerminalCardProps) {
  return (
    <div className="rec-capture" style={{ background: '#1c1d21', border: '1px solid #34363d' }}>
      <div
        className="rec-capture-bar rec-mono flex items-center gap-3 px-3.5 py-2 text-[11px] tracking-[0.1em]"
        style={{ borderBottom: '1px solid #2c2e34', color: '#9093a0' }}
      >
        <span className="truncate text-[12px] tracking-normal">{title}</span>
      </div>
      <div
        className="rec-mono overflow-x-auto px-4 py-3.5 text-[12.5px] leading-[1.75]"
        style={{ color: '#cbcdd2' }}
      >
        {children}
      </div>
    </div>
  );
}
