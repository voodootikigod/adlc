// fleet-ext item 9 / AC6: the --json result carries fleetRunId, review meta and
// a machine-readable `reason` for EVERY non-zero exit. Table-driven over the
// closed reason set; an exit-2 path with no reason is a test failure.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resultDocument, summaryReason, TICKET_REASONS, RUN_REASONS } from '../lib/result.mjs';
import { REASON_CODES } from '../lib/scheduler.mjs';
import { runExitCode } from '../lib/run.mjs';
import { runLive, parseFlags } from '../bin/fleet.mjs';

const summaryWith = (ticket, extra = {}) => ({
  integrationBranch: 'fleet/run-r', merged: 0, prCount: 0, prOpenFailed: false, contaminated: false, wallClockExpired: false,
  results: { A: ticket.state }, status: { runId: 'r', tickets: { A: ticket } }, strikesConsumed: 1, ...extra,
});

test('the closed ticket-reason set is exactly the eight codes of §14', () => {
  assert.deepEqual([...TICKET_REASONS].sort(), ['flail', 'lock-held', 'mirror-fetch-failed', 'quota-paused', 'review-unavailable', 'strikes-exhausted', 'ticket-blocked', 'wall-clock']);
});

test('every ticket outcome code maps to itself as the run reason and to exit 2 (table-driven)', () => {
  const stateFor = { 'quota-paused': 'paused', 'wall-clock': 'paused', 'ticket-blocked': 'blocked' };
  for (const code of Object.values(REASON_CODES)) {
    if (code === 'lock-held') continue; // a preflight outcome, covered below
    const summary = summaryWith({ state: stateFor[code] ?? 'failed', strikes: 1, reasonCode: code, reason: 'x' }, code === 'wall-clock' ? { wallClockExpired: true } : {});
    const exitCode = runExitCode(summary);
    assert.equal(exitCode, 2, `${code}: exit 2`);
    const doc = resultDocument({ runId: 'r', exitCode, summary });
    assert.equal(doc.reason, code, `${code}: reason`);
    assert.equal(doc.fleetRunId, 'r');
    assert.equal(doc.tickets.A.reasonCode, code);
  }
});

test('run-level failures are never reasonless: quarantine, PR failure, preflight, resume refusal', () => {
  assert.equal(summaryReason(summaryWith({ state: 'merged' }, { contaminated: true })), RUN_REASONS.QUARANTINED);
  assert.equal(summaryReason(summaryWith({ state: 'merged' }, { prOpenFailed: true })), RUN_REASONS.PR_OPEN_FAILED);
  assert.equal(resultDocument({ exitCode: 1, reason: 'lock-held' }).reason, 'lock-held');
  assert.equal(resultDocument({ exitCode: 1, reason: RUN_REASONS.RESUME_REFUSED }).reason, 'resume-refused');
  // An exit-2 document built from a summary with NO derivable reason still names one.
  const doc = resultDocument({ exitCode: 2, summary: summaryWith({ state: 'failed', strikes: 2 }) });
  assert.equal(doc.reason, 'strikes-exhausted', 'a terminal ticket without a code reads as strikes-exhausted');
  const bare = resultDocument({ exitCode: 2, summary: null });
  assert.ok(typeof bare.reason === 'string' && bare.reason.length > 0, 'never null on a non-zero exit');
});

test('a clean exit carries reason null, the single ticket review at the top level, and the policy echo defaults', () => {
  const summary = summaryWith({ state: 'merged', strikes: 1, review: { provider: 'codex', verdict: 'approve', revision: 'R', rounds: 1 } }, { merged: 1 });
  const doc = resultDocument({ runId: 'r', exitCode: 0, summary, sandbox: { readPolicy: 'bounded', privateTmp: true, gitSource: 'mirror', mirror: '/m.git', egress: 'allowlist', egressAllowlist: ['api.anthropic.com:443'], homeBinds: ['/h/.claude/settings.json'], writableRoots: ['/wt'] } });
  assert.equal(doc.reason, null);
  assert.deepEqual(doc.review, { provider: 'codex', verdict: 'approve', revision: 'R', rounds: 1 });
  assert.equal(doc.strikes.A, 1); assert.equal(doc.strikesConsumed, 1);
  assert.equal(doc.readPolicy, 'bounded'); assert.equal(doc.privateTmp, true); assert.equal(doc.gitSource, 'mirror');
  assert.equal(doc.mirror, '/m.git'); assert.equal(doc.egress, 'allowlist'); assert.deepEqual(doc.egressAllowlist, ['api.anthropic.com:443']);
  const defaults = resultDocument({ exitCode: 0, summary });
  assert.equal(defaults.readPolicy, 'host'); assert.equal(defaults.privateTmp, false); assert.equal(defaults.gitSource, 'shared'); assert.equal(defaults.egress, 'open');
});

test('two tickets → no top-level review (ambiguous), but every ticket carries its own', () => {
  const summary = { ...summaryWith({ state: 'merged', review: { rounds: 1 } }), results: { A: 'merged', B: 'merged' }, status: { tickets: { A: { state: 'merged', review: { rounds: 1 } }, B: { state: 'merged', review: { rounds: 2 } } } } };
  const doc = resultDocument({ exitCode: 0, summary });
  assert.equal(doc.review, null);
  assert.equal(doc.tickets.B.review.rounds, 2);
});

// ── through runLive: the document is what the CLI emits under --json ──

const ARGS = { repo: '/repo', dir: '/repo/.adlc', all: [{ id: 'A', title: 'A', scope: ['x/**'], edges: [] }], config: { base: 'main', gate: { test: 't' } }, onlyIds: undefined, json: true };
function live(over = {}) {
  const emitted = [];
  const ov = {
    io: { git: () => () => 'SHA', readFile: () => '', env: {} },
    preflight: async () => over.preflight ?? { ok: true, warnings: [], sandboxSpec: { mode: 'sandbox' } },
    build: () => ({ describeSandbox: () => ({ readPolicy: 'host' }) }),
    run: async () => over.summary ?? summaryWith({ state: 'merged' }, { merged: 1, prCount: 1 }),
    loadPrior: () => over.prior ?? null,
    reconcile: () => over.reconcile ?? {},
    release: () => {},
    now: () => 1_700_000_000_000,
    emit: (d) => emitted.push(d),
  };
  return { emitted, ov };
}

test('runLive --json: a held lock is exit 1 with reason lock-held (a skip a caller retries, never an escalation)', async () => {
  const { emitted, ov } = live({ preflight: { ok: false, exitCode: 1, reason: 'another fleet run holds the lock', reasonCode: 'lock-held', warnings: [] } });
  const code = await runLive(ARGS, ov);
  assert.equal(code, 1);
  assert.equal(emitted.length, 1, 'exactly one document on stdout');
  assert.equal(emitted[0].reason, 'lock-held');
  assert.equal(emitted[0].exitCode, 1);
});

test('runLive --json: a refused resume reports resume-refused with the prior fleetRunId', async () => {
  const { emitted, ov } = live({ prior: { runId: 'prior-1' }, reconcile: { refused: true, reason: 'branch gone' } });
  const code = await runLive(ARGS, ov);
  assert.equal(code, 1);
  assert.equal(emitted[0].reason, 'resume-refused');
  assert.equal(emitted[0].fleetRunId, 'prior-1');
});

test('runLive --json: a paused ticket is exit 2 with reason quota-paused and the same fleetRunId a resume will reuse', async () => {
  const { emitted, ov } = live({ summary: summaryWith({ state: 'paused', strikes: 0, reasonCode: 'quota-paused', reason: 'quota' }) });
  const code = await runLive(ARGS, ov);
  assert.equal(code, 2);
  assert.equal(emitted[0].reason, 'quota-paused');
  assert.equal(typeof emitted[0].fleetRunId, 'string');
});

test('runLive --json: a clean run emits reason null and echoes the sandbox policy from the deps', async () => {
  const { emitted, ov } = live();
  const code = await runLive(ARGS, ov);
  assert.equal(code, 0);
  assert.equal(emitted[0].reason, null);
  assert.equal(emitted[0].readPolicy, 'host');
  assert.equal(emitted[0].merged, 1);
});

test('runLive --json: a pipeline that REJECTS still emits one document (reason dispatch-refused, exit 1) and releases the lock', async () => {
  const { emitted, ov } = live();
  let released = false;
  const code = await runLive(ARGS, { ...ov, run: async () => { throw new Error('worktree init exploded'); }, release: () => { released = true; } });
  assert.equal(code, 1);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].reason, 'dispatch-refused');
  assert.equal(released, true, 'the preflight-held lock is released on the rejection path');
});

test('runLive without --json emits no document (legacy output unchanged)', async () => {
  const { emitted, ov } = live();
  await runLive({ ...ARGS, json: false }, ov);
  assert.equal(emitted.length, 0);
});

test('--json is a real flag of `fleet run` and `--resume` is not', () => {
  assert.equal(parseFlags(['--json']).json, true);
  assert.throws(() => parseFlags(['--resume']));
});
