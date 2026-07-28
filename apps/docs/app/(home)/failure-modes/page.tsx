import type { Metadata } from 'next';
import { theoryLink } from '@/lib/theory-links.mjs';
import { MarketingSection } from '@/components/marketing/section';
import { FailureMap } from '@/components/marketing/failure-map';
import { RouteExhibit } from '@/components/marketing/route-exhibit';
import { ImplementClause } from '@/components/marketing/implement-clause';

export const metadata: Metadata = {
  title: 'Failure Modes: Why Agents Fail',
  description: 'The eight model failure modes F1–F8, and the machine-checkable gate that defends against each one.',
};

export default function FailureModesPage() {
  return (
    <main>
      <MarketingSection n="1" headingLevel={1} kicker="The problem" title="Every defense traces to a failure mode">
        <p className="mb-10 max-w-[72ch]" style={{ color: 'var(--rec-ink-2)' }}>
          ADLC has one design rule: if a gate can&apos;t name the model failure mode it
          defends against, it gets cut. Here is the full map.
        </p>
        <FailureMap />
        {/* The cheapest page on the site to attach evidence to: eight claims
            that a named gate kills a named failure mode, so show one doing it. */}
        <div className="mt-10">
          <RouteExhibit id="1.1" gateName="hollow-test" />
        </div>
        <p className="mt-8 text-sm" style={{ color: 'var(--rec-ink-2)' }}>
          <a href={theoryLink('F1')} style={{ color: 'var(--rec-link)' }}>Read the original essay ↗</a>
        </p>
      </MarketingSection>

      <ImplementClause n="2" />
    </main>
  );
}
