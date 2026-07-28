import { source } from '@/lib/source';
import { llms } from 'fumadocs-core/source';
import { MARKETING_ROUTES, SITE_URL } from '@/lib/routes.mjs';
import { INTEGRATIONS } from '@/lib/integration-facts.mjs';

export const revalidate = false;

// GEO surface: the marketing pages lead (they answer "what is ADLC"), the
// full docs index follows from the Fumadocs source.
export function GET() {
  const marketing = MARKETING_ROUTES.map(
    (r) => `- [${r.title}](${SITE_URL}${r.path === '/' ? '' : r.path}): ${r.summary}`,
  ).join('\n');

  const integrations = INTEGRATIONS.map(
    (i) => `- [ADLC for ${i.name}](${SITE_URL}/integrations/${i.slug}): ${i.tagline}`,
  ).join('\n');

  const header = [
    '# ADLC: The Agentic Development Lifecycle',
    '',
    '> A software lifecycle built around how AI models actually fail: machine-checkable gates, auditable evidence, and native support for coding agents. The canonical theory series lives at https://voodootikigod.com/series/adlc; the toolkit is open source at https://github.com/voodootikigod/adlc.',
    '',
    '## Site',
    '',
    marketing,
    '',
    '## Integrations',
    '',
    integrations,
    '',
    '## For agents',
    '',
    `- [Agent onboarding guide](${SITE_URL}/agent-guide.md): step-by-step install and setup instructions written for a coding agent acting on a human's behalf — harness detection, install paths, first-run walkthrough, and the constraints an agent must respect.`,
    '',
    '## Documentation',
    '',
  ].join('\n');

  // The Fumadocs index emits site-relative links. Everything above is
  // absolute, and an LLM consuming llms.txt away from the site has no base
  // URL to resolve `/docs/...` against, so absolutize them to match.
  const docsIndex = llms(source).index().replaceAll('](/docs/', `](${SITE_URL}/docs/`);

  return new Response(header + docsIndex);
}
