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
