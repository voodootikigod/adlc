// schema.mjs promises that the runtime validator and the published JSON Schemas
// cannot diverge. `additionalProperties: false` was published but never enforced,
// so a typo'd config key (`selct`, `statusLabel`) passed `doctor config-valid`
// and silently widened the sync selection. The validator now honours the flag.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unknownKeys, validateConfig, validateTicket, validateBlock } from '../lib/validate.mjs';
import { doctor } from '../lib/doctor.mjs';

const fixtureDirs = new Set();
after(() => { for (const dir of fixtureDirs) rmSync(dir, { recursive: true, force: true }); });

// --- AC3: the pure predicate ---

test('AC3: unknownKeys lists own keys the spec does not declare, only when additionalProperties is false', () => {
  const obj = { a: 1, b: 2 };
  const fields = { a: { type: 'number' } };
  assert.deepEqual(unknownKeys(obj, { additionalProperties: false, fields }), ['b']);
  assert.deepEqual(unknownKeys(obj, { additionalProperties: true, fields }), []);
  assert.deepEqual(unknownKeys(obj, { fields }), [], 'flag absent stays tolerant');
});

test('AC3: the result is sorted, covers every extra key, and the input is not mutated', () => {
  const obj = { z: 1, a: 1, m: 1 };
  const before = JSON.stringify(obj);
  assert.deepEqual(unknownKeys(obj, { additionalProperties: false, fields: { a: {} } }), ['m', 'z']);
  assert.equal(JSON.stringify(obj), before);
  assert.deepEqual(unknownKeys({}, { additionalProperties: false, fields: { a: {} } }), []);
  assert.deepEqual(unknownKeys({ a: 1 }, { additionalProperties: false, fields: { a: {} } }), []);
});

test('AC3: a spec with no fields map declares nothing, so every key is unknown when closed', () => {
  assert.deepEqual(unknownKeys({ x: 1 }, { additionalProperties: false }), ['x']);
});

// --- AC4: validateConfig ---

const GOOD = { ticketSync: { provider: 'github', repo: 'acme/app', select: { state: 'open', labels: ['adlc'] }, createLabel: 'adlc', statusLabels: { done: 'adlc:done' } } };

test('AC4: the issue config (selct, statusLabel) is rejected and both keys are named with their path', () => {
  const errors = validateConfig({ ticketSync: { provider: 'github', repo: 'acme/app', selct: { labels: ['adlc'] }, statusLabel: {} } });
  assert.ok(errors.includes('ticketSync.selct: unknown key'), errors.join('; '));
  assert.ok(errors.includes('ticketSync.statusLabel: unknown key'), errors.join('; '));
});

test('AC4: a correct config is clean; a nested unknown key under select is rejected', () => {
  assert.deepEqual(validateConfig(GOOD), []);
  const errors = validateConfig({ ticketSync: { provider: 'github', select: { state: 'open', label: ['adlc'] } } });
  assert.deepEqual(errors, ['ticketSync.select.label: unknown key']);
});

test('AC4: an extra key under statusLabels (additionalProperties: true) and at the config root (true) stay tolerated', () => {
  assert.deepEqual(validateConfig({ ...GOOD, ticketSync: { ...GOOD.ticketSync, statusLabels: { done: 'x', anything: 'y' } } }), []);
  assert.deepEqual(validateConfig({ ...GOOD, fleet: { lanes: 4 } }), [], 'the root config carries other tools\' sections');
});

test('AC4: unknown-key errors are reported alongside, not instead of, the other field errors', () => {
  const errors = validateConfig({ ticketSync: { provider: 'gitlab', selct: {} } });
  assert.ok(errors.some((e) => e.startsWith('ticketSync.provider')));
  assert.ok(errors.includes('ticketSync.selct: unknown key'));
});

test('fail-closed direction: closing a definition can only ADD errors, never remove one', () => {
  // The guard is additive. Whatever a definition says, a config the open validator
  // rejected is still rejected, so this change cannot thaw any existing check.
  assert.ok(validateConfig({ ticketSync: {} }).some((e) => e.includes('provider')));
  assert.ok(validateConfig({ ticketSync: 5 }).some((e) => e === 'ticketSync: expected object'));
});

test('block and ticket definitions are open (additionalProperties: true) and keep tolerating extension keys', () => {
  assert.deepEqual(validateBlock({ scope: ['x'], note: 'kept' }), []);
  assert.deepEqual(validateTicket({ id: 'T1', title: 'x', completed: true, issue: 42 }), []);
});

// --- AC5: doctor ---

function repoWithConfig(config) {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-doctor-unknown-'));
  fixtureDirs.add(dir);
  mkdirSync(join(dir, '.adlc'));
  writeFileSync(join(dir, '.adlc', 'config.json'), JSON.stringify(config));
  writeFileSync(join(dir, '.adlc', 'tickets.json'), JSON.stringify({ tickets: [{ id: 'T1', title: 'x', scope: ['a/**'], duration: 1 }] }));
  return dir;
}

test('AC5: doctor config-valid fails on the typo config and its detail names the key', () => {
  const dir = repoWithConfig({ ticketSync: { provider: 'github', repo: 'acme/app', selct: { labels: ['adlc'] }, statusLabel: {} } });
  const r = doctor({ dir });
  const row = r.checks.find((c) => c.name === 'config-valid');
  assert.equal(row.ok, false);
  assert.match(row.detail, /ticketSync\.selct: unknown key/);
  assert.match(row.detail, /ticketSync\.statusLabel: unknown key/);
  assert.equal(r.exitCode, 2, 'a failing row keeps today\'s exit mapping');
});

test('AC5: doctor config-valid passes on the corrected config', () => {
  const dir = repoWithConfig({ ticketSync: { provider: 'github', repo: 'acme/app', select: { labels: ['adlc'] }, statusLabels: {} } });
  const r = doctor({ dir });
  assert.equal(r.checks.find((c) => c.name === 'config-valid').ok, true);
});

// --- AC6: this repository's own store ---

const STORE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.adlc', 'tickets');

// The published ticket schema closes `edges[]` (additionalProperties: false) and
// these shards carry an `edges[].type` key, so they violate the schema the repo
// ships. The store is a frozen trust root (a PR may add a ticket, never rewrite
// one) and opening the edge definition is a schema decision, so the debt is
// pinned here instead: it can shrink, it cannot grow.
const KNOWN_EDGE_TYPE_SHARDS = new Set(['T64', 'T67', 'T68']);

function sweepStore() {
  assert.ok(existsSync(STORE), `store dir missing: ${STORE}`);
  const rows = [];
  for (const file of readdirSync(STORE)) {
    if (!file.endsWith('.json') || file.startsWith('.')) continue;
    const ticket = JSON.parse(readFileSync(join(STORE, file), 'utf8'));
    rows.push({ id: ticket.id, errors: validateTicket(ticket) });
  }
  assert.ok(rows.length > 0, 'the sweep must see the real store');
  return rows;
}

test('AC6: closing the validator adds no unknown-key failure to this repository\'s store beyond the pinned edges[].type shards', () => {
  const unknown = sweepStore()
    .map(({ id, errors }) => ({ id, errors: errors.filter((e) => e.endsWith(': unknown key')) }))
    .filter(({ errors }) => errors.length > 0);
  const unexpected = unknown.filter(({ id }) => !KNOWN_EDGE_TYPE_SHARDS.has(id));
  assert.deepEqual(unexpected, [], 'a shard the schema forbids that is not in the pinned set');
  for (const { id, errors } of unknown) {
    assert.ok(errors.every((e) => /^edges\[\d+\]\.type: unknown key$/.test(e)), `${id}: ${errors.join('; ')}`);
  }
});

test('AC6: no shard fails validateTicket for an unknown key at the ticket root (TICKET_DEF is open)', () => {
  const rootUnknown = sweepStore().flatMap(({ id, errors }) => errors.filter((e) => /^[^.[]+: unknown key$/.test(e)).map((e) => `${id}: ${e}`));
  assert.deepEqual(rootUnknown, []);
});
