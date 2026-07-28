import type { Metadata } from 'next';
import { theoryLink } from '@/lib/theory-links.mjs';
import { MarketingSection } from '@/components/marketing/section';
import { VsTable } from '@/components/marketing/vs-table';
import { ImplementClause } from '@/components/marketing/implement-clause';

export const metadata: Metadata = {
  title: 'ADLC vs SDLC',
  description: 'The SDLC is 60 years of defenses against human failure modes. Models fail differently. Here is what transfers and what has to be rebuilt.',
};

export default function VsSdlcPage() {
  return (
    <main>
      <MarketingSection n="1" headingLevel={1} kicker="The argument" title="60 years of process, built for the wrong failure modes">
        <p className="mb-10 max-w-[72ch]" style={{ color: 'var(--rec-ink-2)' }}>
          Code review, standups, and sprint ceremonies all exist because humans forget,
          tire, and protect their egos. Models do none of that. They fail in their own
          ways, and a lifecycle that never checks for <em>those</em> failures will pass
          them straight through.
        </p>
        <VsTable />
        <p className="mt-8 text-sm" style={{ color: 'var(--rec-ink-2)' }}>
          <a href={theoryLink('vs-sdlc')} style={{ color: 'var(--rec-link)' }}>Read the original essay ↗</a>
        </p>
      </MarketingSection>

      <ImplementClause n="2" />
    </main>
  );
}
