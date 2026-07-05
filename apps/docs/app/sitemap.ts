import type { MetadataRoute } from 'next';
import { MARKETING_ROUTES, SITE_URL } from '@/lib/routes.mjs';
import { INTEGRATIONS } from '@/lib/integration-facts.mjs';
import { source } from '@/lib/source';

export default function sitemap(): MetadataRoute.Sitemap {
  const marketing = MARKETING_ROUTES.map((r) => ({ url: `${SITE_URL}${r.path === '/' ? '' : r.path}` }));
  const integrations = INTEGRATIONS.map((i) => ({ url: `${SITE_URL}/integrations/${i.slug}` }));
  const docs = source.getPages().map((p) => ({ url: `${SITE_URL}${p.url}` }));
  return [...marketing, ...integrations, ...docs];
}
