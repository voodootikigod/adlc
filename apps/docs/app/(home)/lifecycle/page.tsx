import type { Metadata } from 'next';
import Link from 'next/link';
import { PHASES, HUMAN_GATE_IDS } from '@/lib/phase-graph.mjs';
import { theoryLink } from '@/lib/theory-links.mjs';
import { MarketingSection } from '@/components/marketing/section';
import { LifecyclePipeline } from '@/components/marketing/lifecycle-pipeline';
import { ThreeDials } from '@/components/marketing/three-dials';

export const metadata: Metadata = {
  title: 'The Lifecycle: Phases and Gates',
  description:
    'Eight phases, P0–P7, each ending in a machine-checkable gate. The ADLC pipeline from triage to distillation.',
};

const PHASE_DETAIL: Record<string, string> = {
  P0: 'Triage the ticket: is this executable by an agent at all, and at what dial settings?',
  P1: 'Interrogate the spec until it is unambiguous. Human gate one.',
  P2: 'Decompose into cold-startable units that an agent with zero context can pick up.',
  P3: 'Rail the work: write and freeze the tests that define done.',
  P4: 'Build inside the rails. Supervision tooling watches for flailing and drift.',
  P5: 'Prosecute the change: prove the tests are load-bearing, not hollow.',
  P6: 'Review the evidence, not the diff. Human gate two.',
  P7: 'Distill what the review found into permanent, deterministic defenses.',
};

// Which phases end in a human gate now comes from phase-graph.mjs, the same
// source the pipeline reads. It used to be a second hand-maintained Set here,
// so this page and the diagram above it could have disagreed about which two
// gates are human — the one structural claim the section exists to make.
const HUMAN_GATES = new Set(HUMAN_GATE_IDS);

export default function LifecyclePage() {
  return (
    <main>
      <MarketingSection headingLevel={1} n="1" kicker="The chain" title="Eight phases. A gate between every one.">
        <LifecyclePipeline />

        {/* The detail sits as annotations to the chain above, not as a second
            grid of cards restating it. One row per control point, ruled. */}
        <dl className="mt-12" style={{ borderTop: '1px solid var(--rec-rule-strong)' }}>
          {PHASES.map((p) => (
            <div
              key={p.id}
              className="grid grid-cols-1 gap-x-6 px-1 py-4 md:grid-cols-[46px_150px_minmax(0,1fr)]"
              style={{
                borderBottom: '1px solid var(--rec-rule)',
                background: HUMAN_GATES.has(p.id) ? 'var(--rec-gate-field)' : undefined,
              }}
            >
              <dt className="rec-mono px-2 text-[12px]" style={{ color: 'var(--rec-ink-3)' }}>
                {p.id}
              </dt>
              <dt className="px-2 text-[15px] font-semibold" style={{ color: 'var(--rec-ink)' }}>
                {p.name}
                {HUMAN_GATES.has(p.id) ? (
                  <span className="rec-mono mt-1 block text-[10px] tracking-[0.12em]" style={{ color: 'var(--rec-gate-ink)' }}>
                    ◆ HUMAN GATE
                  </span>
                ) : null}
              </dt>
              <dd className="px-2 text-[14px] leading-[1.55]" style={{ color: 'var(--rec-ink-2)' }}>
                {PHASE_DETAIL[p.id]}
                <a
                  href={theoryLink(p.id)}
                  className="ml-2 whitespace-nowrap text-[13px]"
                  style={{ color: 'var(--rec-link)', borderBottom: '1px solid var(--rec-link-edge)' }}
                >
                  essay ↗
                </a>
              </dd>
            </div>
          ))}
        </dl>
      </MarketingSection>

      <MarketingSection n="2" kicker="Calibration" title="Three dials, set per ticket">
        <p className="mb-10 max-w-[72ch] text-[16px] leading-[1.55]" style={{ color: 'var(--rec-ink-2)' }}>
          Not every ticket deserves the same autonomy. You set three dials at triage,
          and the gates hold you to whatever you chose.
        </p>
        <ThreeDials />
        <p className="mt-8 flex flex-wrap gap-x-4 text-[13px]">
          <a href={theoryLink('three-dials')} style={{ color: 'var(--rec-link)', borderBottom: '1px solid var(--rec-link-edge)' }}>
            Read the original essay ↗
          </a>
          <Link href="/docs" style={{ color: 'var(--rec-link)', borderBottom: '1px solid var(--rec-link-edge)' }}>
            Full reference in the docs
          </Link>
        </p>
      </MarketingSection>
    </main>
  );
}
