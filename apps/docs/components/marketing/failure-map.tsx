import Link from 'next/link';
import { FAILURE_MODES } from '@/lib/failure-modes.mjs';

// Same visual language as the pipeline's GateConnector — rail, gate ring in
// the pass token, rail, arrowhead — stretched for the map's wider gap.
// Decorative only; the list's aria-label carries the semantics.
function DefenseConnector() {
  return (
    <svg aria-hidden viewBox="0 0 64 12" className="hidden h-3 w-16 shrink-0 md:block">
      <line x1="1" y1="6" x2="25" y2="6" stroke="#3f4044" strokeWidth="1.5" />
      <circle cx="32" cy="6" r="3.5" fill="none" stroke="var(--adlc-pass)" strokeWidth="1.5" />
      <line x1="39" y1="6" x2="58" y2="6" stroke="#3f4044" strokeWidth="1.5" />
      <path
        d="M 55.5 2.5 L 60 6 L 55.5 9.5"
        fill="none"
        stroke="#3f4044"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// F1–F8 on the left, the defending gate on the right — the core ADLC claim
// (every defense traces to a failure mode) made visual. One continuous
// hairline lattice (gap-px over the border color), not floating cards.
export function FailureMap() {
  return (
    <ul
      className="grid gap-px overflow-hidden rounded-lg border"
      style={{ borderColor: '#3f4044', background: '#3f4044' }}
      aria-label="Eight model failure modes F1 through F8, each mapped to the machine-checkable gate that defends against it"
    >
      {Object.entries(FAILURE_MODES).map(([id, fm], i) => (
        <li
          key={id}
          className="mk-gate-line grid items-center gap-x-6 gap-y-3 p-5 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]"
          style={{ background: '#26272c', animationDelay: `${i * 0.06}s` }}
        >
          <div>
            <span className="font-mono text-xs" style={{ color: 'var(--adlc-highlight)' }}>
              {id}
            </span>
            <p className="font-semibold" style={{ color: '#cbcdd2' }}>{fm.name}</p>
            <p className="mt-1 text-sm leading-relaxed" style={{ color: 'var(--mk-muted)' }}>
              {fm.tagline}
            </p>
          </div>
          <DefenseConnector />
          <div className="md:text-right">
            <Link
              href={`/docs/toolkit/${fm.defense.tool}`}
              className="font-mono font-semibold"
              style={{ color: '#4fb4d8' }}
            >
              {fm.defense.tool}
            </Link>
            <p className="mt-1 font-mono text-xs uppercase tracking-wider" style={{ color: 'var(--mk-muted)' }}>
              gate at {fm.defense.phase}
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
}
