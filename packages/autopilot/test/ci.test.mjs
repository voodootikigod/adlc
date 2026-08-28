// AC 8 / 40 / 51 / 66 — CI follow-up: the §6.9 normalization table over
// fixtures captured verbatim from `gh pr checks --json name,state,bucket,workflow`
// (PR #900), the fix-round precedence, the independent CI budget, and head
// binding on every poll.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeChecks, normalizeRow, blockingPrefixOf, watchCi, ciFixRoundBudget, ciFixFleetArgs, BLOCKING_PREFIXES } from '../lib/ci.mjs';
import { withMutation } from '../lib/mutations.mjs';
import { buildCtx, scratch, cleanup, prOpenRecord, FAKE, OID } from './helpers/review-ctx.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_900 = JSON.parse(readFileSync(join(HERE, 'fixtures', 'gh-pr-checks-900.json'), 'utf8'));
const row = (name, bucket, state, workflow = 'CI') => ({ bucket, name, state, workflow });
const allGreen = () => ['test (18)', 'test (20)', 'test (22)', 'rails-guard', 'mutation-gate', 'ticket-store-platform (ubuntu-latest, 18)'].map((n) => row(n, 'pass', 'SUCCESS')).concat([row('gate', 'pass', 'SUCCESS', 'cross-model-gate')]);

/** A gh fake over a queue of check rows and a head OID (both mutable by the test). */
function ghQueue({ polls, head }) {
  const st = { polls: [...polls], head, checksCalls: 0, viewCalls: 0 };
  const handler = (args) => {
    if (args[0] === 'pr' && args[1] === 'view') { st.viewCalls++; return { stdout: JSON.stringify({ headRefOid: typeof st.head === 'function' ? st.head(st.viewCalls) : st.head }) }; }
    if (args[0] === 'pr' && args[1] === 'checks') { st.checksCalls++; const rows = st.polls.length > 1 ? st.polls.shift() : st.polls[0]; return { stdout: JSON.stringify(rows), status: rows.some((r) => r.bucket === 'fail') ? 1 : rows.some((r) => r.bucket === 'pending') ? 8 : 0 }; }
    if (args[0] === 'run' && args[1] === 'list') return { stdout: '[]' };
    return { stdout: '{}' };
  };
  return { st, handler };
}
const harness = ({ polls, head = OID.b, record = {}, config = {} }) => {
  const root = scratch('ap-ci');
  const q = ghQueue({ polls, head });
  const ctx = buildCtx({ repoRoot: root, handlers: { [FAKE.gh]: q.handler }, config });
  ctx.records.save(prOpenRecord({ issue: 7, prNumber: 41, attestedHead: OID.b, extra: record }));
  const sleep = async (ms) => ctx.advance(ms);
  return { root, ctx, q, sleep, rec: () => ctx.records.load(7) };
};

export function ac66_normalizationContractFromRealFixture() {
  assert.deepEqual([...BLOCKING_PREFIXES], ['test (18)', 'test (20)', 'test (22)', 'rails-guard', 'mutation-gate', 'cross-model-gate', 'ticket-store-platform ('], 'the blocking set is exactly §0.11 / §6.9');
  const n = normalizeChecks(FIXTURE_900);
  assert.equal(n.verdict, 'red');
  assert.deepEqual([...n.red].sort(), ['rails-guard', 'test (18)', 'test (20)', 'test (22)'], 'the four failing blocking jobs of PR #900');
  assert.deepEqual(n.missing, [], 'every blocking prefix is present — including cross-model-gate via workflow');
  assert.equal(blockingPrefixOf(FIXTURE_900.find((r) => r.name === 'gate')), 'cross-model-gate', 'the real cross-model job is named `gate` under workflow `cross-model-gate`');
  assert.equal(blockingPrefixOf(row('ticket-store-platform (windows-latest, 18)', 'pass', 'SUCCESS', 'Ticket store platform')), 'ticket-store-platform (');
  assert.ok(n.ignored.includes('pre-ga-gate') && n.ignored.includes('router-drift') && n.ignored.includes('codex-live-latest'), 'non-blocking jobs are ignored');
  // One row per bucket, captured shapes.
  assert.equal(normalizeRow(row('test (18)', 'pass', 'SUCCESS')), 'pass');
  assert.equal(normalizeRow(row('test (18)', 'fail', 'FAILURE')), 'red');
  assert.equal(normalizeRow(row('test (18)', 'pending', 'PENDING')), 'wait');
  assert.equal(normalizeRow(row('test (18)', 'skipping', 'SKIPPED')), 'skipped');
  assert.equal(normalizeRow(row('test (18)', 'skipping', 'NEUTRAL')), 'skipped');
  assert.equal(normalizeRow(row('test (18)', 'cancel', 'CANCELLED')), 'red');
  assert.equal(normalizeRow(row('test (18)', 'weird', 'SUCCESS')), 'red', 'anything else → red');
  assert.equal(normalizeChecks([...allGreen(), { name: 'test (18)', state: 'SUCCESS', workflow: 'CI' }]).verdict, 'red', 'a row with no bucket → red');
  assert.equal(normalizeChecks([...allGreen(), row('pre-ga-gate', 'fail', 'FAILURE')]).verdict, 'pass', 'a non-blocking pre-ga-gate fail is ignored');
  assert.equal(normalizeChecks(allGreen()).verdict, 'pass');
  return withMutation('ci.missingBucketIsPass', () => {
    assert.equal(normalizeChecks([...allGreen(), { name: 'test (18)', state: 'SUCCESS', workflow: 'CI' }]).verdict, 'pass', 'seam: a bucket-less row passes');
  });
}
test('AC66: fixtures captured verbatim from gh pr checks (PR #900) normalize per §6.9 — pass/fail/pending/skipping/cancel, no bucket → red, ticket-store-platform matrix + cross-model `gate` are blocking, pre-ga-gate ignored', ac66_normalizationContractFromRealFixture);

export async function ac8_ciFollowUpTable() {
  // Row fixtures: red / skipped test (N) / skipped rails-guard / ignored non-blocking / wait / missing.
  assert.equal(normalizeChecks([...allGreen().filter((r) => r.name !== 'rails-guard'), row('rails-guard', 'fail', 'FAILURE')]).verdict, 'red', 'rails-guard FAILURE → red');
  assert.deepEqual(normalizeChecks([...allGreen().filter((r) => r.name !== 'test (20)'), row('test (20)', 'skipping', 'SKIPPED')]).red, ['test (20)'], 'test (20) SKIPPED → red');
  assert.equal(normalizeChecks([...allGreen().filter((r) => r.name !== 'rails-guard'), row('rails-guard', 'skipping', 'SKIPPED')]).verdict, 'pass', 'a skipped non-test blocking job passes');
  assert.equal(normalizeChecks([...allGreen(), row('pre-ga-gate', 'fail', 'FAILURE')]).verdict, 'pass', 'pre-ga-gate FAILURE → ignored');
  const pending = [...allGreen().filter((r) => r.name !== 'mutation-gate'), row('mutation-gate', 'pending', 'PENDING')];
  assert.equal(normalizeChecks(pending).verdict, 'wait');
  const absent = allGreen().filter((r) => r.name !== 'mutation-gate');
  assert.equal(normalizeChecks(absent).verdict, 'wait', 'an absent blocking job waits');
  assert.deepEqual(normalizeChecks(absent, { clockExpired: true }).red, ['missing: mutation-gate'], '…then red after the clock');
  // A red with other jobs pending → the fix round starts without waiting; afterwards all green → done.
  const redWithPending = [row('rails-guard', 'fail', 'FAILURE'), row('test (18)', 'pending', 'PENDING'), row('test (20)', 'pending', 'PENDING')];
  const h = harness({ polls: [redWithPending, allGreen()], record: { roundsUsed: 15, wallClockUsedMs: 90 * 60_000 } });
  try {
    const rounds = [];
    const res = await watchCi({ ctx: h.ctx, record: h.rec(), attestedHead: OID.b, poll: 60_000, sleep: h.sleep, runFixRound: async (r) => { rounds.push(r); return { ok: true, attestedHead: OID.b }; } });
    assert.equal(rounds.length, 1, 'exactly one fix round, dispatched on the first red poll');
    assert.deepEqual(rounds[0].red, ['rails-guard']); assert.equal(h.q.st.checksCalls, 2, 'no waiting poll before the fix round');
    assert.equal(res.outcome, 'done');
    assert.equal(h.rec().ciRoundsUsed, 1, 'charged to ciRoundsUsed'); assert.equal(h.rec().roundsUsed, 15, 'roundsUsed untouched'); assert.equal(h.rec().wallClockUsedMs, 90 * 60_000, 'the build clock untouched');
    assert.equal(h.rec().state, 'done');
  } finally { cleanup(h.root); }
  // Third red (ciRoundsUsed already 2) → ci-red label + comment naming the job, zero fix rounds.
  const h2 = harness({ polls: [[...allGreen().filter((r) => r.name !== 'test (20)'), row('test (20)', 'skipping', 'SKIPPED')]], record: { ciRoundsUsed: 2 } });
  try {
    let called = 0;
    const res = await watchCi({ ctx: h2.ctx, record: h2.rec(), attestedHead: OID.b, sleep: h2.sleep, runFixRound: async () => { called++; return { ok: true, attestedHead: OID.b }; } });
    assert.equal(res.outcome, 'ci-red'); assert.equal(res.label, 'adlc:autopilot-ci-red'); assert.ok(res.comment.includes('test (20)'), 'the comment names the failing job');
    assert.equal(called, 0);
    await withMutation('ci.skippedIsPass', async () => {
      const r = await watchCi({ ctx: h2.ctx, record: h2.rec(), attestedHead: OID.b, sleep: h2.sleep, runFixRound: async () => ({ ok: true, attestedHead: OID.b }) });
      assert.equal(r.outcome, 'done', 'seam: a skipped test (20) passes');
    });
  } finally { cleanup(h2.root); }
}
test('AC8: one fixture per §6.9 row (pass/red/wait/ignored/missing); rails-guard FAILURE → fix round; test (20) SKIPPED → red; pre-ga-gate FAILURE ignored; a red with pending jobs fixes without waiting; third red → adlc:autopilot-ci-red naming the job; CI budget independent of roundsUsed', ac8_ciFollowUpTable);

export async function ac40_ciBudgetIndependentOfBuildBudget() {
  const exhausted = { roundsUsed: 15, wallClockUsedMs: 90 * 60_000 };
  const budget = ciFixRoundBudget({ record: exhausted, config: { maxRounds: 15, wallClockMinutes: 90 } });
  assert.deepEqual(ciFixFleetArgs(budget), ['--max-strikes', '2', '--wall-clock-minutes', '15']);
  const red = [...allGreen().filter((r) => r.name !== 'rails-guard'), row('rails-guard', 'fail', 'FAILURE')];
  const h = harness({ polls: [red, allGreen()], record: exhausted });
  try {
    const seen = [];
    const res = await watchCi({ ctx: h.ctx, record: h.rec(), attestedHead: OID.b, sleep: h.sleep, runFixRound: async ({ fleetArgs }) => { seen.push(fleetArgs); return { ok: true, attestedHead: OID.b }; } });
    assert.equal(res.outcome, 'done');
    assert.deepEqual(seen, [['--max-strikes', '2', '--wall-clock-minutes', '15']], 'a CI red with roundsUsed 15 / 90 min still dispatches the CI allowance');
    // Third red: ciRoundsUsed == 2 → no fleet call and the label.
    h.ctx.records.update(7, { ciRoundsUsed: 2 });
    h.q.st.polls = [red];
    const third = await watchCi({ ctx: h.ctx, record: h.rec(), attestedHead: OID.b, sleep: h.sleep, runFixRound: async ({ fleetArgs }) => { seen.push(fleetArgs); return { ok: true, attestedHead: OID.b }; } });
    assert.equal(third.outcome, 'ci-red'); assert.equal(third.label, 'adlc:autopilot-ci-red'); assert.equal(seen.length, 1, 'no fleet call on the third red');
    await withMutation('ci.shareBudgets', async () => {
      h.ctx.records.update(7, { ciRoundsUsed: 0 });
      const r = await watchCi({ ctx: h.ctx, record: h.rec(), attestedHead: OID.b, sleep: h.sleep, runFixRound: async ({ fleetArgs }) => { seen.push(fleetArgs); return { ok: true, attestedHead: OID.b }; } });
      assert.equal(r.outcome, 'ci-red', 'seam: the exhausted build budget starves the CI round');
    });
  } finally { cleanup(h.root); }
}
test('AC40: with roundsUsed 15 and 90 minutes used a CI red still yields fleet argv --max-strikes 2 --wall-clock-minutes 15; the third red produces no fleet call and adlc:autopilot-ci-red', ac40_ciBudgetIndependentOfBuildBudget);

export async function ac51_headBindingDuringCi() {
  const h = harness({ polls: [allGreen()], head: OID.c });
  try {
    let fixes = 0;
    const res = await watchCi({ ctx: h.ctx, record: h.rec(), attestedHead: OID.b, sleep: h.sleep, runFixRound: async () => { fixes++; return { ok: true, attestedHead: OID.b }; } });
    assert.equal(res.outcome, 'oid-mismatch'); assert.equal(res.observed, OID.c); assert.equal(fixes, 0, 'zero fix rounds');
    assert.equal(h.rec().state, 'oid-mismatch'); assert.notEqual(h.rec().state, 'done', 'done is never reached with all jobs green');
    // A head that moves on a LATER poll (first poll pending, second all green with a foreign head).
    h.ctx.records.update(7, { state: 'pr-open' });
    h.q.st.polls = [[...allGreen().filter((r) => r.name !== 'test (18)'), row('test (18)', 'pending', 'PENDING')], allGreen()];
    h.q.st.viewCalls = 0; h.q.st.head = (call) => (call === 1 ? OID.b : OID.c);
    const later = await watchCi({ ctx: h.ctx, record: h.rec(), attestedHead: OID.b, sleep: h.sleep, runFixRound: async () => { fixes++; return { ok: true }; } });
    assert.equal(later.outcome, 'oid-mismatch', 'a mismatch on ANY poll quarantines'); assert.equal(fixes, 0);
    // Equal head + all green → done.
    h.ctx.records.update(7, { state: 'pr-open' }); h.q.st.polls = [allGreen()]; h.q.st.head = OID.b;
    const ok = await watchCi({ ctx: h.ctx, record: h.rec(), attestedHead: OID.b, sleep: h.sleep, runFixRound: async () => ({ ok: true }) });
    assert.equal(ok.outcome, 'done'); assert.equal(h.rec().state, 'done');
    await withMutation('ci.ignoreHeadBinding', async () => {
      h.ctx.records.update(7, { state: 'pr-open' }); h.q.st.head = OID.c;
      const r = await watchCi({ ctx: h.ctx, record: h.rec(), attestedHead: OID.b, sleep: h.sleep, runFixRound: async () => ({ ok: true }) });
      assert.equal(r.outcome, 'done', 'seam: a foreign head reaches done');
    });
  } finally { cleanup(h.root); }
}
test('AC51: a headRefOid that differs from attestedHead on any poll → oid-mismatch, zero fix rounds, never done even with all jobs green; equal head + all green → done', ac51_headBindingDuringCi);
