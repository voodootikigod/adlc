import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { INTEGRATIONS, integrationFor } from '@/lib/integration-facts.mjs';
import { MarketingSection } from '@/components/marketing/section';
import { IntegrationCard } from '@/components/marketing/integration-card';
import { CodexIntegrationPage } from '@/components/marketing/codex-integration';

export function generateStaticParams() {
  return INTEGRATIONS.map((i) => ({ slug: i.slug }));
}

export const dynamicParams = false;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const integration = integrationFor(slug);
  if (!integration) return {};
  return {
    title: `ADLC for ${integration.name}`,
    description: integration.tagline,
  };
}

export default async function IntegrationPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const integration = integrationFor(slug);
  if (!integration) notFound();
  if (integration.slug === 'codex') return <CodexIntegrationPage />;

  return (
    <main>
      <MarketingSection headingLevel={1} kicker="Integrations" title={`ADLC, native in ${integration.name}`}>
        <p className="mb-8 max-w-2xl" style={{ color: 'var(--mk-muted)' }}>
          {integration.tagline}
        </p>
        <IntegrationCard integration={integration} />
        <p className="mt-8 text-sm" style={{ color: 'var(--mk-muted)' }}>
          <Link href={`/docs/integrations/${integration.slug}`} style={{ color: '#4fb4d8' }}>
            Full {integration.name} guide in the docs →
          </Link>
        </p>
      </MarketingSection>
    </main>
  );
}
