import { GateBadge } from './gate-badge';
import type { GateState } from './gate-badge';
import { MARKETING_GATES } from '@/lib/marketing-gates.mjs';

const SEQUENCE: ReadonlyArray<{ cmd: string; state: GateState; detail: string }> =
  MARKETING_GATES.map((gate) => ({
    cmd: gate.command,
    state: gate.state as GateState,
    detail: gate.detail,
  }));

// Staggered entrance is pure CSS (.mk-gate-line + animation-delay), so the
// prefers-reduced-motion guard in global.css shows all lines statically.
export function GateSequence() {
  return (
    <div
      className="flex flex-col gap-2"
      role="img"
      aria-label="Terminal showing executable ADLC gate commands and their example verdicts"
    >
      {SEQUENCE.map((line, i) => (
        <div
          key={line.cmd}
          className="mk-gate-line flex flex-wrap items-center gap-3 font-mono text-sm"
          style={{ animationDelay: `${0.5 + i * 0.7}s` }}
        >
          <span style={{ color: 'var(--mk-muted)' }}>$</span>
          <span style={{ color: '#cbcdd2' }}>{line.cmd}</span>
          <GateBadge state={line.state} />
          <span style={{ color: 'var(--mk-muted)' }}>{line.detail}</span>
        </div>
      ))}
      <div
        aria-hidden
        className="mk-gate-line flex items-center gap-3 font-mono text-sm"
        style={{ animationDelay: `${0.5 + SEQUENCE.length * 0.7}s` }}
      >
        <span style={{ color: 'var(--mk-muted)' }}>$</span>
        <span className="mk-pulse inline-block h-4 w-2" style={{ background: '#686b78' }} />
      </div>
    </div>
  );
}
