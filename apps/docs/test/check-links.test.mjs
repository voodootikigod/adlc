import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildUrlList } from '../scripts/check-links.mjs';

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
