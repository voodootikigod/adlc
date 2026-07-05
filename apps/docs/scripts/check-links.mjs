// Cutover gate (spec §6): crawl the sitemap of a running deployment and assert
// every URL (plus known legacy docs paths) returns 200.
// Usage: node apps/docs/scripts/check-links.mjs <base-url>
//   e.g. node apps/docs/scripts/check-links.mjs http://localhost:3000
//        node apps/docs/scripts/check-links.mjs https://<preview>.vercel.app

export const LEGACY_PATHS = [
  '/docs',
  '/docs/getting-started',
  '/docs/toolkit/spec-lint',
  '/docs/integrations/claude-code',
];

export function buildUrlList(sitemapXml, base) {
  const origin = new URL(base).origin;
  const locs = [...sitemapXml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  return locs.map((loc) => {
    const u = new URL(loc);
    return `${origin}${u.pathname === '/' ? '/' : u.pathname}`;
  });
}

async function main(base) {
  const res = await fetch(`${base.replace(/\/$/, '')}/sitemap.xml`);
  if (!res.ok) {
    console.error(`sitemap.xml fetch failed: ${res.status}`);
    process.exit(1);
  }
  const urls = new Set([
    ...buildUrlList(await res.text(), base),
    ...LEGACY_PATHS.map((p) => `${new URL(base).origin}${p}`),
  ]);
  let failed = 0;
  for (const url of urls) {
    const r = await fetch(url, { redirect: 'follow' });
    if (r.ok) {
      console.log(`  ok ${url}`);
    } else {
      console.error(`FAIL ${r.status} ${url}`);
      failed++;
    }
  }
  console.log(`${urls.size} URLs checked, ${failed} failures`);
  process.exit(failed === 0 ? 0 : 1);
}

const base = process.argv[2];
if (base) {
  await main(base);
} else if (import.meta.url === `file://${process.argv[1]}`) {
  console.error('usage: node apps/docs/scripts/check-links.mjs <base-url>');
  process.exit(1);
}
