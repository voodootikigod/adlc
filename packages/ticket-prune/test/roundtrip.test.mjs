// roundtrip.test.mjs — producer→consumer round-trip coverage (T40 / #104).
//
// #104: `ticket-prune` (PRODUCER) and `scripts/rails-guard-ci.mjs` (CONSUMER
// gate) encoded the "add-only completed annotation" predicate INDEPENDENTLY, in
// different packages, and nothing tested the seam — so ticket-prune could emit a
// tickets.json diff the very gate it exists to satisfy would DENY.
//
// These tests close the seam DETERMINISTICALLY (no model needed): they run the
// REAL `ticket-prune --write` in a temp git repo, commit its ACTUAL output, then
// run the REAL `scripts/rails-guard-ci.mjs` on that committed diff and assert the
// gate's verdict. Nothing here is mocked — both are real subprocesses.
//
// Offline, leaves no trace (mkdtempSync temp dirs + scratch git repos inside them).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PRUNE_BIN = join(HERE, '..', 'bin', 'ticket-prune.mjs');
// The REAL consumer gate, resolved from the repo root (packages/ticket-prune/test → root).
const RAILS_GUARD_CI = join(HERE, '..', '..', '..', 'scripts', 'rails-guard-ci.mjs');

function git(dir, args) {
  execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
}

function writeTickets(dir, tickets) {
  mkdirSync(join(dir, '.adlc'), { recursive: true });
  writeFileSync(join(dir, '.adlc', 'tickets.json'), JSON.stringify({ tickets }, null, 2));
}

/** Run the REAL ticket-prune bin (subprocess) in `dir`. Returns its exit code. */
/**
 * Every fixture here keeps a RAILED ticket in the store so rails are genuinely
 * active at base, which also makes the store a frozen trust root: `--write` is an
 * audited override and refuses unless it can be signed
 * (packages/tickets/test/bypass-audit.test.mjs). The key is what an operator
 * running this has; what these tests are about is the diff the gate then sees.
 */
function runPruneWrite(dir) {
  try {
    execFileSync(process.execPath, [PRUNE_BIN, '--write'], {
      cwd: dir, stdio: 'pipe', env: { ...process.env, ADLC_MANIFEST_KEY: 'test-manifest-key' },
    });
    return 0;
  } catch (e) {
    return e.status ?? 1;
  }
}

/** Run the REAL rails-guard-ci gate (subprocess) against base=main in `dir`. */
function runRailsGuardCi(dir) {
  try {
    execFileSync(process.execPath, [RAILS_GUARD_CI, 'main'], { cwd: dir, stdio: 'pipe' });
    return 0;
  } catch (e) {
    return e.status ?? 1;
  }
}

/**
 * Build a base repo on `main` with `baseTickets` committed to
 * .adlc/tickets.json plus each `seedFiles` path (so a ticket's scope can be
 * "shipped"), then branch `feat`. No .adlc/config.json or manifest is created,
 * matching the established rails-guard-ci scratch-repo pattern (base has nothing
 * frozen beyond what the base tickets declare).
 */
function setupBaseRepo({ baseTickets, seedFiles = [] }) {
  const dir = mkdtempSync(join(tmpdir(), 'ticket-prune-rt-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'a@b.c']);
  git(dir, ['config', 'user.name', 'x']);
  writeTickets(dir, baseTickets);
  // An EMPTY committed manifest, which is what `adlc init` leaves behind and what
  // rails-guard-ci itself prescribes ("create it empty during bootstrap"). A prune
  // of a frozen trust root now appends its audit entry here, and the gate's rule is
  // that a manifest may be APPENDED to in a PR but not CREATED carrying evidence —
  // so a fixture with no manifest at base would fail for the bootstrap reason
  // rather than anything these tests are about.
  writeFileSync(join(dir, '.adlc', 'manifest.jsonl'), '');
  for (const f of seedFiles) {
    mkdirSync(join(dir, dirname(f)), { recursive: true });
    writeFileSync(join(dir, f), 'shipped\n');
  }
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'base']);
  git(dir, ['checkout', '-q', '-b', 'feat']);
  return dir;
}

// ── AC1(a): the real tombstone output MERGES through the real gate → exit 0 ───

test('AC1(a): ticket-prune --write tombstones a rails-LESS stale ticket, and the REAL committed diff is ACCEPTED by the REAL rails-guard-ci → exit 0', () => {
  // Base: T1 rails-less + shipped scope (→ ticket-prune classifies it stale and
  // tombstones it). T2 is RAILED and in-flight (scope not shipped), so rails are
  // genuinely ACTIVE at base — the gate is not trivially satisfied. The tombstone
  // touches only .adlc/tickets.json and no frozen path, so it must still merge.
  const dir = setupBaseRepo({
    baseTickets: [
      { id: 'T1', title: 'Ship the widget', scope: ['plugins/adlc-widget/**'], rails: [] },
      { id: 'T2', title: 'Still building', scope: ['packages/never-built/**'], rails: ['src/guarded/**'] },
    ],
    seedFiles: ['plugins/adlc-widget/index.mjs', 'src/guarded/thing.mjs'],
  });
  try {
    assert.equal(runPruneWrite(dir), 0, 'ticket-prune --write exits 0 (advisory)');

    // Prove ticket-prune ACTUALLY produced the tombstone (real output, not a mock).
    const after = JSON.parse(readFileSync(join(dir, '.adlc', 'tickets.json'), 'utf8'));
    assert.equal(after.tickets.find((t) => t.id === 'T1').completed, true, 'T1 tombstoned');
    assert.equal(after.tickets.find((t) => t.id === 'T2').completed, undefined, 'railed T2 left alone');

    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'prune tombstone']);

    assert.equal(runRailsGuardCi(dir), 0, 'the tombstone diff must merge through the gate');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── AC1(b): the tool REFUSES a railed stale ticket, and the gate DENIES the
//            hand-made completion the tool refused → the two predicates agree ──

test('AC1(b) part 1: ticket-prune --write does NOT tombstone a RAILED stale ticket — it reports needsCeremony and leaves tickets.json byte-untouched', () => {
  const dir = setupBaseRepo({
    baseTickets: [
      { id: 'T1', title: 'Ship the widget', scope: ['plugins/adlc-widget/**'], rails: ['test/adlc-widget/**'] },
    ],
    seedFiles: ['plugins/adlc-widget/index.mjs'],
  });
  try {
    const before = readFileSync(join(dir, '.adlc', 'tickets.json'), 'utf8');
    // Use --json to read the tool's own report; --write must be a no-op on tickets.json.
    const out = execFileSync(process.execPath, [PRUNE_BIN, '--write', '--json'], { cwd: dir, encoding: 'utf8' });
    const report = JSON.parse(out);
    assert.deepEqual(report.tombstoned, [], 'a railed stale ticket is NOT auto-tombstoned');
    assert.deepEqual(report.needsCeremony.map((t) => t.id), ['T1']);
    assert.equal(report.needsCeremony[0].blocker, 'rails-freeze');
    assert.equal(readFileSync(join(dir, '.adlc', 'tickets.json'), 'utf8'), before, 'tickets.json untouched');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC1(b) part 2: the completion the tool REFUSED (completed:true on a RAILED base ticket), hand-constructed and run through the REAL rails-guard-ci, is DENIED → exit 2', () => {
  // This is the other half of the seam: the tool refuses exactly what the gate
  // rejects. If the two predicates ever drift apart, one of these two asserts breaks.
  const dir = setupBaseRepo({
    baseTickets: [
      { id: 'T1', title: 'Ship the widget', scope: ['plugins/adlc-widget/**'], rails: ['test/adlc-widget/**'] },
    ],
    seedFiles: ['plugins/adlc-widget/index.mjs'],
  });
  try {
    // Hand-construct the mutation ticket-prune declined to make.
    writeTickets(dir, [
      { id: 'T1', title: 'Ship the widget', scope: ['plugins/adlc-widget/**'], rails: ['test/adlc-widget/**'], completed: true },
    ]);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'forge completion on a railed ticket']);
    assert.equal(runRailsGuardCi(dir), 2, 'completing a still-railed ticket would unfreeze it → the gate DENIES it');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── AC1(c): the #104 regression — a rails-less ticket already carrying
//            completed:false is NOT rewritten (no gate-denied mutation emitted) ─

test('AC1(c): ticket-prune --write does NOT rewrite a rails-less stale ticket that already carries completed:false — tickets.json is byte-untouched (the #104 mismatch)', () => {
  const dir = setupBaseRepo({
    baseTickets: [
      { id: 'T1', title: 'Ship the widget', scope: ['plugins/adlc-widget/**'], rails: [], completed: false },
    ],
    seedFiles: ['plugins/adlc-widget/index.mjs'],
  });
  try {
    const before = readFileSync(join(dir, '.adlc', 'tickets.json'), 'utf8');
    const out = execFileSync(process.execPath, [PRUNE_BIN, '--write', '--json'], { cwd: dir, encoding: 'utf8' });
    const report = JSON.parse(out);
    assert.deepEqual(report.tombstoned, [], 'false→true would be a MUTATION the add-only gate denies; the tool must not make it');
    assert.deepEqual(report.needsCeremony.map((t) => t.id), ['T1']);
    assert.equal(report.needsCeremony[0].blocker, 'preexisting-completed-field');
    assert.equal(readFileSync(join(dir, '.adlc', 'tickets.json'), 'utf8'), before, 'tickets.json untouched');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC1(c) gate half: the false→true mutation the tool refused, hand-constructed and run through the REAL rails-guard-ci, is DENIED → exit 2 (proving why the tool must refuse it)', () => {
  const dir = setupBaseRepo({
    baseTickets: [
      { id: 'T1', title: 'Ship the widget', scope: ['plugins/adlc-widget/**'], rails: [], completed: false },
    ],
    seedFiles: ['plugins/adlc-widget/index.mjs'],
  });
  try {
    writeTickets(dir, [
      { id: 'T1', title: 'Ship the widget', scope: ['plugins/adlc-widget/**'], rails: [], completed: true },
    ]);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'rewrite completed:false to true']);
    assert.equal(runRailsGuardCi(dir), 2, 'the add-only exemption is pristine→completed only; false→true is a denied mutation');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
