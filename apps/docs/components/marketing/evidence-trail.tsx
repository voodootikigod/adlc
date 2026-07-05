const STEPS = [
  { label: 'Ticket', detail: 'Executable spec, dials set at triage' },
  { label: 'Gates', detail: 'spec-lint · premortem · rails-guard · hollow-test · prosecute' },
  { label: 'gate-manifest', detail: 'Every verdict recorded as a machine-readable artifact' },
  { label: 'Merge', detail: 'Approved on evidence, not vibes' },
] as const;

// Rail, gate ring (pass token), rail, arrowhead — same connector grammar as
// the lifecycle pipeline. Decorative only; the ol's aria-label carries the
// semantics.
function TrailConnector() {
  return (
    <svg aria-hidden viewBox="0 0 44 12" className="mx-2 hidden h-3 w-11 shrink-0 md:block">
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

// Chain-of-custody diagram: how a change becomes auditable (spec §4 table).
// The mono index reads as custody paperwork — this is a real sequence, and
// order is the point.
export function EvidenceTrail() {
  return (
    <ol
      className="flex flex-col gap-2 md:flex-row md:items-stretch md:gap-0"
      aria-label="Evidence trail from ticket through gates and gate-manifest to merge"
    >
      {STEPS.map((s, i) => (
        <li
          key={s.label}
          className="mk-gate-line flex items-center md:flex-1"
          style={{ animationDelay: `${i * 0.12}s` }}
        >
          <div
            className="h-full flex-1 rounded-lg border p-4"
            style={{ borderColor: '#3f4044', background: '#26272c' }}
          >
            <p className="font-mono text-[10px] tracking-[0.2em]" style={{ color: 'var(--mk-muted)' }}>
              {String(i + 1).padStart(2, '0')}
            </p>
            <p className="mt-1 font-mono text-sm font-semibold" style={{ color: '#4fb4d8' }}>
              {s.label}
            </p>
            <p className="mt-1 text-xs leading-relaxed" style={{ color: 'var(--mk-muted)' }}>
              {s.detail}
            </p>
          </div>
          {i < STEPS.length - 1 ? <TrailConnector /> : null}
        </li>
      ))}
    </ol>
  );
}
