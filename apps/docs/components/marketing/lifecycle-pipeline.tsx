import { PHASES } from '@/lib/phase-graph.mjs';
import { ExitCode } from './record';

// The approval chain.
//
// The section claims "a gate between every one", so the gate is the subject
// here, not the connector. Under the record world the chain is what it is in
// any change record: a ruled table with one row per control point, an approver
// column, and a verdict. The two human gates are simply the two rows where the
// approver is a person — the exception reads structurally, not as a colour.
//
// Every approver below is a real CLI (or a person). There is deliberately no
// per-row evidence column: only some phases have an artifact whose filename can
// be stated as fact, and a column that is right six times out of eight is worse
// than no column. The manifest is named once, in the note beneath.

/**
 * The approver for each phase. Human gates name a person; the rest name the tool.
 *
 * Every machine approver here MUST be a real dispatchable tool — this component
 * tells the visitor these are executable, so a name that does not dispatch is a
 * broken promise, not a typo. P4 previously read `adlc gate`, which does not
 * exist: `packages/gate` is not a package and the dispatcher exits 1 on it. The
 * name was taken from an MCP tool called `adlc_gate`, which is not a CLI.
 * scripts/test/marketing-approvers.test.mjs now dispatches every one of these.
 */
export const APPROVER: Record<string, string> = {
  P0: 'adlc ticket',
  P1: 'A person',
  P2: 'adlc coldstart',
  P3: 'adlc rails-guard',
  P4: 'adlc build-gate',
  P5: 'adlc prosecute',
  P6: 'A person',
  P7: 'adlc lesson-foundry',
};

export function LifecyclePipeline() {
  return (
    <div>
      <div style={{ borderTop: '1px solid var(--rec-rule-strong)' }}>
        {/* Header row: the record's column legend. Columns never move. */}
        <div
          className="hidden grid-cols-[46px_minmax(0,1fr)_minmax(0,1.1fr)_minmax(0,1fr)_112px] md:grid"
          style={{ background: 'var(--rec-paper-sunk)', borderBottom: '1px solid var(--rec-rule-strong)' }}
        >
          <div className="rec-legend px-3 py-2.5" />
          <div className="rec-legend px-3 py-2.5">Control point</div>
          <div className="rec-legend px-3 py-2.5">Exit gate</div>
          <div className="rec-legend px-3 py-2.5">Approver</div>
          <div className="rec-legend px-3 py-2.5">Verdict</div>
        </div>

        <ol aria-label="The eight ADLC phases, each with the gate that ends it">
          {PHASES.map((phase, i) => (
            <li
              key={phase.id}
              className="rec-row-settle grid grid-cols-[46px_minmax(0,1fr)] items-center gap-y-1 md:grid-cols-[46px_minmax(0,1fr)_minmax(0,1.1fr)_minmax(0,1fr)_112px] md:gap-y-0"
              style={{
                animationDelay: `${i * 32}ms`,
                borderBottom: '1px solid var(--rec-rule)',
                background: phase.human ? 'var(--rec-gate-field)' : 'var(--rec-paper-raised)',
              }}
            >
              <div className="rec-mono px-3 py-3 text-[12px] md:py-3.5" style={{ color: 'var(--rec-ink-3)' }}>
                {phase.id}
              </div>
              <div
                className="px-3 py-3 text-[15px] font-semibold tracking-[-0.012em] md:py-3.5"
                style={{ color: 'var(--rec-ink)' }}
              >
                {phase.name}
              </div>
              <div
                className="rec-mono col-start-2 px-3 pb-1 text-[12.5px] md:col-start-auto md:py-3.5 md:pb-3.5"
                style={{ color: 'var(--rec-ink-2)' }}
              >
                {phase.gate}
              </div>
              <div
                className="col-start-2 flex items-center px-3 pb-1 text-[13px] md:col-start-auto md:py-3.5 md:pb-3.5"
                style={{
                  color: phase.human ? 'var(--rec-gate-ink)' : 'var(--rec-ink-2)',
                  fontWeight: phase.human ? 600 : 400,
                }}
              >
                {phase.human ? (
                  <span
                    aria-hidden
                    className="mr-2 inline-block h-[7px] w-[7px] shrink-0 rotate-45"
                    style={{ background: '#e5cd52', border: '1px solid var(--rec-gate-edge)' }}
                  />
                ) : null}
                {APPROVER[phase.id]}
              </div>
              <div className="col-start-2 px-3 pb-3 md:col-start-auto md:py-3.5 md:pb-3.5">
                {/* The verdict lands just after its row settles: the record
                    resolving, once. Kept short so a chip is never blank long
                    enough to read as missing data. */}
                <ExitCode verdict={phase.human ? 'attest' : 'pass'} stampDelay={i * 32 + 150} />
              </div>
            </li>
          ))}
        </ol>
      </div>

      {/* The legend earns its place: it states the ratio, which is the thesis. */}
      <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-2 text-[13.5px]" style={{ color: 'var(--rec-ink-2)' }}>
        <span className="flex items-center gap-2">
          <svg aria-hidden viewBox="0 0 12 12" className="h-3 w-3 shrink-0">
            <circle cx="6" cy="6" r="4" fill="none" stroke="var(--rec-pass-ink)" strokeWidth="1.5" />
          </svg>
          Six gates a machine can check
        </span>
        <span className="flex items-center gap-2">
          <svg aria-hidden viewBox="0 0 12 12" className="h-3 w-3 shrink-0">
            <path d="M6 1 L11 6 L6 11 L1 6 Z" fill="#e5cd52" stroke="var(--rec-gate-edge)" />
          </svg>
          Two a person has to close
        </span>
        <span className="rec-mono text-[12px]" style={{ color: 'var(--rec-ink-3)' }}>
          Evidence lands in .adlc/manifest.jsonl
        </span>
      </div>
    </div>
  );
}
