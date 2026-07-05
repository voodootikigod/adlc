import type { Metadata } from 'next';
import { theoryLink } from '@/lib/theory-links.mjs';
import { MarketingSection } from '@/components/marketing/section';
import { FailureMap } from '@/components/marketing/failure-map';

export const metadata: Metadata = {
  title: 'Failure Modes — Why Agents Fail',
  description: 'The eight model failure modes F1–F8, and the machine-checkable gate that defends against each one.',
};

export default function FailureModesPage() {
  return (
    <main>
      <MarketingSection kicker="The problem" title="Every defense traces to a failure mode">
        <p className="mb-10 max-w-2xl" style={{ color: '#686b78' }}>
          The ADLC design rule: every phase, gate, and loop must trace to a specific model
          failure mode it defends against — or be cut. Here is the full map.
        </p>
        <FailureMap />
        <p className="mt-8 text-sm" style={{ color: '#686b78' }}>
          <a href={theoryLink('F1')} style={{ color: '#4fb4d8' }}>Read the original essay ↗</a>
        </p>
      </MarketingSection>
    </main>
  );
}
