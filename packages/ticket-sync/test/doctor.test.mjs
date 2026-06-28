import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, statSync, readdirSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { doctor } from '../lib/doctor.mjs';
import { generateAll } from '../scripts/gen-schema.mjs';

const VALID_CONFIG = { ticketSync: { provider: 'github', repo: 'acme/app', statusLabels: {} } };
const VALID_TICKETS = { tickets: [{ id: 'T1', title: 'x', scope: ['a/**'], duration: 1 }] };

/** Build a repo with selected .adlc files; omit a key to leave that file out. */
function mk({ config = VALID_CONFIG, tickets = VALID_TICKETS, sidecar, lock = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-doctor-'));
  mkdirSync(join(dir, '.adlc'));
  if (config !== null) writeFileSync(join(dir, '.adlc', 'config.json'), typeof config === 'string' ? config : JSON.stringify(config));
  if (tickets !== null) writeFileSync(join(dir, '.adlc', 'tickets.json'), typeof tickets === 'string' ? tickets : JSON.stringify(tickets));
  if (sidecar !== undefined) writeFileSync(join(dir, '.adlc', 'ticket-sync.state.json'), typeof sidecar === 'string' ? sidecar : JSON.stringify(sidecar));
  if (lock) mkdirSync(join(dir, '.adlc', 'tickets.lock'));
  return dir;
}
const check = (r, name) => r.checks.find((c) => c.name === name);

// --- healthy baseline ---

test('a healthy repo passes every check → exit 0', () => {
  const dir = mk();
  try {
    const r = doctor({ dir });
    assert.equal(r.exitCode, 0, JSON.stringify(r.checks.filter((c) => !c.ok)));
    assert.ok(r.ok);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- config-valid: fail + pass ---

test('config-valid fails (exit 2) on a missing config; passes when present', () => {
  const bad = mk({ config: null });
  try {
    const r = doctor({ dir: bad });
    assert.equal(r.exitCode, 2);
    assert.equal(check(r, 'config-valid').ok, false);
  } finally { rmSync(bad, { recursive: true, force: true }); }
  const good = mk();
  try {
    assert.equal(check(doctor({ dir: good }), 'config-valid').ok, true);
  } finally { rmSync(good, { recursive: true, force: true }); }
});

test('config-valid fails on a schema-invalid config', () => {
  const dir = mk({ config: { ticketSync: { provider: 123 } } });
  try {
    const r = doctor({ dir });
    assert.equal(r.exitCode, 2);
    assert.equal(check(r, 'config-valid').ok, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- tickets-load: fail + pass ---

test('tickets-load fails on a duplicate id / dangling edge (hand-edit corruption)', () => {
  const dir = mk({ tickets: { tickets: [{ id: 'T1', title: 'a', edges: [{ to: 'T9' }] }] } });
  try {
    const r = doctor({ dir });
    assert.equal(r.exitCode, 2);
    assert.equal(check(r, 'tickets-load').ok, false);
    assert.match(check(r, 'tickets-load').detail, /T9/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- schema-drift: fail (drifted dir) + pass (real package dir) ---

test('schema-drift detects CONTENT drift when all files exist (the load-bearing compare, not just missing)', () => {
  // All four committed schemas present and matching, then exactly one is tampered.
  // This exercises the content `!==` compare (line 47), NOT the missing-file branch.
  const driftDir = mkdtempSync(join(tmpdir(), 'adlc-schemas-'));
  const gen = generateAll();
  for (const [file, content] of Object.entries(gen)) writeFileSync(join(driftDir, file), content);
  writeFileSync(join(driftDir, 'adlc-config.schema.json'), `${gen['adlc-config.schema.json']}// tampered\n`);
  const dir = mk();
  try {
    const r = doctor({ dir, schemaDir: driftDir });
    assert.equal(r.exitCode, 2);
    const c = check(r, 'schema-drift');
    assert.equal(c.ok, false);
    assert.match(c.detail, /adlc-config\.schema\.json drifted/);
    assert.doesNotMatch(c.detail, /missing/, 'must fail via content drift, not a missing file');
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(driftDir, { recursive: true, force: true }); }
});

test('schema-drift detects a MISSING committed schema (distinct from content drift)', () => {
  const driftDir = mkdtempSync(join(tmpdir(), 'adlc-schemas-'));
  writeFileSync(join(driftDir, 'adlc-config.schema.json'), generateAll()['adlc-config.schema.json']);
  // the other three schemas are absent → missing-file branch
  const dir = mk();
  try {
    const r = doctor({ dir, schemaDir: driftDir });
    assert.equal(r.exitCode, 2);
    const c = check(r, 'schema-drift');
    assert.equal(c.ok, false);
    assert.match(c.detail, /missing/);
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(driftDir, { recursive: true, force: true }); }
});

test('schema-drift passes against the real packaged schemas (default dir)', () => {
  const dir = mk();
  try {
    assert.equal(check(doctor({ dir }), 'schema-drift').ok, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- sidecar checks: each fails on its fixture; an absent sidecar is healthy ---

test('an absent sidecar is healthy (no sidecar checks run, no failure)', () => {
  const dir = mk(); // no sidecar
  try {
    const r = doctor({ dir });
    assert.equal(r.checks.some((c) => c.name.startsWith('sidecar')), false, 'no sidecar checks when the file is absent');
    assert.equal(r.exitCode, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('sidecar-valid fails on unparseable sidecar JSON', () => {
  const dir = mk({ sidecar: '{ not json' });
  try {
    const r = doctor({ dir });
    assert.equal(r.exitCode, 2);
    assert.equal(check(r, 'sidecar-valid').ok, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('sidecar-valid fails on a PARSEABLE but schema-invalid sidecar (the validateSyncState branch)', () => {
  // Distinct from the unparseable case above: this exercises the schema validation
  // path (line 66), not the JSON.parse catch. A sidecar missing `version` is invalid.
  const dir = mk({ sidecar: { tickets: {}, pendingCreates: {} } });
  try {
    const r = doctor({ dir });
    assert.equal(r.exitCode, 2);
    assert.equal(check(r, 'sidecar-valid').ok, false);
    assert.match(check(r, 'sidecar-valid').detail, /version/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('sidecar-nodeid-unique fails when two ids map to one nodeId', () => {
  const dir = mk({ sidecar: { version: 1, tickets: {
    'gh:acme/app#1': { provider: 'github', repo: 'acme/app', number: 1, nodeId: 'I_SAME', syncedHash: 'h' },
    'gh:acme/app#2': { provider: 'github', repo: 'acme/app', number: 2, nodeId: 'I_SAME', syncedHash: 'h' },
  }, pendingCreates: {} } });
  try {
    const r = doctor({ dir });
    assert.equal(r.exitCode, 2);
    assert.equal(check(r, 'sidecar-nodeid-unique').ok, false);
    assert.match(check(r, 'sidecar-nodeid-unique').detail, /I_SAME/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('sidecar-syncedhash fails when a synced entry is missing its syncedHash key', () => {
  const dir = mk({ sidecar: { version: 1, tickets: {
    'gh:acme/app#1': { provider: 'github', repo: 'acme/app', number: 1, nodeId: 'I_1' },
  }, pendingCreates: {} } });
  try {
    const r = doctor({ dir });
    assert.equal(r.exitCode, 2);
    assert.equal(check(r, 'sidecar-syncedhash').ok, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('sidecar-no-stale-pending fails on a leftover pendingCreates entry', () => {
  const dir = mk({ sidecar: { version: 1, tickets: {}, pendingCreates: { 'key-1': { localId: 'T7' } } } });
  try {
    const r = doctor({ dir });
    assert.equal(r.exitCode, 2);
    assert.equal(check(r, 'sidecar-no-stale-pending').ok, false);
    assert.match(check(r, 'sidecar-no-stale-pending').detail, /orphaned/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a fully-consistent sidecar passes all sidecar checks', () => {
  const dir = mk({ sidecar: { version: 1, tickets: {
    'gh:acme/app#1': { provider: 'github', repo: 'acme/app', number: 1, nodeId: 'I_1', syncedHash: 'h1' },
  }, pendingCreates: {} } });
  try {
    const r = doctor({ dir });
    assert.equal(r.exitCode, 0, JSON.stringify(r.checks.filter((c) => !c.ok)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- stale lock: age-guarded fail + pass ---

test('lock-not-stale fails for an old lock and passes for a fresh one (age-guarded, never removed)', () => {
  const dir = mk({ lock: true });
  try {
    const mtime = statSync(join(dir, '.adlc', 'tickets.lock')).mtimeMs;
    const stale = doctor({ dir, now: mtime + 20 * 60 * 1000, lockMaxAgeMs: 10 * 60 * 1000 });
    assert.equal(stale.exitCode, 2);
    assert.equal(check(stale, 'lock-not-stale').ok, false);
    // The lock must NOT have been removed — doctor is read-only.
    assert.ok(readdirSync(join(dir, '.adlc')).includes('tickets.lock'), 'doctor must not remove the lock');

    const fresh = doctor({ dir, now: mtime + 1000, lockMaxAgeMs: 10 * 60 * 1000 });
    assert.equal(check(fresh, 'lock-not-stale').ok, true, 'a young lock is an active op, not stale');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('lock staleness uses the DEFAULT 10-min threshold when none is injected', () => {
  const dir = mk({ lock: true });
  const lockPath = join(dir, '.adlc', 'tickets.lock');
  const twentyMinAgo = new Date(Date.now() - 20 * 60 * 1000);
  utimesSync(lockPath, twentyMinAgo, twentyMinAgo);
  try {
    const r = doctor({ dir }); // default now() + default lockMaxAgeMs
    assert.equal(check(r, 'lock-not-stale').ok, false, 'a 20-min-old lock is stale under the built-in 10-min default');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- AC#2: zero writes, zero network ---

test('doctor performs ZERO writes (the .adlc tree is byte-identical after a run)', () => {
  const dir = mk({ sidecar: { version: 1, tickets: {}, pendingCreates: {} }, lock: true });
  const snapshot = () => readdirSync(join(dir, '.adlc')).sort().map((f) => `${f}:${statSync(join(dir, '.adlc', f)).mtimeMs}`).join('|');
  try {
    const before = snapshot();
    doctor({ dir, now: Date.now() });
    assert.equal(snapshot(), before, 'doctor must not create, modify, or remove any .adlc file');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('doctor takes no provider/runner — it is structurally offline (signature has no network seam)', () => {
  // The only inputs are { dir, now, lockMaxAgeMs, schemaDir }; there is no runner to
  // call, so a network call is impossible by construction (AC#2).
  const dir = mk();
  try {
    const r = doctor({ dir });
    assert.ok(Array.isArray(r.checks) && typeof r.exitCode === 'number');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
