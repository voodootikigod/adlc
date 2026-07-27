import { PHASES } from '@/lib/phase-graph.mjs';

// The section claims "a gate between every one", so the gate is the subject
// here, not the connector. The previous version inverted that: phases were
// cards and gates were 3.5px rings in the gaps — the one thing the headline
// promised was the least visible thing on screen. It also wrapped 6+2 because
// flex-wrap sized cells to their content ("Rail" narrow, "Interrogate" wide),
// which left a connector arrow pointing at nothing at the end of row one.
//
// A fixed grid removes the ragged wrap by construction: 4×2, 2×4, then 1
// column, always even. Each phase carries its own exit gate, so there are no
// between-cell connectors left to break, and the eight gates are named rather
// than implied.

/** Machine gate: the ring glyph already used for a passing gate elsewhere. */
function MachineGateMark() {
  return (
    <svg aria-hidden viewBox="0 0 12 12" className="h-3 w-3 shrink-0">
      <circle cx="6" cy="6" r="4" fill="none" stroke="var(--adlc-pass)" strokeWidth="1.5" />
    </svg>
  );
}

/** Human gate: a filled diamond — a different shape, not just a different colour. */
function HumanGateMark() {
  return (
    <svg aria-hidden viewBox="0 0 12 12" className="h-3 w-3 shrink-0">
      <path d="M6 1 L11 6 L6 11 L1 6 Z" fill="var(--adlc-highlight)" />
    </svg>
  );
}

export function LifecyclePipeline() {
  return (
    <div>
      {/* gap-px over a border-coloured container is the hairline-grid pattern
          already used by the failure-mode grid on this page. It matters here
          for a second reason: /lifecycle renders this directly above a grid of
          phase DETAIL cards, and separate bordered cards read as the same
          content twice. Collapsing the cells into one continuous rail keeps
          this a map and leaves the cards below as the content. */}
      <div
        className="overflow-hidden rounded-lg border"
        style={{ borderColor: '#3f4044', background: '#3f4044' }}
      >
        <ol
          className="grid grid-cols-1 gap-px sm:grid-cols-2 lg:grid-cols-4"
          aria-label="The eight ADLC phases, each with the gate that ends it"
        >
          {PHASES.map((phase, i) => (
          <li
            key={phase.id}
            className="mk-gate-line flex flex-col px-4 py-3.5"
            style={{
              animationDelay: `${i * 0.06}s`,
              // Flat surface for every cell. A tint on the two human cells was
              // tried and removed: over this warm-grey it muddies toward brown
              // and reads as a warning state. The amber mark and label already
              // mark the exception, and one signal is enough.
              background: '#26272c',
            }}
          >
            <span className="font-mono text-xs" style={{ color: '#4fb4d8' }}>
              {phase.id}
            </span>
            <span className="mt-0.5 text-sm font-semibold" style={{ color: '#cbcdd2' }}>
              {phase.name}
            </span>

            <span className="mt-2.5 flex items-center gap-2">
              {phase.human ? <HumanGateMark /> : <MachineGateMark />}
              <span
                className="font-mono text-xs"
                style={{ color: phase.human ? 'var(--adlc-highlight)' : 'var(--mk-muted)' }}
              >
                {phase.gate}
              </span>
            </span>
          </li>
          ))}
        </ol>
      </div>

      {/* The legend earns its place: it states the ratio, which is the thesis. */}
      <p className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm" style={{ color: 'var(--mk-muted)' }}>
        <span className="flex items-center gap-2">
          <MachineGateMark />
          Six gates a machine can check
        </span>
        <span className="flex items-center gap-2">
          <HumanGateMark />
          Two a person has to close
        </span>
      </p>
    </div>
  );
}
