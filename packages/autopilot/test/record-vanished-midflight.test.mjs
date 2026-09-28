// A run record can vanish while a step is awaiting a child, the network or the
// fleet (the run was retired or torn down concurrently). `records.update`
// throws on a missing record, so every record write that follows an await must
// either stop the run with `record-vanished` (when more world-effects would
// follow) or tolerate the missing record (when the write is bookkeeping around
// a result the caller is already owed). These tests pin that direction for each
// group of post-await writes in lib/round.mjs, lib/ci.mjs and lib/run.mjs.
//
// Regression tests for a bugfix, not spec criteria: absent from ac-registry.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { continueRun, runIssue } from '../lib/run.mjs';
import { createRunSteps } from '../lib/round.mjs';
import { watchCi } from '../lib/ci.mjs';
import { createRecordStore, newRecord, updateIfPresent } from '../lib/records.mjs';
import { autopilotPaths } from '../lib/paths.mjs';
import { createRedactor } from '../lib/redact.mjs';
import { after } from './helpers/node-test.mjs';

// Every fixture the factories below mint; removed once this file's tests finish.
const fixtureDirs = new Set();
after(() => { for (const dir of fixtureDirs) rmSync(dir, { recursive: true, force: true }); });

const ISSUE = 7;
const OID = 'd'.repeat(40);
const TICKET_ID = 'T-01M23AFQ7HGVTZ6RSVEBX5V3VR';
const BUDGET = Object.freeze({ strikes: 3, wallClockMinutes: 90, wallClockMs: 90 * 60_000 });
const VANISHED = Object.freeze({ state: 'unchanged', reason: 'record-vanished' });

/** A real record store over a temp root, so every throw under test is the production one. */
function makeWorld({ state = 'dispatched', extra = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ap-vanish-'));
  fixtureDirs.add(root);
  const paths = autopilotPaths(root);
  const records = createRecordStore({ paths, redactor: createRedactor() });
  records.save({
    ...newRecord({
      issue: ISSUE, token: 'a'.repeat(64), baseOid: 'b'.repeat(40),
      branch: `adlc/autopilot/${ISSUE}`, stagingBranch: 'staging', stagingPath: join(root, 's'), finalPath: join(root, 'f'),
    }),
    state, creationPhase: null, ...extra,
  });
  const ctx = {
    repoRoot: root, paths, records, baseOid: 'b'.repeat(40),
    config: { autopilot: { maxRounds: 3, wallClockMinutes: 90, ciWatchMinutes: 30 } },
    git: { localOut: async () => OID, local: async () => ({ status: 0, stdout: `${OID}\n`, stderr: '' }), overlayEnv: () => ({}) },
    pinned: { adlc: '/fake/adlc' }, local: { adapter: 'claude-code', model: 'opus' }, iterationId: 'it-1', charterPath: '/charter.md',
    env: { base: {} }, status: { read: () => null },
    log: () => {}, now: () => Date.now(),
  };
  return { root, paths, records, ctx, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const vanish = (w) => rmSync(w.paths.record(ISSUE), { force: true });

/** Fails the test on any unhandled rejection that surfaces while `fn` runs. */
async function settled(fn) {
  const seen = [];
  const on = (e) => seen.push(e);
  process.on('unhandledRejection', on);
  try {
    const value = await fn();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(seen, [], 'no unhandled rejection was emitted');
    return value;
  } finally { process.off('unhandledRejection', on); }
}

const fleetOk = () => ({ exitCode: 0, parsed: { fleetRunId: 'r1', integrationBranch: 'fleet/run-1', readPolicy: 'bounded', gitSource: 'mirror', egress: 'allowlist', strikesConsumed: 1 } });

function stepsFor(w, deps) {
  return createRunSteps({ ctx: w.ctx, deps: { revalidate: async () => ({ ok: true }), deadEnd: async () => '/dead-end', ...deps }, issue: ISSUE, ticket: { scope: [] }, ticketId: TICKET_ID, mirror: '/m', workerDeps: '/d' });
}

// ---------------------------------------------------------------------------
// The shared helper.
// ---------------------------------------------------------------------------

test('updateIfPresent: returns the updated record, null for a vanished one, and rethrows any other failure', () => {
  const w = makeWorld();
  try {
    assert.equal(updateIfPresent(w.records, ISSUE, { lastError: 'x' }).lastError, 'x');
    vanish(w);
    assert.equal(updateIfPresent(w.records, ISSUE, { lastError: 'y' }), null);
    const broken = { load: () => ({ issue: ISSUE }), update: () => { throw new Error('EIO: disk on fire'); } };
    assert.throws(() => updateIfPresent(broken, ISSUE, {}), /EIO: disk on fire/);
  } finally { w.cleanup(); }
});

// ---------------------------------------------------------------------------
// round(): the fleet dispatch is the widest window.
// ---------------------------------------------------------------------------

test('round: a record that vanishes DURING the fleet dispatch ends the round as record-vanished, and nothing after it runs', async () => {
  const w = makeWorld();
  try {
    let after = 0;
    const steps = stepsFor(w, {
      dispatch: async () => { vanish(w); return fleetOk(); },
      deps: { dependencyDiffCheck: async () => { after++; return { ok: true }; } },
    });
    const r = await settled(() => steps.round({ budget: BUDGET }));
    assert.deepEqual(r, { status: 'terminal', result: VANISHED });
    assert.equal(after, 0, 'no later step ran on a retired run');
  } finally { w.cleanup(); }
});

test('round: a record that vanishes BEFORE the dispatch write never dispatches the fleet', async () => {
  const w = makeWorld();
  try {
    let dispatched = 0;
    const steps = stepsFor(w, {
      revalidate: async () => { vanish(w); return { ok: true }; },
      dispatch: async () => { dispatched++; return fleetOk(); },
    });
    const r = await settled(() => steps.round({ budget: BUDGET }));
    assert.deepEqual(r, { status: 'terminal', result: VANISHED });
    assert.equal(dispatched, 0, 'the fleet was never dispatched for a run with no record');
  } finally { w.cleanup(); }
});

test('round: a record that vanishes during the fast-forward stops before the dependency checks', async () => {
  const w = makeWorld();
  try {
    let after = 0;
    w.ctx.git.local = async (_cwd, args) => { if (args[0] === 'merge') vanish(w); return { status: 0, stdout: `${OID}\n`, stderr: '' }; };
    const steps = stepsFor(w, { dispatch: async () => fleetOk(), deps: { dependencyDiffCheck: async () => { after++; return { ok: true }; } } });
    const r = await settled(() => steps.round({ budget: BUDGET }));
    assert.deepEqual(r, { status: 'terminal', result: VANISHED });
    assert.equal(after, 0);
  } finally { w.cleanup(); }
});

test('round: a record that vanishes during the dependency checks stops before the actual-diff check', async () => {
  const w = makeWorld();
  try {
    let diffChecks = 0;
    const steps = stepsFor(w, {
      dispatch: async () => fleetOk(),
      deps: { dependencyDiffCheck: async () => ({ ok: true }), checkIgnoredFiles: async () => { vanish(w); return { ok: true }; } },
      diffcheck: { actualDiffCheck: async () => { diffChecks++; return { ok: true }; } },
    });
    const r = await settled(() => steps.round({ budget: BUDGET }));
    assert.deepEqual(r, { status: 'terminal', result: VANISHED });
    assert.equal(diffChecks, 0);
  } finally { w.cleanup(); }
});

test('round: a fleet outcome that is itself terminal (quota-paused, unchanged) is still returned when the record vanished', async () => {
  for (const [fleet, expected] of [
    [{ exitCode: 2, reason: 'quota-paused', parsed: { fleetRunId: 'r1', reason: 'quota-paused' } }, { state: 'quota-paused', reason: 'quota-paused' }],
    [{ exitCode: 1, reason: 'boom', parsed: { fleetRunId: 'r1', reason: 'boom' } }, { state: 'unchanged', reason: 'boom' }],
  ]) {
    const w = makeWorld();
    try {
      // The dispatch-settlement write must survive for these to be reached, so the
      // record goes on the NEXT write: the terminal one under test.
      let writes = 0;
      const real = w.records;
      w.ctx.records = { ...real, update: (n, p) => { writes++; if (writes === 3) vanish(w); return real.update(n, p); } };
      const steps = stepsFor(w, { dispatch: async () => fleet });
      const r = await settled(() => steps.round({ budget: BUDGET }));
      assert.deepEqual(r, { status: 'terminal', result: expected });
    } finally { w.cleanup(); }
  }
});

// ---------------------------------------------------------------------------
// attestTail(): completion, review, attest.
// ---------------------------------------------------------------------------

function tailDeps(w, over = {}) {
  return {
    mirror: { createGateMirror: async () => ({}) },
    deps: { installGateDeps: async () => '/gd' },
    gates: { runOuterGates: async () => ({ ok: true }) },
    review: {
      completeTicket: async () => ({}),
      reviewRound: async () => ({ ok: true, reviewedHead: OID }),
      attest: async () => ({ attestedHead: OID, revision: 'r' }),
      ...(over.review ?? {}),
    },
    ...over.top,
  };
}

test('attestTail: a record that vanishes during the ticket completion stops before the final review', async () => {
  const w = makeWorld();
  try {
    let reviews = 0;
    const steps = stepsFor(w, tailDeps(w, { review: { completeTicket: async () => { vanish(w); return {}; }, reviewRound: async () => { reviews++; return { ok: true, reviewedHead: OID }; } } }));
    const r = await settled(() => steps.attestTail({ head: OID }));
    assert.deepEqual(r, { status: 'terminal', result: VANISHED });
    assert.equal(reviews, 0);
  } finally { w.cleanup(); }
});

test('attestTail: a record that vanishes during the final review stops before the attestation', async () => {
  const w = makeWorld();
  try {
    let attests = 0;
    const steps = stepsFor(w, tailDeps(w, { review: { reviewRound: async () => { vanish(w); return { ok: true, reviewedHead: OID }; }, attest: async () => { attests++; return { attestedHead: OID }; } } }));
    const r = await settled(() => steps.attestTail({ head: OID }));
    assert.deepEqual(r, { status: 'terminal', result: VANISHED });
    assert.equal(attests, 0);
  } finally { w.cleanup(); }
});

test('attestTail: a record that vanishes during the attestation is not reported as attested', async () => {
  const w = makeWorld();
  try {
    const steps = stepsFor(w, tailDeps(w, { review: { attest: async () => { vanish(w); return { attestedHead: OID, revision: 'r' }; } } }));
    const r = await settled(() => steps.attestTail({ head: OID }));
    assert.deepEqual(r, { status: 'terminal', result: VANISHED });
  } finally { w.cleanup(); }
});

// ---------------------------------------------------------------------------
// block() / mismatch(): the outcome is truthful, the effects need a record.
// ---------------------------------------------------------------------------

test('block: a vanished record still yields the blocked result and skips the terminal effects', async () => {
  const w = makeWorld();
  try {
    let effects = 0;
    const steps = stepsFor(w, { effects: { applyTerminalEffects: async () => { effects++; return {}; } } });
    vanish(w);
    const r = await settled(() => steps.block('resume-refused', 'detail'));
    assert.deepEqual(r, { state: 'blocked', reason: 'resume-refused', deadEnd: null });
    assert.equal(effects, 0);
  } finally { w.cleanup(); }
});

test('block and mismatch: with the record PRESENT the state write and the effects both happen, with the updated record', async () => {
  const w = makeWorld({ extra: { prNumber: 41 } });
  try {
    const seen = [];
    const steps = stepsFor(w, { effects: { applyTerminalEffects: async (a) => { seen.push(a); return {}; } } });
    await steps.block('resume-refused', 'detail');
    assert.equal(seen[0].record.state, 'blocked');
    assert.deepEqual(seen[0].target, { kind: 'issue', number: ISSUE });
    const m = await steps.mismatch('moved');
    assert.deepEqual(m, { state: 'oid-mismatch', reason: 'oid-mismatch' });
    assert.equal(seen[1].record.state, 'oid-mismatch');
    assert.deepEqual(seen[1].target, { kind: 'pr', number: 41 }, 'the recorded PR is the mismatch target');
  } finally { w.cleanup(); }
});

test('failed: a vanished record still yields the failure result', async () => {
  const w = makeWorld();
  try {
    const steps = stepsFor(w, {});
    vanish(w);
    assert.deepEqual(steps.failed('x-code', 'why'), { state: 'failed', reason: 'x-code', exitCode: 1, detail: 'why' });
  } finally { w.cleanup(); }
});

test('settleCi oid-mismatch: a record that vanished during the CI watch still returns oid-mismatch and skips the effects', async () => {
  const w = makeWorld({ state: 'ci-watch', extra: { ticketId: 'T-CI', attestedHead: OID, prNumber: 41 } });
  try {
    let effects = 0;
    const deps = {
      mirror: { createWorkerMirror: async () => ({}) }, deps: { buildWorkerDeps: async () => ({}) },
      effects: { applyTerminalEffects: async () => { effects++; return {}; } },
      ci: { watchCi: async () => { vanish(w); return { outcome: 'oid-mismatch', comment: 'PR head moved' }; } },
    };
    const r = await settled(() => continueRun({ ctx: w.ctx, deps, issue: ISSUE, ticket: { title: 't' }, from: 'ci' }));
    assert.equal(r.state, 'oid-mismatch');
    assert.equal(r.prNumber, 41);
    assert.equal(effects, 0);
  } finally { w.cleanup(); }
});

// ---------------------------------------------------------------------------
// pushAndOpen(): the push and the PR upsert.
// ---------------------------------------------------------------------------

function pushDeps(w, over = {}) {
  return {
    mirror: { createWorkerMirror: async () => ({}) }, deps: { buildWorkerDeps: async () => ({}) },
    diffcheck: { actualDiffCheck: async () => ({ ok: true }) },
    push: { verifyPushVerify: async () => ({ ok: true, pushedOid: OID }), upsertPr: async () => ({ ok: true, prNumber: 5 }), prTitle: () => 't', prBody: () => 'b', ...(over.push ?? {}) },
    ci: { watchCi: async () => ({ outcome: 'done' }) },
    ...(over.top ?? {}),
  };
}
const attestedWorld = () => makeWorld({ state: 'attested', extra: { ticketId: 'T-P', attestedHead: OID, reviewedHead: OID } });

test('pushAndOpen: a record that vanishes during the PR upsert ends as record-vanished with the PR number, never a rejection', async () => {
  const w = attestedWorld();
  try {
    let watched = 0;
    const deps = pushDeps(w, { push: { upsertPr: async () => { vanish(w); return { ok: true, prNumber: 5 }; } }, top: { ci: { watchCi: async () => { watched++; return { outcome: 'done' }; } } } });
    const r = await settled(() => continueRun({ ctx: w.ctx, deps, issue: ISSUE, ticket: { title: 't', scope: [] }, from: 'push' }));
    assert.deepEqual(r, { ...VANISHED, prNumber: 5, ticketId: 'T-P' });
    assert.equal(watched, 0, 'no CI watch for a retired run');
  } finally { w.cleanup(); }
});

test('pushAndOpen: a record that vanishes during the push never opens the PR', async () => {
  const w = attestedWorld();
  try {
    let upserts = 0;
    const deps = pushDeps(w, { push: { verifyPushVerify: async () => { vanish(w); return { ok: true, pushedOid: OID }; }, upsertPr: async () => { upserts++; return { ok: true, prNumber: 5 }; } } });
    const r = await settled(() => continueRun({ ctx: w.ctx, deps, issue: ISSUE, ticket: { title: 't', scope: [] }, from: 'push' }));
    assert.deepEqual(r, { ...VANISHED, ticketId: 'T-P' });
    assert.equal(upserts, 0);
  } finally { w.cleanup(); }
});

test('pushAndOpen: a record that vanishes during the pre-push diff check never pushes', async () => {
  const w = attestedWorld();
  try {
    let pushes = 0;
    const deps = pushDeps(w, { top: { diffcheck: { actualDiffCheck: async () => { vanish(w); return { ok: true }; } } }, push: { verifyPushVerify: async () => { pushes++; return { ok: true, pushedOid: OID }; } } });
    const r = await settled(() => continueRun({ ctx: w.ctx, deps, issue: ISSUE, ticket: { title: 't', scope: [] }, from: 'push' }));
    assert.deepEqual(r, { ...VANISHED, ticketId: 'T-P' });
    assert.equal(pushes, 0);
  } finally { w.cleanup(); }
});

// ---------------------------------------------------------------------------
// watchCi(): the CI watch loop.
// ---------------------------------------------------------------------------

const RED_ROWS = [{ name: 'rails-guard', bucket: 'fail', workflow: 'ci' }];
function ciCtx(w, { rows = RED_ROWS, onView = () => {} } = {}) {
  return {
    ...w.ctx,
    gh: {
      json: async (args) => { if (args[0] === 'pr') { onView(); return { headRefOid: OID }; } return []; },
      run: async () => ({ status: 0, stdout: JSON.stringify(rows) }),
    },
    quota: { sample: async () => ({ ok: true }) },
  };
}
const ciRecord = (w) => w.records.load(ISSUE);

test('watchCi: a null record (it vanished before the watch began) returns record-vanished instead of a TypeError', async () => {
  const w = makeWorld({ state: 'ci-watch', extra: { prNumber: 41 } });
  try {
    const r = await settled(() => watchCi({ ctx: ciCtx(w), record: null, attestedHead: OID, runFixRound: async () => ({ ok: true }), sleep: async () => {} }));
    assert.deepEqual(r, { outcome: 'record-vanished' });
  } finally { w.cleanup(); }
});

test('watchCi: a record that vanishes during the PR head poll never charges or runs a CI fix round', async () => {
  const w = makeWorld({ state: 'ci-watch', extra: { prNumber: 41 } });
  try {
    let fixRounds = 0;
    const rec = ciRecord(w);
    const r = await settled(() => watchCi({ ctx: ciCtx(w, { onView: () => vanish(w) }), record: rec, attestedHead: OID, runFixRound: async () => { fixRounds++; return { ok: true, attestedHead: OID }; }, sleep: async () => {} }));
    assert.deepEqual(r, { outcome: 'record-vanished' });
    assert.equal(fixRounds, 0);
  } finally { w.cleanup(); }
});

test('watchCi: a record that vanishes during a CI fix round ends the watch as record-vanished', async () => {
  const w = makeWorld({ state: 'ci-watch', extra: { prNumber: 41 } });
  try {
    const rec = ciRecord(w);
    const r = await settled(() => watchCi({ ctx: ciCtx(w), record: rec, attestedHead: OID, runFixRound: async () => { vanish(w); return { ok: true, attestedHead: OID }; }, sleep: async () => {} }));
    assert.deepEqual(r, { outcome: 'record-vanished' });
  } finally { w.cleanup(); }
});

test('watchCi: a record that vanishes while the watch is polling still reports a passing CI as done', async () => {
  const w = makeWorld({ state: 'ci-watch', extra: { prNumber: 41 } });
  try {
    const rec = ciRecord(w);
    const pass = ['test (18)', 'test (20)', 'test (22)', 'rails-guard', 'mutation-gate', 'cross-model-gate', 'ticket-store-platform (x)'].map((name) => ({ name, bucket: 'pass', workflow: 'ci' }));
    let views = 0;
    const r = await settled(() => watchCi({ ctx: ciCtx(w, { rows: pass, onView: () => { views++; vanish(w); } }), record: rec, attestedHead: OID, runFixRound: async () => ({ ok: true }), sleep: async () => {} }));
    assert.deepEqual(r, { outcome: 'done', head: OID });
    assert.equal(views, 1);
  } finally { w.cleanup(); }
});

test('settleCi record-vanished: continueRun maps the CI watch outcome to unchanged/record-vanished', async () => {
  const w = makeWorld({ state: 'ci-watch', extra: { ticketId: 'T-CI', attestedHead: OID, prNumber: 41 } });
  try {
    const deps = { mirror: { createWorkerMirror: async () => ({}) }, deps: { buildWorkerDeps: async () => ({}) }, ci: { watchCi: async () => ({ outcome: 'record-vanished' }) } };
    const r = await settled(() => continueRun({ ctx: w.ctx, deps, issue: ISSUE, ticket: { title: 't' }, from: 'ci' }));
    assert.deepEqual(r, { ...VANISHED, prNumber: 41, ticketId: 'T-CI' });
  } finally { w.cleanup(); }
});

// ---------------------------------------------------------------------------
// runIssue(): the ticketCache write after staged creation.
// ---------------------------------------------------------------------------

test('runIssue: a record that vanished during creation stops at once — no ticket write, no coldstart, no mirror', async () => {
  const w = makeWorld({ state: 'shaped' });
  try {
    const calls = [];
    const deps = {
      revalidate: async () => ({ ok: true }),
      create: {
        createIssueWorktree: async () => { vanish(w); return {}; },
        writeTicket: async () => { calls.push('writeTicket'); return { ticketId: 'T-W' }; },
        recordEvidence: async () => { calls.push('recordEvidence'); return { verdict: 'OK' }; },
      },
      mirror: { createWorkerMirror: async () => { calls.push('createWorkerMirror'); return {}; } },
      deps: { buildWorkerDeps: async () => { calls.push('buildWorkerDeps'); return {}; } },
    };
    const r = await settled(() => runIssue({ ctx: w.ctx, deps, issue: ISSUE, ticket: { title: 't' } }));
    assert.deepEqual(r, VANISHED);
    assert.deepEqual(calls, []);
  } finally { w.cleanup(); }
});
