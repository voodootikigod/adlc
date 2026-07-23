// T73 — fleet auto-completes a ticket on the integration branch after a passing
// merge gate. Two levels of proof:
//   1. completeTicketOnIntegration against a REAL directory store + REAL git repo,
//      proving (a) a merged+gate-passed ticket ends completed:true ON THE BRANCH
//      (a commit lands) and (c) a re-run over an already-completed ticket is a
//      no-op (no second commit, no error).
//   2. runFleet wiring, proving completion is GATED — invoked after a passing
//      post-merge gate, and (b) NEVER invoked when the post-merge gate fails.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { initializeTicketStores, TicketService, detectTicketStore, ticketFilename } from '@adlc/tickets';
import { runFleet, integrationBranchName } from '../lib/run.mjs';
import { resolveRunConfig } from '../lib/config.mjs';
import { completeTicketOnIntegration } from '../lib/complete.mjs';

function gitRunner(cwd) {
  return (...args) =>
    execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.email=fleet@test', '-c', 'user.name=fleet', ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
}

/** A temp git repo carrying a directory ticket store with one open ticket on an integration branch. */
function makeRepo(ticket = { id: 'T1', title: 'first' }, { bootstrapManifest = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fleet-complete-'));
  const git = gitRunner(root);
  git('init', '-b', 'main');
  git('commit', '--allow-empty', '-q', '-m', 'root');
  initializeTicketStores(root);
  // Bootstrap a manifest ledger so completion evidence APPENDS — the supported case
  // (rails-guard-ci allows append, denies create). Tests that want the un-bootstrapped
  // repo pass { bootstrapManifest: false }.
  if (bootstrapManifest) {
    writeFileSync(join(root, '.adlc', 'manifest.jsonl'), '{"seq":1,"gate":"bootstrap","ts":"2026-01-01T00:00:00.000Z","data":{"note":"test-bootstrap"},"prev":null}\n');
  }
  const service = new TicketService(detectTicketStore({ root }), { root });
  service.apply(service.planCreate(ticket));
  git('add', '-A');
  git('commit', '-q', '-m', 'author ticket');
  const integrationBranch = integrationBranchName('t73');
  git('branch', integrationBranch);
  git('checkout', '-q', integrationBranch);
  return { root, git, integrationBranch };
}

const commitCount = (git) => Number(git('rev-list', '--count', 'HEAD'));
const isCompleted = (root, id) => detectTicketStore({ root }).load().get(id)?.completed === true;

test('completeTicketOnIntegration marks completed:true and commits it onto the run branch (T73 a)', () => {
  const { root, git, integrationBranch } = makeRepo();
  try {
    assert.equal(isCompleted(root, 'T1'), false, 'precondition: ticket starts open');
    const before = commitCount(git);

    // The post-merge gate runs a build on the integration branch immediately
    // before completion and can leave untracked output in the tree. The
    // completion commit MUST be path-scoped and never sweep such files into the
    // PR-riding commit (an `git add -A` would).
    writeFileSync(join(root, 'dist-leaked-build-artifact.js'), '// build output the gate left behind\n');

    const res = completeTicketOnIntegration({ repo: root, ticketId: 'T1', integrationBranch, git });

    assert.equal(res.completed, true);
    assert.equal(isCompleted(root, 'T1'), true, 'store now records completed:true');
    assert.equal(commitCount(git), before + 1, 'a single completion commit landed on the run branch');

    // The commit is the add-only annotation: it touches the ticket shard and the
    // evidence ledger — and NOTHING else.
    const touched = git('show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean);
    assert.ok(touched.some((p) => p.startsWith('.adlc/tickets/')), `commit touches a ticket shard: ${touched.join(', ')}`);
    assert.ok(touched.includes('.adlc/manifest.jsonl'), 'completion records manifest evidence in the same commit');
    assert.deepEqual(
      touched.filter((p) => !p.startsWith('.adlc/')),
      [],
      `completion commit is scoped to .adlc/ — it must not sweep in unrelated tree state, but committed: ${touched.join(', ')}`,
    );
    // The stray build output stays untracked (never staged by the scoped commit).
    assert.match(git('status', '--porcelain'), /\?\? dist-leaked-build-artifact\.js/, 'the build artifact remains untracked');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('completeTicketOnIntegration is idempotent — a re-run over an already-completed ticket is a no-op (T73 c)', () => {
  const { root, git, integrationBranch } = makeRepo();
  try {
    completeTicketOnIntegration({ repo: root, ticketId: 'T1', integrationBranch, git });
    const after = commitCount(git);

    const again = completeTicketOnIntegration({ repo: root, ticketId: 'T1', integrationBranch, git });

    assert.equal(again.completed, false, 'no completion performed the second time');
    assert.equal(again.alreadyComplete, true, 'and it says so, rather than erroring');
    assert.equal(commitCount(git), after, 'no second commit is created');
    assert.equal(isCompleted(root, 'T1'), true, 'ticket stays completed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a failed completion commit is rolled back — the shared integration checkout stays clean (T73)', () => {
  const { root, git, integrationBranch } = makeRepo();
  try {
    // A git that behaves normally except it refuses to COMMIT (e.g. a rejecting
    // commit hook). add/reset delegate to real git so staging is real.
    const failingGit = (...args) => {
      if (args[0] === 'commit') throw new Error('commit rejected by hook');
      return git(...args);
    };

    assert.throws(
      () => completeTicketOnIntegration({ repo: root, ticketId: 'T1', integrationBranch, git: failingGit }),
      /commit rejected/,
      'the completion surfaces the commit failure',
    );

    // The on-disk transaction was undone: the ticket is open again...
    assert.equal(isCompleted(root, 'T1'), false, 'the completion write is rolled back');
    // ...and NOTHING is left staged or modified in the shared checkout — a later
    // fleet step must not find orphaned completion state to sweep into a commit.
    assert.equal(git('status', '--porcelain'), '', 'the integration checkout is clean after the failed completion');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the completion commit is CI-shaped — completed:true-only shard + append-only manifest (rails-guard-ci)', () => {
  const { root, git, integrationBranch } = makeRepo();
  try {
    const shardRel = `.adlc/tickets/${ticketFilename('T1')}`;
    const baseShard = JSON.parse(git('show', `HEAD:${shardRel}`));
    const baseManifest = git('show', 'HEAD:.adlc/manifest.jsonl');
    assert.ok(!('completed' in baseShard), 'precondition: base shard has no completed field');

    completeTicketOnIntegration({ repo: root, ticketId: 'T1', integrationBranch, git });

    // Shard diff is EXACTLY `completed: true` added — what rails-guard-ci's
    // isCompletionAnnotationOnly exempts (add-only on a pristine field).
    const headShard = JSON.parse(git('show', `HEAD:${shardRel}`));
    assert.equal(headShard.completed, true);
    const { completed, ...headWithoutCompleted } = headShard;
    assert.deepEqual(headWithoutCompleted, baseShard, 'the only shard change is the completed:true annotation');

    // Manifest diff is append-only — what rails-guard-ci requires (HEAD starts with base).
    const headManifest = git('show', 'HEAD:.adlc/manifest.jsonl');
    assert.ok(headManifest.startsWith(baseManifest), 'the manifest is append-only');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('on a repo with NO manifest baseline, completion is skipped — it never creates a manifest CI would reject', () => {
  const { root, git, integrationBranch } = makeRepo({ id: 'T1', title: 'first' }, { bootstrapManifest: false });
  try {
    const res = completeTicketOnIntegration({ repo: root, ticketId: 'T1', integrationBranch, git });
    assert.equal(res.completed, false);
    assert.equal(res.reason, 'no-manifest-baseline', 'it degrades to merged-not-completed with a clear reason');
    assert.equal(isCompleted(root, 'T1'), false, 'the ticket stays open');
    assert.ok(!existsSync(join(root, '.adlc', 'manifest.jsonl')), 'no manifest was created');
    assert.equal(git('status', '--porcelain'), '', 'the checkout is untouched');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---- runFleet wiring: completion is gated on a passing post-merge gate --------

const T = (id) => ({ id, title: id, scope: [`src/${id}/**`], edges: [] });

function harness({ postMerge = () => ({ ok: true }) } = {}) {
  const rec = { completed: [] };
  const deps = {
    baseSha: 'BASE',
    createIntegrationBranch: () => {},
    createWorktree: ({ ticket }) => ({ path: `/wt/${ticket.id}`, branch: `fleet/${ticket.id.toLowerCase()}`, startSha: 'tip' }),
    dispatch: () => ({ exitCode: 0, output: 'TICKET-DONE' }),
    gate: () => ({ ok: true }),
    prosecute: () => ({ verdict: 'pass' }),
    flail: () => ({ flail: false }),
    mergeToIntegration: () => ({ mergeSha: 'M', preMergeSha: 'P' }),
    postMergeGate: postMerge,
    revertMerge: () => ({ method: 'reset', ok: true }),
    completeTicket: ({ ticket, integrationBranch }) => { rec.completed.push({ id: ticket.id, integrationBranch }); },
    openPR: () => {},
  };
  return { deps, rec };
}

test('runFleet completes a merged+gate-passed ticket via the completeTicket effect', async () => {
  const { deps, rec } = harness();
  const config = { ...resolveRunConfig({}, {}), baseSha: 'BASE' };
  const summary = await runFleet({ all: [T('T1')], runId: 'r', config, deps });
  assert.equal(summary.results.T1, 'merged');
  assert.deepEqual(rec.completed, [{ id: 'T1', integrationBranch: integrationBranchName('r') }]);
});

test('runFleet does NOT complete a ticket whose post-merge gate failed (T73 b)', async () => {
  const { deps, rec } = harness({ postMerge: () => ({ ok: false }) });
  const config = { ...resolveRunConfig({}, {}), baseSha: 'BASE' };
  const summary = await runFleet({ all: [T('T1')], runId: 'r', config, deps });
  assert.notEqual(summary.results.T1, 'merged', 'a gate-failed ticket must not be reported merged');
  assert.equal(rec.completed.length, 0, 'a gate-failed ticket is never completed');
});
