import type { Metadata } from 'next';
import { MarketingSection } from '@/components/marketing/section';
import { GateBadge } from '@/components/marketing/gate-badge';
import { EvidenceTrail } from '@/components/marketing/evidence-trail';
import { RouteExhibit } from '@/components/marketing/route-exhibit';
import { ContactForm } from './contact-form';

export const metadata: Metadata = {
  title: 'ADLC for Enterprise',
  description: 'Roll out agentic development with an audit trail: machine-checkable gates, evidence artifacts, and a lifecycle your compliance team can read.',
};

const ROLLOUT = [
  // No duration here on purpose: a time-to-value figure is exactly the claim
  // class PRODUCT.md forbids inventing, and this page's reader is the one most
  // damaged by discovering an unbacked number.
  { phase: 'Pilot', detail: 'One team, full gates, conservative dials, through to the first prosecuted merge.' },
  { phase: 'Rails', detail: 'Freeze org-wide conventions as rails: CI gates, protected specs, calibrated review.' },
  { phase: 'Org-wide', detail: 'Native integrations for every agent your teams use. Same gates everywhere.' },
] as const;

export default function EnterprisePage() {
  return (
    <main>
      <MarketingSection n="1" headingLevel={1} kicker="Enterprise" title="Unreviewable agent output is an audit problem">
        <p className="max-w-[72ch] text-[16.5px] leading-[1.55]" style={{ color: 'var(--rec-ink-2)' }}>
          When agents write most of the code, &ldquo;a human approved the PR&rdquo; stops being
          evidence of anything. Regulators, auditors, and your own security team will ask what
          the approval was based on. ADLC gives you an answer: a gate-by-gate evidence trail,
          produced by machines, readable by humans.
        </p>
      </MarketingSection>

      <MarketingSection n="2" kicker="The evidence" title="From ticket to merge, every verdict recorded">
        <EvidenceTrail />
        {/* Accurate about who emits what: six machine gates return exit codes;
            the two human gates record attestation. "Every gate emits all three"
            contradicted the /lifecycle chain, which shows ATTEST on two of eight. */}
        <div className="mt-8 flex flex-wrap items-center gap-3 text-sm" style={{ color: 'var(--rec-ink-2)' }}>
          <span>Machine gates emit</span>
          <GateBadge state="pass" />
          <GateBadge state="fail" />
          <span>with exit codes; the two human gates record</span>
          <GateBadge state="wish" />
          <span>— verdicts your auditors can read without an engineer translating.</span>
        </div>
        {/* The page that argues "approval is not evidence" attaches some: a real
            gate, the question it answers, and its verdict. */}
        <div className="mt-10">
          <RouteExhibit id="2.1" gateName="review-calibration" />
        </div>
      </MarketingSection>

      <MarketingSection n="3" kicker="Rollout" title="Pilot → rails → org-wide">
        {/* A rollout schedule, not three cards. Same-size cards of number +
            heading + text are the lazy page scaffold; a staged rollout is a
            sequence, and the record writes a sequence as ruled stages. */}
        <ol style={{ borderTop: '1px solid var(--rec-rule-strong)' }}>
          {ROLLOUT.map((r, i) => (
            <li
              key={r.phase}
              className="grid grid-cols-1 gap-x-6 px-1 py-4 md:grid-cols-[52px_170px_minmax(0,1fr)]"
              style={{ borderBottom: '1px solid var(--rec-rule)', background: 'var(--rec-paper-raised)' }}
            >
              <span className="rec-legend px-2 pt-1">Stage {i + 1}</span>
              <span className="px-2 text-[15px] font-semibold" style={{ color: 'var(--rec-ink)' }}>
                {r.phase}
              </span>
              <span className="px-2 text-[14px] leading-[1.55]" style={{ color: 'var(--rec-ink-2)' }}>
                {r.detail}
              </span>
            </li>
          ))}
        </ol>
      </MarketingSection>

      <MarketingSection n="4" kicker="Talk to us" title="Doing agentic development right?">
        <p className="max-w-[72ch]" style={{ color: 'var(--rec-ink-2)' }}>
          If you&apos;re rolling agentic development out across an organization and want it
          gated, auditable, and defensible, get in touch. Tell us what you&apos;re rolling out
          and we&apos;ll reply within a couple of business days. Prefer email? Reach us directly
          at{' '}
          <a
            href="mailto:help@agenticlifecycle.ai?subject=ADLC%20enterprise"
            className="underline"
            style={{ color: 'var(--rec-link)' }}
          >
            help@agenticlifecycle.ai
          </a>
          .
        </p>
        <div className="mt-8">
          <ContactForm />
        </div>
      </MarketingSection>
    </main>
  );
}
