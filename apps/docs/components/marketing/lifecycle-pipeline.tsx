import { PHASES } from '@/lib/phase-graph.mjs';

// The connector draws the gate the section title claims: rail, gate ring
// (pass token), rail, arrowhead. Decorative only — the list's aria-label
// carries the semantics.
function GateConnector() {
  return (
    <svg aria-hidden viewBox="0 0 44 12" className="mx-1 h-3 w-11 shrink-0">
      <line x1="1" y1="6" x2="15" y2="6" stroke="#3f4044" strokeWidth="1.5" />
      <circle cx="22" cy="6" r="3.5" fill="none" stroke="var(--adlc-pass)" strokeWidth="1.5" />
      <line x1="29" y1="6" x2="38" y2="6" stroke="#3f4044" strokeWidth="1.5" />
      <path
        d="M 35.5 2.5 L 40 6 L 35.5 9.5"
        fill="none"
        stroke="#3f4044"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// Designed component (not Mermaid) — data-driven from the tested PHASES
// module. Chips enter left-to-right; reduced-motion shows them statically
// (mk-gate-line guard in global.css).
export function LifecyclePipeline() {
  return (
    <ol
      className="flex flex-wrap items-center gap-y-4"
      aria-label="ADLC phases P0 through P7 with a gate after each phase"
    >
      {PHASES.map((p, i) => (
        <li
          key={p.id}
          className="mk-gate-line flex items-center"
          style={{ animationDelay: `${i * 0.08}s` }}
        >
          <span
            className="flex flex-col rounded-lg border px-4 py-3"
            style={{ borderColor: '#3f4044', background: '#26272c' }}
          >
            <span className="font-mono text-xs" style={{ color: '#4fb4d8' }}>{p.id}</span>
            <span className="whitespace-nowrap text-sm font-semibold" style={{ color: '#cbcdd2' }}>
              {p.name}
            </span>
          </span>
          {i < PHASES.length - 1 ? <GateConnector /> : null}
        </li>
      ))}
    </ol>
  );
}
