import type { Metadata } from 'next';
import { MarketingSection } from '@/components/marketing/section';
import { GateBadge } from '@/components/marketing/gate-badge';
import { EvidenceTrail } from '@/components/marketing/evidence-trail';
import { ContactForm } from './contact-form';

export const metadata: Metadata = {
  title: 'ADLC for Enterprise',
  description: 'Roll out agentic development with an audit trail: machine-checkable gates, evidence artifacts, and a lifecycle your compliance team can read.',
};

const ROLLOUT = [
  { phase: 'Pilot', detail: 'One team, full gates, conservative dials. Two weeks to the first prosecuted merge.' },
  { phase: 'Rails', detail: 'Freeze org-wide conventions as rails: CI gates, protected specs, calibrated review.' },
  { phase: 'Org-wide', detail: 'Native integrations for every agent your teams use. Same gates everywhere.' },
] as const;

export default function EnterprisePage() {
  return (
    <main>
      <MarketingSection headingLevel={1} kicker="Enterprise" title="Unreviewable agent output is an audit problem">
        <p className="mk-fade-up max-w-2xl text-lg" style={{ color: 'var(--mk-muted)' }}>
          When agents write most of the code, &ldquo;a human approved the PR&rdquo; stops being
          evidence of anything. Regulators, auditors, and your own security team will ask what
          the approval was based on. ADLC gives you an answer: a gate-by-gate evidence trail,
          produced by machines, readable by humans.
        </p>
      </MarketingSection>

      <MarketingSection kicker="The evidence" title="From ticket to merge, every verdict recorded">
        <EvidenceTrail />
        <div className="mt-8 flex flex-wrap items-center gap-3 text-sm" style={{ color: 'var(--mk-muted)' }}>
          <span>Every gate emits</span>
          <GateBadge state="pass" />
          <GateBadge state="fail" />
          <GateBadge state="wish" />
          <span>verdicts your auditors can read without an engineer translating.</span>
        </div>
      </MarketingSection>

      <MarketingSection kicker="Rollout" title="Pilot → rails → org-wide">
        <div className="grid gap-4 md:grid-cols-3">
          {ROLLOUT.map((r, i) => (
            <div
              key={r.phase}
              className="rounded-lg border p-5"
              style={{ borderColor: '#3f4044', background: '#26272c' }}
            >
              <p className="font-mono text-[10px] tracking-[0.2em]" style={{ color: 'var(--mk-muted)' }}>
                {String(i + 1).padStart(2, '0')}
              </p>
              <p className="mt-1 font-semibold" style={{ color: '#4fb4d8' }}>{r.phase}</p>
              <p className="mt-2 text-sm leading-relaxed" style={{ color: 'var(--mk-muted)' }}>{r.detail}</p>
            </div>
          ))}
        </div>
      </MarketingSection>

      <MarketingSection kicker="Talk to us" title="Doing agentic development right?">
        <p className="max-w-2xl" style={{ color: 'var(--mk-muted)' }}>
          If you&apos;re rolling agentic development out across an organization and want it
          gated, auditable, and defensible, get in touch. Tell us what you&apos;re rolling out
          and we&apos;ll reply within a couple of business days. Prefer email? Reach us directly
          at{' '}
          <a
            href="mailto:chris@voodootikigod.com?subject=ADLC%20enterprise"
            className="underline"
            style={{ color: '#4fb4d8' }}
          >
            chris@voodootikigod.com
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
