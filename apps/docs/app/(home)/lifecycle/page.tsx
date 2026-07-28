import type { Metadata } from 'next';
import Link from 'next/link';
import { theoryLink } from '@/lib/theory-links.mjs';
import { MarketingSection } from '@/components/marketing/section';
import { LifecyclePipeline } from '@/components/marketing/lifecycle-pipeline';
import { ThreeDials } from '@/components/marketing/three-dials';
import { RouteExhibit } from '@/components/marketing/route-exhibit';
import { ImplementClause } from '@/components/marketing/implement-clause';

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

export default function LifecyclePage() {
  return (
    <main>
      <MarketingSection headingLevel={1} n="1" kicker="The chain" title="Eight phases. A gate between every one.">
        {/* One table, annotated in place. This page used to render the chain and
            then a second eight-row list restating it to carry one sentence per
            phase — on mobile, the same table twice. */}
        <LifecyclePipeline details={PHASE_DETAIL} />
        <div className="mt-10">
          <RouteExhibit id="1.1" gateName="rails-guard" />
        </div>
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

      <ImplementClause n="3" />
    </main>
  );
}
