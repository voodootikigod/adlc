import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { MARKETING_ROUTES, SITE_URL } from '../lib/routes.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const homeDir = path.join(__dirname, '..', 'app', '(home)');

test('SITE_URL is the canonical production host (www — apex 308s to it)', () => {
  assert.equal(SITE_URL, 'https://www.agenticlifecycle.ai');
});

test('routes are unique and well-formed', () => {
  const paths = MARKETING_ROUTES.map((r) => r.path);
  assert.equal(new Set(paths).size, paths.length);
  for (const r of MARKETING_ROUTES) {
    assert.match(r.path, /^\//);
    assert.ok(r.title.length > 0);
  }
});

test('every marketing route has a page file (no nav 404s)', () => {
  for (const r of MARKETING_ROUTES) {
    const rel = r.path === '/' ? 'page.tsx' : path.join(r.path.slice(1), 'page.tsx');
    const p = path.join(homeDir, rel);
    assert.ok(existsSync(p), `route ${r.path}: missing ${p}`);
  }
});
