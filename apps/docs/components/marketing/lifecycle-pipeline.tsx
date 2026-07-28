import { PHASES } from '@/lib/phase-graph.mjs';
import { theoryLink } from '@/lib/theory-links.mjs';
import { ExitCode } from './record';

// The approval chain.
//
// The section claims "a gate between every one", so the gate is the subject
// here, not the connector. Under the record world the chain is what it is in
// any change record: a ruled table with one row per control point, and a column
// naming what acts at that phase. The two human gates are simply the two rows
// where that is a person — the exception reads structurally, not as a colour.
//
// The column is deliberately headed "At this phase", not "Approver". An earlier
// version claimed the named CLI *enforced* that phase's exit gate, and for two
// rows that was not true: rails-guard enforces frozen rails rather than proving
// the suite is RED, and build-gate denies starting a build in a degraded session
// rather than validating the P4 build. Naming a tool that runs at a phase is
// true; naming it as the thing that closes the gate was a claim the toolkit does
// not back. The machine/person split is unaffected and remains the real thesis.
//
// Every name here must still dispatch — the page renders them as commands, and
// marketing-approvers.test.mjs asserts the dispatcher routes each one. That test
// checks the names are real, not that they enforce a gate; the weakened column
// header is what makes that the right assertion.
//
// There is deliberately no per-row evidence column: only some phases have an
// artifact whose filename can be stated as fact, and a column that is right six
// times out of eight is worse than no column. The manifest is named once, in the
// note beneath.

/** What acts at each phase. Human gates name a person; the rest name the tool. */
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

/**
 * `details` folds the per-phase annotation into the chain itself. The
 * /lifecycle page used to render a second eight-row table restating this one —
 * same identifiers, same names, same amber banding — to carry one sentence per
 * phase; on mobile that was the same table twice. The sentence belongs to the
 * row it annotates.
 */
export function LifecyclePipeline({ details }: { details?: Record<string, string> } = {}) {
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
          <div className="rec-legend px-3 py-2.5">At this phase</div>
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
                {/* The header row is display:none below md, so the collapsed
                    rows restate their legends inline — an unlabeled mono value
                    like "routed" carries nothing on its own. */}
                <span className="rec-legend mr-2 md:hidden">Exit gate</span>
                {phase.gate}
              </div>
              <div
                className="col-start-2 flex items-center px-3 pb-1 text-[13px] md:col-start-auto md:py-3.5 md:pb-3.5"
                style={{
                  color: phase.human ? 'var(--rec-gate-ink)' : 'var(--rec-ink-2)',
                  fontWeight: phase.human ? 600 : 400,
                }}
              >
                <span className="rec-legend mr-2 md:hidden" style={{ color: 'var(--rec-ink-3)' }}>
                  At this phase
                </span>
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
              {details?.[phase.id] ? (
                <div className="col-span-full px-3 pb-3.5 md:pl-[58px]">
                  <p className="max-w-[72ch] text-[13.5px] leading-[1.55]" style={{ color: 'var(--rec-ink-2)' }}>
                    {details[phase.id]}{' '}
                    <a
                      href={theoryLink(phase.id)}
                      aria-label={`${phase.name} essay`}
                      className="whitespace-nowrap text-[13px]"
                      style={{ color: 'var(--rec-link)', borderBottom: '1px solid var(--rec-link-edge)' }}
                    >
                      essay ↗
                    </a>
                  </p>
                </div>
              ) : null}
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
        {/* Same honesty the dials block already has: these chips are the form's
            worked example, not the output of a live run. */}
        <span className="rec-mono text-[12px]" style={{ color: 'var(--rec-ink-3)' }}>
          Verdicts shown are illustrative
        </span>
      </div>
    </div>
  );
}
