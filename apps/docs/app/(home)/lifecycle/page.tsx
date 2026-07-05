import type { Metadata } from 'next';
import Link from 'next/link';
import { PHASES } from '@/lib/phase-graph.mjs';
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

// The two phases whose gate is a human, per PHASE_DETAIL — tagged so the
// grid encodes the "two human gates" structure at a glance.
const HUMAN_GATES = new Set(['P1', 'P6']);

export default function LifecyclePage() {
  return (
    <main>
      <MarketingSection headingLevel={1} kicker="The lifecycle" title="Eight phases. A gate between every one.">
        <LifecyclePipeline />
        <div className="mt-12 grid gap-4 md:grid-cols-2">
          {PHASES.map((p) => (
            <div
              key={p.id}
              className="rounded-lg border p-5"
              style={{ borderColor: '#3f4044', background: '#26272c' }}
            >
              <div className="flex items-baseline justify-between gap-3">
                <p className="font-mono text-xs" style={{ color: '#4fb4d8' }}>{p.id}</p>
                {HUMAN_GATES.has(p.id) ? (
                  <span
                    className="rounded-sm border px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wider"
                    style={{
                      color: 'var(--adlc-highlight)',
                      borderColor: 'color-mix(in srgb, var(--adlc-highlight) 55%, transparent)',
                    }}
                  >
                    Human gate
                  </span>
                ) : null}
              </div>
              <p className="mt-1 font-semibold" style={{ color: '#cbcdd2' }}>{p.name}</p>
              <p className="mt-2 text-sm leading-relaxed" style={{ color: 'var(--mk-muted)' }}>
                {PHASE_DETAIL[p.id]}
              </p>
              <a href={theoryLink(p.id)} className="mt-3 inline-block text-sm" style={{ color: '#4fb4d8' }}>
                Read the original essay ↗
              </a>
            </div>
          ))}
        </div>
      </MarketingSection>

      <MarketingSection kicker="Calibration" title="Three dials, set per ticket">
        <p className="mb-10 max-w-2xl" style={{ color: 'var(--mk-muted)' }}>
          Not every ticket deserves the same autonomy. You set three dials at triage,
          and the gates hold you to whatever you chose.
        </p>
        <ThreeDials />
        <p className="mt-8 text-sm" style={{ color: 'var(--mk-muted)' }}>
          <a href={theoryLink('three-dials')} style={{ color: '#4fb4d8' }}>Read the original essay ↗</a>
          {' · '}
          <Link href="/docs" style={{ color: '#4fb4d8' }}>Full reference in the docs</Link>
        </p>
      </MarketingSection>
    </main>
  );
}
