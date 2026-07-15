import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { INTEGRATIONS, integrationFor } from '@/lib/integration-facts.mjs';
import { IntegrationDetailPage } from '@/components/marketing/integration-detail';

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

  return <IntegrationDetailPage integration={integration} />;
}
