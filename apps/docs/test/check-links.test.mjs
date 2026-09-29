import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildUrlList } from '../scripts/check-links.mjs';
import { tmp } from '@adlc/core/test-kit';
import { runAsProgram, importFromInlineModule } from '../../../scripts/test/helpers/entry-guard.mjs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const SCRIPT = fileURLToPath(new URL('../scripts/check-links.mjs', import.meta.url));

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>https://agenticlifecycle.ai</loc></url>
<url><loc>https://agenticlifecycle.ai/lifecycle</loc></url>
<url><loc>https://agenticlifecycle.ai/docs/toolkit/spec-lint</loc></url>
</urlset>`;

test('extracts every loc and rebases onto the target origin', () => {
  const urls = buildUrlList(XML, 'http://localhost:3000');
  assert.deepEqual(urls, [
    'http://localhost:3000/',
    'http://localhost:3000/lifecycle',
    'http://localhost:3000/docs/toolkit/spec-lint',
  ]);
});

test('empty sitemap yields empty list', () => {
  assert.deepEqual(buildUrlList('<urlset></urlset>', 'http://localhost:3000'), []);
});

test('run as a program with no base url, it prints its usage and exits 1', (t) => {
  const r = runAsProgram(SCRIPT, { cwd: tmp(t, 'adlc-links-entry-') });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /usage: node apps\/docs\/scripts\/check-links\.mjs <base-url>/);
});

test('imported by another module, the entry guard neither throws nor runs the CLI', (t) => {
  const r = importFromInlineModule(SCRIPT, { cwd: tmp(t, 'adlc-import-entry-') });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout + r.stderr, '');
});
