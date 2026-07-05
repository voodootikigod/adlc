import type { Metadata } from 'next';
import { theoryLink } from '@/lib/theory-links.mjs';
import { MarketingSection } from '@/components/marketing/section';
import { Constellation } from '@/components/marketing/constellation';

export const metadata: Metadata = {
  title: 'The Toolkit',
  description:
    'Zero-dependency, gate-shaped CLIs — one machine-checkable gate each, grouped by lifecycle phase.',
};

export default function ToolkitPage() {
  return (
    <main>
      <MarketingSection kicker="The toolkit" title="Small CLIs. One gate each. Zero dependencies.">
        <p className="mb-10 max-w-2xl" style={{ color: 'var(--mk-muted)' }}>
          Every package enforces one machine-checkable gate and shares a runtime convention,
          so independently built tools feel like one product. Click any package for its docs.
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
