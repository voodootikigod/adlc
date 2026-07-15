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
// The verdict detail sits below its command as a shell comment (dimmed like
// the install snippets in IntegrationCard): it explains a result, so it reads
// as output rather than intent. Keeping it off the command line also lets
// every command sit on one line at the section width.
export function GateSequence() {
  return (
    <div
      className="flex flex-col gap-4"
      role="img"
      aria-label="Terminal showing executable ADLC gate commands and their example verdicts"
    >
      {SEQUENCE.map((line, i) => (
        <div
          key={line.cmd}
          className="mk-gate-line flex flex-col gap-1 font-mono text-sm"
          style={{ animationDelay: `${0.5 + i * 0.7}s` }}
        >
          <div className="flex flex-wrap items-center gap-3">
            {/* The prompt is inline with the command so a wrapped command
                never strands a lone "$" on the line above. */}
            <span style={{ color: '#cbcdd2' }}>
              <span style={{ color: 'var(--mk-muted)' }}>$ </span>
              {line.cmd}
            </span>
            <GateBadge state={line.state} />
          </div>
          <span style={{ color: 'var(--mk-muted)' }}># {line.detail}</span>
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
