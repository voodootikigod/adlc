// #992 — a run record that vanishes concurrently (the run was retired/torn
// down) must never turn a clean terminal result into an unhandled rejection.
//
// `records.update` THROWS when the record is gone (lib/records.mjs). Several of
// continueRun's record writes are bookkeeping performed immediately BEFORE the
// result the caller is owed — three of them inside a `catch` block — so that
// throw REPLACES the result and escapes as a rejection from a continuation
// whose owning call has already ended. #962 fixed two such sites; these tests
// pin the rest.
//
// These are REGRESSION tests for a bugfix, not spec criteria: they are
// deliberately absent from test/ac-registry.mjs, matching the #962 precedent
// (commits ca7299e5 / 763bd2a5, whose ac962_* tests are named after the issue).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { continueRun, runIssue } from '../lib/run.mjs';
import { createRecordStore, newRecord } from '../lib/records.mjs';
import { autopilotPaths } from '../lib/paths.mjs';
import { createRedactor } from '../lib/redact.mjs';

const ISSUE = 7;

/**
 * A real record store over a temp root — never a hand-written fake, so the
 * throw under test is the production `records.update` throw.
 */
function makeWorld({ state = 'dispatched', extra = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ap-992-'));
  const paths = autopilotPaths(root);
  const records = createRecordStore({ paths, redactor: createRedactor() });
  records.save({
    ...newRecord({
      issue: ISSUE, token: 'a'.repeat(64), baseOid: 'b'.repeat(40),
      branch: `adlc/autopilot/${ISSUE}`, stagingBranch: 'staging', stagingPath: join(root, 's'), finalPath: join(root, 'f'),
    }),
    state, creationPhase: null, ...extra,
  });
  const logs = [];
  const ctx = {
    repoRoot: root, paths, records, baseOid: 'b'.repeat(40),
    config: { autopilot: { maxRounds: 3, wallClockMinutes: 90, ciWatchMinutes: 30 } },
    git: { localOut: async () => 'c'.repeat(40) },
    log: (l) => logs.push(l),
    now: () => Date.now(),
  };
  return { root, paths, records, ctx, logs, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** Drop the record the way a concurrent retire/teardown does: the file simply goes. */
const vanish = (w) => rmSync(w.paths.record(ISSUE), { force: true });

/** Collect unhandled rejections for the duration of `fn`, then settle the loop. */
async function withUnhandledRejectionWatch(fn) {
  const seen = [];
  const onUnhandled = (e) => seen.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    const value = await fn();
    // Let any stale continuation surface before we judge.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setImmediate(r));
    return { value, seen };
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
}

/** A `deps.mirror` whose worker-mirror build always throws. */
const throwingMirror = (message = 'clone failed: fatal: failed to copy file', code = undefined) => ({
  mirror: { createWorkerMirror: async () => { const e = new Error(message); if (code) e.code = code; throw e; } },
});

// ---------------------------------------------------------------------------
// AC1 / AC2 / AC3 — the ticketed site: the init-failure handler (lib/run.mjs).
// ---------------------------------------------------------------------------

test('#992 AC1: continueRun RESOLVES with the init-failed result when the record vanished during the mirror/deps build', async () => {
  const w = makeWorld({ extra: { ticketId: 'T-TEST' } });
  try {
    const deps = {
      mirror: { createWorkerMirror: async () => { vanish(w); const e = new Error('clone failed: fatal: failed to copy file'); throw e; } },
      deps: { buildWorkerDeps: async () => ({}) },
    };
    const { value: r, seen } = await withUnhandledRejectionWatch(() =>
      continueRun({ ctx: w.ctx, deps, issue: ISSUE, ticket: { title: 't' }, from: 'rounds' }));

    assert.equal(r.state, 'failed');
    assert.equal(r.reason, 'init-failed');
    assert.equal(r.exitCode, 1);
    assert.equal(r.detail, 'clone failed: fatal: failed to copy file', 'the thrown error’s detail reaches the caller');
    assert.equal(r.ticketId, 'T-TEST', 'the ticketId is still reported');
    assert.deepEqual(seen, [], 'no unhandled rejection was emitted');
    assert.equal(w.records.load(ISSUE), null, 'the record really was gone (the test proved what it claims)');
  } finally { w.cleanup(); }
});

test('#992 AC1b: the error code, when the failure carries one, still names the reason', async () => {
  const w = makeWorld({ extra: { ticketId: 'T-TEST' } });
  try {
    const deps = {
      mirror: { createWorkerMirror: async () => { vanish(w); const e = new Error('npm ci exited 1'); e.code = 'init-failed'; throw e; } },
      deps: { buildWorkerDeps: async () => ({}) },
    };
    const { value: r, seen } = await withUnhandledRejectionWatch(() =>
      continueRun({ ctx: w.ctx, deps, issue: ISSUE, ticket: { title: 't' }, from: 'rounds' }));
    assert.equal(r.reason, 'init-failed');
    assert.equal(r.detail, 'npm ci exited 1');
    assert.deepEqual(seen, []);
  } finally { w.cleanup(); }
});

test('#992 AC2: with the record PRESENT the init failure is still recorded as lastError and the same result returned', async () => {
  const w = makeWorld({ extra: { ticketId: 'T-TEST' } });
  try {
    const deps = { ...throwingMirror('npm ci exited 7', 'init-failed'), deps: { buildWorkerDeps: async () => ({}) } };
    const r = await continueRun({ ctx: w.ctx, deps, issue: ISSUE, ticket: { title: 't' }, from: 'rounds' });

    assert.equal(r.state, 'failed');
    assert.equal(r.reason, 'init-failed');
    assert.equal(r.exitCode, 1);
    const rec = w.records.load(ISSUE);
    assert.ok(rec, 'the record survived');
    assert.equal(rec.lastError, 'init-failed: npm ci exited 7', 'the bookkeeping still happens on the normal path');
  } finally { w.cleanup(); }
});

test('#992 AC3: an update failure that is NOT a missing record propagates instead of being swallowed', async () => {
  const w = makeWorld({ extra: { ticketId: 'T-TEST' } });
  try {
    const real = w.ctx.records;
    const ctx = {
      ...w.ctx,
      records: { ...real, load: (n) => real.load(n), update: () => { throw new Error('EIO: disk on fire'); } },
    };
    const deps = { ...throwingMirror(), deps: { buildWorkerDeps: async () => ({}) } };
    await assert.rejects(
      () => continueRun({ ctx, deps, issue: ISSUE, ticket: { title: 't' }, from: 'rounds' }),
      /EIO: disk on fire/,
      'a real write failure is not hidden by the vanished-record guard');
  } finally { w.cleanup(); }
});

// ---------------------------------------------------------------------------
// The sibling sites in the same file that share the hazard (ticket NORMATIVE 3).
// ---------------------------------------------------------------------------

test('#992 evidence quota-gate (run.mjs :127): a vanished record still returns quota-paused', async () => {
  const w = makeWorld();
  try {
    const deps = {
      create: {
        writeTicket: async () => ({ ticketId: 'T-Q' }),
        recordEvidence: async () => { vanish(w); const e = new Error('quota'); e.code = 'quota-gated'; throw e; },
      },
    };
    const { value: r, seen } = await withUnhandledRejectionWatch(() =>
      continueRun({ ctx: w.ctx, deps, issue: ISSUE, ticket: { title: 't' }, from: 'evidence' }));
    assert.equal(r.state, 'shaped');
    assert.equal(r.reason, 'quota-paused');
    assert.equal(r.ticketId, 'T-Q');
    assert.deepEqual(seen, [], 'no unhandled rejection was emitted');
  } finally { w.cleanup(); }
});

test('#992 evidence failure (run.mjs :132): a vanished record still returns the evidence failure', async () => {
  const w = makeWorld();
  try {
    const deps = {
      create: {
        writeTicket: async () => ({ ticketId: 'T-E' }),
        recordEvidence: async () => { vanish(w); const e = new Error('spec-lint blew up'); e.code = 'evidence-failed'; throw e; },
      },
    };
    const { value: r, seen } = await withUnhandledRejectionWatch(() =>
      continueRun({ ctx: w.ctx, deps, issue: ISSUE, ticket: { title: 't' }, from: 'evidence' }));
    assert.equal(r.state, 'failed');
    assert.equal(r.reason, 'evidence-failed');
    assert.equal(r.detail, 'spec-lint blew up');
    assert.deepEqual(seen, [], 'no unhandled rejection was emitted');
  } finally { w.cleanup(); }
});

test('#992 runIssue ticketCache write (run.mjs :79): a record that vanished during creation does not reject', async () => {
  const w = makeWorld();
  try {
    const deps = {
      revalidate: async () => ({ ok: true }),
      create: {
        createIssueWorktree: async () => { vanish(w); return {}; },
        writeTicket: async () => ({ ticketId: 'T-W' }),
        recordEvidence: async () => ({ verdict: 'OK' }),
      },
      mirror: { createWorkerMirror: async () => ({}) },
      deps: { buildWorkerDeps: async () => ({}) },
    };
    const { value: r, seen } = await withUnhandledRejectionWatch(() =>
      runIssue({ ctx: w.ctx, deps, issue: ISSUE, ticket: { title: 't' } }));

    // The write at :79 no longer throws over the missing record, so the run
    // carries on and terminates at the #962 rounds-loop guard — the truthful
    // "this run is gone" answer — instead of rejecting three steps earlier.
    assert.equal(r.state, 'unchanged');
    assert.equal(r.reason, 'record-vanished');
    assert.equal(r.ticketId, 'T-W');
    assert.deepEqual(seen, [], 'no unhandled rejection was emitted');
  } finally { w.cleanup(); }
});

test('#992 settleCi ci-red (run.mjs :41): a vanished record still returns ci-red and skips the terminal effects', async () => {
  const w = makeWorld({ state: 'ci-watch', extra: { ticketId: 'T-CI', attestedHead: 'd'.repeat(40), prNumber: 41 } });
  try {
    let effectsCalls = 0;
    const deps = {
      mirror: { createWorkerMirror: async () => ({}) },
      deps: { buildWorkerDeps: async () => ({}) },
      effects: { applyTerminalEffects: async () => { effectsCalls++; return {}; } },
      ci: { watchCi: async () => { vanish(w); return { outcome: 'ci-red', comment: 'the build is red', label: 'adlc:autopilot-ci-red', red: ['test (22)'] }; } },
    };
    const { value: r, seen } = await withUnhandledRejectionWatch(() =>
      continueRun({ ctx: w.ctx, deps, issue: ISSUE, ticket: { title: 't' }, from: 'ci' }));

    assert.equal(r.state, 'ci-red');
    assert.equal(r.reason, 'ci-red');
    assert.equal(r.prNumber, 41);
    assert.deepEqual(seen, [], 'no unhandled rejection was emitted');
    assert.equal(effectsCalls, 0, 'applyTerminalEffects is NOT called with a null record (it throws bad-input:record)');
  } finally { w.cleanup(); }
});

test('#992 settleCi ci-red: with the record PRESENT the state write and the terminal effects still happen', async () => {
  const w = makeWorld({ state: 'ci-watch', extra: { ticketId: 'T-CI', attestedHead: 'd'.repeat(40), prNumber: 41 } });
  try {
    const effectsSeen = [];
    const deps = {
      mirror: { createWorkerMirror: async () => ({}) },
      deps: { buildWorkerDeps: async () => ({}) },
      effects: { applyTerminalEffects: async (a) => { effectsSeen.push(a); return {}; } },
      ci: { watchCi: async () => ({ outcome: 'ci-red', comment: 'the build is red', label: 'adlc:autopilot-ci-red', red: ['test (22)'] }) },
    };
    const r = await continueRun({ ctx: w.ctx, deps, issue: ISSUE, ticket: { title: 't' }, from: 'ci' });

    assert.equal(r.state, 'ci-red');
    assert.equal(w.records.load(ISSUE).state, 'ci-red', 'the state write still happens');
    assert.equal(effectsSeen.length, 1, 'the terminal effects still run');
    // The full effect call is pinned: the sentinel is what makes the comment
    // idempotent across iterations, and the target/label decide where it lands.
    const eff = effectsSeen[0];
    assert.equal(eff.record.issue, ISSUE, 'they receive a real record');
    assert.equal(eff.record.state, 'ci-red', 'and it is the UPDATED record, not a stale read');
    assert.equal(eff.outcome, 'ci-red');
    assert.deepEqual(eff.target, { kind: 'pr', number: 41 });
    assert.equal(eff.sentinel, '<!-- adlc-autopilot:ci-red ci-red -->');
    assert.equal(eff.body, 'the build is red');
    assert.equal(eff.label, 'adlc:autopilot-ci-red');
  } finally { w.cleanup(); }
});
