import type { Metadata } from 'next';
import { theoryLink } from '@/lib/theory-links.mjs';
import { TOOLKIT_GROUPS, ALL_PACKAGES } from '@/lib/toolkit-packages.mjs';
import { MarketingSection } from '@/components/marketing/section';
import { Constellation } from '@/components/marketing/constellation';
import { RouteExhibit } from '@/components/marketing/route-exhibit';
import { ImplementClause } from '@/components/marketing/implement-clause';

export const metadata: Metadata = {
  title: 'The Toolkit',
  description:
    'Zero-dependency CLIs that each enforce one machine-checkable gate, grouped by lifecycle phase.',
};

// Derived from the data module, never typed: the total the visitor can count on
// this page must reconcile with the "gate CLIs" figure used elsewhere, and the
// difference is exactly the shared-foundation packages.
const FOUNDATION = TOOLKIT_GROUPS.find((g) => g.group === 'Shared foundation');
const FOUNDATION_COUNT = FOUNDATION?.packages.length ?? 0;

export default function ToolkitPage() {
  return (
    <main>
      <MarketingSection n="1" headingLevel={1} kicker="The toolkit" title="Small CLIs, one gate each, zero dependencies">
        <p className="mb-10 max-w-[72ch]" style={{ color: 'var(--rec-ink-2)' }}>
          {ALL_PACKAGES.length} published packages: {ALL_PACKAGES.length - FOUNDATION_COUNT} gate
          CLIs behind one dispatcher, plus the shared foundation
          ({FOUNDATION?.packages.join(', ')}). Each gate enforces a single machine-checkable
          question and answers on its exit code, and they all share a runtime convention, so
          tools built independently still feel like one product. Click any package for its docs.
        </p>
        <Constellation />
        {/* "One gate each" is a capability claim, so a gate demonstrates it:
            one command in, one exit code out. */}
        <div className="mt-10">
          <RouteExhibit id="1.1" gateName="spec-lint" />
        </div>
        <p className="mt-8 text-sm" style={{ color: 'var(--rec-ink-2)' }}>
          <a href={theoryLink('toolkit')} style={{ color: 'var(--rec-link)' }}>
            Read the original essay ↗
          </a>
        </p>
      </MarketingSection>

      <ImplementClause n="2" />
    </main>
  );
}
