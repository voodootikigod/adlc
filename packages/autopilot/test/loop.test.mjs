// Dry-run honesty (AC 10) and "dry-run never needs a worktree" (AC 128) over
// the REAL iterate(): phase A/B faked, selection + triage real, fake tools.

import { test } from './helpers/node-test.mjs';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { iterate } from '../lib/loop.mjs';
import { runIssue } from '../lib/run.mjs';
import { createSequenceFixture } from './helpers/sequence-fixture.mjs';
import { FAKE, GIT } from './helpers/recover-fixture.mjs';

/** A digest of every file under `root` (paths + bytes), skipping volatile git internals. */
function treeDigest(root) {
  const h = createHash('sha256');
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      if (name === '.git' && dir !== root) continue;
      const st = statSync(p, { throwIfNoEntry: false }); if (!st) continue;
      if (st.isDirectory()) { if (p === join(root, '.git')) { for (const f of ['config', join('info', 'exclude'), 'HEAD']) if (existsSync(join(p, f))) h.update(`${f}\n${readFileSync(join(p, f))}`); continue; } walk(p); }
      else if (st.isFile()) h.update(`${p.slice(root.length)}\n${readFileSync(p)}`);
    }
  };
  walk(root);
  return h.digest('hex');
}

const READ_ONLY_GIT = /^(for-each-ref|show|ls-tree|ls-remote|rev-parse|cat-file|config|status|diff|log)$/;

async function dryRun({ baselineLocal }) {
  const fx = await createSequenceFixture({ dryRun: true });
  const before = treeDigest(fx.repoRoot);
  const manifestBefore = readdirSync(join(fx.repoRoot, '.adlc', 'manifest.d')).map((f) => readFileSync(join(fx.repoRoot, '.adlc', 'manifest.d', f), 'utf8')).join('\0');
  const phaseB = baselineLocal
    // phase B reports ITS items only; the loop adds fleet-dry-run-needs-worktree itself
    ? async () => ({ complete: false, incomplete: [], tokenShort: false, checks: { config: 'ok', parity: 'ok' } })
    : async () => ({ complete: false, incomplete: ['baseline-not-local'], tokenShort: null, checks: { config: 'skipped', parity: 'skipped', ssh: 'skipped' } });
  const it = await iterate({ ctx: fx.ctx, deps: fx.loopDeps({ preflight: { phaseA: async () => {}, resolveBaseline: async () => fx.baseOid, phaseB } }), pinnedIssue: fx.issue });
  return { fx, it, before, manifestBefore };
}

export async function ac10_dryRunHonesty() {
  for (const baselineLocal of [true, false]) {
    const { fx, it, before, manifestBefore } = await dryRun({ baselineLocal });
    try {
      assert.equal(it.exitCode, 0, JSON.stringify(it.document));
      assert.equal(it.outcome, 'dry-run');
      assert.equal(it.document.complete, false, 'the plan is never complete');
      assert.ok(it.document.incomplete.includes('fleet-dry-run-needs-worktree'), 'always lists fleet-dry-run-needs-worktree');
      if (!baselineLocal) {
        assert.ok(it.document.incomplete.includes('baseline-not-local'));
        assert.ok(Object.values(it.document.preflightB.checks).every((v) => v === 'skipped'), 'every phase-B item is skipped without the objects');
      }
      assert.equal(it.document.selection.picked, fx.issue, 'the pinned issue is planned');
      assert.ok(Array.isArray(it.document.fleetArgv) && it.document.fleetArgv.includes('--tickets'), 'the plan carries the fleet argv');
      // Only read-only argv reached the recorder.
      for (const r of fx.recorder) {
        const exe = r.argv[0]; const a = r.argv.slice(1);
        if (exe === GIT) {
          const verb = a.find((x, i) => !x.startsWith('-') && !(i > 0 && (a[i - 1] === '-C' || a[i - 1] === '--git-dir')));
          assert.match(verb, READ_ONLY_GIT, `read-only git only: ${a.join(' ')}`);
          if (verb === 'config') assert.ok(a.includes('--get') && a.includes('--file'), 'the identity read is the --file --get form, never a write');
          assert.ok(!['fetch', 'worktree', 'push'].includes(verb));
        }
        if (exe === FAKE.gh) assert.ok(!/^(create|edit|comment|close|merge|delete)$/.test(a[1] ?? '') && !a.includes('--add-label'), `no gh mutation: ${a.join(' ')}`);
        assert.ok(!a.includes('--write') && !a.includes('--record'), `no --write/--record flag: ${a.join(' ')}`);
        assert.ok(exe !== FAKE.adlc || a[0] !== 'fleet', 'no fleet spawn');
      }
      assert.ok(!existsSync(fx.paths.lockDir), 'no lock was taken');
      assert.equal(treeDigest(fx.repoRoot), before, 'the filesystem fixture is byte-identical before and after');
      const manifestAfter = readdirSync(join(fx.repoRoot, '.adlc', 'manifest.d')).map((f) => readFileSync(join(fx.repoRoot, '.adlc', 'manifest.d', f), 'utf8')).join('\0');
      assert.equal(manifestAfter, manifestBefore, 'no manifest line was appended');
    } finally { fx.cleanup(); }
  }
}
test('AC10: once --dry-run --issue N exits 0 with a plan that is complete:false and lists fleet-dry-run-needs-worktree (and baseline-not-local with every phase-B item skipped when the objects are absent); the recorder shows only the read-only argv set; the fixture is byte-identical afterwards; no manifest line appended', { timeout: 120_000 }, ac10_dryRunHonesty);

export async function ac128_dryRunNeverNeedsAWorktree() {
  for (const baselineLocal of [true, false]) {
    const { fx, it } = await dryRun({ baselineLocal });
    try {
      assert.ok(!fx.recorder.some((r) => r.argv[0] === GIT && r.argv.includes('worktree')), 'no git worktree add');
      assert.ok(!fx.recorder.some((r) => r.argv[0] === FAKE.adlc && r.argv[1] === 'fleet'), 'no fleet spawn');
      assert.ok(it.document.incomplete.includes('fleet-dry-run-needs-worktree'));
      const checks = it.document.preflightB.checks;
      if (baselineLocal) assert.ok(Object.values(checks).some((v) => v === 'ok'), 'the read-only phase-B checks RUN when the objects are local');
      else assert.ok(Object.values(checks).every((v) => v === 'skipped'), 'and are all skipped when they are not');
      assert.ok(!existsSync(fx.paths.issueWorktree(fx.issue)));
    } finally { fx.cleanup(); }
  }
}
test('AC128: in dry-run the recorder shows no git worktree add and no fleet spawn; the plan lists fleet-dry-run-needs-worktree; the read-only phase-B checks run when the baseline objects are local and are all skipped when they are not', { timeout: 120_000 }, ac128_dryRunNeverNeedsAWorktree);

export async function ac28_loweringIsApplied() {
  // --max-rounds 3 against the committed 15 → the first fleet argv carries --max-strikes 3; a raise is refused.
  const fx = await createSequenceFixture({ flags: { maxRounds: '3' } });
  try {
    const it = await iterate({ ctx: fx.ctx, deps: fx.loopDeps(), pinnedIssue: fx.issue });
    assert.equal(it.outcome, 'done', JSON.stringify(it.document?.run ?? it.outcome));
    const fleet = fx.recorder.find((r) => r.argv[0] === FAKE.adlc && r.argv[1] === 'fleet');
    assert.equal(fleet.argv[fleet.argv.indexOf('--max-strikes') + 1], '3', 'the lowered budget is the effective one');
    assert.equal(fx.ctx.config.autopilot.maxRounds, 3);
  } finally { fx.cleanup(); }
  const fx2 = await createSequenceFixture({ flags: { maxRounds: '20' } });
  try {
    await assert.rejects(() => iterate({ ctx: fx2.ctx, deps: fx2.loopDeps(), pinnedIssue: fx2.issue }), /may be lowered by the CLI but not raised/);
  } finally { fx2.cleanup(); }
}
test('AC28: the operator lowering flags are APPLIED to the committed config in phase B (--max-rounds 3 → --max-strikes 3); a raise is refused', { timeout: 120_000 }, ac28_loweringIsApplied);

export async function ac21_resumableRunsAreResumed() {
  // A `shaped` record with a cached ticket and no worktree (the quota refused before creation) is resumed BEFORE selection.
  const fx = await createSequenceFixture();
  try {
    const { newRecord } = await import('../lib/records.mjs');
    const { branchFor } = await import('../lib/input.mjs');
    const n = fx.issue;
    const rec = { ...newRecord({ issue: n, token: 'e'.repeat(64), baseOid: fx.baseOid, branch: branchFor(n), stagingBranch: null, stagingPath: null, finalPath: fx.paths.issueWorktree(n), issueRevision: { updatedAt: fx.state.issue.updatedAt }, ticketCache: fx.ticket }), state: 'shaped', creationPhase: null };
    fx.ctx.records.save(rec);
    const recover = await import('../lib/recover.mjs');                      // the REAL classifier (the fixture stubs it to no actions)
    const it = await iterate({ ctx: fx.ctx, deps: fx.loopDeps({ recover }), pinnedIssue: null });
    assert.deepEqual(it.document.resume, { action: 'resume-shaped', issue: n }, 'recovery classified the row and the loop consumed it');
    assert.equal(it.outcome, 'resumed:done', JSON.stringify(it.document.run));
    assert.equal(fx.ctx.records.load(n).state, 'done');
    assert.ok(!fx.recorder.some((r) => r.argv[0] === FAKE.gh && String(r.argv[2] ?? '').includes('issues?state=open')), 'no new selection ran');
  } finally { fx.cleanup(); }
  // A `dispatched` record with a worktree resumes at the rounds (no second ticket write).
  const fx2 = await createSequenceFixture();
  try {
    const n = fx2.issue;
    const first = await runIssue({ ctx: fx2.ctx, deps: fx2.ctx.deps, issue: n, ticket: fx2.ticket, revision: { updatedAt: fx2.state.issue.updatedAt }, authorization: { ok: true } });
    assert.equal(first.state, 'done');
    fx2.ctx.records.update(n, { state: 'quota-paused', attestedHead: null });   // the run's OWN open PR stays exempt from revalidation
    const before = fx2.recorder.filter((r) => r.argv[0] === FAKE.adlc && r.argv[1] === 'ticket' && r.argv[2] === 'create').length;
    const { resumeRun } = await import('../lib/run.mjs');
    const r = await resumeRun({ ctx: fx2.ctx, deps: fx2.ctx.deps, action: 'resume-dispatch', issue: n });
    assert.ok(['done', 'ci-watch', 'ci-red', 'oid-mismatch', 'blocked'].includes(r.state), JSON.stringify(r));
    assert.equal(fx2.recorder.filter((x) => x.argv[0] === FAKE.adlc && x.argv[1] === 'ticket' && x.argv[2] === 'create').length, before, 'no second ticket write on resume');
  } finally { fx2.cleanup(); }
}
test('AC21: recovery\'s resume actions are consumed by the loop — a shaped run resumes before selection and a dispatched run resumes at its rounds without a second ticket write', { timeout: 240_000 }, ac21_resumableRunsAreResumed);
