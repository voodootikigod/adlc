import type { Metadata } from 'next';
import { theoryLink } from '@/lib/theory-links.mjs';
import { MarketingSection } from '@/components/marketing/section';
import { VsTable } from '@/components/marketing/vs-table';

export const metadata: Metadata = {
  title: 'ADLC vs SDLC',
  description: 'The SDLC is 60 years of defenses against human failure modes. Models fail differently. Here is what transfers and what has to be rebuilt.',
};

export default function VsSdlcPage() {
  return (
    <main>
      <MarketingSection headingLevel={1} kicker="The argument" title="60 years of process, built for the wrong failure modes">
        <p className="mb-10 max-w-2xl" style={{ color: 'var(--mk-muted)' }}>
          Code review, standups, and sprint ceremonies all exist because humans forget,
          tire, and protect their egos. Models do none of that. They fail in their own
          ways, and a lifecycle that doesn&apos;t defend against <em>those</em> failures
          is theater.
        </p>
        <VsTable />
        <p className="mt-8 text-sm" style={{ color: 'var(--mk-muted)' }}>
          <a href={theoryLink('vs-sdlc')} style={{ color: '#4fb4d8' }}>Read the original essay ↗</a>
        </p>
      </MarketingSection>
    </main>
  );
}
