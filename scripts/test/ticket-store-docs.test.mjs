import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '../..');
const REQUIRED = [
  'docs/adr/0010-sharded-ticket-store.md',
  'docs/specs/sharded-ticket-store.md',
  'docs/superpowers/plans/2026-07-13-sharded-ticket-store.md',
  'docs/ticket-store-migration.md',
  'docs/ticket-store-threat-model.md',
  'docs/releases/1.3-sharded-ticket-store.md',
  'apps/docs/content/docs/toolkit/tickets.mdx',
  'packages/tickets/README.md',
  'packages/tickets/schemas/ticket.schema.json',
  'packages/tickets/schemas/current-ticket.schema.json',
  'docs/active-ticket-pointer.md',
];

test('the sharded-store documentation set is complete', () => {
  assert.deepEqual(REQUIRED.filter((path) => !existsSync(join(ROOT, path))), []);
});

test('migration documentation states approval, decline, automation, and removal policy', () => {
  const migration = readFileSync(join(ROOT, 'docs/ticket-store-migration.md'), 'utf8');
  assert.match(migration, /Apply migration\? \[y\/N\]/);
  assert.match(migration, /declin/i);
  assert.match(migration, /non-interactive/i);
  assert.match(migration, /--write --yes/);
  assert.match(migration, /2\.0/);
});

test('the ADR records deferred scale and merge-assistant issues', () => {
  const adr = readFileSync(join(ROOT, 'docs/adr/0010-sharded-ticket-store.md'), 'utf8');
  assert.match(adr, /#167/);
  assert.match(adr, /#168/);
});

test('the active-ticket pointer is documented: schema, worktree rule, fail-closed, deprecations', () => {
  const doc = readFileSync(join(ROOT, 'docs/active-ticket-pointer.md'), 'utf8');
  // The schema going undocumented is the root cause the doc exists to remove:
  // readers guessed at the key, and a guess that missed disabled enforcement.
  assert.match(doc, /"ticketHash"/);
  assert.match(doc, /git worktree add/);
  assert.match(doc, /delete the file/i);
  for (const code of ['ACTIVE_TICKET_CONFLICT', 'ACTIVE_TICKET_STALE', 'ACTIVE_TICKET_MISSING', 'INVALID_CURRENT_TICKET']) {
    assert.match(doc, new RegExp(code), `pointer doc must state the ${code} outcome`);
  }
  for (const deprecated of ['ticketId', 'ticket']) assert.match(doc, new RegExp(`\`?${deprecated}`));
  assert.match(doc, /2\.0/, 'the doc must state when deprecated forms are removed');
});

test('every integration doc that offers the pointer links its schema', () => {
  // Each harness used to describe the pointer in its own words while showing the
  // schema nowhere — which is how three different read semantics shipped. One
  // canonical page, linked; no per-harness copy to drift.
  const harnesses = ['cursor', 'gemini', 'opencode', 'claude-code', 'codex'];
  for (const harness of harnesses) {
    const path = `docs/integrations/${harness}.md`;
    const body = readFileSync(join(ROOT, path), 'utf8');
    if (!body.includes('current-ticket.json')) continue;
    assert.match(body, /active-ticket-pointer\.md/, `${path} mentions the pointer but never links its schema`);
  }
});

test('the pointer schema admits the canonical and alias forms and rejects an unrecognized object', () => {
  const schema = JSON.parse(readFileSync(join(ROOT, 'packages/tickets/schemas/current-ticket.schema.json'), 'utf8'));
  const titles = schema.oneOf.map((variant) => variant.title);
  assert.equal(titles.length, 3, 'canonical + alias + legacy-string');
  const canonical = schema.oneOf[0];
  assert.deepEqual(canonical.required, ['id', 'ticketHash'], 'the canonical form pins both fields');
  // No variant admits an object without an id key — that shape is the fail-open hole.
  const objectVariants = schema.oneOf.filter((variant) => variant.type === 'object');
  for (const variant of objectVariants) {
    const names = variant.required ?? (variant.anyOf ?? []).flatMap((option) => option.required ?? []);
    assert.ok(names.some((n) => ['id', 'ticket', 'ticketId'].includes(n)), 'every object variant must require an id key');
  }
});
