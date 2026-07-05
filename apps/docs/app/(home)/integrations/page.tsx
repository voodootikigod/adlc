import type { Metadata } from 'next';
import Link from 'next/link';
import { INTEGRATIONS } from '@/lib/integration-facts.mjs';
import { MarketingSection } from '@/components/marketing/section';
import { STATUS_LABEL } from '@/components/marketing/integration-card';

export const metadata: Metadata = {
  title: 'Integrations: Native to Your Agent',
  description:
    'Install the ADLC natively in Claude Code, Codex, Cursor, OpenCode, Pi, or Google Antigravity.',
};

export default function IntegrationsPage() {
  return (
    <main>
      <MarketingSection headingLevel={1} kicker="Integrations" title="Pick your agent">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {INTEGRATIONS.map((i) => (
            <Link
              key={i.slug}
              href={`/integrations/${i.slug}`}
              className="group flex flex-col rounded-lg border p-5 transition-colors hover:border-[#4fb4d8]"
              style={{ borderColor: '#3f4044', background: '#26272c' }}
            >
              <p className="text-lg font-semibold" style={{ color: '#cbcdd2' }}>
                {i.name}
              </p>
              <p className="mt-2 text-sm leading-relaxed" style={{ color: 'var(--mk-muted)' }}>
                {i.tagline}
              </p>
              <p
                className="mt-auto flex items-center justify-between pt-4 font-mono text-xs"
                style={{ color: 'var(--mk-muted)' }}
              >
                <span>{STATUS_LABEL[i.status]}</span>
                <span aria-hidden className="transition-colors group-hover:text-[#4fb4d8]">
                  →
                </span>
              </p>
            </Link>
          ))}
        </div>
      </MarketingSection>
    </main>
  );
}
