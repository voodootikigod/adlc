import Link from 'next/link';
import type { Metadata } from 'next';
import { FAILURE_MODES } from '@/lib/failure-modes.mjs';
import { INTEGRATIONS } from '@/lib/integration-facts.mjs';
import { SERIES_BASE, theoryLink } from '@/lib/theory-links.mjs';
import { ALL_PACKAGES } from '@/lib/toolkit-packages.mjs';
import { SITE_URL } from '@/lib/routes.mjs';
import { MARKETING_GATES } from '@/lib/marketing-gates.mjs';
import { UNIVERSAL_INSTALL } from '@/lib/install-commands.mjs';
import { PHASES, HUMAN_GATE_IDS } from '@/lib/phase-graph.mjs';
import { InstallCommand } from '@/components/marketing/install-command';
import { LifecyclePipeline } from '@/components/marketing/lifecycle-pipeline';
import {
  Capture,
  Clause,
  ClauseTitle,
  ExhibitOutput,
  ExitCode,
  FieldBlock,
  RecordBody,
  RecordLink,
  RecordRail,
  Statement,
} from '@/components/marketing/record';

export const metadata: Metadata = {
  description:
    'The SDLC defends against human failure modes. Your agents fail differently. ADLC gives every phase an explicit exit contract: deterministic gates produce evidence, and human gates record attestation.',
};

/**
 * The direction contract. Emitted as a real HTML comment so it survives the
 * production build and can be audited against the render.
 */
const DIRECTION_CONTRACT = `<!--
IMPECCABLE DIRECTION CONTRACT — seed 54a31abe, direction/persuade, re-roll 1, assigned index 3.

THESIS: A change is only defensible if something backs it. This surface refuses the
enterprise dev-tool hero — headline, gradient, three feature cards — and is instead the
change record for adopting ADLC, where no claim of capability stands without an attached
exhibit. Argument (§1, §7) is allowed to be argument; anything the toolkit is said to DO
carries either a numbered exhibit or the name of the gate that produces it.

OWN-WORLD: The controlled-change record in its contemporary register. Cool paper
(#e7eaef) desaturated from An Old Hope's own foreground, hairline rules, fixed field
blocks, numbered clauses, an approver column, squared corners, no cards. Evidence stays
true terminal on #1c1d21 with the unmodified An Old Hope palette. Archivo (width axis at
panel scale) sets the record; Azeret Mono sets every identifier, exit code, and legend.

STORY: An engineer sees real commands and real exit codes and installs. A leader sees an
approval chain with an approver column and two named human attestations, and understands
there is an audit trail a non-engineer could read. Both act on the same honest account.

FIRST VIEWPORT: Terminal-dark masthead, then the record rail naming ADLC-CR-0001 and its
standing. A four-field header block. §1 STATEMENT sets the thesis at panel scale in narrow
Archivo. §2 IMPLEMENT carries the install command as the field's executable value — the
primary action, rendered as a ruled control on terminal ground, not a button.

FORM: Composition A of three rendered comps, chosen by the user over a chain-led and a
pinned claim/exhibit split. Staging: the record's own header-block-then-clauses sequence.
The paper/terminal inversion was confirmed by the user against staying dark throughout.
-->`;

const APP_STRUCTURED_DATA = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: 'ADLC Toolkit',
  applicationCategory: 'DeveloperApplication',
  operatingSystem: 'Node.js >= 18',
  url: `${SITE_URL}/toolkit`,
  license: 'https://github.com/voodootikigod/adlc/blob/main/LICENSE',
  offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
  description:
    'Zero-dependency CLIs that each enforce one machine-checkable gate of the Agentic Development Lifecycle.',
  sameAs: ['https://github.com/voodootikigod/adlc'],
};

export default function HomePage() {
  const machineGates = PHASES.length - HUMAN_GATE_IDS.length;

  return (
    <main>
      <div dangerouslySetInnerHTML={{ __html: DIRECTION_CONTRACT }} />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(APP_STRUCTURED_DATA) }}
      />

      <RecordRail
        items={[
          { k: 'Record', v: 'ADLC-CR-0001' },
          { k: '', v: 'Open — awaiting implementation', open: true },
          { k: 'Control points', v: PHASES.length },
          // ALL_PACKAGES is every published package, not a gate subset — the
          // data module draws no such distinction. Labelling it "gate CLIs"
          // would be a count the repository cannot back.
          { k: 'Packages', v: ALL_PACKAGES.length },
          { k: 'Human attestations', v: HUMAN_GATE_IDS.length },
        ]}
      />

      <RecordBody>
        <FieldBlock
          fields={[
            { label: 'Subject', value: 'Adopt the Agentic Development Lifecycle' },
            { label: 'Class', value: 'Process change · software delivery' },
            { label: 'Scope', value: 'macOS · Linux · Node 18+', mono: true },
            {
              // The installer mutates the machine, not just the repo: `npm install -g`
              // plus native plugins for each detected harness. Reverting the repo
              // cannot remove either, so the field says what a revert actually
              // covers rather than implying a clean one-command rollback.
              label: 'Back-out',
              value: 'revert the repo · uninstall the CLI separately',
              mono: true,
            },
          ]}
        />

        {/* §1 — the thesis, at panel scale */}
        <Clause
          n="1"
          label="Statement"
          title={
            <Statement>
              The SDLC defends against human failure.{' '}
              <span style={{ color: 'var(--rec-ink-2)' }}>Your agents fail differently.</span>
            </Statement>
          }
          lede={
            <>
              Models fail <b style={{ color: 'var(--rec-ink)' }}>confidently, quickly, and at scale</b> — a
              process built for forgetting and fatigue is not adequate for hallucination and reward hacking.
              ADLC gives every phase an explicit exit contract: deterministic gates leave machine-checkable
              evidence, and two human gates record attestation.
            </>
          }
        />

        {/* §2 — install is the record's executable field, not a call to action */}
        <Clause
          n="2"
          label="Implement"
          aside={
            <>
              <div className="rec-legend">Enforcement</div>
              <p className="mt-2 text-[12.5px] leading-[1.55]" style={{ color: 'var(--rec-ink-2)' }}>
                In-session hooks are best-effort and harness-dependent. The commit-time CI gate is the
                unbypassable control.
              </p>
            </>
          }
        >
          <InstallCommand command={UNIVERSAL_INSTALL} label="Install the toolkit and your agent integrations" />
          <p className="mt-3 max-w-[72ch] text-[13px] leading-[1.55]" style={{ color: 'var(--rec-ink-3)' }}>
            macOS and Linux, Node 18+. Then{' '}
            <code className="rec-mono" style={{ color: 'var(--rec-ink)' }}>
              adlc init
            </code>{' '}
            in your repository. Cursor and OpenCode need one manual step, which the installer prints —{' '}
            <RecordLink href="/integrations">see what gets installed</RecordLink>. Windows is not supported.
          </p>
        </Clause>

        {/* §3 — the approval chain: dense, after two airier clauses */}
        <Clause
          n="3"
          label="Chain"
          title={<ClauseTitle>Eight control points. A gate closes every one.</ClauseTitle>}
          lede={
            <>
              Each phase ends on an exit code: <b style={{ color: 'var(--rec-ink)' }}>0</b> passes,{' '}
              <b style={{ color: 'var(--rec-ink)' }}>1</b> is an operational error, and{' '}
              <b style={{ color: 'var(--rec-ink)' }}>2</b> means the gate refused. That is what makes the
              lifecycle executable in CI rather than aspirational in a wiki.
            </>
          }
        >
          <div className="mt-7">
            <LifecyclePipeline />
          </div>
          <p className="mt-6 text-[13px]">
            <RecordLink href="/lifecycle">Explore the phases and gates →</RecordLink>
          </p>
        </Clause>

        {/* §4 — The problem: the failure register */}
        <Clause
          n="4"
          label="The problem"
          title={<ClauseTitle>Eight ways agents fail. None of them human.</ClauseTitle>}
          lede="Each one is answered by a specific gate at a specific phase, which is the only reason the register is worth writing down."
        >
          <div className="mt-7" style={{ borderTop: '1px solid var(--rec-rule-strong)' }}>
            <div
              className="hidden grid-cols-[46px_minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,0.8fr)] md:grid"
              style={{ background: 'var(--rec-paper-sunk)', borderBottom: '1px solid var(--rec-rule-strong)' }}
            >
              <div className="rec-legend px-3 py-2.5" />
              <div className="rec-legend px-3 py-2.5">Failure mode</div>
              <div className="rec-legend px-3 py-2.5">How it shows up</div>
              <div className="rec-legend px-3 py-2.5">Answered by</div>
            </div>
            {Object.entries(FAILURE_MODES).map(([id, fm]) => (
              <div
                key={id}
                className="grid grid-cols-[46px_minmax(0,1fr)] gap-y-1 md:grid-cols-[46px_minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,0.8fr)] md:gap-y-0"
                style={{ borderBottom: '1px solid var(--rec-rule)', background: 'var(--rec-paper-raised)' }}
              >
                <div className="rec-mono px-3 py-3 text-[12px]" style={{ color: '#b4571a' }}>
                  {id}
                </div>
                <div className="px-3 py-3 text-[14.5px] font-semibold" style={{ color: 'var(--rec-ink)' }}>
                  {fm.name}
                </div>
                <div
                  className="col-start-2 px-3 pb-1 text-[13.5px] leading-[1.5] md:col-start-auto md:py-3 md:pb-3"
                  style={{ color: 'var(--rec-ink-2)' }}
                >
                  {fm.tagline}
                </div>
                <div className="rec-mono col-start-2 px-3 pb-3 text-[12.5px] md:col-start-auto md:py-3">
                  <span style={{ color: 'var(--rec-ink)' }}>{fm.defense.tool}</span>
                  <span style={{ color: 'var(--rec-ink-3)' }}> · {fm.defense.phase}</span>
                </div>
              </div>
            ))}
          </div>
          <p className="mt-6 text-[13px]">
            <RecordLink href="/failure-modes">See which gate kills each one →</RecordLink>
          </p>
        </Clause>
      </RecordBody>

      {/* §5 — the exhibits. A full-bleed terminal band: the record's proof, on
          the surface that produced it. This is the page's one tonal break. */}
      <section style={{ background: '#1c1d21', borderTop: '1px solid #000', borderBottom: '1px solid var(--rec-rule-strong)' }}>
        <div className="mx-auto max-w-[1180px] px-6 py-14 md:px-8 md:py-20">
          <div className="flex flex-col gap-x-6 md:flex-row">
            <div className="mb-4 shrink-0 md:mb-0 md:w-[104px] md:pt-1">
              <div className="rec-legend" style={{ color: '#686b78' }}>
                §5 Exhibits
              </div>
            </div>
            <div className="min-w-0 flex-1">
              <h2
                className="max-w-[36ch] text-[clamp(19px,2.1vw,26px)] font-bold tracking-[-0.018em]"
                style={{ color: '#cbcdd2' }}
              >
                Attached to this record: the gate, the question, and the verdict.
              </h2>
              <p className="mt-4 max-w-[72ch] text-[16px] leading-[1.55]" style={{ color: '#9093a0' }}>
                Two of these are refusals. They are here because a record that only attaches its passes is
                not evidence, it is marketing — and because a gate that never refuses is not a gate. The
                commands and the exit codes are real; the verdict line under each is the record's own
                one-line summary of the result, not a verbatim transcript of what the tool prints.
              </p>

              <div className="mt-8 grid gap-5 lg:grid-cols-2">
                {MARKETING_GATES.map((gate, i) => (
                  <figure key={gate.name}>
                    <figcaption className="mb-2.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      <b className="rec-mono text-[11px] font-semibold tracking-[0.1em]" style={{ color: '#cbcdd2' }}>
                        EXHIBIT 5.{i + 1}
                      </b>
                      <span className="text-[12.5px]" style={{ color: '#686b78' }}>
                        {gate.gate}
                      </span>
                    </figcaption>
                    <Capture
                      title={`adlc ${gate.name}`}
                      status={gate.state === 'pass' ? 'EXIT 0 — PASS' : 'EXIT 2 — REFUSED'}
                      fail={gate.state !== 'pass'}
                    >
                      <ExhibitOutput output={gate.output} />
                    </Capture>
                  </figure>
                ))}
              </div>

              <p className="mt-7 text-[13px]">
                <Link
                  href="/toolkit"
                  style={{ color: '#4fb4d8', borderBottom: '1px solid #2b5f74' }}
                >{`All ${ALL_PACKAGES.length} packages, grouped by phase →`}</Link>
              </p>
            </div>
          </div>
        </div>
      </section>

      <RecordBody>
        {/* §6 — integrations, compact after the dense band */}
        <Clause
          n="6"
          label="Applies to"
          title={<ClauseTitle>Native to the agent you already run.</ClauseTitle>}
          lede="Seven harnesses get a native integration. Everything else installs the skills catalog, which is skills only — no hooks, MCP, agents, or rail enforcement."
        >
          <div className="mt-7 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3" style={{ borderTop: '1px solid var(--rec-rule-strong)' }}>
            {INTEGRATIONS.map((integration) => (
              <Link
                key={integration.slug}
                href={`/integrations/${integration.slug}`}
                className="group px-4 py-4"
                style={{
                  borderBottom: '1px solid var(--rec-rule)',
                  borderRight: '1px solid var(--rec-rule)',
                  background: 'var(--rec-paper-raised)',
                }}
              >
                <p className="text-[14.5px] font-semibold" style={{ color: 'var(--rec-ink)' }}>
                  {integration.name}
                </p>
                <p className="mt-1.5 text-[13px] leading-[1.5]" style={{ color: 'var(--rec-ink-2)' }}>
                  {integration.tagline}
                </p>
              </Link>
            ))}
          </div>
        </Clause>

        {/* §7 — economics: the page's quiet passage, wide measure, one voice */}
        <Clause
          n="7"
          label="Economics"
          title={<ClauseTitle>Spend heavy at the ends, light in the middle.</ClauseTitle>}
        >
          <blockquote
            className="mt-7 max-w-[36ch] text-[clamp(21px,2.6vw,30px)] font-semibold leading-[1.22] tracking-[-0.02em]"
            style={{ color: 'var(--rec-ink)', borderLeft: '1px solid #ef7c2a', paddingLeft: 20 }}
          >
            The unit of account is cost per merged, verified change. Not tokens per developer per month.
          </blockquote>
          <p className="mt-7 max-w-[74ch] text-[15.5px] leading-[1.62]" style={{ color: 'var(--rec-ink-2)' }}>
            This is the SDLC inverted, because misbuilding is expensive and building is cheap. Review stops
            being the bottleneck, and it goes deeper than a human team could sustain anyway. Every merge
            carries an evidence manifest, so auditors get an answer without an engineer translating. Senior
            {/* Spelled out: a numeral mid-sentence reads as data, and this is prose.
                phase-diagram.test.mjs pins the count at two, so the word cannot drift. */}
            time goes to the two human gates instead of rubber-stamping diffs. And each
            run costs a little less than the last, as findings distill into lints and skills nobody has to
            learn twice.
          </p>
          <p className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px]">
            <RecordLink href={theoryLink('distill')}>The lifecycle gets cheaper ↗</RecordLink>
            <RecordLink href="/vs-sdlc">ADLC vs the enterprise SDLC →</RecordLink>
          </p>
        </Clause>
      </RecordBody>

      {/* §8 — the record's disposition: who signs off on rolling this out */}
      <section style={{ background: 'var(--rec-paper-sunk)', borderTop: '1px solid var(--rec-rule-strong)' }}>
        <div className="mx-auto max-w-[1180px] px-6 py-14 md:px-8 md:py-16">
          <div className="flex flex-col gap-x-6 md:flex-row">
            <div className="mb-4 shrink-0 md:mb-0 md:w-[104px] md:pt-1">
              <div className="rec-legend">§8 Disposition</div>
            </div>
            <div className="min-w-0 flex-1">
              <ClauseTitle>Rolling this out across an org?</ClauseTitle>
              <p className="mt-4 max-w-[72ch] text-[16px] leading-[1.55]" style={{ color: 'var(--rec-ink-2)' }}>
                Unreviewable agent output is an audit problem, not just an engineering problem. ADLC produces
                a gate-by-gate evidence trail your auditors can actually read, and{' '}
                {machineGates} of the {PHASES.length} gates need no human in the loop to produce it.
              </p>
              {/* The attestation block. A record ends in signatures, and these
                  two are the product's actual differentiator: the gates a
                  machine cannot close. Rendered as the ruled signature panel the
                  form uses in life, rather than left as a cell in the chain. */}
              <div className="mt-8 grid grid-cols-1 gap-px sm:grid-cols-2" style={{ background: 'var(--rec-rule)', border: '1px solid var(--rec-rule-strong)' }}>
                {PHASES.filter((p) => p.human).map((p) => (
                  <div key={p.id} className="px-4 pb-3 pt-3.5" style={{ background: 'var(--rec-gate-field)' }}>
                    <div className="rec-legend" style={{ color: 'var(--rec-gate-ink)' }}>
                      Attestation · {p.id} {p.name}
                    </div>
                    <p className="mt-2 text-[13.5px] leading-[1.5]" style={{ color: 'var(--rec-ink-2)' }}>
                      {p.id === 'P1'
                        ? 'Is this what I meant?'
                        : 'Is this what I meant, running?'}
                    </p>
                    <div className="mt-6 flex items-end justify-between gap-3">
                      <span
                        aria-hidden
                        className="h-px flex-1"
                        style={{ background: 'var(--rec-gate-edge)' }}
                      />
                      <span className="rec-mono text-[10px] tracking-[0.12em]" style={{ color: 'var(--rec-gate-ink)' }}>
                        SIGNED BY A PERSON
                      </span>
                    </div>
                  </div>
                ))}
              </div>

              <div className="mt-7 flex flex-wrap items-center gap-4">
                <Link
                  href="/enterprise"
                  className="rec-mono px-5 py-2.5 text-[11px] tracking-[0.14em]"
                  style={{ background: '#1c1d21', color: '#cbcdd2', border: '1px solid var(--rec-ink)' }}
                >
                  READ THE ROLLOUT →
                </Link>
                <span className="flex items-center gap-2.5 text-[13px]" style={{ color: 'var(--rec-ink-3)' }}>
                  <ExitCode verdict="attest" />
                  The other {machineGates} close without one
                </span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <div className="mx-auto max-w-[1180px] px-6 py-8 text-[12.5px] md:px-8" style={{ color: 'var(--rec-ink-3)' }}>
        ADLC gates this repository in its own CI — rails-guard on frozen paths, cross-model attestation on
        trust-root changes, and a mutation gate that refuses to report a kill rate when the baseline is red.{' '}
        <RecordLink href={`${SERIES_BASE}/series/adlc`}>The original essay series ↗</RecordLink>
        {/* The record framing is authored: the gate output is real, the record
            number is not a live ticket. Saying so costs one line and protects
            the credibility everything else on the page depends on. */}
        <span className="mt-2 block" style={{ color: 'var(--rec-ink-3)' }}>
          This page is laid out as a change record. The commands, exit codes, gate names, and counts are
          real. The verdict line in each exhibit is this record's one-line summary of the result rather
          than a verbatim transcript — <span className="rec-mono">adlc spec-lint</span> really prints a
          per-criterion table. <span className="rec-mono">ADLC-CR-0001</span> and its status are an
          illustrative framing, not a live ticket.
        </span>
      </div>
    </main>
  );
}
