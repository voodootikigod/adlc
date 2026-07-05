import type { Metadata } from 'next';
import { theoryLink } from '@/lib/theory-links.mjs';
import { MarketingSection } from '@/components/marketing/section';
import { Constellation } from '@/components/marketing/constellation';

export const metadata: Metadata = {
  title: 'The Toolkit',
  description:
    'Zero-dependency CLIs that each enforce one machine-checkable gate, grouped by lifecycle phase.',
};

export default function ToolkitPage() {
  return (
    <main>
      <MarketingSection headingLevel={1} kicker="The toolkit" title="Small CLIs, one gate each, zero dependencies">
        <p className="mb-10 max-w-2xl" style={{ color: 'var(--mk-muted)' }}>
          Each package enforces a single machine-checkable gate, and they all share a
          runtime convention, so tools built independently still feel like one product.
          Click any package for its docs.
        </p>
        <Constellation />
        <p className="mt-8 text-sm" style={{ color: 'var(--mk-muted)' }}>
          <a href={theoryLink('toolkit')} style={{ color: '#4fb4d8' }}>
            Read the original essay ↗
          </a>
        </p>
      </MarketingSection>
    </main>
  );
}
